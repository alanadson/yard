//! Keep-awake ("modo energético") — keeps Windows from sleeping and from
//! turning the display off while the Yard (or an agent) is working.
//!
//! `SetThreadExecutionState(ES_CONTINUOUS | …)` is *per thread* and dies with
//! it. Tauri commands run on a pool — each call may land on a different
//! thread, so applying the state inline would lose it on the next request.
//! A dedicated thread owns the state for the life of the process; when the
//! process exits, Windows clears everything on its own, so there is no
//! teardown to get wrong.

use std::sync::mpsc::Sender;
use std::sync::OnceLock;

static WORKER: OnceLock<Sender<bool>> = OnceLock::new();

/// Turns "the PC does not suspend nor turns the screen off" on or off.
/// Idempotent: repeated states are swallowed inside the worker.
pub fn set_keep_awake(on: bool) {
    let tx = WORKER.get_or_init(spawn_worker);
    if tx.send(on).is_err() {
        tracing::error!("a thread do modo energético morreu; pedido ignorado");
    }
}

#[cfg(windows)]
fn spawn_worker() -> Sender<bool> {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            let mut current = false;
            while let Ok(on) = rx.recv() {
                if on == current {
                    continue;
                }
                let flags = if on {
                    ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
                } else {
                    ES_CONTINUOUS
                };
                // 0 = the request was refused (documented, though unheard of
                // for ES_CONTINUOUS); `atual` keeps the last state that took,
                // so a later retry with the same wish is not swallowed.
                if unsafe { SetThreadExecutionState(flags) } == 0 {
                    tracing::warn!(on, "SetThreadExecutionState recusou o pedido");
                } else {
                    current = on;
                    tracing::info!(
                        "modo energético {}",
                        if on { "ligado: o PC não suspende" } else { "desligado" }
                    );
                }
            }
        })
        .expect("não consegui criar a thread do modo energético");
    tx
}

#[cfg(not(windows))]
fn spawn_worker() -> Sender<bool> {
    // Nothing to hold outside Windows; the channel exists only for the API.
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::spawn(move || while rx.recv().is_ok() {});
    tx
}
