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

use crate::bounded_cache::BoundedCache;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;

use super::bookmark::{read_lines, Bookmark};
use super::tokens::TokenCounts;
use super::usage_line::{self, UsageLine};

/// How many lines from the start of the `.jsonl` we read to discover the title.
const HEAD_LINES: usize = 120;
/// Cap per line: a message with a whole file pasted in cannot blow the
/// listing's memory.
const MAX_LINE: usize = 512 * 1024;
const SESSION_CACHE_MAX: usize = 4096;

#[derive(Clone)]
struct CachedSession {
    updated_at: i64,
    size_bytes: u64,
    session: AgentSession,
}

fn session_cache() -> &'static Mutex<BoundedCache<PathBuf, CachedSession>> {
    static CACHE: OnceLock<Mutex<BoundedCache<PathBuf, CachedSession>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BoundedCache::new(SESSION_CACHE_MAX)))
}

fn cached_session(path: &Path, updated_at: i64, size_bytes: u64) -> Option<AgentSession> {
    session_cache()
        .lock()
        .get(path)
        .filter(|hit| hit.updated_at == updated_at && hit.size_bytes == size_bytes)
        .map(|hit| hit.session.clone())
}

fn remember_session(path: PathBuf, session: &AgentSession) {
    let mut cache = session_cache().lock();
    cache.insert(
        path,
        CachedSession {
            updated_at: session.updated_at,
            size_bytes: session.size_bytes,
            session: session.clone(),
        },
    );
}

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
            let updated_at = mtime_ms(&meta);
            let size_bytes = meta.len();
            if let Some(mut session) = cached_session(&path, updated_at, size_bytes) {
                if session.project_path.is_empty() {
                    session.project_path = project_path.to_string();
                }
                out.push(session);
                continue;
            }
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
            let session = AgentSession {
                agent: "claude".into(),
                external_id,
                project_path: cwd.unwrap_or_default(),
                title,
                updated_at,
                size_bytes,
                file: path.to_string_lossy().into_owned(),
            };
            remember_session(path, &session);
            let mut visible = session;
            if visible.project_path.is_empty() {
                visible.project_path = project_path.to_string();
            }
            out.push(visible);
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
        let updated_at = mtime_ms(&meta);
        let size_bytes = meta.len();
        if let Some(session) = cached_session(&path, updated_at, size_bytes) {
            if project_path.is_empty() || path_matches(&session.project_path, project_path) {
                out.push(session);
            }
            continue;
        }
        let head = read_head(&path, 40);
        let (id, cwd, title) = codex_head_info(&head);

        let external_id = id.unwrap_or_else(|| {
            // `rollout-2026-08-12T10-00-00-<uuid>.jsonl` -> the uuid at the end.
            path.file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| {
                    codex_rollout_id(s)
                        .or_else(|| s.rsplit_once('-').map(|(_, tail)| tail.to_string()))
                })
                .unwrap_or_default()
        });
        if external_id.is_empty() {
            continue;
        }

        let session_cwd = cwd.unwrap_or_default();
        if !project_path.is_empty() && !path_matches(&session_cwd, project_path) {
            continue;
        }

        let session = AgentSession {
            agent: "codex".into(),
            external_id,
            project_path: session_cwd,
            title,
            updated_at,
            size_bytes,
            file: path.to_string_lossy().into_owned(),
        };
        remember_session(path, &session);
        out.push(session);
    }
    out
}

/// The session id inside a Codex rollout file name: the trailing UUID of
/// `rollout-<timestamp>-<uuid>`. Splitting on `-` would hand back only the
/// UUID's last group, because the UUID has dashes of its own.
fn codex_rollout_id(stem: &str) -> Option<String> {
    const UUID_LEN: usize = 36;
    let start = stem.len().checked_sub(UUID_LEN)?;
    let tail = stem.get(start..)?;
    let shaped = tail.bytes().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => b == b'-',
        _ => b.is_ascii_hexdigit(),
    });
    shaped.then(|| tail.to_string())
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
        let updated_at = mtime_ms(&meta);
        let size_bytes = meta.len();
        if let Some(session) = cached_session(&path, updated_at, size_bytes) {
            if project_path.is_empty() || path_matches(&session.project_path, project_path) {
                out.push(session);
            }
            continue;
        }
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
        let session = AgentSession {
            agent: "opencode".into(),
            external_id,
            project_path: cwd,
            title: v
                .get("title")
                .and_then(|x| x.as_str())
                .map(|s| truncate(s, 90)),
            updated_at,
            size_bytes,
            file: path.to_string_lossy().into_owned(),
        };
        remember_session(path, &session);
        out.push(session);
    }
    out
}

