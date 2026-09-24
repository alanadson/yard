//! Discovery of agent CLIs installed on Windows (§F4, §9.3).
//!
//! The real problem: `claude`, `codex`, `opencode` and company are installed
//! via npm and become `claude.cmd` / `claude.ps1` **shims** in `%APPDATA%\npm`.
//! `CreateProcess` (which ConPTY uses underneath) does not execute `.cmd` — it
//! needs an `.exe`. So every launch goes through `resolve_launch`,
//! which rewrites the command to `cmd.exe /c <shim> <args>` when needed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// An agent from the catalog, already resolved against the user's machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    /// Path of the executable/shim found; `None` if not installed.
    pub bin: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
    /// How to resume a session: `{}` is replaced by the external id.
    pub resume_template: Option<String>,
    /// Resume the last session without needing an id.
    pub continue_args: Option<Vec<String>>,
    /// Where this agent stores local sessions (for the sessions §F4).
    pub sessions_kind: Option<String>,
    pub docs: Option<String>,
}

struct AgentSpec {
    id: &'static str,
    name: &'static str,
    candidates: &'static [&'static str],
    version_args: &'static [&'static str],
    resume_template: Option<&'static str>,
    continue_args: Option<&'static [&'static str]>,
    sessions_kind: Option<&'static str>,
    docs: Option<&'static str>,
}

/// Catalog. Adding an agent here is the only change needed.
const CATALOG: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        name: "Claude Code",
        candidates: &["claude"],
        version_args: &["--version"],
        resume_template: Some("--resume {}"),
        continue_args: Some(&["--continue"]),
        sessions_kind: Some("claude"),
        docs: Some("https://docs.claude.com/claude-code"),
    },
    AgentSpec {
        id: "codex",
        name: "Codex CLI",
        candidates: &["codex"],
        version_args: &["--version"],
        resume_template: Some("resume {}"),
        continue_args: Some(&["resume", "--last"]),
        sessions_kind: Some("codex"),
        docs: None,
    },
    AgentSpec {
        id: "opencode",
        name: "OpenCode",
        candidates: &["opencode"],
        version_args: &["--version"],
        resume_template: Some("--session {}"),
        continue_args: Some(&["--continue"]),
        sessions_kind: Some("opencode"),
        docs: None,
    },
    AgentSpec {
        id: "gemini",
        name: "Gemini CLI",
        candidates: &["gemini"],
        version_args: &["--version"],
        resume_template: None,
        continue_args: None,
        sessions_kind: None,
        docs: None,
    },
    AgentSpec {
        // The usage strip already polls Grok (`usage.rs` reads
        // `~/.grok/auth.json`), so the machine that has the CLI was showing its
        // limits in the title bar with no way to open it from "New terminal".
        id: "grok",
        name: "Grok CLI",
        candidates: &["grok"],
        version_args: &["--version"],
        resume_template: None,
        continue_args: None,
        sessions_kind: None,
        docs: None,
    },
    AgentSpec {
        id: "cursor-agent",
        name: "Cursor CLI",
        candidates: &["cursor-agent"],
        version_args: &["--version"],
        resume_template: Some("--resume {}"),
        continue_args: None,
        sessions_kind: None,
        docs: None,
    },
    AgentSpec {
        id: "aider",
        name: "Aider",
        candidates: &["aider"],
        version_args: &["--version"],
        resume_template: None,
        continue_args: None,
        sessions_kind: None,
        docs: None,
    },
    AgentSpec {
        id: "goose",
        name: "Goose",
        candidates: &["goose"],
        version_args: &["--version"],
        resume_template: Some("session resume --name {}"),
        continue_args: Some(&["session", "resume"]),
        sessions_kind: None,
        docs: None,
    },
    AgentSpec {
        id: "gh-copilot",
        name: "GitHub Copilot CLI",
        candidates: &["copilot"],
        version_args: &["--version"],
        resume_template: Some("--resume {}"),
        continue_args: Some(&["--continue"]),
        sessions_kind: None,
        docs: None,
    },
];

/// Extensions Windows treats as executables via PATHEXT. A `.cmd` shim
/// is "findable" but not "executable" by CreateProcess.
#[cfg(windows)]
const NPM_DIRS: &[&str] = &[r"npm", r"npm\node_modules\.bin"];

