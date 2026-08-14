//! Yard — code-agent orchestrator for Windows.
//!
//! This file is the boundary: it registers the commands the UI can call and
//! builds the app. All real logic lives in the modules.

// Public so integration tests in `tests/` can exercise the engine without
// going through the UI.
pub mod agents;
pub mod bridge;
pub mod browsers;
pub mod events;
pub mod files;
pub mod git;
pub mod paths;
pub mod persistence;
pub mod portal;
pub mod process_tree;
pub mod pty;
pub mod scores;
pub mod state;

mod logging;
mod resources;
mod watcher;

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, State};

use agents::resolver::AgentInfo;
use browsers::BrowserInfo;
use agents::sessions::{AgentSession, SessionUsage};
use persistence::workspace::{SaveResult, WorkspaceSnapshot};
use pty::{AttachResult, PtySnapshot, ShellOption, SpawnOptions};
use state::AppState;

/// Keeps the non-blocking log writer alive for the lifetime of the app.
struct LogGuard(#[allow(dead_code)] Option<tracing_appender::non_blocking::WorkerGuard>);

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

/// Blocking on purpose (the RAM gate waits up to 45 s), so it goes to the
/// blocking pool instead of holding a runtime worker.
#[tauri::command]
async fn spawn_pty(app: AppHandle, opts: SpawnOptions) -> Result<PtySnapshot, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<Arc<AppState>>();
        pty::spawn(pty::emit::tauri_sink(&app2), &state, opts)
    })
    .await
    .map_err(|e| format!("spawn interrompido: {e}"))?
}

#[tauri::command]
fn write_pty(state: State<'_, Arc<AppState>>, id: String, data: String) -> Result<(), String> {
    pty::write(&state, &id, &data)
}

#[tauri::command]
fn resize_pty(state: State<'_, Arc<AppState>>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    pty::resize(&state, &id, rows, cols)
}

#[tauri::command]
fn attach_pty(state: State<'_, Arc<AppState>>, id: String) -> AttachResult {
    pty::attach(&state, &id)
}

#[tauri::command]
fn pty_exists(state: State<'_, Arc<AppState>>, id: String) -> bool {
    pty::exists(&state, &id)
}

#[tauri::command]
fn list_ptys(state: State<'_, Arc<AppState>>) -> Vec<PtySnapshot> {
    pty::list(&state)
}

#[tauri::command]
fn kill_pty(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    pty::kill(&state, &id)
}

#[tauri::command]
fn suspend_pty(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    pty::suspend(&state, &id)
}

/// Suspends several at once — the RAM valve from §5.6.
#[tauri::command]
fn suspend_group(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Vec<String> {
    let mut falhas = Vec::new();
    for id in ids {
        if let Err(e) = pty::suspend(&state, &id) {
            tracing::warn!(id = %id, error = %e, "falha ao suspender");
            falhas.push(id);
        }
    }
    falhas
}

#[tauri::command]
async fn restart_pty(app: AppHandle, id: String) -> Result<PtySnapshot, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<Arc<AppState>>();
        pty::restart(pty::emit::tauri_sink(&app2), &state, &id)
    })
    .await
    .map_err(|e| format!("restart interrompido: {e}"))?
}

#[tauri::command]
fn clear_pty(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    pty::clear_scrollback(&state, &id)
}

/// The UI reports when a panel leaves/enters the screen (§5.3).
#[tauri::command]
fn set_pty_visible(state: State<'_, Arc<AppState>>, id: String, visible: bool) {
    pty::set_visible(&state, &id, visible);
}

#[tauri::command]
fn get_pty_tree_info(state: State<'_, Arc<AppState>>, id: String) -> Result<events::PtyResource, String> {
    pty::tree_info(&state, &id)
}

/// Deletes the on-disk scrollback of a terminal that was removed for good.
#[tauri::command]
fn forget_pty(state: State<'_, Arc<AppState>>, id: String) {
    state.statuses.lock().remove(&id);
    pty::scrollback::Scrollback::delete_file(&id);
}