// ---------------------------------------------------------------------------
// Usage / cost
// ---------------------------------------------------------------------------

/// How many sessions keep their "Uso" answer (and the message ids behind
/// it) between clicks.
const USAGE_CACHE_MAX: usize = 64;

/// The usage of one file as of `(len, mtime)`, and where its complete lines
/// end, with the running state right there.
struct CachedUsage {
    len: u64,
    mtime: i64,
    answer: SessionUsage,
    bookmark: Bookmark,
    scan: UsageScan,
}

fn usage_cache() -> &'static Mutex<BoundedCache<PathBuf, CachedUsage>> {
    static CACHE: OnceLock<Mutex<BoundedCache<PathBuf, CachedUsage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BoundedCache::new(USAGE_CACHE_MAX)))
}

/// Sums a session's tokens. Called on demand (not during listing): the first
/// call reads the whole file, the answer of a read that reached its end is
/// kept per `(size, mtime)`, and a session that grew since is read only from
/// where its complete lines ended (`bookmark`), each line into the few fields
/// it needs (`usage_line`). The tests hold it against the old full `Value`
/// re-parse.
pub fn usage(file: &str) -> SessionUsage {
    let path = Path::new(file);
    // No metadata, no key to keep it under: read it as it always was read.
    let Ok(meta) = std::fs::metadata(path) else {
        return scan_usage(path, 0, 0, None).0.answer;
    };
    let (len, mtime) = (meta.len(), mtime_ms(&meta));
    let previous = {
        let mut cache = usage_cache().lock();
        if let Some(hit) = cache.get(path) {
            if hit.len == len && hit.mtime == mtime {
                return hit.answer.clone();
            }
        }
        cache.remove(path)
    };
    let (entry, complete) = scan_usage(path, len, mtime, previous);
    let answer = entry.answer.clone();
    // A read that did not reach the end (the open refused by a sharing
    // lock, an I/O error partway) answers this click only: the entry was
    // taken out above, so the next click reads the file from byte 0, as
    // every click did before the cache.
    if complete {
        usage_cache().lock().insert(path.to_path_buf(), entry);
    }
    answer
}

/// Brings one session's usage up to date: resumed from `previous` only
/// when the file grew and still starts with the bytes already read, from
/// byte 0 otherwise. The flag says whether the read reached the end of the
/// file, the only answer worth keeping.
fn scan_usage(path: &Path, len: u64, mtime: i64, previous: Option<CachedUsage>) -> (CachedUsage, bool) {
    let resumed = previous
        .filter(|p| len > p.len)
        .and_then(|p| p.bookmark.reopen(path).map(|handle| (handle, p)));
    let (handle, mut bookmark, mut scan) = match resumed {
        Some((handle, p)) => (Some(handle), p.bookmark, p.scan),
        None => (File::open(path).ok(), Bookmark::default(), UsageScan::default()),
    };
    let read = handle.map(|handle| read_lines(handle, &mut bookmark, |line| scan.line(line)));
    // Not opened, or stopped by an I/O error: the answer still counts the
    // lines read, as the old full read counted them, but it is not the file's.
    let complete = matches!(read, Some(Ok(_)));
    let tail = read.and_then(Result::ok).flatten();
    // A last line with no `\n` yet counts as it reads now, on a copy of the
    // state: the next read starts at it again.
    let mut answer = match tail.as_deref().and_then(parse_usage_line) {
        Some(line) => {
            let mut last = scan.clone();
            last.apply(line);
            last.totals
        }
        None => scan.totals.clone(),
    };
    answer.cost_usd = estimate_cost(&answer);
    let entry = CachedUsage {
        len,
        mtime,
        answer,
        bookmark,
        scan,
    };
    (entry, complete)
}

/// The totals so far and what the next line needs: the previous Codex
/// cumulative total and the API messages already counted.
#[derive(Clone, Default)]
struct UsageScan {
    totals: SessionUsage,
    previous_tokens: Option<TokenCounts>,
    seen_messages: HashSet<String>,
}

