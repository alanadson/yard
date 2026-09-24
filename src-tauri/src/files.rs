//! **Project** file watcher — "what the CLI is touching right now".
//!
//! Unlike `watcher.rs` (which watches the agents' session directories),
//! this one watches the root of a registered project and tells the UI,
//! in near-real time, which files were created/modified/deleted.
//! It is what feeds the "Files" panel (live feed + change review).
//!
//! Decisions:
//! - Our own coalescing instead of the mini-debouncer: we need to distinguish
//!   created/modified/deleted, and the mini only delivers `Any`. We join events
//!   by path in a ~250 ms quiet window (900 ms cap under continuous activity)
//!   and classify on flush by looking at disk.
//! - `.git` **must** be in the filter: the UI itself runs `git status` when
//!   it receives activity, which touches `.git/index` — without the filter
//!   that would become an infinite feedback loop.
//! - Storms (npm install, cargo build) are trimmed in two layers:
//!   noisy directories stay out and the window has a path cap; anything
//!   past the cap becomes just a `dropped` counter in the payload.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Runtime};

use crate::events::{FileEvent, FilesActivity, FILES_ACTIVITY};

/// Quiet window before the flush.
const QUIET: Duration = Duration::from_millis(250);
/// Under continuous activity, flush at most this often — the feed is "live".
const MAX_WINDOW: Duration = Duration::from_millis(900);
/// Cap of distinct paths per window; past that only `dropped` is counted.
const MAX_PATHS: usize = 400;

/// Directories that never interest the user and generate an event avalanche.
use crate::file_policy::{excluded_directory, DirectoryUse};

/// Keeps the watcher alive; dropping it turns off notify and, with the channel
/// closed, the flush thread ends on its own.
pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    pub root: PathBuf,
}

/// Accumulated state of a path inside the window.
#[derive(Default)]
struct PathState {
    saw_create: bool,
}

/// What is already queued for the flusher: a path, and whether the queued
/// event was a create (the one fact `ingest` keeps per path). A repeat of
/// the same key adds nothing to the window, so it is not sent and, above
/// all, not counted as lost when the channel is full.
type Pending = Mutex<HashSet<(PathBuf, bool)>>;

