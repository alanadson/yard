//! The PTY engine's event output, behind a trait.
//!
//! The engine does not need to know what Tauri is to work — it produces
//! events, someone delivers them. Besides being the right boundary, this makes
//! the engine truly testable: tests plug in an in-memory collector and
//! check order, exit reason, and content, without spinning up a GUI runtime.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime};

use crate::events;

pub trait PtyEvents: Send + Sync + 'static {
    fn output(&self, id: &str, data: String);
    fn exit(&self, payload: events::ExitPayload);
    fn activity(&self, payload: events::ActivityPayload);
    fn idle(&self, payload: events::IdlePayload);
}

/// Delivery via the Tauri bus — what the real app uses.
pub struct TauriEvents<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> PtyEvents for TauriEvents<R> {
    fn output(&self, id: &str, data: String) {
        let _ = self.0.emit(&events::output(id), events::OutputChunk { data });
    }
    fn exit(&self, payload: events::ExitPayload) {
        let topic = events::exit(&payload.id);
        let _ = self.0.emit(&topic, payload);
    }
    fn activity(&self, payload: events::ActivityPayload) {
        let topic = events::activity(&payload.id);
        let _ = self.0.emit(&topic, payload);
    }
    fn idle(&self, payload: events::IdlePayload) {
        let _ = self.0.emit(events::AGENT_IDLE, payload);
    }
}

pub fn tauri_sink<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn PtyEvents> {
    Arc::new(TauriEvents(app.clone()))
}

/// Discards everything. Useful on paths where there is no window (tests, tools).
pub struct NullEvents;

impl PtyEvents for NullEvents {
    fn output(&self, _id: &str, _data: String) {}
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
        pub activities: Mutex<usize>,
    }

    impl PtyEvents for Arc<CollectingEvents> {
        fn output(&self, _id: &str, data: String) {
            self.output.lock().push_str(&data);
        }
        fn exit(&self, payload: events::ExitPayload) {
            self.exits.lock().push(payload);
        }
        fn activity(&self, _payload: events::ActivityPayload) {
            *self.activities.lock() += 1;
        }
        fn idle(&self, payload: events::IdlePayload) {
            self.idles.lock().push(payload);
        }
    }
}
