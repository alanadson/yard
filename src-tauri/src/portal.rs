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
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use crate::browsers::{self, BrowserInfo};
use crate::paths;

const UA_CHROME: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_FIREFOX: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0";
const UA_EDGE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";

#[cfg(windows)]
use crate::pty::job::JobHandle;

// ---------------------------------------------------------------------------
// live registry
// ---------------------------------------------------------------------------

enum Backend {
    Webview {
        label: String,
    },
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
    /// Project the card belongs to. Only `storage: "workspace"` reads it, and
    /// it has to live here because the portal is **recreated** on a user-agent
    /// change: rebuilding the options without it moved the profile from
    /// `portals/workspace/<projeto>/` to `portals/workspace/none/` — a
    /// different folder, so the session (cookies, login) was simply gone.
    project_id: Option<String>,
    muted: bool,
    backend: Backend,
    last: Bounds,
    visible: bool,
    /// The canvas rectangle the page is allowed to paint in, in screen
    /// coordinates. `None` = the whole screen.
    clip: Option<Bounds>,
    /// App surfaces cut out of the page — see `PortalPlace::holes`.
    holes: Vec<Bounds>,
    /// Canvas zoom the page is rendering at.
    zoom: f64,
    /// The region currently on the host window, in its own physical pixels.
    /// Kept so a pan does not hand Windows the same region every frame.
    region: Option<RegionSpec>,
    /// The host window the clip was last applied to — see `host_of`.
    host: Option<isize>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Bounds {
    fn right(&self) -> f64 {
        self.x + self.w
    }
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
    fn intersect(&self, other: &Bounds) -> Bounds {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let w = self.right().min(other.right()) - x;
        let h = self.bottom().min(other.bottom()) - y;
        Bounds {
            x,
            y,
            w: w.max(0.0),
            h: h.max(0.0),
        }
    }
    fn is_empty(&self) -> bool {
        self.w < 1.0 || self.h < 1.0
    }
    /// Does `other` fit entirely inside? Half a pixel of slack: the rectangles
    /// come from `getBoundingClientRect`, which is fractional.
    fn holds(&self, other: &Bounds) -> bool {
        other.x >= self.x - 0.5
            && other.y >= self.y - 0.5
            && other.right() <= self.right() + 0.5
            && other.bottom() <= self.bottom() + 0.5
    }
    fn near(&self, other: &Bounds) -> bool {
        (self.x - other.x).abs() < 0.5
            && (self.y - other.y).abs() < 0.5
            && (self.w - other.w).abs() < 0.5
            && (self.h - other.h).abs() < 0.5
    }
}

fn near_opt(a: Option<Bounds>, b: Option<Bounds>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.near(&b),
        _ => false,
    }
}

/// What the host window is allowed to paint, in its own physical pixels:
/// one rectangle with rectangular bites taken out of it.
#[derive(Clone, Debug, PartialEq)]
struct RegionSpec {
    base: [i32; 4],
    holes: Vec<[i32; 4]>,
}

/// WebView2 refuses anything outside this; the canvas goes further than that
/// in both directions.
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 5.0;

fn registry() -> &'static Mutex<HashMap<String, PortalLive>> {
    static REG: OnceLock<Mutex<HashMap<String, PortalLive>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The window wry parents each child webview onto (`WRY_WEBVIEW`), by portal
/// id.
///
/// Tauri hands out no handle for a child webview, so it is read once from the
/// WebView2 controller and kept here. It is a map of its own, not a field of
/// `PortalLive`, because it is filled from a main-thread callback that can
/// land before `open` finishes inserting the entry.
fn hosts() -> &'static Mutex<HashMap<String, isize>> {
    static HOSTS: OnceLock<Mutex<HashMap<String, isize>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn host_of(id: &str) -> Option<isize> {
    hosts().lock().get(id).copied()
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
    /// Where the canvas may paint — see `PortalPlace::clip`. Sent at open time
    /// too so a portal born under a panel never flashes over it.
    pub clip: Option<PortalRect>,
    pub zoom: Option<f64>,
    pub holes: Option<Vec<PortalRect>>,
}

