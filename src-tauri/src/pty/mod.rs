//! PTY engine (§5). Public API: spawn, write, resize, attach, kill,
//! suspend, restart.
//!
//! Lifecycle of a terminal:
//!
//! ```text
//! spawn ──> [RAM gate] ──> openpty ──> spawn_command ──> drop(slave)
//!                                              │
//!                    ┌─────────── Job Object ──┤
//!                    │                         ├── reader  (reads, stitches UTF-8)
//!                    │                         ├── pump    (coalesce, flush, heartbeat)
//!                    │                         └── watcher (child.wait -> exit)
//!                    └── kill/suspend/restart: TerminateJobObject (entire tree)
//! ```

pub mod emit;
pub mod job;
pub mod reader;
pub mod scrollback;
pub mod teardown;

#[cfg(test)]
mod engine_tests;

use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::events;
use crate::state::AppState;
use emit::PtyEvents;
use job::JobHandle;
use reader::PtyShared;
use scrollback::Scrollback;
use teardown::{ExitReason, PtyStatus};

/// Free RAM required before booting an agent (§5.4).
const SPAWN_MIN_FREE_MB: f32 = 400.0;
/// How long to wait for that RAM before going ahead anyway.
const SPAWN_WAIT_MAX: Duration = Duration::from_secs(45);
/// Pause between the two sizes of a `repaint`, so the host sees two events.
const REPAINT_GAP: Duration = Duration::from_millis(40);

// "intent" codes: whoever requested the kill writes here *beforehand*, so the
// watcher can report the right reason instead of calling everything a normal exit.
const INTENT_NONE: u8 = 0;
const INTENT_KILLED: u8 = 1;
const INTENT_SUSPENDED: u8 = 2;
const INTENT_RESTARTED: u8 = 3;

struct SpawnReservation<'a> {
    state: &'a AppState,
    id: String,
}

impl<'a> SpawnReservation<'a> {
    fn claim(state: &'a AppState, id: &str) -> Result<Self, String> {
        let mut spawning = state.spawning_ptys.lock();
        if state.ptys.lock().contains_key(id) || !spawning.insert(id.to_string()) {
            return Err(format!("pty '{id}' ja esta rodando"));
        }
        Ok(Self {
            state,
            id: id.to_string(),
        })
    }
}

impl Drop for SpawnReservation<'_> {
    fn drop(&mut self) {
        self.state.spawning_ptys.lock().remove(&self.id);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    /// `shell` (default) or `agent` — `agent` turns on the idle detector (§5.7).
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// Preserves the previous scrollback for this id (used on restart/resume).
    #[serde(default)]
    pub keep_scrollback: bool,
}

