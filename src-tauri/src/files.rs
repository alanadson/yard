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

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
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
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vs",
];

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

pub fn watch<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    root: PathBuf,
) -> Result<WatchHandle, String> {
    if !root.is_dir() {
        return Err(format!("pasta inexistente: {}", root.display()));
    }

    let (tx, rx) = mpsc::channel::<Event>();
    let filter_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        // Access is pure noise (every file read would fire an event).
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        if event.paths.iter().any(|p| !ignored(&filter_root, p)) {
            let _ = tx.send(event);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    tracing::info!(project = %project_id, path = %root.display(), "observando arquivos do projeto");

    let flusher_root = root.clone();
    std::thread::spawn(move || flusher(app, project_id, flusher_root, rx));

    Ok(WatchHandle {
        _watcher: watcher,
        root,
    })
}

/// Joins events by path and emits classified batches to the UI.
fn flusher<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    root: PathBuf,
    rx: mpsc::Receiver<Event>,
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
                    emit(&app, &project_id, &root, batch, dropped);
                    return;
                }
            }
        }

        emit(&app, &project_id, &root, batch, dropped);
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
            *dropped += 1;
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
        if IGNORED_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d)) {
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