pub fn watch<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    root: PathBuf,
) -> Result<WatchHandle, String> {
    if !root.is_dir() {
        return Err(format!("pasta inexistente: {}", root.display()));
    }

    let (tx, rx) = mpsc::sync_channel::<Event>(MAX_PATHS);
    let overflow = Arc::new(AtomicU32::new(0));
    let callback_overflow = overflow.clone();
    let pending: Arc<Pending> = Arc::new(Mutex::new(HashSet::new()));
    let callback_pending = pending.clone();
    let filter_root = root.clone();
    // Worked out once instead of on every event: the callback runs on
    // notify's own thread, and time spent there delays that thread's next
    // pass over the kernel's change buffer. It is the key `invalidate_status`
    // would work out per event for as long as the root keeps its canonical
    // path, which only renaming the folder (or re-pointing a link to it)
    // mid-watch changes.
    let status_key = crate::git::status_key(&root);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let event = match res {
            Ok(event) => event,
            Err(_) => {
                callback_overflow.fetch_add(1, Ordering::Relaxed);
                enqueue(&tx, &callback_overflow, &callback_pending, Event::new(EventKind::Any));
                return;
            }
        };
        if event.need_rescan() {
            callback_overflow.fetch_add(1, Ordering::Relaxed);
            enqueue(&tx, &callback_overflow, &callback_pending, event);
            return;
        }
        // Access is pure noise (every file read would fire an event).
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        if event.paths.iter().any(|p| !ignored(&filter_root, p)) {
            crate::git::invalidate_status_key(&status_key);
            enqueue(&tx, &callback_overflow, &callback_pending, event);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    tracing::info!(project = %project_id, path = %root.display(), "observando arquivos do projeto");

    let flusher_root = root.clone();
    std::thread::spawn(move || flusher(app, project_id, flusher_root, rx, overflow, pending));

    Ok(WatchHandle {
        _watcher: watcher,
        root,
    })
}

/// Callback-side backpressure is nonblocking; lost paths require a root rescan.
///
/// Paths already queued (same path, same create-ness) are left out before
/// the send: a burst of saves on the same few files never fills the channel
/// and never reads as a loss. Events with no path (rescan, watcher error)
/// cannot be deduplicated and always go through.
fn enqueue(tx: &mpsc::SyncSender<Event>, dropped: &AtomicU32, pending: &Pending, mut event: Event) {
    if event.paths.len() > MAX_PATHS {
        dropped.fetch_add((event.paths.len() - MAX_PATHS).min(u32::MAX as usize) as u32, Ordering::Relaxed);
        event.paths.truncate(MAX_PATHS);
    }
    if event.paths.is_empty() {
        if let Err(mpsc::TrySendError::Full(_)) = tx.try_send(event) {
            dropped.fetch_add(1, Ordering::Relaxed);
        }
        return;
    }
    let create = matches!(event.kind, EventKind::Create(_));
    // Held across the send so a refused event can take its keys back.
    let mut queued = pending.lock().unwrap_or_else(|p| p.into_inner());
    event.paths.retain(|p| queued.insert((p.clone(), create)));
    if event.paths.is_empty() {
        return;
    }
    if let Err(mpsc::TrySendError::Full(event)) = tx.try_send(event) {
        for p in &event.paths {
            queued.remove(&(p.clone(), create));
        }
        dropped.fetch_add(1, Ordering::Relaxed);
    }
}

/// Joins events by path and emits classified batches to the UI.
fn flusher<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    root: PathBuf,
    rx: mpsc::Receiver<Event>,
    overflow: Arc<AtomicU32>,
    pending: Arc<Pending>,
) {
    loop {
        // Blocks until the first activity; closed channel = watcher removed.
        let first = match rx.recv() {
            Ok(e) => e,
            Err(_) => return,
        };

        let mut batch: HashMap<PathBuf, PathState> = HashMap::new();
        let mut dropped: u32 = 0;
        let started = Instant::now();
        ingest(&mut batch, &mut dropped, &root, first);

        loop {
            match rx.recv_timeout(QUIET) {
                Ok(ev) => {
                    ingest(&mut batch, &mut dropped, &root, ev);
                    if started.elapsed() >= MAX_WINDOW {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    emit(&app, &project_id, &root, batch, dropped.saturating_add(overflow.swap(0, Ordering::Relaxed)));
                    return;
                }
            }
        }

        // The window is closed: whatever the callback queues from here on
        // is news again. A path queued between the last `recv` and this
        // clear is merely sent twice, never lost.
        pending.lock().unwrap_or_else(|p| p.into_inner()).clear();
        emit(&app, &project_id, &root, batch, dropped.saturating_add(overflow.swap(0, Ordering::Relaxed)));
    }
}

fn ingest(batch: &mut HashMap<PathBuf, PathState>, dropped: &mut u32, root: &Path, event: Event) {
    let saw_create = matches!(event.kind, EventKind::Create(_));
    for path in event.paths {
        if ignored(root, &path) {
            continue;
        }
        if let Some(st) = batch.get_mut(&path) {
            st.saw_create |= saw_create;
        } else if batch.len() >= MAX_PATHS {
            *dropped = dropped.saturating_add(1);
        } else {
            batch.insert(path, PathState { saw_create });
        }
    }
}

fn emit<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    root: &Path,
    batch: HashMap<PathBuf, PathState>,
    dropped: u32,
) {
    let at = chrono::Utc::now().timestamp_millis();
    let mut events: Vec<FileEvent> = Vec::with_capacity(batch.len());

    for (path, st) in batch {
        let exists = path.exists();
        // A created/touched directory does not interest the feed; a deleted one
        // cannot be told from a file — it enters as deleted and we live with it.
        if exists && path.is_dir() {
            continue;
        }
        let kind = if !exists {
            "deleted"
        } else if st.saw_create {
            "created"
        } else {
            "modified"
        };
        events.push(FileEvent {
            path: relative(root, &path),
            kind: kind.into(),
            at,
        });
    }

    if events.is_empty() && dropped == 0 {
        return;
    }
    events.sort_by(|a, b| a.path.cmp(&b.path));

    let _ = app.emit(
        FILES_ACTIVITY,
        FilesActivity {
            project_id: project_id.to_string(),
            root: root.to_string_lossy().into_owned(),
            events,
            dropped,
        },
    );
}

