//! Ordered lanes: blocking commands off the UI thread, in the order they arrived.
//!
//! Tauri runs a command declared without `async` inline, inside the IPC
//! handler, on the main thread, the one that pumps the window. That gave two
//! things at once: every such command ran **one at a time, in arrival order**,
//! and every one of them froze the UI while it ran. A `save_workspace` stuck
//! behind the backup's database lock, a paste into a console that stopped
//! reading its stdin, a portal screenshot waiting on the browser: the whole
//! window stopped painting.
//!
//! `async fn` + `spawn_blocking` frees the UI thread and loses the first
//! property. The pool has no notion of order: two `write_pref`s of the same key
//! fired without awaiting (the last active group, on two quick switches) can
//! reach SQLite in either order, and the older value wins; two keystrokes can
//! swap places on their way into the ConPTY.
//!
//! A lane keeps both. The IPC handler still runs on the main thread, in arrival
//! order, and all it does for a routed command is drop the call onto its lane
//! (a lock and a channel send). The lane's thread then runs the very same
//! command wrapper, unchanged: same arguments, same result, same error, and the
//! promise settles when the work is done, exactly as before. Jobs on one lane
//! run one at a time, first in, first out; different lanes never wait on each
//! other. A lane's thread lingers for a while after its last job and then
//! retires, so a lane per terminal does not mean a thread per terminal forever.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::ipc::{Invoke, InvokeBody};
use tauri::Runtime;

type Job = Box<dyn FnOnce() + Send + 'static>;

/// How long an idle lane's thread waits for more work before retiring: long
/// enough that a burst of typing, or the autosave cadence, reuses one thread.
const LINGER: Duration = Duration::from_secs(30);

/// The lanes the IPC handler routes to (and the window geometry writes).
pub fn lanes() -> &'static Lanes {
    static LANES: OnceLock<Lanes> = OnceLock::new();
    LANES.get_or_init(|| Lanes::new(LINGER))
}

/// The command table `generate_handler!` builds, shareable with the lanes'
/// threads.
pub type Commands<R> = Arc<dyn Fn(Invoke<R>) -> bool + Send + Sync + 'static>;

/// Wraps what `generate_handler!` expands to. Outside `invoke_handler` that
/// closure has nothing to infer its argument type from; this gives it one.
pub fn commands<R: Runtime, F>(table: F) -> Commands<R>
where
    F: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    Arc::new(table)
}

/// The IPC handler. Runs on the main thread, in arrival order, like the table
/// it wraps: a routed command is handed to its lane (a lock and a channel
/// send) and everything else runs in place, as before.
///
/// The lane runs the same generated wrapper, so arguments, result, error text
/// and the moment the promise settles (when the work is done) are unchanged.
/// `payload()` is JSON Tauri already parsed; routing reads one field of it.
pub fn dispatch<R: Runtime>(commands: &Commands<R>, invoke: Invoke<R>) -> bool {
    let payload = match invoke.message.payload() {
        InvokeBody::Json(value) => Some(value),
        InvokeBody::Raw(_) => None,
    };
    let Some(lane) = route(invoke.message.command(), payload) else {
        return commands(invoke);
    };
    let commands = commands.clone();
    let resolver = invoke.resolver.clone();
    let name = invoke.message.command().to_string();
    lanes().submit(&lane, move || {
        // Tauri's own answer to an unknown command, word for word. Routed
        // names are all registered, so this is a belt, not a path.
        if !commands(invoke) {
            resolver.reject(format!("Command {name} not found"));
        }
    });
    true
}

pub struct Lanes {
    inner: Arc<Inner>,
}

struct Inner {
    /// The live lanes. An entry exists exactly while its thread does, and it
    /// is only ever added or removed with this lock held: that is what makes
    /// "one thread per lane" and "no job lost to a retiring thread" hold.
    lanes: Mutex<HashMap<String, Sender<Job>>>,
    linger: Duration,
}

