//! Watcher of the agents' session directories (§F4).
//!
//! When Claude Code writes a new line to the `.jsonl`, the project's session
//! list went stale. Instead of the UI polling from time to time, the backend
//! notifies: `agents://changed`.
//!
//! 800 ms debounce because one agent turn writes dozens of times per
//! second — without it, the event becomes a DDoS on the UI itself.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const DEBOUNCE: Duration = Duration::from_millis(800);
/// How soon a change held while the window was hidden is announced after it
/// comes back.
const CATCH_UP: Duration = Duration::from_secs(1);

fn watch_roots(mut system: Vec<std::path::PathBuf>, app_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    system.push(app_dir.join("accounts"));
    system.into_iter().filter(|root| root.is_dir()).collect()
}

/// Session changes seen while the main window was off screen: held, and
/// announced once when it is back (`tick`).
#[derive(Default)]
pub(crate) struct HeldChanges(AtomicBool);

impl HeldChanges {
    /// A batch of changes. Whether to announce it now: with the window shown,
    /// yes; hidden, it is held for the first tick after the window is back.
    pub(crate) fn changed(&self, shown: bool) -> bool {
        if !shown {
            self.0.store(true, Ordering::Release);
        }
        shown
    }

    /// A periodic check: whether a held change is due now.
    pub(crate) fn tick(&self, shown: bool) -> bool {
        shown && self.0.swap(false, Ordering::AcqRel)
    }
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let shown = app.state::<Arc<crate::state::AppState>>().window_shown.clone();
        let held = Arc::new(HeldChanges::default());
        let app_dir = crate::paths::app_dir();
        let _ = std::fs::create_dir_all(app_dir.join("accounts"));
        let system: Vec<_> = ["claude", "codex", "opencode"]
            .iter()
            .filter_map(|kind| crate::agents::resolver::sessions_root(kind))
            .filter(|p| p.exists())
            .collect();
        let roots = watch_roots(system, &app_dir);

        if roots.is_empty() {
            tracing::info!("nenhum diretorio de sessao de agente encontrado; watcher parado");
            return;
        }

        let app_for_events = app.clone();
        let (held_for_events, shown_for_events) = (held.clone(), shown.clone());
        let debouncer = new_debouncer(DEBOUNCE, move |res| {
            if let Ok(events) = res {
                let events: Vec<notify_debouncer_mini::DebouncedEvent> = events;
                if !events.is_empty() && held_for_events.changed(shown_for_events.load(Ordering::Acquire)) {
                    let _ = app_for_events.emit(crate::events::AGENTS_CHANGED, ());
                }
            }
        });

        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(error = %e, "nao consegui iniciar o watcher de sessoes");
                return;
            }
        };

        for root in &roots {
            if let Err(e) = debouncer.watcher().watch(root, RecursiveMode::Recursive) {
                tracing::warn!(path = %root.display(), error = %e, "falha ao observar diretorio");
            } else {
                tracing::info!(path = %root.display(), "observando sessoes de agente");
            }
        }

        // The debouncer needs to stay alive; this thread is its owner. It
        // also announces, once, what changed while the window was hidden.
        loop {
            std::thread::sleep(CATCH_UP);
            if held.tick(shown.load(Ordering::Acquire)) {
                let _ = app.emit(crate::events::AGENTS_CHANGED, ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    // With the window in the tray nobody reads the session list, yet every
    // turn of every agent announced a change each 800 ms. One held change is
    // enough to refresh the page when the window comes back.
    use super::*;

    #[test]
    fn managed_account_directories_are_watched_before_any_provider_has_sessions() {
        let root = std::env::temp_dir().join(format!("yard-account-watch-{}", std::process::id()));
        std::fs::create_dir_all(root.join("accounts")).unwrap();
        let roots = watch_roots(Vec::new(), &root);
        assert_eq!(roots, [root.join("accounts")]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_while_hidden_are_announced_once_when_the_window_comes_back() {
        let held = HeldChanges::default();
        assert!(held.changed(true), "on screen: announced right away");
        assert!(!held.tick(true), "nothing was held");
        assert!(!held.changed(false));
        assert!(!held.changed(false));
        assert!(!held.tick(false), "still hidden");
        assert!(held.tick(true), "back on screen: announced");
        assert!(!held.tick(true), "announced once");
    }
}
