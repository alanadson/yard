//! Event contract between Rust and the UI. This file is the **only** source of
//! truth on the Rust side; the TypeScript mirror is `src/lib/ipc.ts`.
//!
//! Rule: no module writes a topic name by hand — use the helpers.

use serde::Serialize;

/// Output chunk of a PTY. Coalesced (~16 ms / 32 KB; 450 ms if invisible).
pub fn output(id: &str) -> String {
    format!("pty://output/{id}")
}

/// Root process exited.
pub fn exit(id: &str) -> String {
    format!("pty://exit/{id}")
}

/// Activity heartbeat — feeds the "agent finished" detector.
pub fn activity(id: &str) -> String {
    format!("pty://activity/{id}")
}

/// A PTY marked as `agent` went idle after working.
pub const AGENT_IDLE: &str = "pty://idle";

/// Watcher saw a new/updated session of some agent.
pub const AGENTS_CHANGED: &str = "agents://changed";

/// Batch of typed events from a live session tail ("Ao Vivo" overlay).
/// Payload: `agents::tail::SessionFeed`.
pub const SESSION_FEED: &str = "session://feed";

/// Batch of file activity in a watched project ("live" feed).
pub const FILES_ACTIVITY: &str = "files://activity";

/// Resource supervisor tick (~2 s).
pub const RESOURCES_TICK: &str = "resources://tick";

#[derive(Clone, Serialize)]
pub struct OutputChunk {
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    pub id: String,
    pub code: Option<i32>,
    /// `normal` | `killed` | `suspended` | `restarted` | `failed`
    pub reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPayload {
    pub id: String,
    /// Epoch in milliseconds of the last byte received.
    pub last_byte_at: i64,
    /// How long it has been without receiving bytes.
    pub idle_ms: u64,
}

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
