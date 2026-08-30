//! Yard — code-agent orchestrator for Windows.
//!
//! This file is the boundary: it registers the commands the UI can call and
//! builds the app. All real logic lives in the modules.

// Public so integration tests in `tests/` can exercise the engine without
// going through the UI.
pub mod agents;
pub mod bridge;
pub mod browsers;
pub mod clipboard;
pub mod encoding;
pub mod events;
pub mod explorer;
pub mod files;
pub mod fonts;
pub mod forge;
pub mod git;
pub mod globs;
pub mod media;
pub mod paths;
pub mod persistence;
pub mod portal;
pub mod power;
pub mod process_tree;
pub mod pty;
pub mod scm;
pub mod scores;
pub mod state;
pub mod usage;
pub mod webhook;
pub mod wsl;
pub mod pty_export;
pub mod scrollback_search;
pub mod tray;
pub mod support;
pub mod updater;
pub mod costs;
pub mod mcp;
pub mod ssh;
pub mod lsp;

mod logging;
mod resources;
mod watcher;
mod window_state;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, State};

use agents::resolver::AgentInfo;
use agents::sessions::{AgentSession, SessionUsage};
use browsers::BrowserInfo;
use persistence::workspace::{SaveResult, WorkspaceSnapshot};
use pty::{AttachResult, PtyDelta, PtyProbe, PtySnapshot, ShellOption, SpawnOptions};
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
fn resize_pty(
    state: State<'_, Arc<AppState>>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    pty::resize(&state, &id, rows, cols)
}

#[tauri::command]
fn attach_pty(state: State<'_, Arc<AppState>>, id: String) -> AttachResult {
    pty::attach(&state, &id)
}

/// Asks the console host to re-emit the current frame (see `pty::repaint`).
/// Blocking (there is a pause between the two sizes), so it goes to the
/// blocking pool.
#[tauri::command]
async fn repaint_pty(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Arc<AppState>>();
        pty::repaint(&state, &id)
    })
    .await
    .map_err(|e| format!("repaint interrompido: {e}"))?
}

#[tauri::command]
fn pty_probe(state: State<'_, Arc<AppState>>, id: String) -> PtyProbe {
    pty::probe(&state, &id)
}

#[tauri::command]
fn pty_read_since(
    state: State<'_, Arc<AppState>>,
    id: String,
    after: u64,
    max_bytes: usize,
) -> PtyDelta {
    pty::read_since(&state, &id, after, max_bytes)
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
    let mut failures = Vec::new();
    for id in ids {
        if let Err(e) = pty::suspend(&state, &id) {
            tracing::warn!(id = %id, error = %e, "falha ao suspender");
            failures.push(id);
        }
    }
    failures
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
fn get_pty_tree_info(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<events::PtyResource, String> {
    pty::tree_info(&state, &id)
}

/// Deletes the on-disk scrollback of a terminal that was removed for good.
#[tauri::command]
fn forget_pty(state: State<'_, Arc<AppState>>, id: String) {
    state.statuses.lock().remove(&id);
    pty::scrollback::Scrollback::delete_file(&id);
}

/// Saves a terminal's scrollback to `dest` (`pty_export.rs`); `plain` strips
/// the escapes. Up to 8 MB of disk in and out, so it goes to the blocking pool
/// like `repaint_pty`.
#[tauri::command]
async fn pty_export(app: AppHandle, id: String, dest: String, plain: bool) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Arc<AppState>>();
        pty_export::export(&state, &id, std::path::Path::new(&dest), plain)
    })
    .await
    .map_err(|e| format!("exportação interrompida: {e}"))?
}