fn default_kind() -> String {
    "shell".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyMeta {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub kind: String,
    pub title: String,
    pub env: Vec<(String, String)>,
}

pub struct PtyHandle {
    pub meta: PtyMeta,
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub pid: Option<u32>,
    job: Option<JobHandle>,
    pub scrollback: Arc<Mutex<Scrollback>>,
    pub shared: Arc<PtyShared>,
    intent: Arc<AtomicU8>,
    pub started_at: i64,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySnapshot {
    pub id: String,
    pub pid: Option<u32>,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub kind: String,
    pub title: String,
    pub started_at: i64,
    pub rows: u16,
    pub cols: u16,
    pub scrollback_bytes: usize,
}

/// Response of `attach_pty`. Richer than the blueprint's `Option<String>`
/// because the UI needs to distinguish three cases: alive, dead-with-history,
/// and never-existed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub alive: bool,
    pub data: String,
    pub exit: Option<ExitInfo>,
    pub pid: Option<u32>,
    /// Size the live PTY is on right now (`0` when there is no process). The
    /// UI seeds its "last size sent" with this, so a reload does not push a
    /// redundant reflow at a CLI that is mid-frame.
    pub rows: u16,
    pub cols: u16,
    /// The application is painting on the alternate screen, so `data` is a log
    /// of incremental redraws and **not** a screen the UI can repaint (see
    /// `reader::scan_screen_mode`). The UI asks for a `repaint` instead.
    pub alt_screen: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyProbe {
    pub alive: bool,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDelta {
    pub alive: bool,
    pub data: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub reason: String,
    pub at: i64,
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

pub fn spawn(
    sink: Arc<dyn PtyEvents>,
    state: &Arc<AppState>,
    opts: SpawnOptions,
) -> Result<PtySnapshot, String> {
    let _reservation = SpawnReservation::claim(state, &opts.id)?;

    let is_agent = opts.kind == "agent";
    if is_agent {
        wait_for_memory(state);
    }

    // npm `.cmd`/`.ps1` shims are not executables for CreateProcess —
    // the resolver rewrites that as `cmd.exe /c ...` (§9.3).
    let (program, args) = crate::agents::resolver::resolve_launch(&opts.program, &opts.args);

    let cwd = if std::path::Path::new(&opts.cwd).is_dir() {
        opts.cwd.clone()
    } else {
        tracing::warn!(cwd = %opts.cwd, "cwd inexistente, caindo para o home");
        crate::paths::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string())
    };

    // The clamped pair is what ConPTY actually gets, so it is also what the
    // handle records: keeping `opts` here would make the next `resize` to the
    // clamped value look like "no change" and get skipped.
    let rows = opts.rows.max(2);
    let cols = opts.cols.max(10);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty falhou: {e}"))?;

    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Yard");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env("YARD", "1");
    cmd.env("YARD_PTY_ID", &opts.id);
    // Agent<->app bridge: the `yard` CLI is prepended to every terminal's PATH
    // and the pipe/id go into the environment. Preserves the original spelling
    // of the PATH key — on Windows a duplicated "PATH"/"Path" pair has undefined
    // resolution.
    {
        let bin = crate::bridge::bin_dir();
        cmd.env("YARD_PIPE", crate::bridge::pipe_name());
        cmd.env(
            "YARD_CLI",
            crate::bridge::cli_path().to_string_lossy().as_ref(),
        );
        // Claude Code finds the bridge via the skill in `~/.claude/skills`. The
        // other agents (codex, opencode, gemini) do not have that mechanism:
        // they get the manual path in the environment and `yard help` covers the
        // rest. Applies to every agent terminal — for claude it is just a
        // redundant pointer, it does not get in the way.
        if is_agent {
            cmd.env(
                "YARD_BRIDGE_HELP",
                crate::bridge::help_path().to_string_lossy().as_ref(),
            );
        }
        let (key, value) = std::env::vars()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .unwrap_or_else(|| ("PATH".into(), String::new()));
        cmd.env(key, format!("{};{}", bin.display(), value));
    }
    // Color is this terminal's decision, not that of whoever launched the app.
    // A Yard opened from inside another terminal/agent (some terminal hosts
    // export NO_COLOR=1; CI scripts export FORCE_COLOR=0) would inherit those vetoes and every
    // spawned CLI — claude, codex, git — would fall back to monochrome output.
    for k in ["NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE"] {
        cmd.env_remove(k);
    }
    // A Yard terminal is a first-class terminal. If Yard itself was launched
    // from inside a Claude Code session (dev via `tauri dev`, for example),
    // the inherited markers would make the nested claude think it is a
    // "child session" and turn off transcript recording — meaning no session
    // to resume later.
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(&k);
        }
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("nao consegui iniciar '{program}': {e}"))?;

    // Essential: without dropping the slave, EOF never reaches the reader when
    // the process dies — the terminal stays "alive" forever.
    drop(pair.slave);

    // WARNING (ConPTY): right at handshake conhost emits `ESC[6n` (DSR-CPR)
    // and **does not forward the application's output until it gets the reply**.
    // The emulator on the other side answers — xterm.js does this on its own.
    // Meaning: this engine depends on a real terminal being connected.
    // If something here ever runs headless (§F7, Rust emulator), whoever
    // consumes the PTY must reply `ESC[<row>;<col>R`, otherwise the
    // process hangs in silence — no error, no output, just stuck.

    let pid = child.process_id();
    let killer = child.clone_killer();

    // Job Object right after spawn, before the process has time to create
    // grandchildren that would escape the association.
    let job = pid.and_then(|p| {
        let j = JobHandle::create_and_assign(p);
        if j.is_none() {
            tracing::warn!(
                pid = p,
                "Job Object indisponivel; kill usara a arvore de processos"
            );
        }
        j
    });

    let reader_stream = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let scrollback = Arc::new(Mutex::new(if opts.keep_scrollback {
        Scrollback::open(&opts.id)
    } else {
        Scrollback::fresh(&opts.id)
    }));
    let shared = PtyShared::new(is_agent);
    let intent = Arc::new(AtomicU8::new(INTENT_NONE));

    let title = if opts.title.is_empty() {
        opts.program.clone()
    } else {
        opts.title.clone()
    };

    let handle = PtyHandle {
        meta: PtyMeta {
            program: opts.program.clone(),
            args: opts.args.clone(),
            cwd: cwd.clone(),
            kind: opts.kind.clone(),
            title: title.clone(),
            env: opts.env.clone(),
        },
        master: pair.master,
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        pid,
        job,
        scrollback: scrollback.clone(),
        shared: shared.clone(),
        intent: intent.clone(),
        started_at: reader::now_ms(),
        rows,
        cols,
    };
    let snap = snapshot_of(&opts.id, &handle);

    // The registry comes **before** the threads. A command that dies in
    // milliseconds (`echo`, or a binary that does not exist) would make the
    // watcher call `finish` before this insert: `remove` would find nothing,
    // the final flush would not happen, and right after that the handle of a
    // dead process would be inserted — a zombie in the registry forever.
    state
        .ptys
        .lock()
        .insert(opts.id.clone(), Arc::new(Mutex::new(handle)));
    state
        .statuses
        .lock()
        .insert(opts.id.clone(), PtyStatus::Running);

    reader::spawn_reader(reader_stream, shared.clone(), scrollback.clone());
    reader::spawn_pump(
        sink.clone(),
        opts.id.clone(),
        title.clone(),
        shared.clone(),
        scrollback.clone(),
    );

    // Exit watcher: waits for the process, decides the reason, clears the registry.
    {
        let sink = sink.clone();
        let state = state.clone();
        let id = opts.id.clone();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => Some(status.exit_code() as i32),
                Err(e) => {
                    tracing::warn!(id = %id, error = %e, "child.wait falhou");
                    None
                }
            };
            finish(&sink, &state, &id, code, &shared, &intent);
        });
    }

    // Size goes into the line on purpose: an agent CLI paints its banner once,
    // at whatever width it was born with, and never redraws it. When someone
    // reports "the CLI came out squeezed", this is the number that explains it.
    tracing::info!(
        id = %opts.id,
        program = %program,
        pid = ?pid,
        cols,
        rows,
        "pty iniciado"
    );
    Ok(snap)
}

