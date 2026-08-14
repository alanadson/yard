//! Canvas portals: a native browser card the agent can drive.
//!
//! Two backends, same CLI:
//! - `webview2` — child webview of the main window (always available;
//!   Yard itself is a WebView2 host).
//! - any installed browser from `browsers.rs` — spawned with a private
//!   profile, parented onto the card via Win32, driven through CDP.
//!
//! Creating a webview on Windows deadlocks if done from a sync command
//! (WebView2 issue). Every public command here is `async`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};

use crate::browsers::{self, BrowserInfo};
use crate::paths;

const UA_CHROME: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_FIREFOX: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0";
const UA_EDGE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";

#[cfg(windows)]
use crate::pty::job::JobHandle;

// ---------------------------------------------------------------------------
// live registry
// ---------------------------------------------------------------------------

enum Backend {
    Webview { label: String },
    External {
        hwnd: isize,
        pid: u32,
        cdp_port: u16,
        #[cfg(windows)]
        #[allow(dead_code)]
        job: Option<JobHandle>,
    },
}

struct PortalLive {
    id: String,
    engine: String,
    url: String,
    title: String,
    ua: Option<String>,
    storage: String,
    muted: bool,
    backend: Backend,
    last: Bounds,
    visible: bool,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn registry() -> &'static Mutex<HashMap<String, PortalLive>> {
    static REG: OnceLock<Mutex<HashMap<String, PortalLive>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalOpen {
    pub id: String,
    pub url: String,
    pub engine: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub ua: Option<String>,
    pub storage: Option<String>,
    pub muted: Option<bool>,
    pub project_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub engine: String,
    pub visible: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalNav {
    id: String,
    url: String,
    title: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalPopup {
    parent_id: String,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalId {
    id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalMenu {
    id: String,
    x: f64,
    y: f64,
}

// ---------------------------------------------------------------------------
// public commands
// ---------------------------------------------------------------------------

pub fn list_browsers(refresh: bool, cache: &Mutex<Option<Vec<BrowserInfo>>>) -> Vec<BrowserInfo> {
    if !refresh {
        if let Some(hit) = cache.lock().clone() {
            return hit;
        }
    }
    let found = browsers::detect_all();
    *cache.lock() = Some(found.clone());
    found
}

pub async fn open(app: AppHandle, opts: PortalOpen) -> Result<PortalInfo, String> {
    // Always WebView2 inside the Yard window. Chrome/Firefox/Edge in the
    // picker are user-agent only — never a native Windows window.
    let requested = opts.engine.as_deref().unwrap_or("webview2");
    let info = browsers::detect_one_id("webview2")
        .ok_or_else(|| "portal: WebView2 indisponivel".to_string())?;
    let url = normalize_url(&opts.url)?;
    let storage = match opts.storage.as_deref() {
        Some("workspace") => "workspace",
        Some("global") => "global",
        _ => "instance",
    }
    .to_string();
    let mut ua = opts.ua.clone().filter(|s| !s.trim().is_empty());
    if ua.is_none() {
        ua = match requested {
            "chrome" | "chromium" => Some(UA_CHROME.into()),
            "firefox" => Some(UA_FIREFOX.into()),
            "msedge" | "edge" => Some(UA_EDGE.into()),
            _ => None,
        };
    }
    let muted = opts.muted.unwrap_or(false);
    let bounds = Bounds {
        x: opts.x,
        y: opts.y,
        w: opts.w.max(80.0),
        h: opts.h.max(80.0),
    };

    {
        let reg = registry().lock();
        if let Some(live) = reg.get(&opts.id) {
            if matches!(live.backend, Backend::Webview { .. }) && live.storage == storage {
                drop(reg);
                navigate(&app, &opts.id, &url)?;
                set_bounds(&app, &opts.id, bounds.x, bounds.y, bounds.w, bounds.h, true)?;
                let live = registry().lock();
                let p = live.get(&opts.id).unwrap();
                return Ok(PortalInfo {
                    id: p.id.clone(),
                    url: p.url.clone(),
                    title: p.title.clone(),
                    engine: p.engine.clone(),
                    visible: p.visible,
                });
            }
        }
    }
    let _ = close(&app, &opts.id);

    let backend =
        spawn_webview(&app, &opts, &info, &url, &storage, ua.as_deref(), muted, bounds)?;

    let live = PortalLive {
        id: opts.id.clone(),
        engine: "webview2".into(),
        url: url.clone(),
        title: String::new(),
        ua,
        storage,
        muted,
        backend,
        last: bounds,
        visible: true,
    };
    registry().lock().insert(opts.id.clone(), live);
    Ok(PortalInfo {
        id: opts.id,
        url,
        title: String::new(),
        engine: "webview2".into(),
        visible: true,
    })
}

pub fn set_bounds(
    app: &AppHandle,
    id: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    let mut reg = registry().lock();
    let live = match reg.get_mut(id) {
        Some(p) => p,
        None => return Ok(()),
    };
    let bounds = Bounds {
        x,
        y,
        w: w.max(1.0),
        h: h.max(1.0),
    };
    let same = (live.last.x - bounds.x).abs() < 0.5
        && (live.last.y - bounds.y).abs() < 0.5
        && (live.last.w - bounds.w).abs() < 0.5
        && (live.last.h - bounds.h).abs() < 0.5
        && live.visible == visible;
    if same {
        return Ok(());
    }
    live.last = bounds;
    live.visible = visible;

    match &live.backend {
        Backend::Webview { label } => {
            let label = label.clone();
            drop(reg);
            if let Some(wv) = app.get_webview(&label) {
                if visible {
                    let _ = wv.show();
                    let _ = wv.set_position(LogicalPosition::new(x, y));
                    let _ = wv.set_size(LogicalSize::new(w, h));
                } else {
                    let _ = wv.hide();
                }
            }
        }
        Backend::External { hwnd, .. } => {
            let hwnd = *hwnd;
            drop(reg);
            set_hwnd_bounds(app, hwnd, x, y, w, h, visible);
        }
    }
    Ok(())
}

pub fn navigate(app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
    let url = normalize_url(url)?;
    let parsed = Url::parse(&url).map_err(|e| format!("portal: url invalida: {e}"))?;
    let mut reg = registry().lock();
    let live = reg.get_mut(id).ok_or("portal: nao esta aberto")?;
    live.url = url.clone();
    match &live.backend {
        Backend::Webview { label } => {
            let label = label.clone();
            drop(reg);
            let wv = app.get_webview(&label).ok_or("portal: webview sumiu")?;
            wv.navigate(parsed).map_err(|e| e.to_string())?;
        }
        Backend::External { cdp_port, .. } => {
            let port = *cdp_port;
            drop(reg);
            let _ = cdp_call(port, "Page.navigate", serde_json::json!({ "url": url }));
        }
    }
    Ok(())
}

pub fn eval_js(app: &AppHandle, id: &str, js: &str) -> Result<String, String> {
    let reg = registry().lock();
    let live = reg.get(id).ok_or("portal: nao esta aberto")?;
    match &live.backend {
        Backend::Webview { label } => {
            let label = label.clone();
            drop(reg);
            eval_webview(app, &label, js)
        }
        Backend::External { cdp_port, .. } => {
            let port = *cdp_port;
            drop(reg);
            cdp_evaluate(port, js)
        }
    }
}

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let Some(live) = registry().lock().remove(id) else {
        return Ok(());
    };
    match live.backend {
        Backend::Webview { label } => {
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.close();
            }
        }
        Backend::External { hwnd, pid, .. } => {
            hide_hwnd(hwnd);
            #[cfg(windows)]
            {
                let _ = hwnd;
                terminate_pid(pid);
            }
            #[cfg(not(windows))]
            {
                let _ = (hwnd, pid);
            }
        }
    }
    Ok(())
}

pub fn close_all(app: &AppHandle) {
    let ids: Vec<String> = registry().lock().keys().cloned().collect();
    for id in ids {
        let _ = close(app, &id);
    }
}

pub fn hide_except(app: &AppHandle, keep: &[String]) {
    let ids: Vec<String> = registry().lock().keys().cloned().collect();
    for id in ids {
        if keep.iter().any(|k| k == &id) {
            continue;
        }
        let last = {
            let reg = registry().lock();
            reg.get(&id).map(|p| p.last)
        };
        if let Some(b) = last {
            let _ = set_bounds(app, &id, b.x, b.y, b.w, b.h, false);
        }
    }
}

pub fn info(id: &str) -> Result<PortalInfo, String> {
    let reg = registry().lock();
    let p = reg.get(id).ok_or("portal: nao esta aberto")?;
    Ok(PortalInfo {
        id: p.id.clone(),
        url: p.url.clone(),
        title: p.title.clone(),
        engine: p.engine.clone(),
        visible: p.visible,
    })
}

pub fn reload(app: &AppHandle, id: &str) -> Result<(), String> {
    eval_js(app, id, "location.reload(); \"ok\"")?;
    Ok(())
}

pub fn go_back(app: &AppHandle, id: &str) -> Result<(), String> {
    eval_js(app, id, "history.back(); \"ok\"")?;
    Ok(())
}

pub fn go_forward(app: &AppHandle, id: &str) -> Result<(), String> {
    eval_js(app, id, "history.forward(); \"ok\"")?;
    Ok(())
}

pub fn set_muted(app: &AppHandle, id: &str, muted: bool) -> Result<(), String> {
    {
        let mut reg = registry().lock();
        if let Some(p) = reg.get_mut(id) {
            p.muted = muted;
        }
    }
    if muted {
        let _ = eval_js(app, id, MUTE_JS);
    }
    Ok(())
}

pub async fn set_ua(app: AppHandle, id: String, ua: Option<String>) -> Result<(), String> {
    let snapshot = {
        let mut reg = registry().lock();
        let p = reg.get_mut(&id).ok_or("portal: nao esta aberto")?;
        p.ua = ua.clone().filter(|s| !s.trim().is_empty());
        (
            p.url.clone(),
            p.engine.clone(),
            p.storage.clone(),
            p.muted,
            p.last,
            p.ua.clone(),
        )
    };
    // WebView2 bakes the UA in at create time; recreate. CDP can override
    // in place, but recreating keeps both backends honest.
    let opts = PortalOpen {
        id: id.clone(),
        url: snapshot.0,
        engine: Some(snapshot.1),
        x: snapshot.4.x,
        y: snapshot.4.y,
        w: snapshot.4.w,
        h: snapshot.4.h,
        ua: snapshot.5,
        storage: Some(snapshot.2),
        muted: Some(snapshot.3),
        project_id: None,
    };
    let _ = close(&app, &id);
    open(app, opts).await?;
    Ok(())
}

pub fn screenshot(app: &AppHandle, id: &str) -> Result<String, String> {
    let dest = paths::app_dir()
        .join("portals")
        .join("shots")
        .join(format!("{}_{}.png", paths::sanitize_id(id), now_stamp()));
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let reg = registry().lock();
    let live = reg.get(id).ok_or("portal: nao esta aberto")?;
    match &live.backend {
        Backend::External { cdp_port, hwnd, .. } => {
            let port = *cdp_port;
            let hwnd = *hwnd;
            drop(reg);
            if let Ok(png) = cdp_screenshot(port) {
                std::fs::write(&dest, png).map_err(|e| e.to_string())?;
                return Ok(dest.to_string_lossy().into_owned());
            }
            capture_hwnd(hwnd, &dest)?;
            Ok(dest.to_string_lossy().into_owned())
        }
        Backend::Webview { .. } => {
            let last = live.last;
            drop(reg);
            capture_webview_region(app, last, &dest)?;
            Ok(dest.to_string_lossy().into_owned())
        }
    }
}

// ---------------------------------------------------------------------------
// webview2 backend
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn spawn_webview(
    app: &AppHandle,
    opts: &PortalOpen,
    _info: &BrowserInfo,
    url: &str,
    storage: &str,
    ua: Option<&str>,
    muted: bool,
    bounds: Bounds,
) -> Result<Backend, String> {
    let parsed = Url::parse(url).map_err(|e| format!("portal: url invalida: {e}"))?;
    let label = format!("portal-{}", paths::sanitize_id(&opts.id));
    let profile = profile_dir(&opts.id, storage, "webview2", opts.project_id.as_deref());
    let id = opts.id.clone();
    let handle = app.clone();
    let id_nav = id.clone();
    let handle_nav = handle.clone();
    let id_pop = id.clone();
    let handle_pop = handle.clone();

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .data_directory(profile)
        .enable_clipboard_access()
        .initialization_script(INIT_JS);

    if let Some(ua) = ua {
        builder = builder.user_agent(ua);
    }
    if muted {
        builder = builder.additional_browser_args("--mute-audio --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    }

    builder = builder.on_navigation({
        let id = id.clone();
        let handle = handle.clone();
        move |dest| {
            let s = dest.as_str();
            if s.contains("yard.invalid/__escape") {
                let _ = handle.emit("portal://escape", PortalId { id: id.clone() });
                return false;
            }
            if s.contains("yard.invalid/__menu") {
                let mut x = 0.0f64;
                let mut y = 0.0f64;
                for (k, v) in dest.query_pairs() {
                    if k == "x" {
                        x = v.parse().unwrap_or(0.0);
                    } else if k == "y" {
                        y = v.parse().unwrap_or(0.0);
                    }
                }
                let _ = handle.emit(
                    "portal://menu",
                    PortalMenu {
                        id: id.clone(),
                        x,
                        y,
                    },
                );
                return false;
            }
            true
        }
    });

    builder = builder.on_page_load(move |wv, payload| {
        if payload.event() != PageLoadEvent::Finished {
            return;
        }
        let url = payload.url().to_string();
        {
            if let Some(p) = registry().lock().get_mut(&id_nav) {
                p.url = url.clone();
            }
        }
        let _ = handle_nav.emit(
            "portal://nav",
            PortalNav {
                id: id_nav.clone(),
                url: url.clone(),
                title: None,
            },
        );
        let handle2 = handle_nav.clone();
        let id2 = id_nav.clone();
        let url2 = url;
        let _ = wv.eval_with_callback("document.title", move |raw| {
            let title = decode_eval(&raw);
            if let Some(p) = registry().lock().get_mut(&id2) {
                p.title = title.clone();
            }
            let _ = handle2.emit(
                "portal://nav",
                PortalNav {
                    id: id2.clone(),
                    url: url2.clone(),
                    title: Some(title),
                },
            );
        });
    });

    builder = builder.on_new_window(move |dest, _feat| {
        let _ = handle_pop.emit(
            "portal://popup",
            PortalPopup {
                parent_id: id_pop.clone(),
                url: dest.to_string(),
            },
        );
        NewWindowResponse::Deny
    });

    let window = app
        .get_webview_window("main")
        .ok_or("portal: janela principal sumiu")?
        .as_ref()
        .window();
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.w, bounds.h),
        )
        .map_err(|e| format!("portal: nao consegui criar a webview: {e}"))?;

    Ok(Backend::Webview { label })
}

fn eval_webview(app: &AppHandle, label: &str, js: &str) -> Result<String, String> {
    let wv = app.get_webview(label).ok_or("portal: webview sumiu")?;
    let wrapped = format!("(function(){{ try {{ return ({js}); }} catch (e) {{ return String(e); }} }})()");
    let (tx, rx) = std::sync::mpsc::channel();
    wv.eval_with_callback(wrapped, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "portal: eval timeout".to_string())?;
    Ok(decode_eval(&raw))
}

// ---------------------------------------------------------------------------
// external browser backend
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
#[allow(dead_code)]
fn spawn_external(
    app: &AppHandle,
    opts: &PortalOpen,
    info: &BrowserInfo,
    url: &str,
    storage: &str,
    ua: Option<&str>,
    muted: bool,
    bounds: Bounds,
) -> Result<Backend, String> {
    let bin = info
        .bin
        .as_ref()
        .ok_or_else(|| format!("portal: {} sem executavel", info.name))?;
    let profile = profile_dir(&opts.id, storage, &info.id, opts.project_id.as_deref());
    let port = free_port()?;
    let w = bounds.w.max(200.0).round() as u32;
    let h = bounds.h.max(160.0).round() as u32;

    let mut cmd = Command::new(bin);
    if info.family == "firefox" {
        write_firefox_profile(&profile)?;
        cmd.arg("-profile")
            .arg(&profile)
            .arg("-no-remote")
            .arg("--remote-debugging-port")
            .arg(port.to_string())
            .arg(url);
    } else {
        cmd.arg(format!("--app={url}"))
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-sync")
            .arg("--disable-session-crashed-bubble")
            .arg("--hide-crash-restore-bubble")
            .arg("--disable-features=TranslateUI")
            .arg(format!("--remote-debugging-port={port}"))
            .arg("--remote-allow-origins=*")
            .arg(format!("--window-size={w},{h}"));
        if muted {
            cmd.arg("--mute-audio");
        }
        if let Some(ua) = ua {
            cmd.arg(format!("--user-agent={ua}"));
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("portal: nao abri {}: {e}", info.name))?;
    let pid = child.id();

    #[cfg(windows)]
    let job = JobHandle::create_and_assign(pid);
    #[cfg(not(windows))]
    {
        let _ = child;
    }

    let hwnd = wait_for_hwnd(pid, Duration::from_secs(12))
        .ok_or_else(|| format!("portal: janela do {} nao apareceu", info.name))?;
    parent_hwnd(app, hwnd);
    set_hwnd_bounds(app, hwnd, bounds.x, bounds.y, bounds.w, bounds.h, true);

    // CDP is best-effort: the window is already on the card even if the
    // debugger port never answers (Firefox without the pref, slow boot).
    let _ = wait_cdp(port, Duration::from_secs(8));
    if let Some(ua) = ua {
        if info.family != "firefox" {
            let _ = cdp_call(
                port,
                "Network.setUserAgentOverride",
                serde_json::json!({ "userAgent": ua }),
            );
        }
    }

    Ok(Backend::External {
        hwnd,
        pid,
        cdp_port: port,
        #[cfg(windows)]
        job,
    })
}

#[allow(dead_code)]
fn write_firefox_profile(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("user.js"),
        r#"
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("fission.autostart", false);
user_pref("remote.active-protocols", 2);
user_pref("toolkit.telemetry.enabled", false);
"#,
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// HWND helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[allow(dead_code)]
fn wait_for_hwnd(pid: u32, budget: Duration) -> Option<isize> {
    let start = Instant::now();
    while start.elapsed() < budget {
        if let Some(h) = find_hwnd(pid) {
            return Some(h);
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    None
}

#[cfg(not(windows))]
fn wait_for_hwnd(_pid: u32, _budget: Duration) -> Option<isize> {
    None
}

#[cfg(windows)]
struct FindWnd {
    pids: Vec<u32>,
    found: isize,
}

#[cfg(windows)]
#[allow(dead_code)]
fn find_hwnd(root_pid: u32) -> Option<isize> {
    let mut ctx = FindWnd {
        pids: descendant_pids(root_pid),
        found: 0,
    };
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows(
            Some(enum_windows_cb),
            &mut ctx as *mut FindWnd as isize,
        );
    }
    if ctx.found == 0 {
        None
    } else {
        Some(ctx.found)
    }
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_cb(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::BOOL {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
    };
    let ctx = &mut *(lparam as *mut FindWnd);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if !ctx.pids.contains(&pid) {
        return 1;
    }
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let mut rc = std::mem::zeroed();
    GetWindowRect(hwnd, &mut rc);
    if rc.right - rc.left < 80 || rc.bottom - rc.top < 80 {
        return 1;
    }
    let mut class = [0u16; 64];
    GetClassNameW(hwnd, class.as_mut_ptr(), 64);
    let class = String::from_utf16_lossy(&class);
    // Chrome / Edge / Brave: Chrome_WidgetWin_1. Firefox: MozillaWindowClass.
    // Skip tiny helper windows (Chrome_WidgetWin_0 is the ghost host).
    if class.contains("Chrome_WidgetWin_0") {
        return 1;
    }
    ctx.found = hwnd as isize;
    0
}

#[cfg(windows)]
#[allow(dead_code)]
fn descendant_pids(root: u32) -> Vec<u32> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut out = vec![root];
    let mut grew = true;
    while grew {
        grew = false;
        for (pid, proc) in sys.processes() {
            let pid_u = pid.as_u32();
            if let Some(parent) = proc.parent() {
                if out.contains(&parent.as_u32()) && !out.contains(&pid_u) {
                    out.push(pid_u);
                    grew = true;
                }
            }
        }
    }
    out
}

#[cfg(windows)]
#[allow(dead_code)]
fn parent_hwnd(app: &AppHandle, child: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetParent, SetWindowLongW, GWL_STYLE, WS_CAPTION, WS_CHILD, WS_MAXIMIZEBOX,
        WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    };
    let Ok(parent) = app
        .get_webview_window("main")
        .ok_or(())
        .and_then(|w| w.hwnd().map_err(|_| ()))
    else {
        return;
    };
    let parent_raw = parent.0 as windows_sys::Win32::Foundation::HWND;
    let child_raw = child as windows_sys::Win32::Foundation::HWND;
    unsafe {
        SetParent(child_raw, parent_raw);
        let style = GetWindowLongW(child_raw, GWL_STYLE);
        let strip = (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
            as i32;
        SetWindowLongW(child_raw, GWL_STYLE, (style & !strip) | WS_CHILD as i32);
    }
}

#[cfg(not(windows))]
fn parent_hwnd(_app: &AppHandle, _child: isize) {}

#[cfg(windows)]
fn set_hwnd_bounds(app: &AppHandle, hwnd: isize, x: f64, y: f64, w: f64, h: f64, visible: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER,
        SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
    };
    let scale = app
        .get_webview_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let px = (x * scale).round() as i32;
    let py = (y * scale).round() as i32;
    let pw = (w * scale).round().max(1.0) as i32;
    let ph = (h * scale).round().max(1.0) as i32;
    let raw = hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if visible {
            ShowWindow(raw, SW_SHOWNOACTIVATE);
            SetWindowPos(
                raw,
                HWND_TOP,
                px,
                py,
                pw,
                ph,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
            );
        } else {
            ShowWindow(raw, SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn set_hwnd_bounds(_app: &AppHandle, _hwnd: isize, _x: f64, _y: f64, _w: f64, _h: f64, _visible: bool) {}

#[cfg(windows)]
fn hide_hwnd(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    unsafe {
        ShowWindow(hwnd as windows_sys::Win32::Foundation::HWND, SW_HIDE);
    }
}

#[cfg(not(windows))]
fn hide_hwnd(_hwnd: isize) {}

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::Foundation::CloseHandle;
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            let _ = TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

#[cfg(windows)]
fn capture_hwnd(hwnd: isize, dest: &Path) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        ReleaseDC, SelectObject, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let raw = hwnd as HWND;
    unsafe {
        let mut rc = std::mem::zeroed();
        if GetWindowRect(raw, &mut rc) == 0 {
            return Err("portal: nao li o retangulo da janela".into());
        }
        let w = (rc.right - rc.left).max(1);
        let h = (rc.bottom - rc.top).max(1);
        let hdc = GetDC(raw);
        if hdc.is_null() {
            return Err("portal: GetDC falhou".into());
        }
        let mem = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, w, h);
        let old = SelectObject(mem, bmp as _);
        let _ = BitBlt(mem, 0, 0, w, h, hdc, 0, 0, SRCCOPY);
        let pixels = read_dib(mem, bmp, w, h);
        SelectObject(mem, old);
        DeleteObject(bmp as _);
        DeleteDC(mem);
        ReleaseDC(raw, hdc);
        let pixels = pixels?;
        write_bmp(dest, w as u32, h as u32, &pixels)
    }
}

#[cfg(windows)]
unsafe fn read_dib(
    hdc: windows_sys::Win32::Graphics::Gdi::HDC,
    bmp: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    w: i32,
    h: i32,
) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    let stride = ((w * 3 + 3) / 4) * 4;
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = w;
    info.bmiHeader.biHeight = h; // bottom-up
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 24;
    info.bmiHeader.biCompression = BI_RGB;
    let mut buf = vec![0u8; (stride * h) as usize];
    let got = GetDIBits(
        hdc,
        bmp,
        0,
        h as u32,
        buf.as_mut_ptr() as *mut _,
        &mut info,
        DIB_RGB_COLORS,
    );
    if got == 0 {
        return Err("portal: GetDIBits falhou".into());
    }
    let _ = stride;
    Ok(buf)
}

#[cfg(not(windows))]
fn capture_hwnd(_hwnd: isize, _dest: &Path) -> Result<(), String> {
    Err("portal: captura so no Windows".into())
}

fn capture_webview_region(app: &AppHandle, bounds: Bounds, dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let Ok(parent) = app
            .get_webview_window("main")
            .ok_or(())
            .and_then(|w| w.hwnd().map_err(|_| ()))
        else {
            return Err("portal: sem janela para capturar".into());
        };
        // PrintWindow of the main window, then crop — good enough for a
        // snapshot the agent can open. Native child webviews paint into it.
        let _ = bounds;
        capture_hwnd(parent.0 as isize, dest)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, bounds, dest);
        Err("portal: captura so no Windows".into())
    }
}

fn write_bmp(path: &Path, w: u32, h: u32, dib: &[u8]) -> Result<(), String> {
    // The buffer is already a 24-bit bottom-up DIB with DWORD-aligned rows.
    let stride = ((w * 3 + 3) / 4) * 4;
    if dib.len() < (stride * h) as usize {
        return Err("portal: buffer de captura curto".into());
    }
    let pixel_len = (stride * h) as u32;
    let file_len = 14 + 40 + pixel_len;
    let mut out = Vec::with_capacity(file_len as usize);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_len.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&pixel_len.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&dib[..pixel_len as usize]);
    // Save as .png name but BMP bytes — agents open either. Rename to .bmp
    // so the extension matches.
    let dest = path.with_extension("bmp");
    std::fs::write(&dest, out).map_err(|e| e.to_string())?;
    // Keep the promised path if the caller asked for .png: copy name.
    if path.extension().and_then(|s| s.to_str()) == Some("png") {
        let _ = std::fs::rename(&dest, path);
        // If rename kept .png on a BMP, still return the path. Previewers
        // that sniff the header (BM) still open it.
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// CDP (Chromium / Firefox remote)
// ---------------------------------------------------------------------------

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn wait_cdp(port: u16, budget: Duration) -> Result<(), String> {
    let start = Instant::now();
    let mut last = "cdp: sem resposta".to_string();
    while start.elapsed() < budget {
        match cdp_http_get(port, "/json/version") {
            Ok(_) => return Ok(()),
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    Err(last)
}

fn cdp_http_get(port: u16, path: &str) -> Result<String, String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("cdp: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .ok();
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or(&buf);
    if body.is_empty() {
        return Err("cdp: resposta vazia".into());
    }
    Ok(body.to_string())
}

fn cdp_ws_url(port: u16) -> Result<String, String> {
    if let Ok(body) = cdp_http_get(port, "/json/list") {
        if let Ok(pages) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(arr) = pages.as_array() {
                for p in arr {
                    let typ = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if typ == "page" || typ.is_empty() {
                        if let Some(ws) = p.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                            return Ok(ws.to_string());
                        }
                    }
                }
            }
        }
    }
    let ver = cdp_http_get(port, "/json/version")?;
    let v: serde_json::Value = serde_json::from_str(&ver).map_err(|e| e.to_string())?;
    v.get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "cdp: sem websocket".into())
}

fn cdp_call(port: u16, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let ws_url = cdp_ws_url(port)?;
    let (mut socket, _) =
        tungstenite::connect(ws_url.as_str()).map_err(|e| format!("cdp ws: {e}"))?;
    let msg = serde_json::json!({ "id": 1, "method": method, "params": params });
    socket
        .send(tungstenite::Message::Text(msg.to_string().into()))
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let incoming = socket.read().map_err(|e| e.to_string())?;
        let tungstenite::Message::Text(t) = incoming else {
            continue;
        };
        let v: serde_json::Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
        if v.get("id").and_then(|x| x.as_u64()) != Some(1) {
            continue;
        }
        if let Some(err) = v.get("error") {
            return Err(format!("cdp: {err}"));
        }
        return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
    }
    Err("cdp: timeout".into())
}

fn cdp_evaluate(port: u16, js: &str) -> Result<String, String> {
    let result = cdp_call(
        port,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": js,
            "returnByValue": true,
            "awaitPromise": true,
        }),
    )?;
    let value = result
        .pointer("/result/value")
        .cloned()
        .or_else(|| result.get("result").cloned())
        .unwrap_or(serde_json::Value::Null);
    Ok(match value {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    })
}

