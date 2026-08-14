//! Process tree per PTY, on top of `sysinfo` (§5.5).
//!
//! Two lessons baked in here:
//!
//! 1. **Cache.** Scanning every process is expensive; the resource HUD asks
//!    for this every 2 s and kill asks at the worst moment. The parent->children
//!    map is rebuilt at most every 2 s.
//! 2. **Threads are not processes.** In the `sysinfo` map, threads show up as
//!    "PIDs" on some platforms; without filtering `thread_kind()`, the tree
//!    inflates and kill gets slow. On Windows `thread_kind()` is always `None`,
//!    but the filter stays for portability and costs nothing.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const CACHE_TTL: Duration = Duration::from_secs(2);

pub struct ProcSnapshot {
    sys: System,
    refreshed_at: Option<Instant>,
}

impl Default for ProcSnapshot {
    fn default() -> Self {
        Self {
            sys: System::new(),
            refreshed_at: None,
        }
    }
}

impl ProcSnapshot {
    fn refresh_if_stale(&mut self, force: bool) {
        let stale = match self.refreshed_at {
            Some(t) => t.elapsed() >= CACHE_TTL,
            None => true,
        };
        if stale || force {
            self.sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::new().with_memory().with_cpu(),
            );
            self.refreshed_at = Some(Instant::now());
        }
    }

    /// Parent -> children map, already without threads.
    fn children_map(&self) -> HashMap<Pid, Vec<Pid>> {
        let mut map: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, proc) in self.sys.processes() {
            if proc.thread_kind().is_some() {
                continue;
            }
            if let Some(parent) = proc.parent() {
                map.entry(parent).or_default().push(*pid);
            }
        }
        map
    }

    /// Every PID in the tree of `root`, including itself, in BFS order.
    pub fn tree_of(&mut self, root: u32) -> Vec<u32> {
        self.refresh_if_stale(false);
        let root = Pid::from_u32(root);
        if self.sys.process(root).is_none() {
            return Vec::new();
        }
        let map = self.children_map();
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([root]);
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            out.push(pid.as_u32());
            if let Some(kids) = map.get(&pid) {
                queue.extend(kids.iter().copied());
            }
            // Safety belt against recycled-PID cycles.
            if out.len() > 4096 {
                break;
            }
        }
        out
    }

    /// `(pids, rss_mb, cpu_percent)` summed over the tree.
    pub fn tree_stats(&mut self, root: u32) -> (Vec<u32>, f32, f32) {
        let pids = self.tree_of(root);
        let mut rss: u64 = 0;
        let mut cpu: f32 = 0.0;
        for pid in &pids {
            if let Some(p) = self.sys.process(Pid::from_u32(*pid)) {
                rss += p.memory();
                cpu += p.cpu_usage();
            }
        }
        (pids, rss as f32 / (1024.0 * 1024.0), cpu)
    }

    /// Kills the tree from leaves to root. Used as fallback when the Job
    /// Object cannot be created or the assign failed.
    pub fn kill_tree(&mut self, root: u32) -> usize {
        self.refresh_if_stale(true);
        let pids = self.tree_of(root);
        let mut killed = 0;
        // Reverse BFS order = leaves before root: keeps the root from dying
        // and the OS reparenting the children before we reach them.
        for pid in pids.iter().rev() {
            if let Some(p) = self.sys.process(Pid::from_u32(*pid)) {
                if p.kill() {
                    killed += 1;
                }
            }
        }
        killed
    }

    /// Available system memory, in MB.
    ///
    /// Read-only. Never try to "reserve" based on this: on Windows
    /// `available_memory()` sees only free physical RAM, ignoring the commit
    /// limit (RAM + page file), and allocating on top of that number makes
    /// the problem you wanted to avoid worse (§5.4).
    pub fn available_mb(&mut self) -> f32 {
        self.sys.refresh_memory();
        self.sys.available_memory() as f32 / (1024.0 * 1024.0)
    }

    pub fn total_mb(&mut self) -> f32 {
        self.sys.refresh_memory();
        self.sys.total_memory() as f32 / (1024.0 * 1024.0)
    }

    pub fn is_alive(&mut self, pid: u32) -> bool {
        self.refresh_if_stale(false);
        self.sys.process(Pid::from_u32(pid)).is_some()
    }
}

/// Last resort when neither the Job Object nor the tree kill could do it.
#[cfg(windows)]
pub fn taskkill(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
pub fn taskkill(_pid: u32) {}
