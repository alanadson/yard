//! Watcher of the agents' session directories (§F4).
//!
//! When Claude Code writes a new line to the `.jsonl`, the project's session
//! list went stale. Instead of the UI polling from time to time, the backend
//! notifies: `agents://changed`.
//!
//! 800 ms debounce because one agent turn writes dozens of times per
//! second — without it, the event becomes a DDoS on the UI itself.

use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use tauri::{AppHandle, Emitter, Runtime};

const DEBOUNCE: Duration = Duration::from_millis(800);

pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let roots: Vec<_> = ["claude", "codex", "opencode"]
            .iter()
            .filter_map(|kind| crate::agents::resolver::sessions_root(kind))
            .filter(|p| p.exists())
            .collect();

        if roots.is_empty() {
            tracing::info!("nenhum diretorio de sessao de agente encontrado; watcher parado");
            return;
        }

        let app_for_events = app.clone();
        let debouncer = new_debouncer(DEBOUNCE, move |res| {
            if let Ok(events) = res {
                let events: Vec<notify_debouncer_mini::DebouncedEvent> = events;
                if !events.is_empty() {
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

        // The debouncer needs to stay alive; this thread is its owner.
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}
