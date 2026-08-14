//! `AppState` — everything the backend keeps between calls.
//!
//! One rule only: **the backend is the source of truth** (§4.3). The UI never
//! owns process state; it mounts a component and calls `attach`, and whatever
//! is here is what it draws.

use std::collections::HashMap;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::agents::resolver::AgentInfo;
use crate::browsers::BrowserInfo;
use crate::files::WatchHandle;
use crate::process_tree::ProcSnapshot;
use crate::pty::teardown::PtyStatus;
use crate::pty::PtyHandle;

pub struct AppState {
    /// Live PTYs, by id.
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
    /// Last known state of each id — including ones that already died,
    /// so the UI can explain the exit banner after a reload.
    pub statuses: Mutex<HashMap<String, PtyStatus>>,
    /// Shared process scan (2 s cache).
    pub procs: Mutex<ProcSnapshot>,
    /// SQLite. `Connection` is Send but not Sync — the Mutex takes care of it.
    pub db: Mutex<Connection>,
    /// Result of agent CLI detection (expensive: runs `--version`).
    pub agents_cache: Mutex<Option<Vec<AgentInfo>>>,
    /// Result of browser detection (cheap path lookup + optional `--version`).
    pub browsers_cache: Mutex<Option<Vec<BrowserInfo>>>,
    /// File watchers per project ("live" feed of the Files panel).
    pub file_watchers: Mutex<HashMap<String, WatchHandle>>,
    /// Live session tails ("Ao Vivo" overlay) — stop flags by tail id.
    pub session_tails: Mutex<HashMap<String, crate::agents::tail::TailStop>>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self {
            ptys: Mutex::new(HashMap::new()),
            statuses: Mutex::new(HashMap::new()),
            procs: Mutex::new(ProcSnapshot::default()),
            db: Mutex::new(db),
            agents_cache: Mutex::new(None),
            browsers_cache: Mutex::new(None),
            file_watchers: Mutex::new(HashMap::new()),
            session_tails: Mutex::new(HashMap::new()),
        }
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.ptys.lock().keys().cloned().collect()
    }
}