/// Path relative to the root, with `/` — the same format git also returns,
/// so the front compares the two without normalizing anything.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn ignored(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    for comp in rel.components() {
        let Component::Normal(os) = comp else {
            continue;
        };
        let name = os.to_string_lossy();
        if excluded_directory(&name, DirectoryUse::Watch) {
            return true;
        }
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Editor/OS junk that only pollutes the feed.
    name.ends_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
        || name.ends_with(".partial")
        || name.starts_with(".#")
        || name == ".DS_Store"
        || name == "Thumbs.db"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Native callbacks cannot grow an unbounded queue during a checkout.
    #[test]
    fn bounded_intake_reports_overflow_without_blocking_the_producer() {
        let (tx, rx) = mpsc::sync_channel(2);
        let dropped = std::sync::atomic::AtomicU32::new(0);
        let pending = std::sync::Mutex::new(std::collections::HashSet::new());
        for _ in 0..1000 {
            enqueue(&tx, &dropped, &pending, Event::new(EventKind::Any));
        }
        assert_eq!(rx.try_iter().count(), 2);
        assert_eq!(dropped.load(std::sync::atomic::Ordering::Relaxed), 998);
    }

    /// A burst on the same few paths is not a loss: the flusher joins events
    /// by path anyway, so nothing distinct went missing, and a `dropped`
    /// count here made the UI treat the whole window as lossy and rescan.
    #[test]
    fn a_burst_on_a_few_paths_is_not_reported_as_dropped() {
        let (tx, rx) = mpsc::sync_channel(MAX_PATHS);
        let dropped = std::sync::atomic::AtomicU32::new(0);
        let pending = std::sync::Mutex::new(std::collections::HashSet::new());
        for i in 0..5000 {
            let mut event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any));
            event.paths.push(PathBuf::from(format!("C:\\proj\\src\\file{}.rs", i % 10)));
            enqueue(&tx, &dropped, &pending, event);
        }
        assert_eq!(dropped.load(std::sync::atomic::Ordering::Relaxed), 0);
        assert_eq!(rx.try_iter().count(), 10);
    }

    /// Index-only exclusions stay explicit so manually inspected folders remain watched.
    #[test]
    fn shared_directory_policy_preserves_watcher_and_index_differences() {
        use crate::file_policy::{excluded_directory, DirectoryUse};
        assert!(excluded_directory("NODE_MODULES", DirectoryUse::Watch));
        assert!(excluded_directory("node_modules", DirectoryUse::Index));
        assert!(!excluded_directory("vendor", DirectoryUse::Watch));
        assert!(excluded_directory("vendor", DirectoryUse::Index));
        assert!(!excluded_directory(".vscode", DirectoryUse::Watch));
    }

    /// Explorer lowercases directory names, including the mixed-case Pods exclusion.
    #[test]
    fn index_directory_exclusions_match_case_insensitively() {
        use crate::file_policy::{excluded_directory, DirectoryUse};
        assert!(excluded_directory("pods", DirectoryUse::Index));
        assert!(excluded_directory("NODE_MODULES", DirectoryUse::Index));
    }

    #[test]
    fn filters_noisy_directories_and_junk() {
        let root = Path::new("C:\\proj");
        assert!(ignored(root, Path::new("C:\\proj\\.git\\index")));
        assert!(ignored(root, Path::new("C:\\proj\\node_modules\\x\\y.js")));
        assert!(ignored(root, Path::new("C:\\proj\\src\\a.swp")));
        assert!(ignored(root, Path::new("C:\\proj\\Thumbs.db")));
        assert!(ignored(root, Path::new("C:\\outro\\src\\a.rs")));
        assert!(!ignored(root, Path::new("C:\\proj\\src\\main.rs")));
        assert!(!ignored(
            root,
            Path::new("C:\\proj\\.vscode\\settings.json")
        ));
    }

    #[test]
    fn relative_path_uses_forward_slashes() {
        let root = Path::new("C:\\proj");
        assert_eq!(
            relative(root, Path::new("C:\\proj\\src\\main.rs")),
            "src/main.rs"
        );
    }
}
