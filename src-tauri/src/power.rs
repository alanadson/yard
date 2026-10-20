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

/// What the worker holds: `(on, display)`.
type Wish = (bool, bool);

static WORKER: OnceLock<Sender<Wish>> = OnceLock::new();

/// Turns "the PC does not suspend" on or off, and with `display` also keeps
/// the screen from turning off. Idempotent: repeated states are swallowed
/// inside the worker.
pub fn set_keep_awake(on: bool, display: bool) {
    let tx = WORKER.get_or_init(spawn_worker);
    if tx.send((on, display)).is_err() {
        tracing::error!("a thread do modo energético morreu; pedido ignorado");
    }
}

/// The execution state for a wish: the system held awake while `on`, the
/// display too only when asked; off releases both.
#[cfg(windows)]
fn execution_flags(on: bool, display: bool) -> windows_sys::Win32::System::Power::EXECUTION_STATE {
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    match (on, display) {
        (true, true) => ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
        (true, false) => ES_CONTINUOUS | ES_SYSTEM_REQUIRED,
        (false, _) => ES_CONTINUOUS,
    }
}

#[cfg(windows)]
fn spawn_worker() -> Sender<Wish> {
    use windows_sys::Win32::System::Power::SetThreadExecutionState;

    let (tx, rx) = std::sync::mpsc::channel::<Wish>();
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            let mut current = execution_flags(false, false);
            while let Ok((on, screen)) = rx.recv() {
                let flags = execution_flags(on, screen);
                if flags == current {
                    continue;
                }
                // 0 = the request was refused (documented, though unheard of
                // for ES_CONTINUOUS); `current` keeps the last state that
                // took, so a later retry with the same wish is not swallowed.
                if unsafe { SetThreadExecutionState(flags) } == 0 {
                    tracing::warn!(on, screen, "SetThreadExecutionState recusou o pedido");
                } else {
                    current = flags;
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};

    /// The regression: keep-awake always held the display on, so a monitor
    /// stayed lit (and the screen unlocked) all night for an agent that only
    /// needed the PC not to sleep. The display is held only when asked.
    #[test]
    fn keep_awake_holds_the_display_only_when_asked_and_off_releases_everything() {
        assert_eq!(execution_flags(true, true), ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        assert_eq!(execution_flags(true, false), ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        assert_eq!(execution_flags(false, true), ES_CONTINUOUS);
        assert_eq!(execution_flags(false, false), ES_CONTINUOUS);
    }
}

#[cfg(not(windows))]
fn spawn_worker() -> Sender<Wish> {
    // Nothing to hold outside Windows; the channel exists only for the API.
    let (tx, rx) = std::sync::mpsc::channel::<Wish>();
    std::thread::spawn(move || while rx.recv().is_ok() {});
    tx
}
