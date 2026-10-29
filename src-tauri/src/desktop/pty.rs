//! Adapts portable PTY frames to Tauri channels without copying their buffers.

use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::{AppHandle, Manager, Runtime};

use crate::pty::emit::PtyEvents;
use crate::pty::pages::{PageLink, PageMessage, Pages};

// The stream deliberately accepts unknown input on the frontend: its decoder
// validates both JSON envelopes and binary frames before notifying listeners.
impl specta::Type for PageMessage {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <specta_typescript::Unknown as specta::Type>::definition(types)
    }
}

impl IpcResponse for PageMessage {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(match self {
            PageMessage::Json(text) => InvokeResponseBody::Json(text),
            PageMessage::Raw(bytes) => InvokeResponseBody::Raw(bytes),
        })
    }
}

impl PageLink for Channel<PageMessage> {
    fn send(&self, body: PageMessage) {
        // A closed webview no longer has a listener for this channel.
        let _ = Channel::send(self, body);
    }
}

pub fn event_sink<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn PtyEvents> {
    app.state::<Arc<Pages>>().inner().clone()
}