/// Looks for a binary on PATH and, on Windows, also in the npm directories —
/// which are not always on the PATH of the process we inherited.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }

    #[cfg(windows)]
    {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            for suffix in NPM_DIRS {
                roots.push(PathBuf::from(&appdata).join(suffix));
            }
        }
        if let Some(home) = crate::paths::home_dir() {
            roots.push(home.join(".bun").join("bin"));
            roots.push(home.join("AppData").join("Local").join("pnpm"));
            roots.push(home.join(".local").join("bin"));
            roots.push(home.join(".cargo").join("bin"));
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            roots.push(PathBuf::from(pf).join("nodejs"));
        }

        for root in roots {
            for ext in ["", ".exe", ".cmd", ".bat", ".ps1"] {
                let candidate = root.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = crate::paths::home_dir() {
            for dir in [".local/bin", ".bun/bin", ".cargo/bin"] {
                let candidate = home.join(dir).join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

/// Rewrites `(program, args)` into something `CreateProcess` will accept.
///
/// - `.cmd` / `.bat` -> `cmd.exe /c "<shim>" <args>`
/// - `.ps1`          -> `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <shim> <args>`
/// - loose name      -> resolved via PATH/npm before the rules above
/// - `.exe`          -> passed through
pub fn resolve_launch(program: &str, args: &[String]) -> (String, Vec<String>) {
    let path = PathBuf::from(program);
    let resolved = if path.is_file() {
        path
    } else {
        match find_binary(program) {
            Some(p) => p,
            None => return (program.to_string(), args.to_vec()),
        }
    };

    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let full = resolved.to_string_lossy().into_owned();

    match ext.as_str() {
        #[cfg(windows)]
        "cmd" | "bat" => {
            let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
            let mut out = vec!["/c".to_string(), full];
            out.extend(args.iter().cloned());
            (comspec, out)
        }
        #[cfg(windows)]
        "ps1" => {
            let mut out = vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                full,
            ];
            out.extend(args.iter().cloned());
            ("powershell.exe".to_string(), out)
        }
        _ => (full, args.to_vec()),
    }
}

/// Runs `<bin> --version` with a timeout. An installed-but-broken agent
/// cannot hold up the entire detection.
pub(crate) fn probe_version(program: &str, version_args: &[&str]) -> Option<String> {
    let owned: Vec<String> = version_args.iter().map(|s| s.to_string()).collect();
    let (prog, args) = resolve_launch(program, &owned);

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&prog);
        cmd.args(&args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = tx.send(cmd.output().ok());
    });

    let out = rx.recv_timeout(Duration::from_secs(12)).ok()??;
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).into_owned()
    } else {
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let first = text.lines().next()?.trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

/// Detects every agent in the catalog. Expensive (runs `--version` of each),
/// so the result is cached on `AppState`.
pub fn detect_all() -> Vec<AgentInfo> {
    detect_all_with(|candidates, version_args| {
        let bin = candidates.iter().find_map(|c| find_binary(c));
        let version = bin
            .as_ref()
            .and_then(|_| probe_version(candidates[0], version_args));
        (bin, version)
    })
}

/// The catalog resolved through `probe`, which answers where an agent's
/// binary is (from its candidate names) and its version. Every agent is
/// probed at once (`probe_each`): each `--version` is a cold start of its
/// CLI, most of them Node at 0.3 to 1.5 s, and one after the other the
/// "Nova aba" grid waited for the sum of nine.
fn detect_all_with(
    probe: impl Fn(&[&str], &[&str]) -> (Option<PathBuf>, Option<String>) + Sync,
) -> Vec<AgentInfo> {
    let probed = probe_each(CATALOG, |spec| probe(spec.candidates, spec.version_args));
    CATALOG
        .iter()
        .zip(probed)
        .map(|(spec, (bin, version))| {
            AgentInfo {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                installed: bin.is_some(),
                bin: bin.map(|p| p.to_string_lossy().into_owned()),
                version,
                resume_template: spec.resume_template.map(|s| s.to_string()),
                continue_args: spec
                    .continue_args
                    .map(|a| a.iter().map(|s| s.to_string()).collect()),
                sessions_kind: spec.sessions_kind.map(|s| s.to_string()),
                docs: spec.docs.map(|s| s.to_string()),
            }
        })
        .collect()
}

/// `probe` run on every item of `items` at once, one thread each, and the
/// answers in the order of `items`. For catalogs of a handful of process
/// launches, where the wait is the launches and not the CPU. A thread the OS
/// refuses to start only means that item is probed here, after the others
/// are under way: slower, never different.
pub(crate) fn probe_each<T: Sync, R: Send>(items: &[T], probe: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let probe = &probe;
    std::thread::scope(|scope| {
        let started: Vec<_> = items
            .iter()
            .map(|item| {
                std::thread::Builder::new()
                    .name("yard-probe".into())
                    .spawn_scoped(scope, move || probe(item))
                    .map_err(|_| item)
            })
            .collect();
        started
            .into_iter()
            .map(|handle| match handle {
                Ok(handle) => handle
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic)),
                Err(item) => probe(item),
            })
            .collect()
    })
}

