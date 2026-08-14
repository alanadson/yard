//! Reading the sessions agents already write to disk (§F4).
//!
//! None of these CLIs expose an API — but they all leave a trail in local files.
//! Reading that trail is what lets you open a project and see "the 6 conversations
//! you had here", with the resume command ready.
//!
//! - **Claude Code**: `~/.claude/projects/<path-slug>/<sessionId>.jsonl`
//! - **Codex**: `~/.codex/sessions/<year>/<month>/<day>/rollout-*-<uuid>.jsonl`
//! - **OpenCode**: `storage/session/info/*.json` (best effort; unstable format)
//!
//! Everything here is failure-tolerant: unexpected format becomes "session ignored",
//! never an error that brings the listing down.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// How many lines from the start of the `.jsonl` we read to discover the title.
const HEAD_LINES: usize = 120;
/// Cap per line: a message with a whole file pasted in cannot blow the
/// listing's memory.
const MAX_LINE: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub agent: String,
    /// What goes into the resume command (`claude --resume <this>`).
    pub external_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub updated_at: i64,
    pub size_bytes: u64,
    pub file: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub models: Vec<String>,
    /// Estimate. Public list prices; good for order of magnitude,
    /// not for reconciling a bill.
    pub cost_usd: Option<f64>,
}

/// Lists an agent's sessions for a project. Empty `project_path` =
/// every project.
pub fn list(agent: &str, project_path: &str) -> Vec<AgentSession> {
    let mut out = match agent {
        "claude" => list_claude(project_path),
        "codex" => list_codex(project_path),
        "opencode" => list_opencode(project_path),
        _ => Vec::new(),
    };
    // Newest first.
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    out
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

fn list_claude(project_path: &str) -> Vec<AgentSession> {
    let Some(root) = super::resolver::sessions_root("claude") else {
        return Vec::new();
    };

    let dirs: Vec<PathBuf> = if project_path.is_empty() {
        read_dirs(&root)
    } else {
        let slug = crate::paths::claude_project_slug(Path::new(project_path));
        let d = root.join(&slug);
        if d.is_dir() {
            vec![d]
        } else {
            // Claude Code normalizes the path before the slug; if the user
            // registered the project with another spelling, search case-insensitively.
            read_dirs(&root)
                .into_iter()
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.eq_ignore_ascii_case(&slug))
                        .unwrap_or(false)
                })
                .collect()
        }
    };

    let mut out = Vec::new();
    for dir in dirs {
        for entry in jsonl_files(&dir) {
            let Ok(meta) = entry.metadata() else { continue };
            let path = entry.path();
            let external_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if external_id.is_empty() {
                continue;
            }
            let head = read_head(&path, HEAD_LINES);
            let (title, cwd) = claude_head_info(&head);
            out.push(AgentSession {
                agent: "claude".into(),
                external_id,
                project_path: cwd.unwrap_or_else(|| project_path.to_string()),
                title,
                updated_at: mtime_ms(&meta),
                size_bytes: meta.len(),
                file: path.to_string_lossy().into_owned(),
            });
        }
    }
    out
}

/// Extracts `(title, cwd)` from the first lines of a Claude Code `.jsonl`.
/// Prefers a `summary` (the CLI itself writes that); otherwise uses the first
/// user message.
fn claude_head_info(lines: &[String]) -> (Option<String>, Option<String>) {
    let mut title = None;
    let mut cwd = None;

    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.to_string());
            }
        }
        if title.is_none() {
            if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
                title = Some(truncate(s, 90));
                continue;
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(text) = extract_text(v.get("message")) {
                    let clean = text.trim();
                    // Internal CLI commands (`<command-name>…`) are not a title.
                    if !clean.is_empty() && !clean.starts_with('<') {
                        title = Some(truncate(clean, 90));
                    }
                }
            }
        }
        if title.is_some() && cwd.is_some() {
            break;
        }
    }
    (title, cwd)
}

/// The `message.content` field is sometimes a string, sometimes a list of blocks.
fn extract_text(message: Option<&serde_json::Value>) -> Option<String> {
    let content = message?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

fn list_codex(project_path: &str) -> Vec<AgentSession> {
    let Some(root) = super::resolver::sessions_root("codex") else {
        return Vec::new();
    };
    let mut files = Vec::new();
    collect_jsonl_recursive(&root, &mut files, 0);

    let mut out = Vec::new();
    for path in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let head = read_head(&path, 40);
        let (id, cwd, title) = codex_head_info(&head);

        let external_id = id.unwrap_or_else(|| {
            // `rollout-2026-08-12T10-00-00-<uuid>.jsonl` -> take the uuid from the end.
            path.file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.rsplit_once('-').map(|(_, tail)| tail.to_string()))
                .unwrap_or_default()
        });
        if external_id.is_empty() {
            continue;
        }

        let session_cwd = cwd.unwrap_or_default();
        if !project_path.is_empty() && !path_matches(&session_cwd, project_path) {
            continue;
        }

        out.push(AgentSession {
            agent: "codex".into(),
            external_id,
            project_path: session_cwd,
            title,
            updated_at: mtime_ms(&meta),
            size_bytes: meta.len(),
            file: path.to_string_lossy().into_owned(),
        });
    }
    out
}

