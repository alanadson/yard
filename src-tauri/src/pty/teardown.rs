//! Explicit shutdown states (§5.6).
//!
//! "Closing the panel" does not kill the process — that is the golden rule of §4.3.
//! When the process *actually* dies, the reason matters: the UI shows a different
//! banner, autosave decides whether to keep resume metadata, and the agent
//! detector ignores exits we caused.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExitReason {
    /// The process exited on its own (user typed `exit`, agent finished).
    Normal,
    /// Explicit `kill_pty` — entire tree taken down.
    Killed,
    /// `suspend_pty` — killed on purpose, scrollback and resume preserved.
    Suspended,
    /// Killed as part of a `restart_pty`.
    Restarted,
    /// Never even ran (spawn failed) or died with an I/O error.
    Failed,
}

impl ExitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ExitReason::Normal => "normal",
            ExitReason::Killed => "killed",
            ExitReason::Suspended => "suspended",
            ExitReason::Restarted => "restarted",
            ExitReason::Failed => "failed",
        }
    }
}

/// Observable state of a terminal, from the backend's point of view.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PtyStatus {
    Running,
    #[serde(rename_all = "camelCase")]
    Exited {
        code: Option<i32>,
        reason: ExitReason,
        at: i64,
    },
}