/// A detection that is slow and asked for from several places at once (at
/// boot, the "Nova aba" grid, the MCP panel and the support bundle each used
/// to find the cache empty and run the whole detection themselves).
///
/// The first caller runs it; whoever arrives while it runs waits for that
/// run instead of starting another, and later callers read its result.
/// `refresh` asks for a run that starts after the call (a CLI was just
/// installed, and a run already under way may have looked before it was
/// there); two refreshes during the same run share the one after it.
pub struct SharedDetection<T> {
    /// The last result. Held only to read or replace it, never across a
    /// run, so `peek` does not wait for one.
    value: parking_lot::Mutex<Option<T>>,
    /// Held for the length of a run: runs happen one at a time.
    running: parking_lot::Mutex<()>,
    /// How many runs have started, to tell a run that started after a
    /// refresh was asked from one that was already under way.
    runs: AtomicU64,
}

impl<T: Clone> SharedDetection<T> {
    pub const fn new() -> Self {
        Self {
            value: parking_lot::Mutex::new(None),
            running: parking_lot::Mutex::new(()),
            runs: AtomicU64::new(0),
        }
    }

    /// The result, running `detect` only when nobody else's run will do.
    pub fn get(&self, refresh: bool, detect: impl FnOnce() -> T) -> T {
        let asked_at = self.runs.load(Ordering::Acquire);
        if !refresh {
            if let Some(found) = self.peek() {
                return found;
            }
        }
        let _running = self.running.lock();
        // While this caller waited, someone else's run may have finished:
        // any result does for a plain ask, and one from a run that started
        // after the call does for a refresh.
        if let Some(found) = self.peek() {
            if !refresh || self.runs.load(Ordering::Acquire) > asked_at {
                return found;
            }
        }
        self.runs.fetch_add(1, Ordering::AcqRel);
        let found = detect();
        *self.value.lock() = Some(found.clone());
        found
    }

    /// The last result, if there is one, without waiting for a run.
    pub fn peek(&self) -> Option<T> {
        self.value.lock().clone()
    }
}

impl<T: Clone> Default for SharedDetection<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// Builds the resume args of a session from the catalog template.
pub fn resume_args(agent_id: &str, session_id: &str) -> Option<Vec<String>> {
    let spec = CATALOG.iter().find(|s| s.id == agent_id)?;
    let template = spec.resume_template?;
    Some(
        template
            .split_whitespace()
            .map(|tok| tok.replace("{}", session_id))
            .collect(),
    )
}

/// Directory where an agent stores local sessions, if known.
pub fn sessions_root(kind: &str) -> Option<PathBuf> {
    let home = crate::paths::home_dir()?;
    let p = match kind {
        "claude" => home.join(".claude").join("projects"),
        "codex" => home.join(".codex").join("sessions"),
        "opencode" => opencode_root(&home)?,
        _ => return None,
    };
    Some(p)
}