impl UsageScan {
    fn line(&mut self, line: &str) {
        if let Some(line) = parse_usage_line(line) {
            self.apply(line);
        }
    }

    fn apply(&mut self, line: UsageLine) {
        let u = &mut self.totals;
        u.messages += 1;

        if let Some(delta) = line
            .payload
            .as_ref()
            .and_then(|payload| payload.info.as_ref())
            .and_then(|info| super::tokens::codex_delta(info, &mut self.previous_tokens))
        {
            u.input_tokens += delta.0;
            u.cache_read_tokens += delta.1;
            u.cache_creation_tokens += delta.2;
            u.output_tokens += delta.3;
        }

        // Claude and compatible per-message usage objects are already deltas.
        let message = line.message.as_ref();
        if let Some(delta) = message.and_then(|m| {
            super::tokens::claude_usage_delta(m.id.as_deref(), m.usage.as_ref(), &mut self.seen_messages)
        }) {
            u.input_tokens += delta.0;
            u.cache_read_tokens += delta.1;
            u.cache_creation_tokens += delta.2;
            u.output_tokens += delta.3;
        } else if let Some(usage) = line.usage.as_ref() {
            u.input_tokens += num(usage, &["input_tokens"]);
            u.output_tokens += num(usage, &["output_tokens"]);
            u.cache_creation_tokens += num(usage, &["cache_creation_input_tokens"]);
            u.cache_read_tokens += num(usage, &["cache_read_input_tokens", "cached_input_tokens"]);
        }

        if let Some(model) = message.and_then(|m| m.model.as_deref()) {
            if !u.models.iter().any(|x| x == model) {
                u.models.push(model.to_string());
            }
        }
    }
}