#[tauri::command]
fn default_shell() -> String {
    pty::default_shell()
}

#[tauri::command]
fn list_shells() -> Vec<ShellOption> {
    pty::list_shells()
}

// ---------------------------------------------------------------------------
// Workspace / preferences
// ---------------------------------------------------------------------------

#[tauri::command]
fn save_workspace(
    state: State<'_, Arc<AppState>>,
    snapshot: WorkspaceSnapshot,
) -> Result<SaveResult, String> {
    let mut conn = state.db.lock();
    persistence::workspace::save(&mut conn, &snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_workspace(state: State<'_, Arc<AppState>>) -> Result<WorkspaceSnapshot, String> {
    let conn = state.db.lock();
    persistence::workspace::load(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_prefs(state: State<'_, Arc<AppState>>) -> Result<HashMap<String, String>, String> {
    let conn = state.db.lock();
    persistence::db::kv_all(&conn)
        .map(|rows| rows.into_iter().collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_pref(state: State<'_, Arc<AppState>>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::db::kv_set(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_pref(state: State<'_, Arc<AppState>>, key: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::db::kv_delete(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_backup(dest: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        persistence::backup::export(std::path::Path::new(&dest))
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_backup(src: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        persistence::backup::import(std::path::Path::new(&src)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Scores (saved arrangements)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn score_save(name: String, json: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || scores::save(&name, &json))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn score_list() -> Result<Vec<scores::ScoreMeta>, String> {
    tauri::async_runtime::spawn_blocking(scores::list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn score_read(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || scores::read(&name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn score_delete(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || scores::delete(&name))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/// `refresh = false` uses the cache; detection runs `--version` of each CLI.
#[tauri::command]
async fn detect_agents(app: AppHandle, refresh: bool) -> Vec<AgentInfo> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<Arc<AppState>>();
        if !refresh {
            if let Some(cached) = state.agents_cache.lock().clone() {
                return cached;
            }
        }
        let found = agents::resolver::detect_all();
        *state.agents_cache.lock() = Some(found.clone());
        found
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn list_agent_sessions(agent: String, project_path: String) -> Vec<AgentSession> {
    tauri::async_runtime::spawn_blocking(move || agents::sessions::list(&agent, &project_path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn get_session_usage(file: String) -> SessionUsage {
    tauri::async_runtime::spawn_blocking(move || agents::sessions::usage(&file))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn agent_resume_args(agent: String, session_id: String) -> Option<Vec<String>> {
    agents::resolver::resume_args(&agent, &session_id)
}

/// Starts the live tail on a `.jsonl` session. Calling again with the same
/// `tail_id` switches the followed file (the previous tail is shut down).
#[tauri::command]
fn session_tail_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tail_id: String,
    file: String,
) {
    let stop = agents::tail::start(app, tail_id.clone(), file);
    if let Some(old) = state.session_tails.lock().insert(tail_id, stop) {
        old.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
fn session_tail_stop(state: State<'_, Arc<AppState>>, tail_id: String) {
    if let Some(stop) = state.session_tails.lock().remove(&tail_id) {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Project files (live feed + change review)
// ---------------------------------------------------------------------------

/// Starts watching a project root. Calling again with the same id
/// replaces the watcher (the old one is dropped when it leaves the registry).
#[tauri::command]
fn watch_project(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    project_id: String,
    root: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(&root);
    {
        // Already watching the same folder? Nothing to do.
        let watchers = state.file_watchers.lock();
        if watchers.get(&project_id).is_some_and(|w| w.root == path) {
            return Ok(());
        }
    }
    let handle = files::watch(app, project_id.clone(), path)?;
    state.file_watchers.lock().insert(project_id, handle);
    Ok(())
}

#[tauri::command]
fn unwatch_project(state: State<'_, Arc<AppState>>, project_id: String) {
    state.file_watchers.lock().remove(&project_id);
}

#[tauri::command]
async fn git_changes(cwd: String) -> Result<git::ChangesSummary, String> {
    tauri::async_runtime::spawn_blocking(move || git::changes(std::path::Path::new(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_file_diff(
    cwd: String,
    path: String,
    untracked: bool,
    orig_path: Option<String>,
    context: Option<u32>,
) -> Result<git::FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::file_diff(
            std::path::Path::new(&cwd),
            &path,
            untracked,
            orig_path.as_deref(),
            context,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Floors (git worktree)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn worktree_provision(
    project_path: String,
    name: String,
    branch: Option<String>,
    existing_branch: bool,
    no_git: bool,
) -> Result<git::WorktreeProvision, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_provision(
            std::path::Path::new(&project_path),
            &name,
            branch.as_deref(),
            existing_branch,
            no_git,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_list(project_path: String) -> Result<Vec<git::WorktreeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_list(std::path::Path::new(&project_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_dirty(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || git::worktree_dirty(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_remove(
    project_path: String,
    path: String,
    delete_branch: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_remove(
            std::path::Path::new(&project_path),
            std::path::Path::new(&path),
            delete_branch.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn floor_run_hook(
    cwd: String,
    command: String,
    env: Vec<(String, String)>,
) -> Result<git::HookResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::run_floor_hook(std::path::Path::new(&cwd), &command, &env)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Portals (navegador no canvas)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_browsers(app: AppHandle, refresh: bool) -> Vec<BrowserInfo> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<Arc<AppState>>();
        portal::list_browsers(refresh, &state.browsers_cache)
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn portal_open(app: AppHandle, opts: portal::PortalOpen) -> Result<portal::PortalInfo, String> {
    portal::open(app, opts).await
}

#[tauri::command]
fn portal_set_bounds(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    portal::set_bounds(&app, &id, x, y, w, h, visible)
}

#[tauri::command]
fn portal_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    portal::navigate(&app, &id, &url)
}

#[tauri::command]
fn portal_eval(app: AppHandle, id: String, js: String) -> Result<String, String> {
    portal::eval_js(&app, &id, &js)
}

#[tauri::command]
fn portal_close(app: AppHandle, id: String) -> Result<(), String> {
    portal::close(&app, &id)
}

#[tauri::command]
fn portal_hide_except(app: AppHandle, keep: Vec<String>) {
    portal::hide_except(&app, &keep);
}

#[tauri::command]
fn portal_info(id: String) -> Result<portal::PortalInfo, String> {
    portal::info(&id)
}

#[tauri::command]
fn portal_reload(app: AppHandle, id: String) -> Result<(), String> {
    portal::reload(&app, &id)
}

#[tauri::command]
fn portal_back(app: AppHandle, id: String) -> Result<(), String> {
    portal::go_back(&app, &id)
}

#[tauri::command]
fn portal_forward(app: AppHandle, id: String) -> Result<(), String> {
    portal::go_forward(&app, &id)
}

#[tauri::command]
fn portal_set_muted(app: AppHandle, id: String, muted: bool) -> Result<(), String> {
    portal::set_muted(&app, &id, muted)
}

#[tauri::command]
async fn portal_set_ua(app: AppHandle, id: String, ua: Option<String>) -> Result<(), String> {
    portal::set_ua(app, id, ua).await
}

#[tauri::command]
fn portal_screenshot(app: AppHandle, id: String) -> Result<String, String> {
    portal::screenshot(&app, &id)
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    app_dir: String,
    db_path: String,
    logs_dir: String,
    backups_dir: String,
}

#[tauri::command]
fn app_paths() -> AppPaths {
    AppPaths {
        app_dir: paths::app_dir().to_string_lossy().into_owned(),
        db_path: paths::db_path().to_string_lossy().into_owned(),
        logs_dir: paths::logs_dir().to_string_lossy().into_owned(),
        backups_dir: paths::backups_dir().to_string_lossy().into_owned(),
    }
}

/// Opens Explorer on the folder (or selects the file).
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let p = std::path::Path::new(&path);
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.is_file() {
            cmd.arg("/select,").arg(&path);
        } else {
            cmd.arg(&path);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        // explorer.exe returns a non-zero exit code even when it opens; only
        // a spawn failure matters here.
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("disponivel apenas no Windows".into())
    }
}

/// Checks that a path exists and is a directory — used when adding a project.
#[tauri::command]
fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Frontend reply to a request from the `yard` CLI (see bridge.rs).
#[tauri::command]
fn bridge_respond(id: u64, body: serde_json::Value) -> bool {
    bridge::respond(id, body)
}

/// UI log channel into the app's log file.
///
/// In a packaged app there is no console: if React breaks at boot, the window
/// stays white and nothing is left behind. With this, a frontend error becomes
/// a line in `yard.log` like any other.
#[tauri::command]
fn ui_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "ui", "{message}"),
        "warn" => tracing::warn!(target: "ui", "{message}"),
        "debug" => tracing::debug!(target: "ui", "{message}"),
        _ => tracing::info!(target: "ui", "{message}"),
    }
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let guard = logging::init();

    let db = match persistence::db::open() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "nao consegui abrir o banco");
            // With no usable disk the app still runs: in-memory SQLite.
            rusqlite::Connection::open_in_memory().expect("sqlite em memoria")
        }
    };

    let mut builder = tauri::Builder::default();

    // Two instances writing the same `app.db` and the same `.bin` = guaranteed
    // corruption (§9.11). Registered before any other plugin.
    //
    // The lock is global per app identifier, but what it actually protects is
    // the *data directory*. Anyone pointing `YARD_DATA_DIR` at their own
    // place shares no state with anyone — and in that case blocking the
    // second instance only gets in the way (dev build next to the installed
    // one, two checkouts, a manual test).
    #[cfg(desktop)]
    if std::env::var_os("YARD_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    } else {
        tracing::warn!("YARD_DATA_DIR definido: instancia unica desativada");
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(AppState::new(db)))
        .manage(LogGuard(guard))
        .setup(|app| {
            let handle = app.handle().clone();
            resources::start(handle.clone());
            watcher::start(handle.clone());
            bridge::start(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            attach_pty,
            pty_exists,
            list_ptys,
            kill_pty,
            suspend_pty,
            suspend_group,
            restart_pty,
            clear_pty,
            set_pty_visible,
            get_pty_tree_info,
            forget_pty,
            default_shell,
            list_shells,
            save_workspace,
            load_workspace,
            read_prefs,
            write_pref,
            delete_pref,
            export_backup,
            import_backup,
            score_save,
            score_list,
            score_read,
            score_delete,
            detect_agents,
            list_agent_sessions,
            get_session_usage,
            agent_resume_args,
            session_tail_start,
            session_tail_stop,
            watch_project,
            unwatch_project,
            git_changes,
            git_file_diff,
            worktree_provision,
            worktree_list,
            worktree_dirty,
            worktree_remove,
            floor_run_hook,
            list_browsers,
            portal_open,
            portal_set_bounds,
            portal_navigate,
            portal_eval,
            portal_close,
            portal_hide_except,
            portal_info,
            portal_reload,
            portal_back,
            portal_forward,
            portal_set_muted,
            portal_set_ua,
            portal_screenshot,
            app_paths,
            reveal_path,
            is_directory,
            bridge_respond,
            ui_log,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao construir o Yard")
        .run(|app, event| {
            // Last line of defense against orphans. Job Objects already cover
            // the crash case; this covers a clean exit.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                let state = app.state::<Arc<AppState>>();
                pty::kill_all(&state);
                portal::close_all(app);
            }
        });
}