/// Where a portal's surface goes, in the screen coordinates of the main
/// window's webview (CSS pixels).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalPlace {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub visible: bool,
    /// The canvas's own rectangle. The page is a native window on top of the
    /// DOM: without this it paints over the sidebar, the panels and the title
    /// bar the moment the card reaches the edge of the board.
    pub clip: Option<PortalRect>,
    /// Rectangles of app surfaces that have to show *through* the page — an
    /// open menu, the toolbar, the minimap, a toast.
    ///
    /// They are cut out of the window's region, which takes the mouse with
    /// them: the menu under the hole is not only visible, it is clickable.
    /// The board used to blank the whole site instead, so right-clicking one
    /// card made the page it was about disappear.
    pub holes: Option<Vec<PortalRect>>,
    /// Canvas zoom. The page renders at this scale, so the site keeps the
    /// card's *world* size as its CSS viewport however far the camera is.
    pub zoom: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PortalBoundsUpdate {
    pub id: String,
    pub place: PortalPlace,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PortalRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl From<PortalRect> for Bounds {
    fn from(r: PortalRect) -> Self {
        Bounds {
            x: r.x,
            y: r.y,
            w: r.w.max(0.0),
            h: r.h.max(0.0),
        }
    }
}

impl From<Bounds> for PortalRect {
    fn from(b: Bounds) -> Self {
        PortalRect {
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
        }
    }
}

/// Where a portal is right now, ready to be handed back to `place` — what
/// "show this again" and "the host window finally arrived" both need.
fn live_place(live: &PortalLive, visible: bool) -> PortalPlace {
    PortalPlace {
        x: live.last.x,
        y: live.last.y,
        w: live.last.w,
        h: live.last.h,
        visible,
        clip: live.clip.map(PortalRect::from),
        zoom: Some(live.zoom),
        holes: Some(live.holes.iter().copied().map(PortalRect::from).collect()),
    }
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
    let clip = opts.clip.map(Bounds::from);
    let zoom = opts.zoom.unwrap_or(1.0).clamp(ZOOM_MIN, ZOOM_MAX);

    {
        let reg = registry().lock();
        if let Some(live) = reg.get(&opts.id) {
            if matches!(live.backend, Backend::Webview { .. }) && live.storage == storage {
                let already_there = live.url == url;
                drop(reg);
                // Re-opening what is already open (a remount, the project id
                // arriving late) must not throw the page away: navigating to
                // the stored address reloads it, and with it goes the scroll,
                // the form being filled and whatever the agent had already
                // done in there. Only a real change of address navigates.
                if !already_there {
                    navigate(&app, &opts.id, &url)?;
                }
                place(
                    &app,
                    &opts.id,
                    PortalPlace {
                        x: bounds.x,
                        y: bounds.y,
                        w: bounds.w,
                        h: bounds.h,
                        visible: true,
                        clip: opts.clip,
                        zoom: Some(zoom),
                        holes: opts.holes.clone(),
                    },
                )?;
                // Not `unwrap`: the lock was released above, and a close
                // landing in that window would take the whole app down with
                // a panic inside a command.
                let live = registry().lock();
                let p = live.get(&opts.id).ok_or("portal: fechou enquanto abria")?;
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

    let backend = spawn_webview(
        &app,
        &opts,
        &info,
        &url,
        &storage,
        ua.as_deref(),
        muted,
        bounds,
    )?;

    let live = PortalLive {
        id: opts.id.clone(),
        engine: "webview2".into(),
        url: url.clone(),
        title: String::new(),
        ua,
        storage,
        project_id: opts.project_id.clone(),
        muted,
        backend,
        last: bounds,
        visible: true,
        clip,
        holes: opts
            .holes
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|r| Bounds::from(*r))
            .collect(),
        zoom,
        region: None,
        host: None,
    };
    registry().lock().insert(opts.id.clone(), live);
    // The host window is read on the main thread and may only land after this
    // returns; asking for the clip again here applies it as soon as it does,
    // instead of waiting for the first pan.
    place(
        &app,
        &opts.id,
        PortalPlace {
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h,
            visible: true,
            clip: opts.clip,
            zoom: Some(zoom),
            holes: opts.holes.clone(),
        },
    )?;
    Ok(PortalInfo {
        id: opts.id,
        url,
        title: String::new(),
        engine: "webview2".into(),
        visible: true,
    })
}

/// Puts the page where the card is — cut to the canvas, at the canvas's zoom.
///
/// The surface is an OS window stacked over the whole app, so *nothing* in
/// CSS can stop it at the edge of the board: it is the window itself that has
/// to be clipped (`SetWindowRgn` on the host window). Without a host handle —
/// the rare race at open, and anything that is not Windows — the rectangle is
/// shrunk to what is allowed instead, which crops the page the ugly way but
/// still never paints over the panels.
pub fn place(app: &AppHandle, id: &str, p: PortalPlace) -> Result<(), String> {
    let bounds = Bounds {
        x: p.x,
        y: p.y,
        w: p.w.max(1.0),
        h: p.h.max(1.0),
    };
    let clip = p.clip.map(Bounds::from);
    let zoom = p.zoom.unwrap_or(1.0).clamp(ZOOM_MIN, ZOOM_MAX);
    let holes: Vec<Bounds> = p
        .holes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|r| Bounds::from(*r))
        .collect();
    let shown = clip.map_or(bounds, |c| bounds.intersect(&c));
    // Entirely outside the canvas is not "somewhere else on screen", it is
    // gone: a one-pixel sliver of a site is noise, and an empty region is not
    // a legal clip anyway.
    let visible = p.visible && !shown.is_empty();
    let host = host_of(id);

    // Computed before the lock: it reads the window's scale factor, and the
    // registry is held on the hot path of a pan.
    let want = host.and(region_for(app, bounds, clip, &holes));

    let mut reg = registry().lock();
    let live = match reg.get_mut(id) {
        Some(p) => p,
        None => return Ok(()),
    };
    let same = live.last.near(&bounds)
        && live.visible == visible
        && near_opt(live.clip, clip)
        && (live.zoom - zoom).abs() < 0.005
        && live.host == host
        && live.region == want;
    if same {
        return Ok(());
    }
    let zoom_changed = (live.zoom - zoom).abs() >= 0.005;
    let region_changed = live.region != want || live.host != host;
    live.last = bounds;
    live.clip = clip;
    live.holes = holes;
    live.visible = visible;
    live.zoom = zoom;
    live.host = host;
    if visible {
        live.region = want.clone();
    }

    match &live.backend {
        Backend::Webview { label } => {
            let label = label.clone();
            drop(reg);
            let Some(wv) = app.get_webview(&label) else {
                return Ok(());
            };
            if !visible {
                let _ = wv.hide();
                return Ok(());
            }
            let rect = if host.is_some() { bounds } else { shown };
            let _ = wv.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = wv.set_size(LogicalSize::new(rect.w, rect.h));
            // Only when it moved: every change of the zoom factor relays out
            // the whole page, and a pinch-zoom would ask for one per frame.
            if zoom_changed {
                let _ = wv.set_zoom(zoom);
            }
            let _ = wv.show();
            if let (Some(h), true) = (host, region_changed) {
                apply_region(h, want.as_ref());
            }
        }
        Backend::External { hwnd, .. } => {
            let hwnd = *hwnd;
            drop(reg);
            set_hwnd_bounds(app, hwnd, shown.x, shown.y, shown.w, shown.h, visible);
        }
    }
    Ok(())
}

/** One IPC crossing for all native surfaces moved in the same animation frame. */
pub fn place_many(app: &AppHandle, updates: Vec<PortalBoundsUpdate>) -> Result<(), String> {
    for update in updates {
        place(app, &update.id, update.place)?;
    }
    Ok(())
}

/// Shows or hides a portal without moving it (`portal_hide_except`).
pub fn set_visible(app: &AppHandle, id: &str, visible: bool) -> Result<(), String> {
    let wanted = {
        let reg = registry().lock();
        let live = match reg.get(id) {
            Some(p) => p,
            None => return Ok(()),
        };
        if live.visible == visible {
            return Ok(());
        }
        live_place(live, visible)
    };
    place(app, id, wanted)
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

/// Runs a script and does **not** wait for its value.
///
/// The answer to `eval_with_callback` is delivered on the UI thread, so
/// anything that blocks waiting for it from the UI thread waits out the whole
/// timeout with the app frozen — which is exactly what the reload button used
/// to do. Nothing here has a result worth that.
fn eval_fire(app: &AppHandle, id: &str, js: &str) -> Result<(), String> {
    let reg = registry().lock();
    let live = reg.get(id).ok_or("portal: nao esta aberto")?;
    match &live.backend {
        Backend::Webview { label } => {
            let label = label.clone();
            drop(reg);
            let wv = app.get_webview(&label).ok_or("portal: webview sumiu")?;
            wv.eval(js).map_err(|e| e.to_string())
        }
        Backend::External { cdp_port, .. } => {
            let port = *cdp_port;
            drop(reg);
            cdp_evaluate(port, js).map(|_| ())
        }
    }
}

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    hosts().lock().remove(id);
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

/// Closes every engine whose card no longer exists, and reports how many.
///
/// The registry here is the only authority on which engines are running. The
/// front end can lose a portal card without ever passing through "delete
/// portal" — an undo that restores a snapshot taken before the card was
/// created, a score replacing the whole canvas, a group or project removed —
/// and each of those used to leak a live WebView2 for the rest of the
/// session: hidden at 1x1 (that is all unmounting a card does), holding its
/// session and its memory, with no UI left to reach it.
///
/// `keep` is the complete set of portal ids the front end still has cards
/// for, across every group. Anything else is an orphan by definition.
pub fn retain(app: &AppHandle, keep: &[String]) -> usize {
    let ids: Vec<String> = registry().lock().keys().cloned().collect();
    let mut closed = 0;
    for id in ids {
        if keep.iter().any(|k| k == &id) {
            continue;
        }
        if close(app, &id).is_ok() {
            closed += 1;
            tracing::info!(portal = %id, "portal orfao fechado (sem cartao no canvas)");
        }
    }
    closed
}

pub fn hide_except(app: &AppHandle, keep: &[String]) {
    let ids: Vec<String> = registry().lock().keys().cloned().collect();
    for id in ids {
        if keep.iter().any(|k| k == &id) {
            continue;
        }
        let _ = set_visible(app, &id, false);
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
    eval_fire(app, id, "location.reload()")
}

pub fn go_back(app: &AppHandle, id: &str) -> Result<(), String> {
    eval_fire(app, id, "history.back()")
}

pub fn go_forward(app: &AppHandle, id: &str) -> Result<(), String> {
    eval_fire(app, id, "history.forward()")
}

pub fn set_muted(app: &AppHandle, id: &str, muted: bool) -> Result<(), String> {
    {
        let mut reg = registry().lock();
        if let Some(p) = reg.get_mut(id) {
            p.muted = muted;
        }
    }
    if muted {
        let _ = eval_fire(app, id, MUTE_JS);
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
            p.clip,
            p.zoom,
            p.holes.clone(),
            p.project_id.clone(),
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
        // The profile folder of a `workspace` portal hangs from this: dropping
        // it here logged the user out of the site every time they changed UA.
        project_id: snapshot.9,
        clip: snapshot.6.map(PortalRect::from),
        zoom: Some(snapshot.7),
        holes: Some(snapshot.8.into_iter().map(PortalRect::from).collect()),
    };
    let _ = close(&app, &id);
    open(app, opts).await?;
    Ok(())
}

pub fn screenshot(app: &AppHandle, id: &str) -> Result<String, String> {
    shot_png(app, id, None)
}

/// Padding around an element crop, in the page's own CSS pixels — enough
/// context that a lone button still shows what it sits on.
const GRAB_PAD: f64 = 8.0;

/// A crop of the page around one element — Modo Design's third artifact,
/// beside the selector and the styles: what the element *looks like*.
///
/// `rect` is the element's box as the page reported it (CSS pixels of the
/// page's own viewport, straight from `getBoundingClientRect`).
pub fn grab_shot(app: &AppHandle, id: &str, rect: PortalRect) -> Result<String, String> {
    shot_png(app, id, Some(rect))
}

fn shot_png(app: &AppHandle, id: &str, focus: Option<PortalRect>) -> Result<String, String> {
    let dest = paths::app_dir().join("portals").join("shots").join(format!(
        "{}_{}.png",
        paths::sanitize_id(id),
        now_stamp()
    ));
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
            let shot = snap_hwnd(hwnd)?;
            let full = [0, 0, shot.w, shot.h];
            write_png(&dest, full[2], full[3], &crop_rgb(&shot, full))?;
            Ok(dest.to_string_lossy().into_owned())
        }
        Backend::Webview { .. } => {
            let last = live.last;
            let zoom = live.zoom;
            drop(reg);
            let scale = app
                .get_webview_window("main")
                .and_then(|w| w.scale_factor().ok())
                .unwrap_or(1.0);
            // The host window's client area *is* the page, so cropping is pure
            // arithmetic on it. Without the handle (the rare race at open) the
            // main window stands in, with the card's rectangle as the offset.
            let (shot, dx, dy) = match host_of(id) {
                Some(h) => (snap_hwnd(h)?, 0.0, 0.0),
                None => (snap_hwnd(main_hwnd(app)?)?, last.x, last.y),
            };
            let crop = match focus {
                // The element's CSS pixels scale by the page zoom and then by
                // the monitor: a rect measured inside a page rendered at 0.8x
                // lands at 0.8 of the distance on screen.
                Some(r) => clamp_crop(
                    &shot,
                    (dx + (r.x - GRAB_PAD) * zoom) * scale,
                    (dy + (r.y - GRAB_PAD) * zoom) * scale,
                    (r.w + GRAB_PAD * 2.0) * zoom * scale,
                    (r.h + GRAB_PAD * 2.0) * zoom * scale,
                )?,
                None => clamp_crop(
                    &shot,
                    dx * scale,
                    dy * scale,
                    last.w * scale,
                    last.h * scale,
                )?,
            };
            write_png(&dest, crop[2], crop[3], &crop_rgb(&shot, crop))?;
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
        builder = builder.additional_browser_args(
            "--mute-audio --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        );
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
        let zoom = {
            let mut reg = registry().lock();
            match reg.get_mut(&id_nav) {
                Some(p) => {
                    p.url = url.clone();
                    p.zoom
                }
                None => 1.0,
            }
        };
        // WebView2 drops the zoom factor when the origin changes, and the
        // canvas would go on drawing a card that no longer matches the page
        // inside it.
        if (zoom - 1.0).abs() >= 0.005 {
            let _ = wv.set_zoom(zoom);
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

    capture_host(app, &label, &opts.id);
    Ok(Backend::Webview { label })
}

/// Reads the window wry parents the child webview onto and files it under the
/// portal id — the handle the clip region needs, which Tauri does not expose.
///
/// The closure runs on the main thread, so it can land before or after `open`
/// finishes: it re-places the portal at the end, which is what actually puts
/// the region on the window the first time.
#[cfg(windows)]
fn capture_host(app: &AppHandle, label: &str, id: &str) {
    let Some(wv) = app.get_webview(label) else {
        return;
    };
    let id = id.to_string();
    let handle = app.clone();
    let _ = wv.with_webview(move |platform| {
        // Out-parameter, and its type is webview2-com's `HWND` — inferred
        // rather than named so this file does not have to depend on the exact
        // `windows` release Tauri happens to be built against.
        let mut hwnd = Default::default();
        if unsafe { platform.controller().ParentWindow(&mut hwnd) }.is_err() {
            return;
        }
        let raw = hwnd.0 as isize;
        if raw == 0 {
            return;
        }
        hosts().lock().insert(id.clone(), raw);
        let wanted = {
            let reg = registry().lock();
            reg.get(&id).map(|p| live_place(p, p.visible))
        };
        if let Some(wanted) = wanted {
            let _ = place(&handle, &id, wanted);
        }
    });
}

#[cfg(not(windows))]
fn capture_host(_app: &AppHandle, _label: &str, _id: &str) {}

fn eval_webview(app: &AppHandle, label: &str, js: &str) -> Result<String, String> {
    let wv = app.get_webview(label).ok_or("portal: webview sumiu")?;
    let wrapped =
        format!("(function(){{ try {{ return ({js}); }} catch (e) {{ return String(e); }} }})()");
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
        let strip =
            (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
                as i32;
        SetWindowLongW(child_raw, GWL_STYLE, (style & !strip) | WS_CHILD as i32);
    }
}

#[cfg(not(windows))]
fn parent_hwnd(_app: &AppHandle, _child: isize) {}

/// What a portal may paint, in the host window's own physical pixels.
/// `None` = nothing to cut, the whole window paints.
fn region_for(
    app: &AppHandle,
    rect: Bounds,
    clip: Option<Bounds>,
    holes: &[Bounds],
) -> Option<RegionSpec> {
    let scale = app
        .get_webview_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    region_spec(rect, clip, holes, scale)
}

/// The geometry of `region_for`, with the screen's scale factor passed in.
fn region_spec(
    rect: Bounds,
    clip: Option<Bounds>,
    holes: &[Bounds],
    scale: f64,
) -> Option<RegionSpec> {
    let whole = clip.is_none_or(|c| c.holds(&rect));
    if whole && holes.is_empty() {
        return None;
    }
    let vis = clip.map_or(rect, |c| rect.intersect(&c));
    // Local to the window, and in the pixels Windows counts in.
    let local = |b: Bounds| {
        let px = |v: f64| (v * scale).round() as i32;
        [
            px(b.x - rect.x),
            px(b.y - rect.y),
            px(b.right() - rect.x),
            px(b.bottom() - rect.y),
        ]
    };
    let cut: Vec<[i32; 4]> = holes
        .iter()
        .map(|h| vis.intersect(h))
        .filter(|h| !h.is_empty())
        .map(local)
        .collect();
    if whole && cut.is_empty() {
        return None;
    }
    Some(RegionSpec {
        base: local(vis),
        holes: cut,
    })
}

/// Cuts the host window down to `region`, or gives it back whole.
///
/// A window region clips the window *and everything it hosts*, which is the
/// only lever that reaches inside WebView2: no z-index, no `overflow: hidden`
/// and no opacity in the DOM can touch a native surface stacked on top of it.
/// It also decides where the mouse lands, so what is cut out is not a picture
/// of the menu underneath — it is the menu, clickable.
#[cfg(windows)]
fn apply_region(hwnd: isize, region: Option<&RegionSpec>) {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
    };
    let raw = hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let Some(spec) = region else {
            SetWindowRgn(raw, std::ptr::null_mut(), 1);
            return;
        };
        let [l, t, r, b] = spec.base;
        let rgn = CreateRectRgn(l, t, r, b);
        if rgn.is_null() {
            return;
        }
        for hole in &spec.holes {
            let cut = CreateRectRgn(hole[0], hole[1], hole[2], hole[3]);
            if cut.is_null() {
                continue;
            }
            CombineRgn(rgn, rgn, cut, RGN_DIFF);
            DeleteObject(cut as _);
        }
        // Windows owns the region once it is accepted; on refusal it is ours
        // to free, and leaking one per frame of a pan is not an option.
        if SetWindowRgn(raw, rgn, 1) == 0 {
            DeleteObject(rgn as _);
        }
    }
}

#[cfg(not(windows))]
fn apply_region(_hwnd: isize, _region: Option<&RegionSpec>) {}

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
fn set_hwnd_bounds(
    _app: &AppHandle,
    _hwnd: isize,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
    _visible: bool,
) {
}

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
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            let _ = TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

/// One frame of a window, the way GDI hands it out: 24-bit BGR, bottom-up,
/// rows padded to a DWORD.
struct Shot {
    w: u32,
    h: u32,
    dib: Vec<u8>,
}

impl Shot {
    fn stride(&self) -> usize {
        ((self.w * 3).div_ceil(4) * 4) as usize
    }
}

#[cfg(windows)]
fn main_hwnd(app: &AppHandle) -> Result<isize, String> {
    app.get_webview_window("main")
        .ok_or("portal: janela principal sumiu")?
        .hwnd()
        .map(|h| h.0 as isize)
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn main_hwnd(_app: &AppHandle) -> Result<isize, String> {
    Err("portal: captura so no Windows".into())
}

#[cfg(windows)]
fn snap_hwnd(hwnd: isize) -> Result<Shot, String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        ReleaseDC, SelectObject, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;
    let raw = hwnd as HWND;
    unsafe {
        // The client rectangle, because `GetDC` is the *client* surface — on a
        // window that still has a frame the two disagree by its thickness.
        let mut rc = std::mem::zeroed();
        if GetClientRect(raw, &mut rc) == 0 {
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
        Ok(Shot {
            w: w as u32,
            h: h as u32,
            dib: pixels?,
        })
    }
}

#[cfg(not(windows))]
fn snap_hwnd(_hwnd: isize) -> Result<Shot, String> {
    Err("portal: captura so no Windows".into())
}

/// Clamps a fractional rectangle to the shot, in whole pixels: x, y, w, h
/// with the origin at the top-left. Anything thinner than a couple of pixels
/// after clamping is an element that is not on screen.
fn clamp_crop(shot: &Shot, x: f64, y: f64, w: f64, h: f64) -> Result<[u32; 4], String> {
    let x0 = (x.floor().max(0.0) as u32).min(shot.w);
    let y0 = (y.floor().max(0.0) as u32).min(shot.h);
    let x1 = (((x + w).ceil().max(0.0)) as u32).min(shot.w);
    let y1 = (((y + h).ceil().max(0.0)) as u32).min(shot.h);
    if x1 <= x0 + 1 || y1 <= y0 + 1 {
        return Err("portal: o elemento esta fora da area visivel do portal".into());
    }
    Ok([x0, y0, x1 - x0, y1 - y0])
}

/// Cuts `crop` out of the bottom-up BGR DIB and returns it top-down RGB —
/// the byte order a PNG wants.
fn crop_rgb(shot: &Shot, crop: [u32; 4]) -> Vec<u8> {
    let [cx, cy, cw, ch] = crop;
    let stride = shot.stride();
    let mut out = Vec::with_capacity((cw * ch * 3) as usize);
    for row in 0..ch {
        let src_y = (shot.h - 1 - (cy + row)) as usize;
        let base = src_y * stride + (cx * 3) as usize;
        for col in 0..cw as usize {
            let p = base + col * 3;
            out.extend_from_slice(&[shot.dib[p + 2], shot.dib[p + 1], shot.dib[p]]);
        }
    }
    out
}

fn write_png(path: &Path, w: u32, h: u32, rgb: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgb).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())
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
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("cdp: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or(&buf);
    if body.is_empty() {
        return Err("cdp: resposta vazia".into());
    }
    Ok(body.to_string())
}

fn cdp_call(
    port: u16,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // External browser portals are no longer constructed (`open` always uses
    // an embedded WebView2). Keep the old branch failure-explicit without
    // shipping a WebSocket stack that has no reachable caller.
    let _ = (port, method, params);
    Err("cdp: backend externo desativado".into())
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
    // The same decoder image paste uses (`clipboard.rs`) — there used to be two
    // copies of the same alphabet, and only one of them had a test.
    crate::clipboard::decode_base64(b64).map_err(|e| format!("portal: {e}"))
}

// ---------------------------------------------------------------------------
// live reload
// ---------------------------------------------------------------------------

/// How much of the answer feeds the fingerprint. A dev server's HTML is a
/// couple of kilobytes; nothing past this tells us anything new.
const PROBE_CAP: u64 = 512 * 1024;

/// A cheap "is this page still the same page?" for the portal's auto-reload.
///
/// Watching the project's files says an agent *wrote* something, not that the
/// server is serving it — a build takes seconds, and reloading in the middle
/// of one shows the user a half-written site. What actually answers the
/// question is the server: validators first (a rebuilt file changes `ETag` /
/// `Last-Modified` even when the bytes come out identical), the body as the
/// fallback for servers that send neither.
///
/// Nothing is remembered here: the caller compares two answers.
pub fn probe(url: &str) -> Result<String, String> {
    let url = normalize_url(url)?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(3000))
        .build();
    let resp = agent
        .get(&url)
        .set("Cache-Control", "no-cache")
        .set("Pragma", "no-cache")
        .call()
        .map_err(|e| format!("portal: sondagem falhou: {e}"))?;
    let etag = resp.header("etag").unwrap_or_default().to_string();
    let modified = resp.header("last-modified").unwrap_or_default().to_string();
    let mut body = Vec::new();
    resp.into_reader()
        .take(PROBE_CAP)
        .read_to_end(&mut body)
        .map_err(|e| format!("portal: sondagem falhou: {e}"))?;
    Ok(format!(
        "{etag}|{modified}|{}|{:x}",
        body.len(),
        fnv1a(&body)
    ))
}

/// FNV-1a. Not a hash for security — a hash for "these bytes changed".
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
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

/// Schemes a portal may point at.
///
/// It used to be "anything `Url::parse` accepts", which included `file:` — so
/// `yard portal create file:///C:/Users/<user>/.ssh/id_rsa` plus a
/// `yard portal text` was a disk read that walked straight around the fence
/// `explorer::resolve` puts on every other path crossing the IPC. A portal is
/// a browser card; the web is what it is for.
const SCHEMES: [&str; 2] = ["http", "https"];

fn check_scheme(u: Url) -> Result<String, String> {
    if SCHEMES.contains(&u.scheme()) {
        return Ok(u.to_string());
    }
    Err(format!(
        "portal: endereco \"{}:\" nao e suportado — um portal abre http/https (ou about:blank)",
        u.scheme()
    ))
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
        // `localhost:3000` parses as a URL whose *scheme* is `localhost` — it
        // is a bare host:port, not an address in another protocol, and it used
        // to come out of here unchanged (and unopenable). Anything else that
        // carries a scheme is judged by the allow-list.
        let host_porta = !s.contains("//")
            && !u.path().is_empty()
            && u.path().chars().all(|c| c.is_ascii_digit());
        if !host_porta {
            return check_scheme(u);
        }
    }
    let guess =
        if s.starts_with("localhost") || s.starts_with("127.0.0.1") || s.starts_with("[::1]") {
            format!("http://{s}")
        } else {
            format!("https://{s}")
        };
    Url::parse(&guess)
        .map_err(|e| format!("portal: url invalida: {e}"))
        .and_then(check_scheme)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: f64, y: f64, w: f64, h: f64) -> Bounds {
        Bounds { x, y, w, h }
    }

    #[test]
    fn inside_the_canvas_needs_no_region() {
        let card = b(100.0, 100.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 1000.0, 800.0);
        assert_eq!(region_spec(card, Some(canvas), &[], 1.0), None);
        // With no canvas at all there is nothing to clip either.
        assert_eq!(region_spec(card, None, &[], 1.0), None);
    }

    #[test]
    fn clips_what_runs_past_the_canvas_edge() {
        // The card starts before the canvas's left edge and runs past the right one.
        let card = b(-50.0, 20.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 300.0, 800.0);
        let spec = region_spec(card, Some(canvas), &[], 1.0).expect("regiao");
        // Card-local: 50px clipped on the left, right edge at 350.
        assert_eq!(spec.base, [50, 0, 350, 300]);
        assert!(spec.holes.is_empty());
    }

    #[test]
    fn scales_the_region_to_windows_pixels() {
        let card = b(0.0, 0.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 200.0, 800.0);
        let spec = region_spec(card, Some(canvas), &[], 1.5).expect("regiao");
        assert_eq!(spec.base, [0, 0, 300, 450]);
    }

    #[test]
    fn a_menu_on_top_becomes_a_hole_and_does_not_hide_the_page() {
        let card = b(100.0, 100.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 1000.0, 800.0);
        let menu = b(300.0, 150.0, 120.0, 90.0);
        let spec = region_spec(card, Some(canvas), &[menu], 1.0).expect("regiao");
        assert_eq!(spec.base, [0, 0, 400, 300]);
        assert_eq!(spec.holes, vec![[200, 50, 320, 140]]);
    }

    #[test]
    fn a_hole_far_from_the_card_stays_out_of_the_region() {
        let card = b(100.0, 100.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 1000.0, 800.0);
        let far = b(700.0, 700.0, 50.0, 50.0);
        assert_eq!(region_spec(card, Some(canvas), &[far], 1.0), None);
    }

    #[test]
    fn a_hole_is_trimmed_to_the_visible_piece() {
        // Half the menu falls outside the canvas; what is left is what gets cut.
        let card = b(0.0, 0.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 200.0, 300.0);
        let menu = b(150.0, 10.0, 100.0, 40.0);
        let spec = region_spec(card, Some(canvas), &[menu], 1.0).expect("regiao");
        assert_eq!(spec.base, [0, 0, 200, 300]);
        assert_eq!(spec.holes, vec![[150, 10, 200, 50]]);
    }

    #[test]
    fn outside_the_canvas_nothing_is_left_to_paint() {
        let card = b(900.0, 100.0, 400.0, 300.0);
        let canvas = b(0.0, 0.0, 800.0, 800.0);
        assert!(card.intersect(&canvas).is_empty());
    }

    fn sample_shot(w: u32, h: u32) -> Shot {
        // Every pixel (x, y) gets BGR = (x, y, x+y): a crop can be checked by
        // looking at a single byte.
        let stride = (((w * 3) + 3) / 4 * 4) as usize;
        let mut dib = vec![0u8; stride * h as usize];
        for y in 0..h {
            // Bottom-up DIB: row 0 of the buffer is the bottom one.
            let row = (h - 1 - y) as usize * stride;
            for x in 0..w as usize {
                dib[row + x * 3] = x as u8;
                dib[row + x * 3 + 1] = y as u8;
                dib[row + x * 3 + 2] = (x as u32 + y) as u8;
            }
        }
        Shot { w, h, dib }
    }

    #[test]
    fn the_crop_becomes_top_down_rgb() {
        let shot = sample_shot(5, 4);
        let rgb = crop_rgb(&shot, [1, 2, 2, 2]);
        assert_eq!(rgb.len(), 2 * 2 * 3);
        // First pixel of the crop: (x=1, y=2) -> R=x+y=3, G=y=2, B=x=1.
        assert_eq!(&rgb[0..3], &[3, 2, 1]);
        // Last: (x=2, y=3) -> R=5, G=3, B=2.
        assert_eq!(&rgb[9..12], &[5, 3, 2]);
    }

    #[test]
    fn the_crop_is_trimmed_to_fit_inside_the_capture() {
        let shot = sample_shot(100, 50);
        assert_eq!(
            clamp_crop(&shot, -10.0, -10.0, 40.0, 40.0).unwrap(),
            [0, 0, 30, 30]
        );
        assert_eq!(
            clamp_crop(&shot, 90.0, 40.0, 40.0, 40.0).unwrap(),
            [90, 40, 10, 10]
        );
        // Fractions grow outward: the whole element stays inside the crop.
        assert_eq!(
            clamp_crop(&shot, 10.4, 10.6, 20.2, 20.2).unwrap(),
            [10, 10, 21, 21]
        );
    }

    #[test]
    fn an_element_off_screen_does_not_become_a_crop() {
        let shot = sample_shot(100, 50);
        assert!(clamp_crop(&shot, 200.0, 10.0, 40.0, 40.0).is_err());
        assert!(clamp_crop(&shot, 10.0, -80.0, 40.0, 40.0).is_err());
    }

    /// A portal is a browser card. `file:` would turn the `portal create`
    /// verb into a disk reader without the fence every path crossing the
    /// IPC has to go through.
    #[test]
    fn a_portal_only_opens_http_https_and_about_blank() {
        assert!(normalize_url("https://example.com").is_ok());
        assert!(normalize_url("http://localhost:5173").is_ok());
        assert!(normalize_url("about:blank").is_ok());
        // Without a scheme it still becomes https/http, as before.
        assert_eq!(
            normalize_url("example.com").unwrap(),
            "https://example.com/"
        );
        assert!(normalize_url("localhost:3000")
            .unwrap()
            .starts_with("http://"));

        for refused in [
            "file:///C:/Users/alguem/.ssh/id_rsa",
            "file://server/share/x",
            "javascript:fetch('/')",
            "data:text/html,<h1>oi</h1>",
            "ftp://exemplo.com/arquivo",
        ] {
            assert!(
                normalize_url(refused).is_err(),
                "{refused} should be refused"
            );
        }
    }
}
