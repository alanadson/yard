//! Event contract between Rust and the UI. This file is the **only** source of
//! truth on the Rust side; the TypeScript mirror is `src/lib/ipc.ts`.
//!
//! Rule: no module writes a topic name by hand — use the helpers.
//!
//! A terminal's own events (output, exit, activity heartbeat, idle) are not on
//! the bus: they travel on one ordered IPC channel per page (`pty/pages.rs`),
//! with the payloads below.

use serde::Serialize;

/// Watcher saw a new/updated session of some agent.
pub const AGENTS_CHANGED: &str = "agents://changed";
pub const NATIVE_HOOK: &str = "automation://hook";

/// The durable queue (`queue.items`) changed: an edit, an enqueue, a delivery
/// state, a reconciliation. Payload `()`.
pub const QUEUE_CHANGED: &str = "queue://changed";
/// A native flow run (`native.flow.run.*`) was written: start, stage change,
/// finish, cancel. Payload `()`.
pub const FLOW_CHANGED: &str = "flow://changed";
/// The pending checkpoint notices changed: a failure recorded, notices
/// acknowledged. Payload `()`.
pub const CHECKPOINT_NOTICES: &str = "checkpoint://notices";
/// A routine's run state (`routine.run.*`) changed. Payload `()`.
pub const ROUTINE_CHANGED: &str = "routine://changed";

/// What a stretch of work changed in the automation records of the `kv`
/// table, as the topics that announce it.
///
/// Every write of those records goes through `persistence::db::kv_set` (or
/// `kv_delete`), which notes the change on the writing thread
/// (`note_kv_write`). Whoever ran the work takes the notes afterwards
/// (`take_kv_changes`) and publishes them: an IPC command, the scheduler, a
/// lane job, the bridge. So "every write emits" holds by construction, and the
/// decision stays testable without a Tauri runtime.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KvChanges(u8);

impl KvChanges {
    const QUEUE: u8 = 1;
    const FLOW: u8 = 1 << 1;
    const ROUTINE: u8 = 1 << 2;
    const NOTICES: u8 = 1 << 3;
    const PAUSE: u8 = 1 << 4;

    /// The change a write of `key` makes.
    pub fn of_key(key: &str) -> Self {
        Self(if key == "queue.items" {
            Self::QUEUE
        } else if key.starts_with("native.flow.run.") {
            Self::FLOW
        } else if key.starts_with("routine.run.") {
            Self::ROUTINE
        } else if key == "checkpoint.notices" {
            Self::NOTICES
        } else if key == crate::scheduler::AUTOMATION_PAUSED {
            Self::PAUSE
        } else {
            0
        })
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The events to emit, in a fixed order.
    pub fn topics(self) -> Vec<&'static str> {
        [(Self::QUEUE, QUEUE_CHANGED), (Self::FLOW, FLOW_CHANGED), (Self::ROUTINE, ROUTINE_CHANGED), (Self::NOTICES, CHECKPOINT_NOTICES)]
            .into_iter()
            .filter(|(bit, _)| self.0 & bit != 0)
            .map(|(_, topic)| topic)
            .collect()
    }

    /// Whether the native scheduler has new work to look at: queued work, a
    /// flow (a start), or the pause switched.
    pub fn wakes_scheduler(self) -> bool {
        self.0 & (Self::QUEUE | Self::FLOW | Self::PAUSE) != 0
    }
}

thread_local! {
    static KV_JOURNAL: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

/// Notes, on this thread, that `key` was just written with a new value.
pub fn note_kv_write(key: &str) {
    let change = KvChanges::of_key(key);
    if !change.is_empty() {
        KV_JOURNAL.with(|journal| journal.set(journal.get() | change.0));
    }
}

/// The changes noted on this thread since the last take, and forgets them.
pub fn take_kv_changes() -> KvChanges {
    KvChanges(KV_JOURNAL.with(|journal| journal.replace(0)))
}

/// Takes this thread's noted changes and emits their events. Returns them, so
/// the caller can decide whether the scheduler should look again.
pub fn publish_kv_changes<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> KvChanges {
    let changes = take_kv_changes();
    emit_kv_changes(app, changes);
    changes
}

/// Emits the events of changes taken elsewhere (work that ran on another
/// thread, like the blocking pool).
pub fn emit_kv_changes<R: tauri::Runtime>(app: &tauri::AppHandle<R>, changes: KvChanges) {
    use tauri::Emitter;
    for topic in changes.topics() {
        if let Err(error) = app.emit(topic, ()) {
            tracing::warn!(%error, topic, "automation change could not be delivered to the page");
        }
    }
}

/// Batch of typed events from a live session tail ("Ao Vivo" overlay).
/// Payload: `agents::tail::SessionFeed`.
pub const SESSION_FEED: &str = "session://feed";

/// Batch of file activity in a watched project ("live" feed).
pub const FILES_ACTIVITY: &str = "files://activity";

/// Resource supervisor tick (~2 s).
pub const RESOURCES_TICK: &str = "resources://tick";

/// The main window came on screen or left it (hidden to the tray, minimized),
/// on every change and only then. Payload: `WindowShown`.
pub const WINDOW_SHOWN: &str = "window://shown";

#[derive(Clone, Serialize)]
pub struct WindowShown {
    pub shown: bool,
}

/// Root process exited.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    pub id: String,
    pub code: Option<i32>,
    /// `normal` | `killed` | `suspended` | `restarted` | `failed`
    pub reason: String,
}