impl Lanes {
    /// `linger` is how long a lane's thread waits for more work before it
    /// retires.
    pub fn new(linger: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                lanes: Mutex::new(HashMap::new()),
                linger,
            }),
        }
    }

    /// Runs `job` after every job submitted earlier on `key` has finished.
    pub fn submit(&self, key: &str, job: impl FnOnce() + Send + 'static) {
        let mut lanes = self.inner.lanes.lock();
        if let Some(tx) = lanes.get(key) {
            // The thread only leaves after removing this entry under the lock
            // we hold, so it is there to receive this.
            let _ = tx.send(Box::new(job));
            return;
        }
        let (tx, rx) = mpsc::channel::<Job>();
        let _ = tx.send(Box::new(job));
        lanes.insert(key.to_string(), tx);
        let inner = self.inner.clone();
        let key = key.to_string();
        std::thread::Builder::new()
            .name(format!("lane {key}"))
            .spawn(move || work(&inner, &key, &rx))
            .expect("nao consegui criar a thread da fila");
    }

    /// Blocks until every job submitted on `key` before this call has run.
    ///
    /// Never call it from a job of the same lane: it would wait for itself.
    pub fn drain(&self, key: &str) {
        let (done, wait) = mpsc::channel::<()>();
        self.submit(key, move || {
            let _ = done.send(());
        });
        let _ = wait.recv();
    }

    /// How many lanes have a thread right now.
    #[cfg(test)]
    fn live(&self) -> usize {
        self.inner.lanes.lock().len()
    }
}

/// The lane of every command that touches `state.db`, and of the window
/// geometry writes (`window_state.rs`).
pub const DB: &str = "db";

/// Runs `teardown` once every job queued on the database lane before this call
/// has run. The exit path and `restart_app` go through here: a save that
/// arrived before them reaches the disk before the process goes, as it did
/// when both ran on the UI thread.
///
/// Like `drain`, never call it from a job of the database lane.
pub fn before_teardown(lanes: &Lanes, teardown: impl FnOnce()) {
    lanes.drain(DB);
    teardown();
}

/// The sync commands that lock `state.db`. Reads are here too, not only
/// writes: a `read_prefs` issued after a `write_pref` has to see it, as it
/// did when both ran on the UI thread.
const DB_COMMANDS: [&str; 13] = [
    "save_workspace",
    "load_workspace",
    "read_prefs",
    "write_pref",
    "write_prefs",
    "delete_pref",
    "notes_load",
    "note_save",
    "note_delete",
    "notebook_save",
    "notebook_delete",
    "note_tag_save",
    "note_tag_delete",
];

/// Which lane an IPC command runs on, or `None` for "where it always ran".
///
/// `payload` is the invoke's JSON arguments, when there are any.
pub fn route(command: &str, payload: Option<&serde_json::Value>) -> Option<String> {
    if DB_COMMANDS.contains(&command) {
        return Some(DB.to_string());
    }
    match command {
        // One lane per terminal: its keystrokes keep their order, and a child
        // that stopped reading its stdin blocks only its own writes. Clearing
        // its history (a scrollback lock, maybe behind a 4 MB rewrite) and
        // forgetting it (a file deleted) queue there too, in order with them.
        "write_pty" | "clear_pty" | "forget_pty" => {
            let id = payload?.get("id")?.as_str()?;
            Some(format!("pty:{id}"))
        }
        // Setting up a watcher (over a big tree, or a slow drive) and dropping
        // it, per project and in the order asked: a drop that overtook its
        // watch would leave a watcher nobody wants.
        "watch_project" | "unwatch_project" => {
            let project = payload?.get("projectId")?.as_str()?;
            Some(format!("watch:{project}"))
        }
        // One lane per language server: the editor fires its messages without
        // waiting for each, and the server has to read them in that order
        // (a `didChange` is a diff against the version before it). Its start
        // and its stop queue there too, so no message overtakes either one.
        "lsp_start" | "lsp_send" | "lsp_stop" => {
            let id = payload?.get("id")?.as_str()?;
            Some(format!("lsp:{id}"))
        }
        // The no-Job-Object fallback refreshes the whole process table and
        // waits on `taskkill`; one lane keeps these in their arrival order.
        "kill_pty" | "suspend_pty" | "suspend_group" => Some("pty-control".to_string()),
        // Capture, crop, PNG encode and file write, or a round trip to the
        // browser's CDP port. The file name only changes once a second.
        "portal_screenshot" | "portal_grab_shot" => Some("portal-shot".to_string()),
        _ => None,
    }
}

