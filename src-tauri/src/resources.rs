//! Resource supervisor: one tick every 2 s with RAM/CPU per PTY tree.
//!
//! Feeds the HUD and the "suspend group" button — the RAM valve when many
//! agents are alive at the same time.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::events;
use crate::state::AppState;

const TICK: Duration = Duration::from_secs(2);

pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);

        let state = app.state::<Arc<AppState>>();
        let ids: Vec<(String, Option<u32>)> = state
            .ptys
            .lock()
            .iter()
            .map(|(id, h)| (id.clone(), h.pid))
            .collect();

        // With no live terminals there is nothing to measure — skip scanning
        // processes for nothing.
        if ids.is_empty() {
            continue;
        }

        let mut per_pty = Vec::with_capacity(ids.len());
        let mut total = 0.0f32;
        {
            let mut procs = state.procs.lock();
            for (id, pid) in ids {
                let (pids, rss_mb, cpu) = match pid {
                    Some(p) => procs.tree_stats(p),
                    None => (vec![], 0.0, 0.0),
                };
                total += rss_mb;
                per_pty.push(events::PtyResource {
                    id,
                    pids,
                    rss_mb,
                    cpu,
                });
            }
        }

        let (available, total_mem) = {
            let mut procs = state.procs.lock();
            (procs.available_mb(), procs.total_mb())
        };

        let _ = app.emit(
            events::RESOURCES_TICK,
            events::ResourcesTick {
                total_rss_mb: total,
                system_available_mb: available,
                system_total_mb: total_mem,
                per_pty,
            },
        );
    });
}
