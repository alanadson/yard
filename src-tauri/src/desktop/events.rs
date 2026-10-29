//! Converts core event delivery into Tauri's desktop event bus.

use tauri::{AppHandle, Emitter, Runtime};

impl<R: Runtime> crate::events::EventSink for AppHandle<R> {
    fn emit(&self, topic: &str, payload: serde_json::Value) -> Result<(), String> {
        Emitter::emit(self, topic, payload).map_err(|error| error.to_string())
    }
}
