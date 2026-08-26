//! Discovery of agent CLIs installed on Windows (§F4, §9.3).
//!
//! The real problem: `claude`, `codex`, `opencode` and company are installed
//! via npm and become `claude.cmd` / `claude.ps1` **shims** in `%APPDATA%\npm`.
//! `CreateProcess` (which ConPTY uses underneath) does not execute `.cmd` — it
//! needs an `.exe`. So every launch goes through `resolve_launch`,
//! which rewrites the command to `cmd.exe /c <shim> <args>` when needed.

use std::path::{Path, PathBuf};
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
    CATALOG
        .iter()
        .map(|spec| {
            let bin = spec.candidates.iter().find_map(|c| find_binary(c));
            let version = bin
                .as_ref()
                .and_then(|_| probe_version(spec.candidates[0], spec.version_args));
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
mod tests {
    use super::*;

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
