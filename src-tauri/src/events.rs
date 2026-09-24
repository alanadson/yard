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
    #[test]
    fn the_window_event_has_the_name_and_the_shape_the_page_listens_for() {
        assert_eq!(WINDOW_SHOWN, "window://shown");
        assert_eq!(
            serde_json::to_value(WindowShown { shown: false }).unwrap(),
            serde_json::json!({ "shown": false })
        );
    }
}
