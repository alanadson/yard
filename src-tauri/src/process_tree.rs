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

use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const CACHE_TTL: Duration = Duration::from_secs(2);

pub struct ProcSnapshot {
    sys: System,
    children: HashMap<Pid, Vec<Pid>>,
    refreshed_at: Option<Instant>,
}

impl Default for ProcSnapshot {
    fn default() -> Self {
        Self {
            sys: System::new(),
            children: HashMap::new(),
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
            self.children.clear();
            for (pid, proc) in self.sys.processes() {
                if proc.thread_kind().is_some() {
                    continue;
                }
                if let Some(parent) = proc.parent() {
                    self.children.entry(parent).or_default().push(*pid);
                }
            }
            self.refreshed_at = Some(Instant::now());
        }
    }

    /// Every PID in the tree of `root`, including itself, in BFS order.
    pub fn tree_of(&mut self, root: u32) -> Vec<u32> {
        self.refresh_if_stale(false);
        let root = Pid::from_u32(root);
        if self.sys.process(root).is_none() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([root]);
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            out.push(pid.as_u32());
            if let Some(kids) = self.children.get(&pid) {
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
        sum_over(pids, |pid| self.sample(pid))
    }

    /// `(pids, rss_mb, cpu_percent)` summed over exactly `pids` (a Job
    /// Object's members), refreshing only those processes instead of the
    /// whole table. The tree scan (`refresh_if_stale`) keeps its own clock:
    /// this does not count as one, so `tree_of`, `is_alive` and the kill
    /// fallback still see a table no older than `CACHE_TTL`.
    pub fn stats_of(&mut self, pids: &[u32]) -> (Vec<u32>, f32, f32) {
        let wanted: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&wanted),
            true,
            ProcessRefreshKind::new().with_memory().with_cpu(),
        );
        sum_over(pids.to_vec(), |pid| self.sample(pid))
    }

    /// Resident bytes and CPU of one process as last refreshed, `None` when
    /// it is not in the table.
    fn sample(&self, pid: u32) -> Option<(u64, f32)> {
        self.sys
            .process(Pid::from_u32(pid))
            .map(|p| (p.memory(), p.cpu_usage()))
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
        self.refresh_ram();
        self.sys.available_memory() as f32 / (1024.0 * 1024.0)
    }

    pub fn total_mb(&mut self) -> f32 {
        self.refresh_ram();
        self.sys.total_memory() as f32 / (1024.0 * 1024.0)
    }

    /// Refreshes memory once and returns `(available_mb, total_mb)`.
    pub fn memory_stats(&mut self) -> (f32, f32) {
        self.refresh_ram();
        let scale = 1024.0 * 1024.0;
        (
            self.sys.available_memory() as f32 / scale,
            self.sys.total_memory() as f32 / scale,
        )
    }

    /// RAM only. A bare `refresh_memory()` also gathers swap through
    /// `K32GetPerformanceInfo`, which nothing here reads, and it runs on every
    /// HUD tick and every second of the spawn gate: ~35 us a call against
    /// ~1 us for the RAM alone (`GlobalMemoryStatusEx`), same numbers.
    fn refresh_ram(&mut self) {
        self.sys
            .refresh_memory_specifics(MemoryRefreshKind::new().with_ram());
    }

    pub fn is_alive(&mut self, pid: u32) -> bool {
        self.refresh_if_stale(false);
        self.sys.process(Pid::from_u32(pid)).is_some()
    }
}