/// Searches what the terminals said (`scrollback_search.rs`). Reads the live
/// ring of whoever is up and the `.bin` of whoever is not, so a closed pane
/// answers the same as an open one. Up to 8 MB per terminal off the disk, so
/// it goes to the blocking pool.
#[tauri::command]
async fn search_scrollback(
    app: AppHandle,
    ids: Vec<String>,
    query: String,
    per: usize,
    total: usize,
) -> Vec<scrollback_search::TerminalHits> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Arc<AppState>>();
        let dir = paths::app_dir();
        scrollback_search::search_with(&ids, &query, per, total, |id| {
            let handle = state.ptys.lock().get(id).cloned();
            match handle {
                Some(handle) => {
                    let scrollback = handle.lock().scrollback.clone();
                    pty_export::live_bytes(&scrollback)
                }
                None => scrollback_search::read_bin(&dir, id),
            }
        })
    })
    .await
    .unwrap_or_default()
}

/// Posts one notification to the address the user configured
/// (`webhook.rs`). Blocking pool: it is a network round trip.
#[tauri::command]
async fn webhook_post(url: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || webhook::post(&url, &body))
        .await
        .map_err(|e| e.to_string())?
}

/// The loopback door of the bridge and the session token, for the SSH launch
/// to carry across (`bridge.rs`, `src/lib/remoteBridge.ts`). `port` is null
/// while the listener has not come up (or could not).
#[tauri::command]
fn bridge_remote() -> serde_json::Value {
    serde_json::json!({
        "port": bridge::tcp_port(),
        "token": bridge::tcp_token(),
    })
}

#[tauri::command]
fn default_shell() -> String {
    pty::default_shell()
}

#[tauri::command]
fn list_shells() -> Vec<ShellOption> {
    pty::list_shells()
}

/// Whether an agent can be told to run inside WSL, and in which distro.
///
/// It spawns `wsl.exe`, so it goes to the blocking pool: on a machine where
/// the WSL service is cold this call takes seconds, and it must not stall a
/// runtime worker while the settings screen is opening.
#[tauri::command]
async fn wsl_status() -> wsl::WslStatus {
    tauri::async_runtime::spawn_blocking(wsl::status)
        .await
        .unwrap_or_default()
}

/// Whether an agent can be told to run on another machine over SSH, and
/// which aliases `~/.ssh/config` already names. A PATH lookup plus one file
/// read — cheap, but it keeps the same shape as `wsl_status` on purpose.
#[tauri::command]
async fn ssh_status() -> ssh::SshStatus {
    tauri::async_runtime::spawn_blocking(ssh::status)
        .await
        .unwrap_or_default()
}