fn codex_head_info(lines: &[String]) -> (Option<String>, Option<String>, Option<String>) {
    let mut id = None;
    let mut cwd = None;
    let mut title = None;

    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // `session_meta` brings id and cwd; the payload sometimes comes nested.
        let payload = v.get("payload").unwrap_or(&v);
        if id.is_none() {
            id = payload
                .get("id")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
        }
        if cwd.is_none() {
            cwd = payload
                .get("cwd")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
        }
        if title.is_none() {
            if let Some(text) = payload
                .get("text")
                .and_then(|x| x.as_str())
                .or_else(|| payload.get("content").and_then(|x| x.as_str()))
            {
                let clean = text.trim();
                if !clean.is_empty() && !clean.starts_with('<') {
                    title = Some(truncate(clean, 90));
                }
            }
        }
        if id.is_some() && cwd.is_some() && title.is_some() {
            break;
        }
    }
    (id, cwd, title)
}

// ---------------------------------------------------------------------------
// OpenCode (best effort)
// ---------------------------------------------------------------------------

fn list_opencode(project_path: &str) -> Vec<AgentSession> {
    let Some(root) = super::resolver::sessions_root("opencode") else {
        return Vec::new();
    };
    let info_dir = root.join("session").join("info");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&info_dir) else {
        return out;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let cwd = v
            .get("directory")
            .or_else(|| v.get("cwd"))
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        if !project_path.is_empty() && !path_matches(&cwd, project_path) {
            continue;
        }
        let external_id = v
            .get("id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        if external_id.is_empty() {
            continue;
        }
        out.push(AgentSession {
            agent: "opencode".into(),
            external_id,
            project_path: cwd,
            title: v
                .get("title")
                .and_then(|x| x.as_str())
                .map(|s| truncate(s, 90)),
            updated_at: mtime_ms(&meta),
            size_bytes: meta.len(),
            file: path.to_string_lossy().into_owned(),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Usage / cost
// ---------------------------------------------------------------------------

/// Scans a whole `.jsonl` summing tokens. Called on demand (not during
/// listing) because it reads the entire file.
pub fn usage(file: &str) -> SessionUsage {
    let mut u = SessionUsage::default();
    let Ok(f) = File::open(file) else { return u };
    let reader = BufReader::new(f);

    for line in reader.lines().map_while(Result::ok) {
        if line.len() > MAX_LINE || line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        u.messages += 1;

        // Claude Code: message.usage.*  |  Codex: payload.info.total_token_usage.*
        let usage_obj = v
            .get("message")
            .and_then(|m| m.get("usage"))
            .or_else(|| v.get("usage"))
            .or_else(|| {
                v.get("payload")
                    .and_then(|p| p.get("info"))
                    .and_then(|i| i.get("total_token_usage"))
            });

        if let Some(usage) = usage_obj {
            u.input_tokens += num(usage, &["input_tokens"]);
            u.output_tokens += num(usage, &["output_tokens"]);
            u.cache_creation_tokens += num(usage, &["cache_creation_input_tokens"]);
            u.cache_read_tokens += num(usage, &["cache_read_input_tokens", "cached_input_tokens"]);
        }

        if let Some(model) = v
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
        {
            if !u.models.iter().any(|x| x == model) {
                u.models.push(model.to_string());
            }
        }
    }

    u.cost_usd = estimate_cost(&u);
    u
}

fn num(v: &serde_json::Value, keys: &[&str]) -> u64 {
    for k in keys {
        if let Some(n) = v.get(*k).and_then(|x| x.as_u64()) {
            return n;
        }
    }
    0
}

/// Price table per million tokens (USD), checked on 2026-08-12.
///
/// Order matters: the first matching pattern wins, so more specific ids
/// come before the generic ones. "opus" alone is **not** a single price
/// family — Opus 5/4.x costs US$ 5/25, while Opus 4.1 and Opus 3
/// cost US$ 15/75. Treating both as the same thing inflates the estimate
/// 3x, which is exactly the kind of wrong number that makes the user take
/// a wrong decision.
const PRECOS: &[(&str, f64, f64)] = &[
    ("fable", 10.0, 50.0),
    ("mythos", 10.0, 50.0),
    ("opus-5", 5.0, 25.0),
    ("opus-4-8", 5.0, 25.0),
    ("opus-4-7", 5.0, 25.0),
    ("opus-4-6", 5.0, 25.0),
    ("opus-4-5", 5.0, 25.0),
    // Earlier Opus generations, in another band.
    ("opus-4-1", 15.0, 75.0),
    ("opus-4", 15.0, 75.0),
    ("opus", 15.0, 75.0),
    ("haiku", 1.0, 5.0),
    ("sonnet", 3.0, 15.0),
];

/// Cache multipliers over the input price: writing costs 1.25x
/// (5 min TTL), reading costs 0.1x.
const CACHE_WRITE_MULT: f64 = 1.25;
const CACHE_READ_MULT: f64 = 0.1;

/// Cost estimate. `None` when the model is not in the table — better to
/// show no number at all than to show a made-up number.
/// `pub(crate)` because the live tail (`tail.rs`) adds up the same totals.
pub(crate) fn estimate_cost(u: &SessionUsage) -> Option<f64> {
    let modelos = u.models.join(" ").to_ascii_lowercase();
    let (_, inp, out) = PRECOS.iter().find(|(pat, _, _)| modelos.contains(pat))?;

    let por_milhao = |n: u64, preco: f64| (n as f64) * preco / 1_000_000.0;
    Some(
        por_milhao(u.input_tokens, *inp)
            + por_milhao(u.output_tokens, *out)
            + por_milhao(u.cache_creation_tokens, inp * CACHE_WRITE_MULT)
            + por_milhao(u.cache_read_tokens, inp * CACHE_READ_MULT),
    )
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

fn read_dirs(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|it| {
            it.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

fn jsonl_files(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|e| {
                    e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")
                })
                .collect()
        })
        .unwrap_or_default()
}

fn collect_jsonl_recursive(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 5 || out.len() > 2000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_recursive(&path, out, depth + 1);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn read_head(path: &Path, max_lines: usize) -> Vec<String> {
    let Ok(f) = File::open(path) else {
        return Vec::new();
    };
    BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.len() <= MAX_LINE)
        .take(max_lines)
        .collect()
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn truncate(s: &str, max: usize) -> String {
    let one_line = s.replace(['\n', '\r'], " ");
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{cut}…")
}

/// Compares paths ignoring case and separator — on Windows agents
/// write sometimes `C:\x`, sometimes `C:/x`.
fn path_matches(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titulo_ignora_comando_interno_e_usa_primeira_msg() {
        let lines = vec![
            r#"{"type":"user","cwd":"C:\\proj","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":"arrume o bug do login"}}"#.to_string(),
        ];
        let (title, cwd) = claude_head_info(&lines);
        assert_eq!(title.as_deref(), Some("arrume o bug do login"));
        assert_eq!(cwd.as_deref(), Some(r"C:\proj"));
    }

    #[test]
    fn caminhos_comparam_sem_ligar_para_barra_ou_caixa() {
        assert!(path_matches(r"C:\Work\App", "c:/work/app"));
        assert!(!path_matches(r"C:\Work\App", r"C:\Work\Other"));
    }

    #[test]
    fn custo_e_none_sem_modelo_conhecido() {
        let u = SessionUsage {
            input_tokens: 1000,
            models: vec!["modelo-desconhecido".into()],
            ..Default::default()
        };
        assert!(estimate_cost(&u).is_none());
        assert!(estimate_cost(&SessionUsage::default()).is_none());
    }

    #[test]
    fn opus_5_nao_e_cobrado_no_preco_do_opus_antigo() {
        let base = |modelo: &str| SessionUsage {
            output_tokens: 1_000_000,
            models: vec![modelo.into()],
            ..Default::default()
        };
        // Opus 5: US$ 25/M of output. Opus 4.1 stays in the old band, 75.
        assert_eq!(estimate_cost(&base("claude-opus-5")), Some(25.0));
        assert_eq!(estimate_cost(&base("claude-opus-4-1")), Some(75.0));
        assert_eq!(estimate_cost(&base("claude-sonnet-5")), Some(15.0));
        assert_eq!(estimate_cost(&base("claude-haiku-4-5")), Some(5.0));
    }

    #[test]
    fn cache_usa_os_multiplicadores_do_preco_de_entrada() {
        let u = SessionUsage {
            cache_creation_tokens: 1_000_000,
            cache_read_tokens: 1_000_000,
            models: vec!["claude-opus-5".into()],
            ..Default::default()
        };
        // Opus 5 input = US$ 5/M -> write 6.25 + read 0.50.
        assert_eq!(estimate_cost(&u), Some(6.25 + 0.5));
    }
}
