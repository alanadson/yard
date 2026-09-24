//! The PTY engine's event output, behind a trait.
//!
//! The engine does not need to know what Tauri is to work — it produces
//! events, someone delivers them. Besides being the right boundary, this makes
//! the engine truly testable: tests plug in an in-memory collector and
//! check order, exit reason, and content, without spinning up a GUI runtime.

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};

use super::pages::Pages;
use crate::events;

pub trait PtyEvents: Send + Sync + 'static {
    /// `true` when a page took the chunk, and so owes an acknowledgement for
    /// it (`PtyShared::ack`); `false` when nobody was showing the terminal.
    fn output(&self, id: &str, data: String) -> bool;
    fn exit(&self, payload: events::ExitPayload);
    fn activity(&self, payload: events::ActivityPayload);
    fn idle(&self, payload: events::IdlePayload);
}

/// Delivery to the pages over their IPC channels (`pages.rs`), what the real
/// app uses. One `Pages` for the whole app, managed by Tauri, so every
/// terminal's events reach a page through the same links, in the order the
/// engine produced them.
pub fn tauri_sink<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn PtyEvents> {
    app.state::<Arc<Pages>>().inner().clone()
}

/// Discards everything. Useful on paths where there is no window (tests, tools).
pub struct NullEvents;

impl PtyEvents for NullEvents {
    fn output(&self, _id: &str, _data: String) -> bool {
        false
    }
    fn exit(&self, _payload: events::ExitPayload) {}
    fn activity(&self, _payload: events::ActivityPayload) {}
    fn idle(&self, _payload: events::IdlePayload) {}
}

#[cfg(test)]
pub mod collect {
    use super::*;
    use parking_lot::Mutex;

    /// In-memory collector for assertions in the tests.
    #[derive(Default)]
    pub struct CollectingEvents {
        pub output: Mutex<String>,
        pub exits: Mutex<Vec<events::ExitPayload>>,
        pub idles: Mutex<Vec<events::IdlePayload>>,
        /// Every `activity` heartbeat, in the order it went out.
        pub beats: Mutex<Vec<events::ActivityPayload>>,
    }

    impl PtyEvents for Arc<CollectingEvents> {
        fn output(&self, _id: &str, data: String) -> bool {
            self.output.lock().push_str(&data);
            true
        }
        fn exit(&self, payload: events::ExitPayload) {
            self.exits.lock().push(payload);
        }
        fn activity(&self, payload: events::ActivityPayload) {
            self.beats.lock().push(payload);
        }
        fn idle(&self, payload: events::IdlePayload) {
            self.idles.lock().push(payload);
        }
    }
}