/// End of life: waits for the reader to drain, does the final flush, removes
/// from the registry and notifies the UI. Called only by the watcher — a
/// single path avoids races between `kill` and the process dying naturally.
fn finish(
    sink: &Arc<dyn PtyEvents>,
    state: &Arc<AppState>,
    id: &str,
    code: Option<i32>,
    shared: &Arc<PtyShared>,
    intent: &Arc<AtomicU8>,
) {
    // Gives the reader up to 3 s to finish draining what the process left.
    let deadline = Instant::now() + Duration::from_secs(3);
    while shared.reading.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    shared.stopping.store(true, Ordering::Release);

    let reason = match intent.load(Ordering::Acquire) {
        INTENT_KILLED => ExitReason::Killed,
        INTENT_SUSPENDED => ExitReason::Suspended,
        INTENT_RESTARTED => ExitReason::Restarted,
        _ => ExitReason::Normal,
    };

    if let Some(handle) = state.ptys.lock().remove(id) {
        let scrollback = handle.lock().scrollback.clone();
        let _ = scrollback.lock().flush();
    }
    state.statuses.lock().insert(
        id.to_string(),
        PtyStatus::Exited {
            code,
            reason,
            at: reader::now_ms(),
        },
    );

    tracing::info!(id = %id, code = ?code, reason = reason.as_str(), "pty encerrado");
    sink.exit(events::ExitPayload {
        id: id.to_string(),
        code,
        reason: reason.as_str().to_string(),
    });
}

fn snapshot_of(id: &str, h: &PtyHandle) -> PtySnapshot {
    PtySnapshot {
        id: id.to_string(),
        pid: h.pid,
        program: h.meta.program.clone(),
        args: h.meta.args.clone(),
        cwd: h.meta.cwd.clone(),
        kind: h.meta.kind.clone(),
        title: h.meta.title.clone(),
        started_at: h.started_at,
        rows: h.rows,
        cols: h.cols,
        scrollback_bytes: h.scrollback.lock().len(),
    }
}