/// `None` for a line that does not count before it is even parsed.
fn parse_usage_line(line: &str) -> Option<UsageLine> {
    if line.len() > MAX_LINE || line.is_empty() {
        return None;
    }
    usage_line::parse(line)
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
const PRICES: &[(&str, f64, f64)] = &[
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
    let models = u.models.join(" ").to_ascii_lowercase();
    let (_, inp, out) = PRICES.iter().find(|(pat, _, _)| models.contains(pat))?;

    let per_million = |n: u64, price: f64| (n as f64) * price / 1_000_000.0;
    Some(
        per_million(u.input_tokens, *inp)
            + per_million(u.output_tokens, *out)
            + per_million(u.cache_creation_tokens, inp * CACHE_WRITE_MULT)
            + per_million(u.cache_read_tokens, inp * CACHE_READ_MULT),
    )
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

/// The folders directly under `root`, links followed. The listing answers
/// for a plain entry (`crate::dir_entries`): no open per entry, except for a
/// link, which is still followed the way `Path::is_dir` follows it.
fn read_dirs(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|it| {
            it.flatten()
                .filter(crate::dir_entries::is_dir)
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

fn jsonl_files(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
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
        // Same answer as `path.is_dir()`, without opening a plain entry. The
        // session file's size and mtime still come from `fs::metadata` in
        // `list_codex`: while a CLI holds its session file open to write it,
        // the listing's copy of those two lags until the handle closes.
        if crate::dir_entries::is_dir(&entry) {
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

    // Repeated content blocks can be interleaved with other API messages.
    #[test]
    fn session_and_history_count_each_api_message_once() {
        let path = std::env::temp_dir().join(format!("yard-session-dedup-{}.jsonl", std::process::id()));
        let lines: Vec<String> = [("a", 10), ("b", 12), ("a", 10)].map(|(id, input)| {
            serde_json::json!({
                "type": "assistant",
                "message": { "id": id, "model": "test-model", "usage": { "input_tokens": input }}
            }).to_string()
        }).to_vec();
        std::fs::write(&path, lines.join("\n")).expect("write isolated session");
        let result = usage(path.to_str().expect("temporary path"));
        std::fs::remove_file(&path).expect("remove isolated session");
        assert_eq!(result.input_tokens, 22);
        let history = crate::costs::claude_samples(lines.into_iter());
        assert_eq!(history.len(), 2);
    }

    /// `usage` as it was before it became typed and incremental, verbatim:
    /// every line through `serde_json::Value`, every call from byte 0. The
    /// oracle the cached, resumed `usage` is held against.
    fn value_oracle_usage(file: &str) -> SessionUsage {
        let mut u = SessionUsage::default();
        let Ok(f) = File::open(file) else { return u };
        let reader = BufReader::new(f);
        let mut previous_tokens = None;
        let mut seen_messages = std::collections::HashSet::new();

        for line in reader.lines().map_while(Result::ok) {
            if line.len() > MAX_LINE || line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            u.messages += 1;

            if let Some(delta) = v.get("payload")
                .and_then(|payload| payload.get("info"))
                .and_then(|info| crate::agents::tokens::codex_delta(info, &mut previous_tokens))
            {
                u.input_tokens += delta.0;
                u.cache_read_tokens += delta.1;
                u.cache_creation_tokens += delta.2;
                u.output_tokens += delta.3;
            }

            if let Some(delta) = v.get("message")
                .and_then(|message| crate::agents::tokens::claude_delta(message, &mut seen_messages))
            {
                u.input_tokens += delta.0;
                u.cache_read_tokens += delta.1;
                u.cache_creation_tokens += delta.2;
                u.output_tokens += delta.3;
            } else if let Some(usage) = v.get("usage") {
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

    fn usage_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-session-usage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Stamps `second` as the file's mtime (a rewrite inside one millisecond
    /// must still read as a change) and holds `usage` against the oracle.
    fn usage_matches_a_full_reparse(file: &Path, second: u64) -> SessionUsage {
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + second);
        std::fs::OpenOptions::new().write(true).open(file).unwrap().set_modified(stamp).unwrap();
        let path = file.to_str().unwrap();
        let got = usage(path);
        let expected = value_oracle_usage(path);
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            serde_json::to_value(&expected).unwrap(),
            "{} at {second}",
            file.display()
        );
        got
    }

    fn append_to(file: &Path, text: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(file).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn assistant(id: &str, model: &str, input: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": { "id": id, "model": model, "content": [{"type": "text", "text": "oi"}],
                         "usage": { "input_tokens": input, "output_tokens": 1, "cache_read_input_tokens": 2 } }
        })
        .to_string()
    }

    fn codex_total(input: u64) -> String {
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "token_count", "info": { "total_token_usage": { "input_tokens": input, "output_tokens": input / 10 } } }
        })
        .to_string()
    }

    /// Growth by whole lines, a message id repeated after the boundary, a
    /// Codex cumulative total continued after it, and lines that only count
    /// as messages (any JSON counts, even one that is not an object).
    #[test]
    fn a_session_that_grew_adds_up_as_a_full_reparse() {
        let file = usage_dir("grow").join("s.jsonl");
        std::fs::write(&file, [assistant("m1", "claude-opus-5", 10), codex_total(100), "[1]".to_string()].join("\n") + "\n").unwrap();
        usage_matches_a_full_reparse(&file, 1);
        append_to(&file, &([
            assistant("m1", "claude-opus-5", 10),
            assistant("m2", "claude-sonnet-5", 20),
            codex_total(160),
            r#"{"usage":{"input_tokens":3,"cached_input_tokens":4}}"#.to_string(),
            "not json".to_string(),
        ].join("\n") + "\n"));
        let u = usage_matches_a_full_reparse(&file, 2);
        assert_eq!(u.input_tokens, 10 + 20 + 160 + 3);
        assert_eq!(u.models, ["claude-opus-5", "claude-sonnet-5"]);
    }

    #[test]
    fn a_session_caught_mid_line_adds_up_as_a_full_reparse_before_and_after() {
        let file = usage_dir("mid").join("s.jsonl");
        let second = assistant("m2", "claude-opus-5", 20);
        let (front, back) = second.split_at(30);
        std::fs::write(&file, assistant("m1", "claude-opus-5", 10) + "\n" + front).unwrap();
        assert_eq!(usage_matches_a_full_reparse(&file, 1).messages, 1);
        append_to(&file, back);
        assert_eq!(usage_matches_a_full_reparse(&file, 2).input_tokens, 30);
        append_to(&file, &("\n".to_string() + &assistant("m3", "claude-opus-5", 30) + "\n"));
        assert_eq!(usage_matches_a_full_reparse(&file, 3).input_tokens, 60);
    }

    #[test]
    fn a_session_rewritten_or_truncated_adds_up_as_a_full_reparse() {
        let file = usage_dir("rewrite").join("s.jsonl");
        std::fs::write(&file, assistant("m1", "claude-opus-5", 11) + "\n").unwrap();
        usage_matches_a_full_reparse(&file, 1);
        // Same size, other content.
        std::fs::write(&file, assistant("m9", "claude-opus-5", 22) + "\n").unwrap();
        assert_eq!(usage_matches_a_full_reparse(&file, 2).input_tokens, 22);
        // Shorter.
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(usage_matches_a_full_reparse(&file, 3).input_tokens, 0);
        // Longer, but the start changed.
        std::fs::write(&file, [assistant("m5", "claude-haiku-4-5", 5), assistant("m6", "claude-haiku-4-5", 6)].join("\n") + "\n").unwrap();
        assert_eq!(usage_matches_a_full_reparse(&file, 4).input_tokens, 11);
    }

    /// "Uso" on a session used to read the whole file on every click. The
    /// answer is now kept per file with where its complete lines end, so the
    /// next click on a session that grew parses only the new lines.
    #[test]
    fn usage_keeps_where_the_complete_lines_of_a_session_end() {
        let file = usage_dir("resume-point").join("s.jsonl");
        let first = assistant("m1", "claude-opus-5", 10) + "\n";
        std::fs::write(&file, first.clone() + "{\"half").unwrap();
        usage_matches_a_full_reparse(&file, 1);
        let resume_point = |file: &Path| usage_cache().lock().get(file).map(|hit| hit.bookmark.offset());
        assert_eq!(resume_point(&file), Some(first.len() as u64));

        append_to(&file, " line\":1}\n");
        usage_matches_a_full_reparse(&file, 2);
        assert_eq!(resume_point(&file), Some(std::fs::metadata(&file).unwrap().len()));
    }

    /// Every real session on this machine: the typed usage from byte 0, and
    /// resumed after its last 16 KiB were appended, must be the `Value`
    /// usage. `--nocapture` prints the time each path took.
    #[test]
    #[ignore = "probe of the local machine; run explicitly with cargo test -- --ignored"]
    fn typed_resumable_usage_matches_the_value_usage_on_every_real_session() {
        use std::time::{Duration, Instant};
        // Copies of real transcripts: the guard removes them even when an
        // assertion below fails.
        let guard = crate::agents::probe_scratch::ProbeScratch::new(&usage_dir("probe"));
        let scratch = guard.path();
        let (mut files, mut bytes) = (0usize, 0u64);
        let (mut old_full, mut new_full, mut new_refresh) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);
        for agent in ["claude", "codex"] {
            let Some(root) = super::super::resolver::sessions_root(agent) else { continue };
            let mut found = Vec::new();
            collect_jsonl_recursive(&root, &mut found, 0);
            for live in found {
                // A frozen copy: a session still being written would hand the
                // oracle and the scan two different files.
                let Ok(data) = std::fs::read(&live) else { continue };
                let file = scratch.join("snapshot.jsonl");
                std::fs::write(&file, &data).unwrap();
                let path = file.to_str().unwrap();
                let clock = Instant::now();
                let expected = serde_json::to_value(value_oracle_usage(path)).unwrap();
                old_full += clock.elapsed();
                let clock = Instant::now();
                let (fresh, _) = scan_usage(&file, data.len() as u64, 0, None);
                new_full += clock.elapsed();
                assert_eq!(serde_json::to_value(&fresh.answer).unwrap(), expected, "{}", live.display());

                let copy = scratch.join("grown.jsonl");
                let cut = data.len().saturating_sub(16 * 1024);
                std::fs::write(&copy, &data[..cut]).unwrap();
                let (before, _) = scan_usage(&copy, cut as u64, 0, None);
                {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new().append(true).open(&copy).unwrap();
                    f.write_all(&data[cut..]).unwrap();
                }
                let clock = Instant::now();
                let (after, _) = scan_usage(&copy, data.len() as u64, 1, Some(before));
                new_refresh += clock.elapsed();
                assert_eq!(serde_json::to_value(&after.answer).unwrap(), expected, "{} resumed", live.display());

                files += 1;
                bytes += data.len() as u64;
            }
        }
        println!(
            "\n--- usage of {files} session files, {:.1} MB ---\n  first click: Value {old_full:?} | typed {new_full:?}\n  click after 16 KiB appended to every file: before (full Value re-parse) {old_full:?} | now {new_refresh:?}",
            bytes as f64 / 1_048_576.0
        );
    }

    #[test]
    fn a_session_that_cannot_be_read_has_no_usage() {
        let missing = usage_dir("missing").join("nope.jsonl");
        let u = usage(missing.to_str().unwrap());
        assert_eq!(
            serde_json::to_value(&u).unwrap(),
            serde_json::to_value(value_oracle_usage(missing.to_str().unwrap())).unwrap()
        );
        assert_eq!(u.messages, 0);
    }

    /// The regression that motivated the fix: a session held open without
    /// read sharing (a backup, sync or antivirus tool) still has metadata,
    /// so the empty answer of the refused open was kept under the file's
    /// real `(len, mtime)`, and "Uso" showed 0 tokens until the file
    /// changed. The old code read the file again on the next click.
    #[cfg(windows)]
    #[test]
    fn a_read_refused_by_a_sharing_lock_is_not_kept_as_the_answer() {
        use std::os::windows::fs::OpenOptionsExt;
        let file = usage_dir("share-lock").join("s.jsonl");
        std::fs::write(&file, assistant("m1", "claude-opus-5", 10) + "\n").unwrap();
        let path = file.to_str().unwrap();
        let json = |u: SessionUsage| serde_json::to_value(u).unwrap();

        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&file).unwrap();
        assert!(File::open(&file).is_err(), "the lock refuses every other open");
        assert!(std::fs::metadata(&file).is_ok(), "the cache key is still there");
        assert_eq!(json(usage(path)), json(value_oracle_usage(path)), "while locked: nothing, as before");
        drop(lock);

        let u = usage(path);
        assert_eq!(json(u.clone()), json(value_oracle_usage(path)), "after the lock: the real totals");
        assert_eq!((u.input_tokens, u.messages), (10, 1));
    }

    /// The same regression for a read that fails once the file is open (a
    /// range another handle locked, a network drive that dropped): that
    /// click gets what the old full read got, the next one reads again.
    #[cfg(windows)]
    #[test]
    fn a_read_cut_by_an_io_error_is_not_kept_as_the_answer() {
        let file = usage_dir("read-error").join("s.jsonl");
        std::fs::write(&file, assistant("m1", "claude-opus-5", 10) + "\n").unwrap();
        let path = file.to_str().unwrap();
        let json = |u: SessionUsage| serde_json::to_value(u).unwrap();

        let holder = File::open(&file).unwrap();
        holder.lock().unwrap();
        assert!(File::open(&file).is_ok(), "the lock lets the file open");
        assert!(std::fs::read(&file).is_err(), "but not be read");
        assert_eq!(json(usage(path)), json(value_oracle_usage(path)), "while locked: what the old read got");
        drop(holder);

        let u = usage(path);
        assert_eq!(json(u.clone()), json(value_oracle_usage(path)), "after the lock: the real totals");
        assert_eq!((u.input_tokens, u.messages), (10, 1));
    }

    /// The Codex walk (year/month/day folders) enters every folder the way
    /// `Path::is_dir` sees it: a junction to a folder is followed, a folder
    /// named like a session is still a folder, and only `.jsonl` files come out.
    #[test]
    fn the_codex_walk_follows_folder_links_and_takes_only_jsonl_files() {
        let root = usage_dir("walk");
        let elsewhere = usage_dir("walk-linked");
        let day = root.join("2026").join("09").join("21");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-a.jsonl"), "").unwrap();
        std::fs::write(day.join("notes.txt"), "").unwrap();
        std::fs::create_dir_all(root.join("odd.jsonl")).unwrap();
        std::fs::write(root.join("odd.jsonl").join("rollout-b.jsonl"), "").unwrap();
        std::fs::write(elsewhere.join("rollout-c.jsonl"), "").unwrap();
        assert!(
            crate::dir_entries::testing::link_dir(&elsewhere, &root.join("linked")),
            "a junction needs no privilege"
        );

        let mut found = Vec::new();
        collect_jsonl_recursive(&root, &mut found, 0);
        let mut found: Vec<String> = found
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec!["2026/09/21/rollout-a.jsonl", "linked/rollout-c.jsonl", "odd.jsonl/rollout-b.jsonl"]
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    /// Claude's project folders are the folders directly under its root, a
    /// linked one included; a file there, or a link whose target is gone, is
    /// not a project folder.
    #[test]
    fn the_claude_project_folders_are_the_folders_under_the_root_links_followed() {
        let root = usage_dir("project-dirs");
        let elsewhere = usage_dir("project-dirs-linked");
        let gone = usage_dir("project-dirs-gone");
        std::fs::create_dir_all(root.join("C--proj")).unwrap();
        std::fs::write(root.join("stray.jsonl"), "").unwrap();
        assert!(crate::dir_entries::testing::link_dir(&elsewhere, &root.join("C--linked")));
        assert!(crate::dir_entries::testing::link_dir(&gone, &root.join("C--gone")));
        std::fs::remove_dir_all(&gone).unwrap();

        let mut names: Vec<String> = read_dirs(&root)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["C--linked", "C--proj"]);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    /// The fallback id was everything after the last `-`, which on
    /// `rollout-<timestamp>-<uuid>` is only the last twelve hex digits of the
    /// UUID: a resume with that id finds nothing.
    #[test]
    fn the_codex_rollout_id_is_the_whole_trailing_uuid() {
        assert_eq!(
            codex_rollout_id("rollout-2026-08-12T10-00-00-0f8fbc2e-5d1a-4c1b-9d2e-8a7b6c5d4e3f")
                .as_deref(),
            Some("0f8fbc2e-5d1a-4c1b-9d2e-8a7b6c5d4e3f")
        );
        assert_eq!(codex_rollout_id("rollout-2026-08-12T10-00-00"), None);
        assert_eq!(codex_rollout_id("0f8fbc2e-5d1a-4c1b-9d2e-8a7b6c5d4e3f").as_deref(), Some("0f8fbc2e-5d1a-4c1b-9d2e-8a7b6c5d4e3f"));
    }

    // Codex writes cumulative totals; summing successive totals double-counts earlier turns.
    #[test]
    fn session_usage_counts_cumulative_tokens_once() {
        let path = std::env::temp_dir().join(format!("yard-session-cumulative-{}.jsonl", std::process::id()));
        let lines = [100, 150].map(|input| serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "token_count", "info": {
                "total_token_usage": { "input_tokens": input, "output_tokens": input / 10 }
            }}
        }).to_string()).join("\n");
        std::fs::write(&path, lines).expect("write isolated session");
        let result = usage(path.to_str().expect("temporary path"));
        std::fs::remove_file(&path).expect("remove isolated session");
        assert_eq!(result.input_tokens, 150);
        assert_eq!(result.output_tokens, 15);
    }

    #[test]
    fn title_skips_internal_commands_and_uses_the_first_message() {
        let lines = vec![
            r#"{"type":"user","cwd":"C:\\proj","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":"arrume o bug do login"}}"#.to_string(),
        ];
        let (title, cwd) = claude_head_info(&lines);
        assert_eq!(title.as_deref(), Some("arrume o bug do login"));
        assert_eq!(cwd.as_deref(), Some(r"C:\proj"));
    }

    #[test]
    fn paths_compare_regardless_of_slash_or_case() {
        assert!(path_matches(r"C:\Work\App", "c:/work/app"));
        assert!(!path_matches(r"C:\Work\App", r"C:\Work\Other"));
    }

    #[test]
    fn cost_is_none_without_a_known_model() {
        let u = SessionUsage {
            input_tokens: 1000,
            models: vec!["modelo-desconhecido".into()],
            ..Default::default()
        };
        assert!(estimate_cost(&u).is_none());
        assert!(estimate_cost(&SessionUsage::default()).is_none());
    }

    #[test]
    fn opus_5_is_not_billed_at_the_old_opus_price() {
        let base = |model: &str| SessionUsage {
            output_tokens: 1_000_000,
            models: vec![model.into()],
            ..Default::default()
        };
        // Opus 5: US$ 25/M of output. Opus 4.1 stays in the old band, 75.
        assert_eq!(estimate_cost(&base("claude-opus-5")), Some(25.0));
        assert_eq!(estimate_cost(&base("claude-opus-4-1")), Some(75.0));
        assert_eq!(estimate_cost(&base("claude-sonnet-5")), Some(15.0));
        assert_eq!(estimate_cost(&base("claude-haiku-4-5")), Some(5.0));
    }

    #[test]
    fn cache_uses_the_input_price_multipliers() {
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
