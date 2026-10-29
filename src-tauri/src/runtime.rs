//! Host services used by automation, without a desktop framework dependency.

use crate::events::EventSink;
use std::sync::Arc;

pub type Job = Box<dyn FnOnce() + Send + 'static>;

pub trait JobQueue: Send + Sync {
    fn submit(&self, lane: &str, job: Job);
}

#[derive(Clone)]
pub struct AutomationRuntime {
    jobs: Arc<dyn JobQueue>,
    events: Arc<dyn EventSink>,
}

impl AutomationRuntime {
    pub fn new(jobs: Arc<dyn JobQueue>, events: Arc<dyn EventSink>) -> Self {
        Self { jobs, events }
    }

    pub fn submit(&self, lane: &str, job: impl FnOnce() + Send + 'static) {
        let events = self.events.clone();
        self.jobs.submit(
            lane,
            Box::new(move || {
                job();
                crate::events::publish_kv_changes(events.as_ref());
            }),
        );
    }

    pub fn publish_changes(&self) {
        crate::events::publish_kv_changes(self.events.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    // A background job must publish its durable changes after the job has run.
    #[test]
    fn a_headless_job_publishes_changes_after_execution_on_its_requested_lane() {
        struct Host(Mutex<Vec<String>>);
        impl super::JobQueue for Host {
            fn submit(&self, lane: &str, job: super::Job) {
                self.0.lock().unwrap().push(lane.to_string());
                job();
            }
        }
        impl crate::events::EventSink for Host {
            fn emit(&self, topic: &str, _: serde_json::Value) -> Result<(), String> {
                self.0.lock().unwrap().push(topic.to_string());
                Ok(())
            }
        }
        crate::events::take_kv_changes();
        let host = Arc::new(Host(Mutex::new(Vec::new())));
        let runtime = super::AutomationRuntime::new(host.clone(), host.clone());
        let observed = host.clone();
        runtime.submit("pty:terminal-1", move || {
            observed.0.lock().unwrap().push("completed".into());
            crate::events::note_kv_write("queue.items");
        });
        assert_eq!(
            *host.0.lock().unwrap(),
            ["pty:terminal-1", "completed", crate::events::QUEUE_CHANGED]
        );
    }
}
