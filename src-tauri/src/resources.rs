//! Resource supervisor: one tick every 2 s with RAM/CPU per PTY tree.
//!
//! Feeds the HUD and the "suspend group" button — the RAM valve when many
//! agents are alive at the same time.
//!
//! The tick is also the catch-all for whether the window is on screen: the
//! page hides it to the tray with `hide()`, which raises no window event, so
//! every tick reads the window first (`window_state::observe`). Behind a
//! hidden window it measures nothing at all.
//!
//! A terminal with a Job Object is measured from the job's own process list,
//! refreshing just those processes; only a terminal without one pays for the
//! walk over the machine's whole process table (~400 processes, 20 to 70 ms
//! of CPU).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::events;
use crate::state::AppState;

const TICK: Duration = Duration::from_secs(2);

pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);

        crate::window_state::observe(&app);

        let state = app.state::<Arc<AppState>>();
        let handles: Vec<_> = state
            .ptys
            .lock()
            .iter()
            .map(|(id, h)| (id.clone(), h.clone()))
            .collect();
        if !tick_measures(state.window_shown.load(Ordering::Acquire), handles.len()) {
            continue;
        }
        // Read under each terminal's own lock, released before the process
        // table is: the job's list is one kernel call.
        let ids: Vec<(String, Option<u32>, Option<Vec<u32>>)> = handles
            .into_iter()
            .map(|(id, h)| {
                let h = h.lock();
                (id, h.pid, h.job_pids())
            })
            .collect();

        let mut per_pty = Vec::with_capacity(ids.len());
        let mut total = 0.0f32;
        {
            let mut procs = state.procs.lock();
            for (id, pid, members) in ids {
                let (pids, rss_mb, cpu) = match (members, pid) {
                    (Some(members), _) => procs.stats_of(&members),
                    (None, Some(p)) => procs.tree_stats(p),
                    (None, None) => (vec![], 0.0, 0.0),
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
            procs.memory_stats()
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

/// Whether a tick measures anything: live terminals, in a window someone can
/// see. Behind a hidden or minimized window the HUD is on nobody's screen,
/// and it catches up at the first tick after the window comes back.
fn tick_measures(window_shown: bool, terminals: usize) -> bool {
    window_shown && terminals > 0
}

#[cfg(test)]
mod tests {
    //! The tick used to scan every process on the machine every 2 s for as
    //! long as a terminal existed, window on screen or not: 20 to 70 ms of
    //! CPU for a HUD nobody could see. These are the rules for when it
    //! measures at all.
    use super::*;

    #[test]
    fn a_tick_measures_only_live_terminals_on_a_window_that_is_on_screen() {
        assert!(tick_measures(true, 3));
        assert!(!tick_measures(false, 3), "hidden to the tray or minimized");
        assert!(!tick_measures(true, 0), "no terminal to measure");
        assert!(!tick_measures(false, 0));
    }
}