/// Activity heartbeat: feeds the "agent finished" detector.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPayload {
    pub id: String,
    /// Epoch in milliseconds of the last byte received.
    pub last_byte_at: i64,
    /// How long it has been without receiving bytes.
    pub idle_ms: u64,
}

/// A PTY marked as `agent` went idle after working.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdlePayload {
    pub id: String,
    pub title: String,
    pub idle_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEvent {
    /// Relative to the project root, with `/` (same as git).
    pub path: String,
    /// `created` | `modified` | `deleted`
    pub kind: String,
    /// Epoch in milliseconds of the batch flush.
    pub at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesActivity {
    pub project_id: String,
    pub root: String,
    pub events: Vec<FileEvent>,
    /// Paths past the window cap — counted only, not listed.
    pub dropped: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResource {
    pub id: String,
    pub pids: Vec<u32>,
    pub rss_mb: f32,
    pub cpu: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesTick {
    pub total_rss_mb: f32,
    pub system_available_mb: f32,
    pub system_total_mb: f32,
    pub per_pty: Vec<PtyResource>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page listens for this exact name and shape (`src/lib/windowShown.ts`
    /// reads `payload.shown`). A rename on either side leaves the page
    /// believing the window is on screen forever, and nothing fails.
    /// The page refetches its queue, flows, routines and checkpoint notices
    /// when these arrive instead of polling; a renamed topic leaves a stale
    /// panel and nothing fails.
    #[test]
    fn the_automation_events_have_the_names_the_page_listens_for() {
        assert_eq!(QUEUE_CHANGED, "queue://changed");
        assert_eq!(FLOW_CHANGED, "flow://changed");
        assert_eq!(CHECKPOINT_NOTICES, "checkpoint://notices");
        assert_eq!(ROUTINE_CHANGED, "routine://changed");
    }

    #[test]
    fn each_automation_record_maps_to_the_event_that_describes_it() {
        let topics = |key: &str| KvChanges::of_key(key).topics();
        assert_eq!(topics("queue.items"), vec![QUEUE_CHANGED]);
        assert_eq!(topics("native.flow.run.0a1b"), vec![FLOW_CHANGED]);
        assert_eq!(topics("routine.run.0a1b"), vec![ROUTINE_CHANGED]);
        assert_eq!(topics("checkpoint.notices"), vec![CHECKPOINT_NOTICES]);
        for silent in ["theme", "checkpoint.notice.history", "queue.itemsx", "automation.paused"] {
            assert!(topics(silent).is_empty(), "{silent}");
        }
        for waking in ["queue.items", "native.flow.run.0a1b", "automation.paused"] {
            assert!(KvChanges::of_key(waking).wakes_scheduler(), "{waking}");
        }
        assert!(!KvChanges::of_key("routine.run.0a1b").wakes_scheduler());
        assert!(!KvChanges::of_key("theme").wakes_scheduler());
    }

    #[test]
    fn the_changes_a_thread_recorded_are_taken_once_and_in_topic_order() {
        let _ = take_kv_changes();
        note_kv_write("routine.run.0a1b");
        note_kv_write("queue.items");
        note_kv_write("queue.items");
        assert_eq!(take_kv_changes().topics(), vec![QUEUE_CHANGED, ROUTINE_CHANGED]);
        assert!(take_kv_changes().is_empty());
    }

    #[test]
    fn the_window_event_has_the_name_and_the_shape_the_page_listens_for() {
        assert_eq!(WINDOW_SHOWN, "window://shown");
        assert_eq!(
            serde_json::to_value(WindowShown { shown: false }).unwrap(),
            serde_json::json!({ "shown": false })
        );
    }
}
