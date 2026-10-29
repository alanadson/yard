//! Connect the automation core to desktop state, worker lanes and events.

use crate::runtime::{AutomationRuntime, Job, JobQueue};
use std::sync::Arc;
use tauri::Manager;

struct DesktopQueue;

impl JobQueue for DesktopQueue {
    fn submit(&self, lane: &str, job: Job) {
        crate::lanes::lanes().submit(lane, job);
    }
}

pub fn start(app: &tauri::AppHandle) {
    let state = app.state::<Arc<crate::state::AppState>>().inner().clone();
    let runtime = AutomationRuntime::new(Arc::new(DesktopQueue), Arc::new(app.clone()));
    crate::scheduler::start(state, runtime);
}