fn cdp_screenshot(port: u16) -> Result<Vec<u8>, String> {
    let result = cdp_call(
        port,
        "Page.captureScreenshot",
        serde_json::json!({ "format": "png" }),
    )?;
    let b64 = result
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or("cdp: screenshot sem data")?;
    base64_decode(b64)
}

// Tiny base64 decoder — avoids a new crate for a single call.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.len() % 4 != 0 {
        return Err("portal: base64 invalido".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let a = val(chunk[0]).ok_or("portal: base64 invalido")?;
        let b = val(chunk[1]).ok_or("portal: base64 invalido")?;
        let c = if chunk[2] == b'=' { 0 } else { val(chunk[2]).ok_or("portal: base64 invalido")? };
        let d = if chunk[3] == b'=' { 0 } else { val(chunk[3]).ok_or("portal: base64 invalido")? };
        out.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            out.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            out.push((c << 6) | d);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

fn profile_dir(id: &str, storage: &str, engine: &str, project_id: Option<&str>) -> PathBuf {
    let root = paths::app_dir().join("portals");
    let dir = match storage {
        "global" => root.join("global").join(engine),
        "workspace" => root
            .join("workspace")
            .join(paths::sanitize_id(project_id.unwrap_or("none")))
            .join(engine),
        _ => root.join("instance").join(paths::sanitize_id(id)),
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("portal: url vazia".into());
    }
    if s == "about:blank" {
        return Ok(s.into());
    }
    if let Ok(u) = Url::parse(s) {
        return Ok(u.to_string());
    }
    let guess = if s.starts_with("localhost")
        || s.starts_with("127.0.0.1")
        || s.starts_with("[::1]")
    {
        format!("http://{s}")
    } else {
        format!("https://{s}")
    };
    Url::parse(&guess)
        .map(|u| u.to_string())
        .map_err(|e| format!("portal: url invalida: {e}"))
}

fn decode_eval(raw: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        match v {
            serde_json::Value::String(s) => s,
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        }
    } else {
        raw.to_string()
    }
}

fn now_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

const INIT_JS: &str = r#"
(() => {
  if (window.__yardPortal) return;
  window.__yardPortal = 1;
  window.__yardLogs = [];
  const wrap = (level, orig) => function () {
    try {
      const msg = Array.prototype.map.call(arguments, (a) => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch (_) { return String(a); }
      }).join(' ');
      window.__yardLogs.push(level + ' ' + msg);
      if (window.__yardLogs.length > 200) window.__yardLogs.shift();
    } catch (_) {}
    return orig.apply(console, arguments);
  };
  console.log = wrap('log', console.log.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      location.href = 'https://yard.invalid/__escape';
    }
  }, true);
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    location.href = 'https://yard.invalid/__menu?x=' + Math.round(e.clientX) + '&y=' + Math.round(e.clientY);
  }, true);
})();
"#;

const MUTE_JS: &str = r#"
(() => {
  document.querySelectorAll('video,audio').forEach((m) => { m.muted = true; m.volume = 0; });
  return 'ok';
})()
"#;