fn opencode_root(home: &Path) -> Option<PathBuf> {
    // OpenCode follows XDG even on Windows in some versions; try both.
    let candidates = [
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("storage"),
        home.join("AppData")
            .join("Local")
            .join("opencode")
            .join("storage"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Instant;

    /// Counts the probes running at once and the most there ever were.
    #[derive(Default)]
    pub(crate) struct Gauge {
        now: AtomicUsize,
        entered: AtomicUsize,
        max: AtomicUsize,
    }

    impl Gauge {
        /// One probe: in, then held until `all` probes have come in (or the
        /// deadline passed, which is what a one-at-a-time detection hits),
        /// then out. Run side by side, every probe is in at once.
        pub(crate) fn probe(&self, all: usize, deadline: Instant) {
            let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.max.fetch_max(now, Ordering::SeqCst);
            self.entered.fetch_add(1, Ordering::SeqCst);
            while self.entered.load(Ordering::SeqCst) < all && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            self.now.fetch_sub(1, Ordering::SeqCst);
        }

        pub(crate) fn max(&self) -> usize {
            self.max.load(Ordering::SeqCst)
        }
    }

    fn catalog_index(candidates: &[&str]) -> usize {
        CATALOG
            .iter()
            .position(|spec| spec.candidates == candidates)
            .expect("a catalog entry")
    }

    /// Nine `--version` runs, each a cold Node start of 0.3 to 1.5 s, one
    /// after the other: the "Nova aba" grid waited for the sum. They run side
    /// by side now, and the wait is the slowest one.
    #[test]
    fn detection_probes_every_agent_at_the_same_time() {
        let gauge = Gauge::default();
        let deadline = Instant::now() + Duration::from_secs(3);
        let found = detect_all_with(|_, _| {
            gauge.probe(CATALOG.len(), deadline);
            (None, None)
        });
        assert_eq!(found.len(), CATALOG.len());
        assert_eq!(gauge.max(), CATALOG.len(), "probes running at once");
    }

    /// Side by side, the probes finish in any order; the grid is the
    /// catalog's order, whatever the machine's timing. Here each probe waits
    /// for every later one to finish first.
    #[test]
    fn detection_keeps_the_catalog_order_whatever_order_the_probes_finish_in() {
        let finished = parking_lot::Mutex::new(vec![false; CATALOG.len()]);
        let deadline = Instant::now() + Duration::from_secs(3);
        let found = detect_all_with(|candidates, _| {
            let me = catalog_index(candidates);
            while !finished.lock()[me + 1..].iter().all(|done| *done) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            finished.lock()[me] = true;
            (
                Some(PathBuf::from(format!("C:/bin/{}.cmd", candidates[0]))),
                Some(format!("v{me}")),
            )
        });
        let ids: Vec<&str> = found.iter().map(|a| a.id.as_str()).collect();
        let catalog: Vec<&str> = CATALOG.iter().map(|spec| spec.id).collect();
        assert_eq!(ids, catalog);
        for (n, agent) in found.iter().enumerate() {
            assert!(agent.installed);
            assert_eq!(agent.version.as_deref(), Some(format!("v{n}").as_str()));
        }
    }

    /// Two callers, the second arriving while the first one's detection runs
    /// (it is held until `open` fires). Returns what each got and how many
    /// detections ran; `refresh` is what the second asks for.
    fn two_callers(refreshes: usize) -> (u32, Vec<u32>, usize) {
        let shared = Arc::new(SharedDetection::<u32>::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let (started_tx, started) = std::sync::mpsc::channel();
        let (open, gate) = std::sync::mpsc::channel::<()>();
        let first = {
            let (shared, runs) = (shared.clone(), runs.clone());
            std::thread::spawn(move || {
                shared.get(false, || {
                    runs.fetch_add(1, Ordering::SeqCst);
                    let _ = started_tx.send(());
                    let _ = gate.recv_timeout(Duration::from_secs(5));
                    7
                })
            })
        };
        started
            .recv_timeout(Duration::from_secs(5))
            .expect("the first detection started");
        let later: Vec<_> = (0..refreshes.max(1))
            .map(|_| {
                let (shared, runs) = (shared.clone(), runs.clone());
                std::thread::spawn(move || {
                    shared.get(refreshes > 0, || {
                        runs.fetch_add(1, Ordering::SeqCst);
                        8
                    })
                })
            })
            .collect();
        // The later callers have had their chance to start runs of their own.
        let deadline = Instant::now() + Duration::from_millis(200);
        while runs.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        open.send(()).unwrap();
        let first = first.join().unwrap();
        let later = later.into_iter().map(|t| t.join().unwrap()).collect();
        (first, later, runs.load(Ordering::SeqCst))
    }

    /// The grid, the MCP panel and the support bundle all ask for the
    /// detection, and at boot they ask at once: each one used to find the
    /// cache empty and run all nine probes itself. A caller that arrives
    /// while a detection runs waits for that one.
    #[test]
    fn callers_that_arrive_during_a_detection_share_it() {
        assert_eq!(two_callers(0), (7, vec![7], 1));
    }

    /// "Atualizar" after installing a CLI must not be answered by a detection
    /// that started before the click: a refresh gets a run of its own. Two
    /// clicks during the same run share the one that follows it.
    #[test]
    fn a_refresh_asked_during_a_detection_gets_a_run_that_started_after_it() {
        assert_eq!(two_callers(2), (7, vec![8, 8], 2));
    }

    #[test]
    fn resume_args_substitutes_the_id() {
        let args = resume_args("claude", "abc-123").unwrap();
        assert_eq!(args, vec!["--resume", "abc-123"]);
        let args = resume_args("codex", "xyz").unwrap();
        assert_eq!(args, vec!["resume", "xyz"]);
        assert!(resume_args("gemini", "x").is_none());
    }

    #[test]
    fn resolve_launch_returns_the_original_when_nothing_is_found() {
        let (p, a) = resolve_launch("nao-existe-mesmo-xyz", &["--flag".into()]);
        assert_eq!(p, "nao-existe-mesmo-xyz");
        assert_eq!(a, vec!["--flag"]);
    }
}