/// First call reads every installed font file (the scan is cached after), so
/// it goes to the blocking pool instead of stalling a runtime worker.
#[tauri::command]
async fn list_fonts() -> Vec<fonts::FontFamilyInfo> {
    tauri::async_runtime::spawn_blocking(fonts::list)
        .await
        .unwrap_or_default()
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
async fn export_backup(app: AppHandle, dest: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // The lock is held for the whole export on purpose: the checkpoint
        // inside `export` only guarantees a complete `app.db` if no write
        // lands between it and the copy. An autosave waiting a few hundred
        // milliseconds is cheaper than a backup missing the last change.
        let state = app.state::<Arc<AppState>>();
        let conn = state.db.lock();
        persistence::backup::export(&conn, std::path::Path::new(&dest))
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Prepares a backup for the next boot. It does **not** replace the live
/// database — see `persistence::backup::import`.
#[tauri::command]
async fn import_backup(src: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        persistence::backup::import(std::path::Path::new(&src)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Is a restored backup waiting for the next boot? The UI keeps the warning
/// on screen while this is true, including after a reload of the webview.
#[tauri::command]
fn backup_pending() -> bool {
    persistence::backup::has_pending()
}

/// Discards the staged backup; the next boot keeps the current workspace.
#[tauri::command]
fn cancel_backup() -> Result<(), String> {
    persistence::backup::cancel_pending().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// notebook (markdown notes)
// ---------------------------------------------------------------------------

#[tauri::command]
fn notes_load(state: State<'_, Arc<AppState>>) -> Result<persistence::notes::NotesData, String> {
    let conn = state.db.lock();
    persistence::notes::load(&conn).map_err(|e| format!("não consegui carregar as anotações: {e}"))
}

#[tauri::command]
fn note_save(
    state: State<'_, Arc<AppState>>,
    note: persistence::notes::Note,
) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::notes::save_note(&conn, &note)
        .map_err(|e| format!("não consegui gravar a nota: {e}"))
}

#[tauri::command]
fn note_delete(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::notes::delete_note(&conn, &id)
        .map_err(|e| format!("não consegui excluir a nota: {e}"))
}

#[tauri::command]
fn notebook_save(
    state: State<'_, Arc<AppState>>,
    notebook: persistence::notes::Notebook,
) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::notes::save_notebook(&conn, &notebook)
        .map_err(|e| format!("não consegui gravar o caderno: {e}"))
}

#[tauri::command]
fn notebook_delete(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::notes::delete_notebook(&conn, &id)
        .map_err(|e| format!("não consegui excluir o caderno: {e}"))
}

#[tauri::command]
fn note_tag_save(
    state: State<'_, Arc<AppState>>,
    tag: persistence::notes::NoteTag,
) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::notes::save_tag(&conn, &tag)
        .map_err(|e| format!("não consegui gravar a etiqueta: {e}"))
}

#[tauri::command]
fn note_tag_delete(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::notes::delete_tag(&conn, &id)
        .map_err(|e| format!("não consegui excluir a etiqueta: {e}"))
}

/// Writes a note's markdown to a path the user picked in the save dialog.
/// Disk I/O, so it goes to the blocking pool like the other file commands.
#[tauri::command]
async fn note_export(dest: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&dest, text).map_err(|e| format!("não consegui exportar a nota: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keep-awake ("modo energético"): the *decision* — always / only with an
/// agent working / off — lives in the frontend; here is just the OS side.
#[tauri::command]
fn set_keep_awake(on: bool) {
    power::set_keep_awake(on);
}

/// Closes and reopens the app. The only way to adopt a restored backup
/// without asking the user to do it by hand.
#[tauri::command]
fn restart_app(app: AppHandle) {
    pty::kill_all(&app.state::<Arc<AppState>>());
    portal::close_all(&app);
    app.restart();
}

// ---------------------------------------------------------------------------
// Scores (saved arrangements)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn score_save(name: String, json: String, overwrite: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || scores::save(&name, &json, overwrite))
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
// File explorer (tree + editor)
// ---------------------------------------------------------------------------
//
// All of these take `root` (the project/floor root) and a path relative to it;
// the fence against escaping the root lives in the module (`explorer::resolve`).

#[tauri::command]
async fn fs_list_dir(root: String, path: String) -> Result<explorer::DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::list_dir(std::path::Path::new(&root), &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_read_text(
    root: String,
    path: String,
    // The encoding the reader picked, or `None` to let the file decide.
    encoding: Option<String>,
) -> Result<explorer::TextFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::read_text(std::path::Path::new(&root), &path, encoding.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_write_text(
    root: String,
    path: String,
    text: String,
    // What the editor last saw on disk (mtime + size). `None` = write anyway.
    expected: Option<explorer::Seen>,
    crlf: bool,
    // The file had a UTF-8 BOM when it was read — write it back.
    bom: bool,
    // The encoding it was opened with; the write uses the same one.
    encoding: Option<String>,
) -> Result<explorer::WriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::write_text(
            std::path::Path::new(&root),
            &path,
            &text,
            expected,
            crlf,
            bom,
            encoding.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_create_entry(root: String, path: String, dir: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::create_entry(std::path::Path::new(&root), &path, dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_rename_entry(root: String, path: String, new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::rename_entry(std::path::Path::new(&root), &path, &new_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_delete_entry(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::delete_entry(std::path::Path::new(&root), &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_search_text(
    state: State<'_, Arc<AppState>>,
    root: String,
    query: String,
    options: explorer::SearchOptions,
) -> Result<explorer::SearchOutcome, String> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut searches = state.search_stops.lock();
        if let Some(previous) = searches.insert(root.clone(), stop.clone()) {
            previous.store(true, Ordering::Release);
        }
    }
    let root_for_search = root.clone();
    let stop_for_search = stop.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        explorer::search_text_cancellable(
            std::path::Path::new(&root_for_search),
            &query,
            &options,
            || stop_for_search.load(Ordering::Acquire),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut searches = state.search_stops.lock();
    if searches
        .get(&root)
        .is_some_and(|current| Arc::ptr_eq(current, &stop))
    {
        searches.remove(&root);
    }
    result
}

/// Replaces across the project what `fs_search_text` would have found.
///
/// Blocking and uncancellable on purpose: this one *writes*, and a half-run
/// replace that stopped somewhere in the middle of the walk is a state nobody
/// can reason about afterwards. It is bounded instead, by the same skip list
/// and filters the search uses, and by a ceiling on the files it will rewrite.
#[tauri::command]
async fn fs_replace_text(
    root: String,
    query: String,
    replacement: String,
    options: explorer::SearchOptions,
) -> Result<explorer::ReplaceOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        explorer::replace_text(
            std::path::Path::new(&root),
            &query,
            &replacement,
            &options,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn fs_cancel_search(root: String, state: tauri::State<'_, Arc<AppState>>) {
    if let Some(stop) = state.search_stops.lock().remove(&root) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn fs_index_files(root: String) -> Result<explorer::FileIndex, String> {
    tauri::async_runtime::spawn_blocking(move || explorer::index_files(std::path::Path::new(&root)))
        .await
        .map_err(|e| e.to_string())?
}

// The editor's git gutter: what the open file looked like at HEAD.
#[tauri::command]
async fn git_head_text(root: String, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git::head_text(std::path::Path::new(&root), &path))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Floors (git worktree)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn worktree_provision(
    project_path: String,
    input: git::ProvisionInput,
) -> Result<git::WorktreeProvision, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_provision(std::path::Path::new(&project_path), &input)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_preflight(
    project_path: String,
    items: Vec<git::PreflightItem>,
) -> Result<git::Preflight, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_preflight(std::path::Path::new(&project_path), &items)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn branch_delete_if_unchanged(
    project_path: String,
    branch: String,
    expected_oid: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::branch_delete_if_unchanged(std::path::Path::new(&project_path), &branch, &expected_oid)
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
) -> Result<git::WorktreeRemoval, String> {
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
async fn worktree_preview(
    project_path: String,
    floor_branch: String,
    floor_path: Option<String>,
) -> Result<git::LandPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_preview(
            std::path::Path::new(&project_path),
            &floor_branch,
            floor_path.as_deref().map(std::path::Path::new),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_land(
    project_path: String,
    floor_branch: String,
    floor_path: Option<String>,
) -> Result<git::LandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::worktree_land(
            std::path::Path::new(&project_path),
            &floor_branch,
            floor_path.as_deref().map(std::path::Path::new),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}


// ---------------------------------------------------------------------------
// source control (the bench's "Controle" tab)
// ---------------------------------------------------------------------------
//
// Every one of these runs a `git` subprocess, so every one goes to the
// blocking pool: a `git push` over a slow link would otherwise hold a runtime
// worker for the length of the network round trip.

/// One door for the whole write half of git. The alternative was thirty
/// `#[tauri::command]`s that differ only in which `scm::` function they call,
/// each with its own two lines of `spawn_blocking` ceremony.
macro_rules! scm_commands {
    ($( $name:ident ( $( $arg:ident : $ty:ty ),* $(,)? ) -> $ret:ty = $body:expr; )+) => {
        $(
            #[tauri::command]
            async fn $name(cwd: String, $( $arg : $ty ),*) -> Result<$ret, String> {
                tauri::async_runtime::spawn_blocking(move || {
                    let cwd = std::path::Path::new(&cwd);
                    #[allow(clippy::redundant_closure_call)]
                    ($body)(cwd, $( $arg ),*)
                })
                .await
                .map_err(|e| e.to_string())?
            }
        )+
    };
}

scm_commands! {
    scm_info() -> scm::ScmInfo = |cwd: &std::path::Path| scm::info(cwd);
    scm_init() -> () = |cwd: &std::path::Path| scm::init_repo(cwd);

    scm_stage(paths: Vec<String>) -> () =
        |cwd: &std::path::Path, paths: Vec<String>| scm::stage(cwd, &paths);
    scm_stage_all() -> () = |cwd: &std::path::Path| scm::stage_all(cwd);
    scm_unstage(paths: Vec<String>) -> () =
        |cwd: &std::path::Path, paths: Vec<String>| scm::unstage(cwd, &paths);
    scm_unstage_all() -> () = |cwd: &std::path::Path| scm::unstage_all(cwd);
    scm_discard(paths: Vec<String>) -> () =
        |cwd: &std::path::Path, paths: Vec<String>| scm::discard(cwd, &paths);
    scm_discard_all(include_untracked: bool) -> () =
        |cwd: &std::path::Path, u: bool| scm::discard_all(cwd, u);

    scm_commit(message: String, opts: scm::CommitOpts) -> scm::CommitResult =
        |cwd: &std::path::Path, message: String, opts: scm::CommitOpts| {
            scm::commit(cwd, &message, opts)
        };
    scm_last_message() -> Option<String> = |cwd: &std::path::Path| scm::last_message(cwd);

    scm_log(query: scm::LogQuery) -> Vec<scm::CommitInfo> =
        |cwd: &std::path::Path, query: scm::LogQuery| scm::log(cwd, query);
    scm_commit_detail(hash: String) -> scm::CommitDetail =
        |cwd: &std::path::Path, hash: String| scm::commit_detail(cwd, &hash);
    scm_commit_file_diff(hash: String, path: String) -> git::FileDiff =
        |cwd: &std::path::Path, hash: String, path: String| {
            scm::commit_file_diff(cwd, &hash, &path)
        };

    scm_branches() -> Vec<scm::BranchInfo> = |cwd: &std::path::Path| scm::branches(cwd);
    scm_checkout(name: String) -> () =
        |cwd: &std::path::Path, name: String| scm::checkout(cwd, &name);
    scm_branch_create(name: String, start_point: Option<String>, switch: bool) -> () =
        |cwd: &std::path::Path, name: String, start: Option<String>, switch: bool| {
            scm::branch_create(cwd, &name, start.as_deref(), switch)
        };
    scm_branch_delete(name: String, force: bool) -> () =
        |cwd: &std::path::Path, name: String, force: bool| scm::branch_delete(cwd, &name, force);
    scm_branch_rename(from: String, to: String) -> () =
        |cwd: &std::path::Path, from: String, to: String| scm::branch_rename(cwd, &from, &to);

    scm_merge(name: String, no_ff: bool) -> scm::MergeResult =
        |cwd: &std::path::Path, name: String, no_ff: bool| scm::merge(cwd, &name, no_ff);
    scm_rebase(onto: String) -> scm::MergeResult =
        |cwd: &std::path::Path, onto: String| scm::rebase(cwd, &onto);
    scm_revert(hash: String) -> scm::MergeResult =
        |cwd: &std::path::Path, hash: String| scm::revert(cwd, &hash);
    scm_reset(rev: String, mode: String) -> () =
        |cwd: &std::path::Path, rev: String, mode: String| scm::reset(cwd, &rev, &mode);
    scm_resolve_conflict(paths: Vec<String>, side: String) -> () =
        |cwd: &std::path::Path, paths: Vec<String>, side: String| {
            scm::resolve_conflict(cwd, &paths, &side)
        };
    scm_abort() -> () = |cwd: &std::path::Path| scm::abort_state(cwd);
    scm_continue() -> () = |cwd: &std::path::Path| scm::continue_state(cwd);

    scm_stash_list() -> Vec<scm::StashEntry> = |cwd: &std::path::Path| scm::stash_list(cwd);
    scm_stash_push(message: Option<String>, include_untracked: bool, keep_index: bool) -> () =
        |cwd: &std::path::Path, message: Option<String>, u: bool, k: bool| {
            scm::stash_push(cwd, message.as_deref(), u, k)
        };
    scm_stash_apply(index: u32, pop: bool) -> () =
        |cwd: &std::path::Path, index: u32, pop: bool| scm::stash_apply(cwd, index, pop);
    scm_stash_drop(index: u32) -> () =
        |cwd: &std::path::Path, index: u32| scm::stash_drop(cwd, index);
    scm_stash_show(index: u32) -> String =
        |cwd: &std::path::Path, index: u32| scm::stash_show(cwd, index);

    scm_fetch(remote: Option<String>, prune: bool) -> () =
        |cwd: &std::path::Path, remote: Option<String>, prune: bool| {
            scm::fetch(cwd, remote.as_deref(), prune)
        };
    scm_pull(rebase: bool) -> () = |cwd: &std::path::Path, rebase: bool| scm::pull(cwd, rebase);
    scm_push(remote: String, branch: Option<String>, set_upstream: bool, force: bool) -> () =
        |cwd: &std::path::Path, remote: String, branch: Option<String>, up: bool, force: bool| {
            scm::push(cwd, &remote, branch.as_deref(), up, force)
        };
    scm_push_delete(remote: String, branch: String) -> () =
        |cwd: &std::path::Path, remote: String, branch: String| {
            scm::push_delete(cwd, &remote, &branch)
        };

    scm_tags() -> Vec<scm::TagInfo> = |cwd: &std::path::Path| scm::tags(cwd);
    scm_tag_create(name: String, message: Option<String>, target: Option<String>) -> () =
        |cwd: &std::path::Path, name: String, message: Option<String>, target: Option<String>| {
            scm::tag_create(cwd, &name, message.as_deref(), target.as_deref())
        };
    scm_tag_delete(name: String) -> () =
        |cwd: &std::path::Path, name: String| scm::tag_delete(cwd, &name);

    scm_diff(path: String, side: String, orig_path: Option<String>, context: Option<u32>)
        -> git::FileDiff =
        |cwd: &std::path::Path, path: String, side: String, orig: Option<String>, ctx: Option<u32>| {
            scm::diff(cwd, &path, &side, orig.as_deref(), ctx)
        };

    scm_apply_patch(patch: String, cached: bool, reverse: bool) -> () =
        |cwd: &std::path::Path, patch: String, cached: bool, reverse: bool| {
            scm::apply_patch(cwd, &patch, cached, reverse)
        };

    // The forge (`forge.rs`). Same shape as the git half, a subprocess in a
    // repository folder, so it rides the same macro and the same pool: `gh`
    // talks to the network, and every one of these can take a second.
    forge_status() -> forge::ForgeStatus =
        |cwd: &std::path::Path| Ok(forge::status(cwd));
    forge_pr(branch: String) -> Option<forge::PullRequest> =
        |cwd: &std::path::Path, branch: String| forge::pr_for(cwd, &branch);
    forge_pr_create(
        branch: String,
        title: String,
        body: String,
        base: Option<String>,
        draft: bool,
    ) -> String =
        |cwd: &std::path::Path,
         branch: String,
         title: String,
         body: String,
         base: Option<String>,
         draft: bool| {
            forge::pr_create(cwd, &branch, &title, &body, base.as_deref(), draft)
        };
    forge_pr_comments(number: u64) -> Vec<forge::ReviewNote> =
        |cwd: &std::path::Path, number: u64| forge::pr_comments(cwd, number);
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
// Portals (browser on the canvas)
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
async fn portal_open(
    app: AppHandle,
    opts: portal::PortalOpen,
) -> Result<portal::PortalInfo, String> {
    portal::open(app, opts).await
}

#[tauri::command]
fn portal_set_bounds(app: AppHandle, id: String, place: portal::PortalPlace) -> Result<(), String> {
    portal::place(&app, &id, place)
}

#[tauri::command]
fn portal_set_bounds_many(
    app: AppHandle,
    updates: Vec<portal::PortalBoundsUpdate>,
) -> Result<(), String> {
    portal::place_many(&app, updates)
}

#[tauri::command]
fn portal_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    portal::navigate(&app, &id, &url)
}

/// Async on purpose: the answer to an `eval` is delivered on the UI thread,
/// and a sync command waiting for it holds the very thread that would deliver
/// it — the whole app freezing until the timeout expires.
#[tauri::command]
async fn portal_eval(app: AppHandle, id: String, js: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || portal::eval_js(&app, &id, &js))
        .await
        .map_err(|e| format!("portal: eval falhou: {e}"))?
}

/// Fingerprint of what a URL is serving right now — the portal's auto-reload
/// compares two of these.
#[tauri::command]
async fn portal_probe(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || portal::probe(&url))
        .await
        .map_err(|e| format!("portal: sondagem falhou: {e}"))?
}

#[tauri::command]
fn portal_close(app: AppHandle, id: String) -> Result<(), String> {
    portal::close(&app, &id)
}

#[tauri::command]
fn portal_hide_except(app: AppHandle, keep: Vec<String>) {
    portal::hide_except(&app, &keep);
}

/// Closes engines with no card left anywhere in the workspace. See `portal::retain`.
#[tauri::command]
fn portal_retain(app: AppHandle, keep: Vec<String>) -> usize {
    portal::retain(&app, &keep)
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

/// A PNG crop of one element inside a portal — Modo Design's screenshot.
#[tauri::command]
fn portal_grab_shot(
    app: AppHandle,
    id: String,
    rect: portal::PortalRect,
) -> Result<String, String> {
    portal::grab_shot(&app, &id, rect)
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
        // `explorer.exe` opens some window anyway on a dead path, and the
        // spawn succeeds — without this, clicking "Reveal" on a folder that
        // had been renamed reported success and opened Documents.
        paths::must_exist(p)?;
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

/// Opens the file in the system's default program.
///
/// It is the viewer's way out for whatever the webview cannot draw: a `.docx`, a
/// `.zip`, an `.mkv` with a codec WebView2 will not play. The verb is Explorer's
/// own — `explorer.exe <path>` opens through the Windows association, without
/// going through a shell (and therefore with nothing to escape).
#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        paths::must_exist(std::path::Path::new(&path))?;
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
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

/// Bytes of a pasted image (base64) → a file in `%TEMP%`, returning the path.
/// It is what makes Ctrl+V of a screenshot work in a terminal: the PTY receives
/// the path, and the agent's CLI attaches the image (see `clipboard.rs`).
///
/// Runs in `spawn_blocking` because it writes to disk and cleans the folder —
/// a few MB and a `read_dir` have no business on the IPC thread.
#[tauri::command]
async fn clipboard_save_image(data: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || clipboard::save_image(&data))
        .await
        .map_err(|e| e.to_string())?
}

/// Frontend reply to a request from the `yard` CLI (see bridge.rs).
#[tauri::command]
fn bridge_respond(id: u64, body: serde_json::Value) -> bool {
    bridge::respond(id, body)
}

/// Latest snapshot of the agent usage limits (may be empty at boot).
#[tauri::command]
fn usage_snapshot() -> usage::UsageSnapshot {
    usage::snapshot()
}

/// Asks for an immediate collection cycle; the result arrives via `usage://update`.
#[tauri::command]
fn usage_refresh() {
    usage::request_refresh();
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // The relaunch the updater asks for once the installer ran.
        .plugin(tauri_plugin_process::init())
        // The project's images, video, audio and PDFs reach the screen through
        // here, not over the IPC: `<video>` asks for chunks as it plays
        // (media.rs). It has to be registered before the window exists.
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, media::serve)
        .manage(Arc::new(AppState::new(db)))
        .manage(LogGuard(guard))
        .setup(|app| {
            let handle = app.handle().clone();
            // Before anything else: the window has to be at its real size
            // *before* the frontend mounts, or the terminals that auto-start at
            // boot are born with the columns of a 1280 px window.
            window_state::restore(&handle);
            window_state::watch(&handle);
            resources::start(handle.clone());
            watcher::start(handle.clone());
            usage::start(handle.clone());
            tray::start(handle.clone());
            // Signed updates from GitHub Releases (updater.rs holds the config
            // lock). Desktop only, as the plugin's own docs register it.
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            bridge::start(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            attach_pty,
            repaint_pty,
            pty_probe,
            pty_read_since,
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
            wsl_status,
            list_fonts,
            save_workspace,
            load_workspace,
            read_prefs,
            write_pref,
            delete_pref,
            export_backup,
            import_backup,
            backup_pending,
            cancel_backup,
            restart_app,
            set_keep_awake,
            notes_load,
            note_save,
            note_delete,
            notebook_save,
            notebook_delete,
            note_tag_save,
            note_tag_delete,
            note_export,
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
            git_head_text,
            fs_list_dir,
            fs_read_text,
            fs_write_text,
            fs_create_entry,
            fs_rename_entry,
            fs_delete_entry,
            fs_search_text,
            fs_replace_text,
            fs_cancel_search,
            fs_index_files,
            scm_info,
            scm_init,
            scm_stage,
            scm_stage_all,
            scm_unstage,
            scm_unstage_all,
            scm_discard,
            scm_discard_all,
            scm_commit,
            scm_last_message,
            scm_log,
            scm_commit_detail,
            scm_commit_file_diff,
            scm_branches,
            scm_checkout,
            scm_branch_create,
            scm_branch_delete,
            scm_branch_rename,
            scm_merge,
            scm_rebase,
            scm_revert,
            scm_reset,
            scm_resolve_conflict,
            scm_abort,
            scm_continue,
            scm_stash_list,
            scm_stash_push,
            scm_stash_apply,
            scm_stash_drop,
            scm_stash_show,
            scm_fetch,
            scm_pull,
            scm_push,
            scm_push_delete,
            scm_tags,
            scm_tag_create,
            scm_tag_delete,
            scm_apply_patch,
            forge_status,
            forge_pr,
            forge_pr_create,
            forge_pr_comments,
            scm_diff,
            worktree_provision,
            worktree_preflight,
            branch_delete_if_unchanged,
            worktree_list,
            worktree_dirty,
            worktree_remove,
            worktree_preview,
            worktree_land,
            floor_run_hook,
            list_browsers,
            portal_open,
            portal_set_bounds,
            portal_set_bounds_many,
            portal_navigate,
            portal_eval,
            portal_probe,
            portal_close,
            portal_hide_except,
            portal_retain,
            portal_info,
            portal_reload,
            portal_back,
            portal_forward,
            portal_set_muted,
            portal_set_ua,
            portal_screenshot,
            portal_grab_shot,
            app_paths,
            reveal_path,
            open_external,
            is_directory,
            clipboard_save_image,
            bridge_respond,
            usage_snapshot,
            usage_refresh,
            ui_log,
            pty_export,
            search_scrollback,
            bridge_remote,
            webhook_post,
            tray::tray_set_status,
            tray::window_summon,
            support::support_bundle,
            persistence::autobackup::backup_auto_run,
            costs::usage_history,
            agents::read::session_events,
            mcp::mcp_list,
            mcp::mcp_save,
            mcp::mcp_delete,
            mcp::mcp_env_values,
            ssh_status,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_detect,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao construir o Yard")
        .run(|app, event| {
            // Last line of defense against orphans. Job Objects already cover
            // the crash case; this covers a clean exit.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                window_state::flush_now(app);
                let state = app.state::<Arc<AppState>>();
                pty::kill_all(&state);
                // Language servers are children like the PTYs: none may outlive
                // the window (lsp.rs).
                lsp::stop_all();
                portal::close_all(app);
            }
        });
}