/// `(pids, rss_mb, cpu_percent)` over `pids`, each read through `sample`
/// (resident bytes and CPU, `None` for a process that is gone). Only the ones
/// still there are listed, in the order given.
fn sum_over(pids: Vec<u32>, sample: impl Fn(u32) -> Option<(u64, f32)>) -> (Vec<u32>, f32, f32) {
    let mut found = Vec::with_capacity(pids.len());
    let mut rss: u64 = 0;
    let mut cpu: f32 = 0.0;
    for pid in pids {
        if let Some((bytes, usage)) = sample(pid) {
            found.push(pid);
            rss += bytes;
            cpu += usage;
        }
    }
    (found, rss as f32 / (1024.0 * 1024.0), cpu)
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

#[cfg(test)]
mod tests {
    //! What this module reports never shows up on screen when it goes wrong:
    //! the HUD just reads 0 MB, the spawn gate waits out its 45 s for RAM
    //! that is really there, and a kill that misses a grandchild leaves an
    //! orphan `node.exe` behind. So these run against real processes and the
    //! real memory counters, and a change to how `sysinfo` is built or asked
    //! (its features, the refresh kinds) is checked against what the OS says.

    use super::*;
    #[cfg(windows)]
    use std::process::{Child, Command, Stdio};

    const MB: f32 = 1024.0 * 1024.0;

    #[cfg(windows)]
    fn wait_until(timeout: Duration, label: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cond() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out waiting for: {label}");
    }

    /// A `cmd` running `ping`: a child and a grandchild of the test, alive for
    /// ~30 s, far longer than any test here needs.
    #[cfg(windows)]
    struct Tree(Child);

    #[cfg(windows)]
    impl Tree {
        fn spawn() -> Self {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let child = Command::new("cmd")
                .args(["/D", "/C", "ping -n 30 127.0.0.1 >NUL"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("spawn cmd");
            Tree(child)
        }

        fn root(&self) -> u32 {
            self.0.id()
        }

        /// Waits for `ping` to show up below `cmd` and returns its PID. Each
        /// look is a fresh snapshot, so the 2 s cache cannot hide it.
        fn grandchild(&self) -> u32 {
            let mut found = None;
            wait_until(Duration::from_secs(10), "ping under cmd", || {
                let mut snap = ProcSnapshot::default();
                found = snap
                    .tree_of(self.root())
                    .into_iter()
                    .skip(1)
                    .find(|pid| is_ping(&snap, *pid));
                found.is_some()
            });
            found.expect("ping pid")
        }
    }

    #[cfg(windows)]
    impl Drop for Tree {
        fn drop(&mut self) {
            // The `Child` handle we still hold keeps the PID from being
            // recycled, so this can only reach the tree the test started.
            taskkill(self.root());
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(windows)]
    fn is_ping(snap: &ProcSnapshot, pid: u32) -> bool {
        snap.sys
            .process(Pid::from_u32(pid))
            .map(|p| p.name().eq_ignore_ascii_case("ping.exe"))
            .unwrap_or(false)
    }

    /// The HUD's system line on a snapshot that never refreshed anything:
    /// a refresh that stopped asking for RAM would leave both at zero.
    #[test]
    fn memory_stats_reads_real_ram_on_a_snapshot_that_never_refreshed() {
        let (available, total) = ProcSnapshot::default().memory_stats();
        assert!(total > 0.0, "total RAM read as {total} MB");
        assert!(
            available > 0.0 && available <= total,
            "available {available} MB out of {total} MB"
        );
    }

    /// The spawn gate calls `available_mb` and nothing else: it has to
    /// refresh the RAM it reports on its own.
    #[test]
    fn available_mb_refreshes_the_ram_it_reports_by_itself() {
        let available = ProcSnapshot::default().available_mb();
        assert!(available > 0.0, "available RAM read as {available} MB");
    }

    /// Physical RAM does not move between two calls, so the RAM-only refresh
    /// must land on exactly the number a full memory refresh (RAM and swap)
    /// reads.
    #[test]
    fn total_ram_is_the_same_number_a_full_memory_refresh_reads() {
        let mut reference = System::new();
        reference.refresh_memory();
        let expected = reference.total_memory() as f32 / MB;

        let mut snap = ProcSnapshot::default();
        assert_eq!(snap.total_mb(), expected);
        assert_eq!(snap.memory_stats().1, expected);
    }

    /// What a terminal costs is the sum over its processes; a process that
    /// died between the listing and the reading counts for nothing and is not
    /// reported, and the order of the list is kept (the tree's is BFS, root
    /// first).
    #[test]
    fn the_stats_of_a_set_of_processes_are_the_sums_over_the_ones_still_there() {
        let mb = 1024 * 1024;
        let sample = |pid: u32| match pid {
            8 => Some((3 * mb, 1.5)),
            4 => Some((mb, 2.0)),
            _ => None,
        };
        assert_eq!(sum_over(vec![8, 12, 4], sample), (vec![8, 4], 4.0, 3.5));
        assert_eq!(sum_over(Vec::new(), sample), (Vec::new(), 0.0, 0.0));
    }

    /// Windows PIDs are multiples of 4, so an odd one never names a process.
    #[test]
    fn a_pid_with_no_process_has_an_empty_tree_and_zero_stats() {
        let ghost = u32::MAX;
        let mut snap = ProcSnapshot::default();
        assert!(snap.tree_of(ghost).is_empty());
        assert_eq!(snap.tree_stats(ghost), (Vec::new(), 0.0, 0.0));
        assert!(!snap.is_alive(ghost));
    }

    #[cfg(windows)]
    #[test]
    fn a_running_child_is_alive() {
        let tree = Tree::spawn();
        assert!(ProcSnapshot::default().is_alive(tree.root()));
    }

    #[cfg(windows)]
    #[test]
    fn the_tree_of_a_process_starts_at_it_and_reaches_its_grandchild() {
        let tree = Tree::spawn();
        let ping = tree.grandchild();

        let pids = ProcSnapshot::default().tree_of(tree.root());
        assert_eq!(pids.first(), Some(&tree.root()), "BFS starts at the root");
        assert!(pids.contains(&ping), "{pids:?} misses ping {ping}");
    }

    /// `cmd` and `ping` each hold a few MB of working set: a refresh that
    /// stopped asking for process memory would sum the tree to zero.
    #[cfg(windows)]
    #[test]
    fn tree_stats_sums_real_resident_memory_over_the_live_tree() {
        let tree = Tree::spawn();
        let ping = tree.grandchild();

        let (pids, rss_mb, cpu) = ProcSnapshot::default().tree_stats(tree.root());
        assert!(pids.contains(&tree.root()) && pids.contains(&ping));
        assert!(rss_mb > 1.0, "tree RSS read as {rss_mb} MB");
        assert!(cpu.is_finite() && cpu >= 0.0, "tree CPU read as {cpu}");
    }

    /// A terminal with a Job Object knows its processes without walking the
    /// machine's process table: the tick refreshes only those. On a snapshot
    /// that never scanned anything, the processes it is handed must still be
    /// read for real, or the HUD shows 0 MB for every agent.
    #[cfg(windows)]
    #[test]
    fn stats_of_reads_real_memory_of_exactly_the_processes_it_is_handed() {
        let tree = Tree::spawn();
        let ping = tree.grandchild();

        let mut snap = ProcSnapshot::default();
        let (pids, rss_mb, cpu) = snap.stats_of(&[tree.root(), ping]);
        assert_eq!(pids, vec![tree.root(), ping]);
        assert!(rss_mb > 1.0, "RSS read as {rss_mb} MB");
        assert!(cpu.is_finite() && cpu >= 0.0, "CPU read as {cpu}");
        assert_eq!(snap.stats_of(&[u32::MAX]), (Vec::new(), 0.0, 0.0));
    }

    /// The fallback kill when the Job Object failed: the grandchild must go
    /// with the root, or it is the orphan this whole module exists to prevent.
    ///
    /// The count is not pinned to 2 on purpose: leaves go first, and once
    /// `ping` is dead `cmd` has nothing left to wait for, so it can exit on
    /// its own before its turn comes and its `taskkill` finds nobody.
    #[cfg(windows)]
    #[test]
    fn kill_tree_ends_the_root_and_its_grandchild() {
        let mut tree = Tree::spawn();
        let ping = tree.grandchild();

        let killed = ProcSnapshot::default().kill_tree(tree.root());
        assert!(killed >= 1, "killed {killed} processes");

        wait_until(Duration::from_secs(10), "cmd to exit", || {
            matches!(tree.0.try_wait(), Ok(Some(_)))
        });
        wait_until(Duration::from_secs(10), "ping to be gone", || {
            !ProcSnapshot::default().is_alive(ping)
        });
    }
}