/// A lane's thread: runs its jobs in order, and retires after `linger` with
/// nothing to do.
fn work(inner: &Inner, key: &str, rx: &Receiver<Job>) {
    loop {
        match rx.recv_timeout(inner.linger) {
            Ok(job) => run(key, job),
            Err(RecvTimeoutError::Timeout) => {
                let mut lanes = inner.lanes.lock();
                // A submit that raced the timeout sent while holding this very
                // lock, so it is already in the channel: look once more before
                // leaving.
                match rx.try_recv() {
                    Ok(job) => {
                        drop(lanes);
                        run(key, job);
                    }
                    Err(_) => {
                        lanes.remove(key);
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Runs one job. A panic (dev builds unwind; release aborts anyway) ends that
/// job and nothing else: the ones queued behind it belong to other callers.
fn run(key: &str, job: Job) {
    if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)) {
        let what = panic
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        tracing::error!(lane = %key, panic = %what, "um comando entrou em panico na fila");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Long enough for any job in these tests; a failure waits this long and
    /// no longer.
    const DEADLINE: Duration = Duration::from_secs(5);

    /// The contract every caller leans on: two calls on one lane run in the
    /// order they were handed over, even when they come from several threads.
    /// Each submitter takes its ticket and submits under the same lock, so the
    /// ticket log *is* the submission order.
    #[test]
    fn jobs_on_one_lane_run_in_the_order_they_were_submitted() {
        let lanes = Arc::new(Lanes::new(DEADLINE));
        let issued = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let submitters: Vec<_> = (0..4)
            .map(|t| {
                let (lanes, issued, tx) = (lanes.clone(), issued.clone(), tx.clone());
                std::thread::spawn(move || {
                    for i in 0..250 {
                        let ticket = t * 1000 + i;
                        let mut log = issued.lock();
                        log.push(ticket);
                        let tx = tx.clone();
                        lanes.submit("db", move || {
                            let _ = tx.send(ticket);
                        });
                    }
                })
            })
            .collect();
        for s in submitters {
            s.join().unwrap();
        }
        let ran: Vec<_> = (0..1000)
            .map(|_| rx.recv_timeout(DEADLINE).expect("every job ran"))
            .collect();
        assert_eq!(ran, *issued.lock());
    }

    /// A terminal whose child stopped reading its stdin blocks its own write.
    /// Before the lanes that was the whole window; it must not become every
    /// other terminal's keystrokes instead.
    #[test]
    fn a_stuck_lane_does_not_hold_up_another_lane() {
        let lanes = Lanes::new(DEADLINE);
        let (release, stuck) = mpsc::channel::<()>();
        let (tx, rx) = mpsc::channel();
        // Stuck for longer than the assertion below is willing to wait.
        lanes.submit("pty-write:a", move || {
            let _ = stuck.recv_timeout(DEADLINE * 2);
        });
        lanes.submit("pty-write:b", move || {
            let _ = tx.send("b");
        });
        assert_eq!(rx.recv_timeout(DEADLINE), Ok("b"), "b ran while a was stuck");
        let _ = release.send(());
    }

    /// A lane per terminal must not mean a thread per terminal for the life of
    /// the app: an idle lane retires. And a keystroke that lands while its lane
    /// is retiring must still run. With no linger at all, every round below
    /// races a retiring thread; a job lost in that race never answers.
    #[test]
    fn an_idle_lane_retires_and_the_next_job_still_runs() {
        let lanes = Lanes::new(Duration::ZERO);
        let (tx, rx) = mpsc::channel();
        for round in 0..200 {
            let tx = tx.clone();
            lanes.submit("pty-write:a", move || {
                let _ = tx.send(round);
            });
            assert_eq!(rx.recv_timeout(DEADLINE), Ok(round));
        }
        let deadline = std::time::Instant::now() + DEADLINE;
        while lanes.live() > 0 {
            assert!(std::time::Instant::now() < deadline, "the idle lane never retired");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The exit and restart paths used to run after every `save_workspace`
    /// that arrived before them, because both ran on the one UI thread. With
    /// the saves on a lane, they have to wait for it: a drained lane is one
    /// with nothing left from before.
    #[test]
    fn drain_returns_only_after_every_earlier_job_ran() {
        let lanes = Lanes::new(DEADLINE);
        let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (open, gate) = mpsc::channel::<()>();
        lanes.submit("db", move || {
            let _ = gate.recv_timeout(DEADLINE);
        });
        for _ in 0..10 {
            let ran = ran.clone();
            lanes.submit("db", move || {
                ran.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            });
        }
        let opener = std::thread::spawn(move || open.send(()));
        lanes.drain("db");
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 10);
        let _ = opener.join();
    }

    /// Exit and restart kill the terminals and take the process down. A
    /// `save_workspace` that arrived before them used to run first, on the
    /// same UI thread; on the database lane it still has to, or the last
    /// change of layout is lost on every close.
    #[test]
    fn teardown_runs_only_after_every_save_queued_before_it() {
        let lanes = Lanes::new(DEADLINE);
        let log = Arc::new(Mutex::new(Vec::new()));
        let (open, gate) = mpsc::channel::<()>();
        lanes.submit(DB, move || {
            let _ = gate.recv_timeout(DEADLINE);
        });
        let saves = log.clone();
        lanes.submit(DB, move || saves.lock().push("save"));
        let opener = std::thread::spawn(move || open.send(()));
        before_teardown(&lanes, || log.lock().push("teardown"));
        assert_eq!(*log.lock(), ["save", "teardown"]);
        let _ = opener.join();
    }

    /// A command that panics (dev builds unwind) takes its own call down, and
    /// only that one. The jobs already queued behind it are other callers'
    /// promises; if the thread died with them in its channel, they would never
    /// settle.
    #[test]
    fn a_job_that_panics_does_not_strand_the_jobs_behind_it() {
        let lanes = Lanes::new(DEADLINE);
        let (open, gate) = mpsc::channel::<()>();
        let (tx, rx) = mpsc::channel();
        // Holds the lane so the next two are queued before the panic happens.
        lanes.submit("db", move || {
            let _ = gate.recv_timeout(DEADLINE);
        });
        lanes.submit("db", || panic!("a command that blew up"));
        lanes.submit("db", move || {
            let _ = tx.send("after");
        });
        open.send(()).unwrap();
        assert_eq!(rx.recv_timeout(DEADLINE), Ok("after"));
    }

    /// The block that opens at byte `open` of `text` (a `{`), up to the brace
    /// that closes it.
    fn block_at(text: &str, open: usize) -> &str {
        let mut depth = 0usize;
        for (i, c) in text[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &text[open..=open + i];
                    }
                }
                _ => {}
            }
        }
        &text[open..]
    }

    /// The names of the sync (`fn`, not `async fn`) commands in `lib.rs` whose
    /// body locks `state.db`.
    fn sync_commands_that_lock_the_database() -> Vec<String> {
        let source = include_str!("lib.rs");
        let mut found = Vec::new();
        for chunk in source.split("#[tauri::command]").skip(1) {
            let Some(rest) = chunk.trim_start().strip_prefix("fn ") else {
                continue;
            };
            let name = rest.split('(').next().unwrap_or_default().trim();
            // The body: from the first brace to the one that closes it.
            let Some(open) = rest.find('{') else { continue };
            if block_at(rest, open).contains("state.db.lock()") {
                found.push(name.to_string());
            }
        }
        found
    }

    /// What the database lane exists for: every command that takes `state.db`
    /// from the IPC handler runs there, in arrival order. One added later
    /// without joining would block the UI again and, worse, race the saves
    /// around it. Read from the source, so it cannot be forgotten.
    #[test]
    fn every_sync_command_that_locks_the_database_runs_on_the_database_lane() {
        let found = sync_commands_that_lock_the_database();
        assert!(
            found.iter().any(|n| n == "save_workspace"),
            "the scan found nothing: {found:?}"
        );
        for name in &found {
            assert_eq!(route(name, None).as_deref(), Some(DB), "{name} is off the lane");
        }
    }

    /// The ways the process goes, from `lib.rs`: each one's block, and the
    /// effects in it that must wait for the database lane.
    fn teardown_paths() -> Vec<(&'static str, &'static str, [&'static str; 2])> {
        let source = include_str!("lib.rs");
        [
            ("fn restart_app(", ["pty::kill_all(", "app.restart()"]),
            (
                "if let RunEvent::ExitRequested",
                ["pty::kill_all(", "lsp::stop_all()"],
            ),
        ]
        .into_iter()
        .map(|(anchor, effects)| {
            let start = source
                .find(anchor)
                .unwrap_or_else(|| panic!("`{anchor}` is gone from lib.rs"));
            // The block opens at the first brace that ends its line; a pattern
            // such as `{ .. }` never does.
            let open = source[start..]
                .match_indices('{')
                .map(|(i, _)| start + i)
                .find(|&i| matches!(source.as_bytes().get(i + 1), Some(b'\n' | b'\r')))
                .unwrap_or_else(|| panic!("`{anchor}` has no block"));
            (anchor, block_at(source, open), effects)
        })
        .collect()
    }

    /// The two ways the process goes (`restart_app`, and the exit arm of the
    /// run loop) kill the terminals and leave only through `before_teardown`.
    /// Either one written without it drops the saves still on the database
    /// lane, and nothing else in the suite would notice. Read from the source,
    /// like the routing check above.
    #[test]
    fn restart_and_exit_tear_down_only_after_the_database_lane_drained() {
        for (anchor, block, effects) in teardown_paths() {
            let drained = block
                .find("lanes::before_teardown(")
                .unwrap_or_else(|| panic!("`{anchor}` does not go through before_teardown"));
            for effect in effects {
                let at = block
                    .find(effect)
                    .unwrap_or_else(|| panic!("`{anchor}` no longer calls `{effect}`"));
                assert!(
                    drained < at,
                    "`{anchor}` calls `{effect}` before the lane drained"
                );
            }
        }
    }

    /// The exit also has to wait for a backup still being zipped
    /// (`persistence::backup::wait_for_exports`): the process exit would cut
    /// the zip off before its central directory. The database lock used to
    /// cover the whole export and every way out took it, so the old exit
    /// waited for free; with that lock down to the copy, only this call does,
    /// and it comes before the terminals are killed, as the old wait did.
    /// Read from the source, like the check above.
    #[test]
    fn the_exit_waits_for_a_backup_in_progress_before_it_tears_down() {
        let (anchor, block, effects) = teardown_paths()
            .into_iter()
            .find(|(anchor, _, _)| anchor.contains("ExitRequested"))
            .expect("the exit arm is among the teardown paths");
        let waited = block
            .find("persistence::backup::wait_for_exports()")
            .unwrap_or_else(|| panic!("`{anchor}` does not wait for a backup in progress"));
        for effect in effects {
            let at = block
                .find(effect)
                .unwrap_or_else(|| panic!("`{anchor}` no longer calls `{effect}`"));
            assert!(waited < at, "`{anchor}` calls `{effect}` before the backup is done");
        }
    }

    /// Keystrokes keep their order per terminal (one lane each), and one
    /// terminal's stuck pipe is not another terminal's problem (not the same
    /// lane).
    #[test]
    fn writes_share_a_lane_per_terminal_and_only_per_terminal() {
        let a1 = serde_json::json!({ "id": "t-a", "data": "l" });
        let a2 = serde_json::json!({ "id": "t-a", "data": "s\r" });
        let b = serde_json::json!({ "id": "t-b", "data": "l" });
        let lane_a1 = route("write_pty", Some(&a1));
        assert!(lane_a1.is_some(), "a write has a lane");
        assert_eq!(lane_a1, route("write_pty", Some(&a2)));
        assert_ne!(lane_a1, route("write_pty", Some(&b)));
        assert_ne!(lane_a1.as_deref(), Some(DB));
    }

    /// A malformed write has no terminal to queue behind. It stays with the
    /// normal handler, whose argument error is the one the caller always got.
    #[test]
    fn a_write_without_a_usable_id_is_left_to_the_normal_handler() {
        for payload in [
            serde_json::json!({ "data": "x" }),
            serde_json::json!({ "id": 7, "data": "x" }),
            serde_json::json!("x"),
        ] {
            assert_eq!(route("write_pty", Some(&payload)), None, "{payload}");
        }
        assert_eq!(route("write_pty", None), None);
    }

    /// Kill and suspend both write the intent the exit watcher reports, so a
    /// suspend and a kill of the same terminal must land in the order they
    /// were asked, as they did on the UI thread. And neither may queue behind
    /// a stuck write: the kill is what unsticks it.
    #[test]
    fn kill_and_suspend_share_one_lane_apart_from_the_writes() {
        let kill = serde_json::json!({ "id": "t-a" });
        let group = serde_json::json!({ "ids": ["t-a", "t-b"] });
        let lane = route("kill_pty", Some(&kill));
        assert!(lane.is_some(), "kill has a lane");
        assert_eq!(lane, route("suspend_pty", Some(&kill)));
        assert_eq!(lane, route("suspend_group", Some(&group)));
        assert_ne!(lane, route("write_pty", Some(&kill)));
        assert_ne!(lane.as_deref(), Some(DB));
    }

    /// Two shots of one portal in the same second get the same file name
    /// (`portal::now_stamp` counts seconds). One after the other, the second
    /// overwrote the first whole; side by side, two writers into one file can
    /// leave a PNG that is half of each. So they queue, as they did.
    #[test]
    fn portal_screenshots_share_one_lane() {
        let lane = route("portal_screenshot", Some(&serde_json::json!({ "id": "p1" })));
        assert!(lane.is_some(), "a screenshot has a lane");
        assert_eq!(
            lane,
            route("portal_grab_shot", Some(&serde_json::json!({ "id": "p1" })))
        );
        assert_ne!(lane.as_deref(), Some(DB));
        assert_ne!(lane, route("kill_pty", None));
    }

    /// Clearing a terminal's history waits on its scrollback lock (behind a
    /// 4 MB rewrite, at worst) and deletes a file; forgetting one deletes a
    /// file. Off the UI thread, and still in order with that terminal's own
    /// writes: on its lane, and only its.
    #[test]
    fn clearing_and_forgetting_a_terminal_queue_on_its_own_lane() {
        let a = serde_json::json!({ "id": "t-a" });
        let b = serde_json::json!({ "id": "t-b" });
        let lane = route("write_pty", Some(&a));
        assert!(lane.is_some(), "a terminal has a lane");
        assert_eq!(route("clear_pty", Some(&a)), lane);
        assert_eq!(route("forget_pty", Some(&a)), lane);
        assert_ne!(route("clear_pty", Some(&b)), lane);
        assert_ne!(route("forget_pty", Some(&b)), lane);
    }

    /// Starting a watch on a project and dropping it (the store drops one
    /// right after asking for it, when the project left in the meantime)
    /// must land in the order asked, as on the UI thread, or a watcher
    /// nobody wants outlives its project. One lane per project.
    #[test]
    fn watching_and_unwatching_a_project_share_a_lane_per_project() {
        let p = serde_json::json!({ "projectId": "p1", "root": "C:/p1" });
        let q = serde_json::json!({ "projectId": "p2", "root": "C:/p2" });
        let lane = route("watch_project", Some(&p));
        assert!(lane.is_some(), "a watch has a lane");
        assert_eq!(route("unwatch_project", Some(&serde_json::json!({ "projectId": "p1" }))), lane);
        assert_ne!(route("watch_project", Some(&q)), lane);
        assert_ne!(lane.as_deref(), Some(DB));
    }

    /// Every `#[tauri::command]` in `source`: its name and whether it is
    /// `async`.
    fn commands_in(source: &str) -> Vec<(String, bool)> {
        source
            .split("#[tauri::command]")
            .skip(1)
            .filter_map(|chunk| {
                let rest = chunk.trim_start();
                let rest = rest.strip_prefix("pub ").unwrap_or(rest);
                let (is_async, rest) = match rest.strip_prefix("async ") {
                    Some(rest) => (true, rest),
                    None => (false, rest),
                };
                let name = rest.strip_prefix("fn ")?.split(['(', '<']).next()?.trim();
                Some((name.to_string(), is_async))
            })
            .collect()
    }

    /// Whatever argument a command's lane is read from.
    fn any_ids() -> serde_json::Value {
        serde_json::json!({ "id": "x", "projectId": "p" })
    }

    /// A sync command runs on the UI thread unless it has a lane, and these
    /// can all stall it: a PATH lookup that walks a dead network share
    /// (`list_shells`, `default_shell`), a stat of a path on one
    /// (`is_directory`, called in a loop at boot), a process spawn
    /// (`reveal_path`, `open_external`), a file watcher set up over a big tree,
    /// a scrollback lock. Each one is either `async` (the blocking pool) or on
    /// a lane. Read from the source, so a revert shows up here.
    #[test]
    fn commands_that_can_block_on_the_disk_or_a_process_stay_off_the_ui_thread() {
        let commands = commands_in(include_str!("lib.rs"));
        for name in [
            "list_shells",
            "default_shell",
            "clear_pty",
            "forget_pty",
            "is_directory",
            "reveal_path",
            "open_external",
            "watch_project",
            "unwatch_project",
        ] {
            let (_, is_async) = commands
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("`{name}` is gone from lib.rs"));
            assert!(
                *is_async || route(name, Some(&any_ids())).is_some(),
                "`{name}` runs on the UI thread"
            );
        }
    }

    /// The regression this locks down: `lsp_send` went through the blocking
    /// pool, and the editor does not await it (`lsp/transport.ts` fires each
    /// message and moves on), so `didChange` version 5 could reach the server
    /// before version 4 and the server's copy of the file came out garbled.
    /// A server's messages share one lane, with its start and its stop, and
    /// one server's stalled stdin holds up no other server.
    #[test]
    fn messages_to_one_language_server_keep_their_order() {
        let v4 = serde_json::json!({ "id": "ts-1", "message": "{\"version\":4}" });
        let v5 = serde_json::json!({ "id": "ts-1", "message": "{\"version\":5}" });
        let other = serde_json::json!({ "id": "ra-1", "message": "{}" });
        let lane = route("lsp_send", Some(&v4));
        assert!(lane.is_some(), "a server's messages have a lane");
        assert_eq!(route("lsp_send", Some(&v5)), lane);
        let start = serde_json::json!({ "id": "ts-1", "program": "x", "args": [], "cwd": "C:/p" });
        assert_eq!(route("lsp_start", Some(&start)), lane);
        assert_eq!(route("lsp_stop", Some(&serde_json::json!({ "id": "ts-1" }))), lane);
        assert_ne!(route("lsp_send", Some(&other)), lane);
        assert_ne!(lane.as_deref(), Some(DB));
    }

    /// A lane runs the command's generated wrapper, and for an `async fn` that
    /// wrapper only hands a future to the runtime and returns: the lane would
    /// "order" nothing at all. Every routed command has to be a plain `fn`.
    /// Read from the source of every file with routed commands.
    #[test]
    fn a_command_on_a_lane_is_not_async_or_its_lane_orders_nothing() {
        for (file, source) in [("lib.rs", include_str!("lib.rs")), ("lsp.rs", include_str!("lsp.rs"))] {
            for (name, is_async) in commands_in(source) {
                if is_async {
                    assert_eq!(
                        route(&name, Some(&any_ids())),
                        None,
                        "`{name}` in {file} is async and routed to a lane"
                    );
                }
            }
        }
    }

    /// Everything off the list keeps running exactly where it did: cheap sync
    /// commands inline, async ones on the runtime, plugins in their plugin.
    /// `restart_app` especially: `AppHandle::restart` takes a different path
    /// off the main thread.
    #[test]
    fn commands_off_the_list_run_where_they_always_did() {
        let id = serde_json::json!({ "id": "t-a" });
        for command in [
            "resize_pty",
            "spawn_pty",
            "attach_pty",
            "get_pty_tree_info",
            "restart_app",
            "export_backup",
            "plugin:dialog|open",
        ] {
            assert_eq!(route(command, Some(&id)), None, "{command}");
        }
    }
}