/// RAM gate (§5.4): waits up to `SPAWN_WAIT_MAX` for free memory and then
/// goes ahead anyway — locking the user forever is worse than a rare crash.
fn wait_for_memory(state: &AppState) {
    let start = Instant::now();
    loop {
        let available = state.procs.lock().available_mb();
        if available >= SPAWN_MIN_FREE_MB {
            return;
        }
        if start.elapsed() >= SPAWN_WAIT_MAX {
            tracing::warn!(
                available_mb = available,
                "seguindo com o spawn mesmo com pouca RAM"
            );
            return;
        }
        tracing::info!(available_mb = available, "aguardando RAM para o spawn");
        std::thread::sleep(Duration::from_secs(1));
    }
}

// ---------------------------------------------------------------------------
// operations on a live PTY
// ---------------------------------------------------------------------------

pub fn write(state: &AppState, id: &str, data: &str) -> Result<(), String> {
    let handle = live_handle(state, id)?;
    let h = handle.lock();
    let mut w = h.writer.lock();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Reflows the PTY.
///
/// **Only when the size really changed.** `ResizePseudoConsole` makes conhost
/// reflow its buffer and re-emit the visible frame; doing that on every
/// `ResizeObserver` tick of a window drag lands dozens of repaints on top of
/// whatever the application was drawing, and a full-screen TUI (Ink, and
/// therefore every agent CLI) comes out garbled — half-drawn boxes, orphan
/// borders. The UI already debounces; this is the second gate, and the one
/// that holds even if a future caller forgets.
pub fn resize(state: &AppState, id: &str, rows: u16, cols: u16) -> Result<(), String> {
    let handle = live_handle(state, id)?;
    let mut h = handle.lock();
    let rows = rows.max(2);
    let cols = cols.max(10);
    if h.rows == rows && h.cols == cols {
        return Ok(());
    }
    tracing::debug!(id = %id, from = ?(h.cols, h.rows), to = ?(cols, rows), "pty redimensionado");
    h.rows = rows;
    h.cols = cols;
    h.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// The UI reports when a panel leaves the screen; the pump drops to 1 emit/450 ms.
pub fn set_visible(state: &AppState, id: &str, visible: bool) {
    let handle = state.ptys.lock().get(id).cloned();
    if let Some(handle) = handle {
        let h = handle.lock();
        h.shared.visible.store(visible, Ordering::Release);
    }
}

/// Entry point of the golden rule (§4.3): the UI mounts an `XTermView`,
/// calls this, and only spawns if `alive == false` and there is nothing to resume.
pub fn attach(state: &AppState, id: &str) -> AttachResult {
    let handle = state.ptys.lock().get(id).cloned();
    if let Some(handle) = handle {
        let h = handle.lock();
        let scrollback = h.scrollback.clone();
        let pid = h.pid;
        let (rows, cols) = (h.rows, h.cols);
        let alt_screen = h.shared.alt_screen.load(Ordering::Acquire);
        drop(h);
        return AttachResult {
            alive: true,
            data: scrollback.lock().snapshot(),
            exit: None,
            pid,
            rows,
            cols,
            alt_screen,
        };
    }

    let exit = match state.statuses.lock().get(id) {
        Some(PtyStatus::Exited { code, reason, at }) => Some(ExitInfo {
            code: *code,
            reason: reason.as_str().to_string(),
            at: *at,
        }),
        _ => None,
    };

    AttachResult {
        alive: false,
        data: Scrollback::read_from_disk(id),
        exit,
        pid: None,
        rows: 0,
        cols: 0,
        // Nothing is painting: the history on disk is all there is, so the UI
        // replays it (imperfect for a full-screen CLI, but it is that or a
        // black pane).
        alt_screen: false,
    }
}

/// Asks the console host for the **current frame**, without the application
/// having to cooperate.
///
/// ConPTY repaints its whole viewport whenever the pseudoconsole changes size —
/// that is measurable: resizing a PTY whose process ignores `SIGWINCH`
/// entirely still brings the full screen back over the wire. So a size that
/// leaves and comes back is a repaint request, and the only one a terminal
/// emulator has: there is no "redraw yourself" sequence a shell, an editor and
/// an agent CLI all answer.
///
/// This is what a view rebuilt from scratch (layout switch, group switch,
/// reload) uses to show what the CLI *actually* has on screen instead of
/// guessing from the byte log.
pub fn repaint(state: &AppState, id: &str) -> Result<(), String> {
    let (rows, cols) = {
        let handle = live_handle(state, id)?;
        let h = handle.lock();
        (h.rows, h.cols)
    };
    // Grows and comes back: shrinking first would scroll the top line of the
    // alternate screen out before conhost re-emitted it.
    resize(state, id, rows.saturating_add(1), cols)?;
    // Two resizes in the same instant can reach the host as one, and one that
    // ends where it started is no change at all — no repaint. The pause is
    // what makes them two events.
    std::thread::sleep(REPAINT_GAP);
    resize(state, id, rows, cols)
}

pub fn exists(state: &AppState, id: &str) -> bool {
    state.ptys.lock().contains_key(id)
}

/// Lightweight output cursor for wait loops. Unlike `attach`, this never
/// clones scrollback and remains useful after the in-memory ring is full.
pub fn probe(state: &AppState, id: &str) -> PtyProbe {
    let handle = state.ptys.lock().get(id).cloned();
    match handle {
        Some(handle) => PtyProbe {
            alive: true,
            total_bytes: handle.lock().shared.total_bytes.load(Ordering::Acquire),
        },
        None => PtyProbe {
            alive: false,
            total_bytes: 0,
        },
    }
}

/// Returns at most `max_bytes` written after a monotonic output cursor.
pub fn read_since(state: &AppState, id: &str, after: u64, max_bytes: usize) -> PtyDelta {
    let max_bytes = max_bytes.min(256 * 1024);
    let handle = state.ptys.lock().get(id).cloned();
    match handle {
        Some(handle) => {
            let h = handle.lock();
            let total_bytes = h.shared.total_bytes.load(Ordering::Acquire);
            let scrollback = h.scrollback.clone();
            drop(h);
            let available = total_bytes.saturating_sub(after) as usize;
            let data = scrollback.lock().tail(available.min(max_bytes));
            PtyDelta {
                alive: true,
                data,
                total_bytes,
            }
        }
        None => PtyDelta {
            alive: false,
            data: Scrollback::read_tail_from_disk(id, max_bytes),
            total_bytes: 0,
        },
    }
}

pub fn list(state: &AppState) -> Vec<PtySnapshot> {
    let handles: Vec<_> = state
        .ptys
        .lock()
        .iter()
        .map(|(id, h)| (id.clone(), h.clone()))
        .collect();
    handles
        .into_iter()
        .map(|(id, h)| snapshot_of(&id, &h.lock()))
        .collect()
}

/// Kills the entire tree. Order: Job Object -> tree via sysinfo -> taskkill.
fn terminate(state: &AppState, id: &str, intent_code: u8) -> Result<(), String> {
    let (pid, has_job) = {
        let handle = live_handle(state, id)?;
        let h = handle.lock();
        h.intent.store(intent_code, Ordering::Release);
        let ok = match &h.job {
            Some(j) => j.terminate(),
            None => false,
        };
        if !ok {
            // No job (or TerminateJobObject failed): at least take down the root.
            let _ = h.killer.lock().kill();
        }
        (h.pid, ok)
    };

    if !has_job {
        if let Some(pid) = pid {
            let killed = state.procs.lock().kill_tree(pid);
            tracing::info!(id = %id, pid, killed, "fallback: kill por arvore de processos");
            if state.procs.lock().is_alive(pid) {
                crate::process_tree::taskkill(pid);
            }
        }
    }
    Ok(())
}

pub fn kill(state: &AppState, id: &str) -> Result<(), String> {
    terminate(state, id, INTENT_KILLED)
}

/// Suspend = kill while preserving scrollback and resume metadata (§5.6).
/// The difference from kill is the reported reason and what the UI
/// keeps: whoever suspends wants to come back later.
pub fn suspend(state: &AppState, id: &str) -> Result<(), String> {
    if let Ok(handle) = live_handle(state, id) {
        let scrollback = handle.lock().scrollback.clone();
        let _ = scrollback.lock().flush();
    }
    terminate(state, id, INTENT_SUSPENDED)
}

/// kill + respawn with the same command/cwd, preserving the scrollback.
pub fn restart(
    sink: Arc<dyn PtyEvents>,
    state: &Arc<AppState>,
    id: &str,
) -> Result<PtySnapshot, String> {
    let (meta, rows, cols) = {
        let handle = state.ptys.lock().get(id).cloned();
        match handle {
            Some(handle) => {
                let h = handle.lock();
                (h.meta.clone(), h.rows, h.cols)
            }
            None => {
                // Already dead: look in the database for how to resume.
                return Err(format!(
                    "pty '{id}' nao esta rodando; use spawn_pty para retomar"
                ));
            }
        }
    };

    terminate(state, id, INTENT_RESTARTED)?;

    // Wait for the watcher to clear the registry before reusing the id.
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.ptys.lock().contains_key(id) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if state.ptys.lock().contains_key(id) {
        return Err("o processo anterior nao encerrou a tempo".to_string());
    }

    spawn(
        sink,
        state,
        SpawnOptions {
            id: id.to_string(),
            program: meta.program,
            args: meta.args,
            cwd: meta.cwd,
            rows,
            cols,
            kind: meta.kind,
            title: meta.title,
            env: meta.env,
            keep_scrollback: true,
        },
    )
}

/// Clears the scrollback (memory + disk) of a live terminal.
pub fn clear_scrollback(state: &AppState, id: &str) -> Result<(), String> {
    let handle = live_handle(state, id)?;
    let scrollback = handle.lock().scrollback.clone();
    scrollback.lock().clear();
    Ok(())
}

/// Tears everything down — called on window close. Because Job Objects have
/// KILL_ON_JOB_CLOSE, even a crash here does not leave orphans.
pub fn kill_all(state: &AppState) {
    let ids = state.running_ids();
    for id in ids {
        let _ = terminate(state, &id, INTENT_KILLED);
    }
}

/// `{ pids, rssMb, cpu }` for the resource HUD.
pub fn tree_info(state: &AppState, id: &str) -> Result<events::PtyResource, String> {
    let pid = live_handle(state, id)?.lock().pid;
    let Some(pid) = pid else {
        return Ok(events::PtyResource {
            id: id.to_string(),
            pids: vec![],
            rss_mb: 0.0,
            cpu: 0.0,
        });
    };
    let (pids, rss_mb, cpu) = state.procs.lock().tree_stats(pid);
    Ok(events::PtyResource {
        id: id.to_string(),
        pids,
        rss_mb,
        cpu,
    })
}

fn live_handle(state: &AppState, id: &str) -> Result<Arc<Mutex<PtyHandle>>, String> {
    state
        .ptys
        .lock()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("pty '{id}' nao existe"))
}

/// Default Windows shell: `pwsh` if it exists, otherwise `powershell` (§9.2).
pub fn default_shell() -> String {
    for candidate in ["pwsh.exe", "pwsh"] {
        if let Ok(p) = which::which(candidate) {
            return p.to_string_lossy().into_owned();
        }
    }
    #[cfg(windows)]
    {
        let fallback = std::env::var("SystemRoot")
            .map(|r| format!(r"{r}\System32\WindowsPowerShell\v1.0\powershell.exe"))
            .unwrap_or_else(|_| "powershell.exe".to_string());
        if std::path::Path::new(&fallback).exists() {
            return fallback;
        }
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

/// Shells offered in the "New terminal" modal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub program: String,
    pub available: bool,
}

pub fn list_shells() -> Vec<ShellOption> {
    let mut out = Vec::new();

    let pwsh = which::which("pwsh.exe")
        .or_else(|_| which::which("pwsh"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    out.push(ShellOption {
        id: "pwsh".into(),
        label: "PowerShell 7 (pwsh)".into(),
        program: pwsh.clone().unwrap_or_else(|| "pwsh.exe".into()),
        available: pwsh.is_some(),
    });

    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ps = format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe");
        let cmd = format!(r"{root}\System32\cmd.exe");
        out.push(ShellOption {
            id: "powershell".into(),
            label: "Windows PowerShell 5.1".into(),
            available: std::path::Path::new(&ps).exists(),
            program: ps,
        });
        out.push(ShellOption {
            id: "cmd".into(),
            label: "Prompt de Comando (cmd)".into(),
            available: std::path::Path::new(&cmd).exists(),
            program: cmd,
        });
        if let Ok(bash) = which::which("bash.exe") {
            out.push(ShellOption {
                id: "bash".into(),
                label: "Git Bash".into(),
                program: bash.to_string_lossy().into_owned(),
                available: true,
            });
        }
    }

    #[cfg(not(windows))]
    {
        out.push(ShellOption {
            id: "sh".into(),
            label: "sh".into(),
            program: "/bin/sh".into(),
            available: true,
        });
    }

    out
}
