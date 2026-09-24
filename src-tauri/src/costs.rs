//! "Custos e uso" — tokens and estimated cost per day, project, agent and
//! model, read from the session files the CLIs already write to disk.
//!
//! `sessions.rs::usage` answers "how much did *this* session cost"; the
//! usage meter answers "how much of the window is left". Nothing answered
//! "how much did I spend today, and on what" — which is the question that
//! decides whether the fan-out of five agents was worth it. The trail is the
//! same one `sessions.rs` lists:
//!
//! - **Claude Code** (`~/.claude/projects/<slug>/*.jsonl`): every `assistant`
//!   line carries `message.usage`, repeated on every content-block line of the
//!   same API message — counted once per `message.id`, like the live tail.
//! - **Codex** (`~/.codex/sessions/**/*.jsonl`): `event_msg`/`token_count`
//!   lines carry `payload.info.last_token_usage` (the delta of the turn) and
//!   `total_token_usage` (cumulative); the model comes from the preceding
//!   `turn_context`, the folder from `session_meta`.
//!
//! Each file is parsed once per `(len, mtime)` and the samples are cached,
//! so reopening the panel costs a directory walk, not a re-read of 30 days of
//! transcripts. A file that grew since (the session still running) is parsed
//! only from where its complete lines ended (`agents::bookmark`), and each
//! line is read into the few fields the scan needs (`agents::usage_line`),
//! not into a whole `Value` tree. Both are pinned against the old full
//! `Value` re-parse by the tests. Everything is failure-tolerant: a line that
//! does not parse is a line that does not count, never an error that empties
//! the panel.

use crate::bounded_cache::BoundedCache;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Local, TimeZone};
use parking_lot::Mutex;
use serde::Serialize;

use crate::agents::sessions::{estimate_cost, SessionUsage};
use crate::agents::bookmark::{read_lines, Bookmark};
use crate::agents::tokens::{claude_usage_delta, codex_delta, TokenCounts};
use crate::agents::usage_line::{self, UsageLine};

/// Cap per line, as in `sessions.rs`: a pasted file inside a message must not
/// blow the scan's memory.
const MAX_LINE: usize = 512 * 1024;
const CACHE_MAX_FILES: usize = 4096;

/// One row of the panel: the usage of one agent, in one project, with one
/// model, on one local day.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    /// `claude` | `codex`.
    pub agent: String,
    /// The working folder the session announced; empty when unknown.
    pub project_path: String,
    /// The model id as the CLI wrote it; empty when unknown.
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Estimate from the table in `sessions.rs`; `None` for a model outside
    /// it — no number beats a made-up number.
    pub cost_usd: Option<f64>,
    /// Distinct session files that contributed to the row.
    pub sessions: u32,
}

/// One API message's worth of usage, with where and when it happened.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Sample {
    at: i64,
    project: String,
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

struct CachedFile {
    len: u64,
    mtime: i64,
    /// The answer: every sample, the trailing half line's included.
    samples: Arc<[Sample]>,
    /// How many of `samples` came from complete lines: the part a resumed
    /// read keeps.
    committed: usize,
    /// Where the complete lines end, and the parser state right there.
    bookmark: Bookmark,
    scan: Scan,
}

#[cfg(test)]
mod cache_regressions {
    /// Warm reads must share immutable samples instead of cloning a full history.
    #[test]
    fn warm_history_reads_share_their_sample_storage() {
        let file = std::env::temp_dir().join(format!("yard-cache-shared-{}.jsonl", std::process::id()));
        std::fs::write(&file, "").unwrap();
        let first = super::samples_for("codex", &file, 0, 0);
        let second = super::samples_for("codex", &file, 0, 0);
        std::fs::remove_file(&file).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &second));
    }
    /// One new session must not evict every recently viewed session.
    #[test]
    fn bounded_cache_keeps_recent_sessions_when_capacity_is_reached() {
        let mut cache = crate::bounded_cache::BoundedCache::new(2);
        cache.insert("old", 1);
        cache.insert("recent", 2);
        assert_eq!(cache.get(&"old"), Some(&1));
        cache.insert("new", 3);
        assert_eq!(cache.get(&"old"), Some(&1));
        assert_eq!(cache.get(&"new"), Some(&3));
        assert_eq!(cache.get(&"recent"), None);
    }
}

fn cache() -> &'static Mutex<BoundedCache<PathBuf, CachedFile>> {
    static CACHE: OnceLock<Mutex<BoundedCache<PathBuf, CachedFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BoundedCache::new(CACHE_MAX_FILES)))
}

/// The panel's command: the last `days` local days (1 = today only), over
/// the real session roots, off the async runtime.
#[tauri::command]
pub async fn usage_history(days: u32) -> Vec<UsageRow> {
    tauri::async_runtime::spawn_blocking(move || history(days))
        .await
        .unwrap_or_default()
}

fn history(days: u32) -> Vec<UsageRow> {
    let mut roots: Vec<(&str, PathBuf)> = Vec::new();
    for agent in ["claude", "codex"] {
        if let Some(root) = crate::agents::resolver::sessions_root(agent) {
            roots.push((agent, root));
        }
    }
    let borrowed: Vec<(&str, &Path)> = roots.iter().map(|(a, p)| (*a, p.as_path())).collect();
    history_in(&borrowed, days, Local::now())
}

/// Local midnight of the first day in the window: `days = 1` is today,
/// `days = 7` is today and the six days before it. `0` reads as today too —
/// an empty window is never what a panel asked for.
pub(crate) fn window_start(now: DateTime<Local>, days: u32) -> i64 {
    // Ten years covers every panel; anything past it is a caller's mistake,
    // and the date arithmetic below overflows long before `u32::MAX`.
    const MAX_DAYS: u32 = 3660;
    let back = i64::from(days.min(MAX_DAYS).saturating_sub(1));
    let first = now
        .date_naive()
        .checked_sub_signed(chrono::Duration::days(back))
        .unwrap_or(chrono::NaiveDate::MIN);
    let midnight = first.and_hms_opt(0, 0, 0).expect("midnight exists");
    Local
        .from_local_datetime(&midnight)
        .earliest()
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

/// The scan over explicit roots — what the tests drive, with fixture files
/// instead of the user's `~/.claude` and `~/.codex`.
pub(crate) fn history_in(roots: &[(&str, &Path)], days: u32, now: DateTime<Local>) -> Vec<UsageRow> {
    let start = window_start(now, days);
    type Key = (String, String, String, String);
    let mut acc: HashMap<Key, (UsageRow, HashSet<PathBuf>)> = HashMap::new();

    for (agent, root) in roots {
        for file in jsonl_under(root) {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let mtime = mtime_ms(&meta);
            // Lines only ever get appended, so a file untouched since before
            // the window has nothing inside it.
            if mtime < start {
                continue;
            }
            let samples = samples_for(agent, &file, meta.len(), mtime);
            for s in samples.iter().filter(|s| s.at >= start) {
                let day = local_day(s.at);
                let key = (day.clone(), agent.to_string(), s.project.clone(), s.model.clone());
                let (row, files) = acc.entry(key).or_insert_with(|| {
                    (
                        UsageRow {
                            day,
                            agent: agent.to_string(),
                            project_path: s.project.clone(),
                            model: s.model.clone(),
                            ..Default::default()
                        },
                        HashSet::new(),
                    )
                });
                row.input += s.input;
                row.output += s.output;
                row.cache_read += s.cache_read;
                row.cache_write += s.cache_write;
                files.insert(file.clone());
            }
        }
    }

    let mut rows: Vec<UsageRow> = acc
        .into_values()
        .map(|(mut row, files)| {
            row.sessions = files.len() as u32;
            row.cost_usd = cost_of(&row);
            row
        })
        .collect();
    rows.sort_by(|a, b| {
        a.day
            .cmp(&b.day)
            .then_with(|| cost_key(b).partial_cmp(&cost_key(a)).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| (b.input + b.output).cmp(&(a.input + a.output)))
            .then_with(|| a.project_path.cmp(&b.project_path))
    });
    rows
}

/// Priced with the same table as a single session, one model per row.
fn cost_of(row: &UsageRow) -> Option<f64> {
    estimate_cost(&SessionUsage {
        input_tokens: row.input,
        output_tokens: row.output,
        cache_creation_tokens: row.cache_write,
        cache_read_tokens: row.cache_read,
        models: vec![row.model.clone()],
        ..Default::default()
    })
}

/// Sort key: a priced row goes before an unpriced one of the same day.
fn cost_key(row: &UsageRow) -> f64 {
    row.cost_usd.unwrap_or(-1.0)
}

fn local_day(at: i64) -> String {
    Local
        .timestamp_millis_opt(at)
        .earliest()
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Every `.jsonl` under `root`, a few levels deep — Claude keeps one folder
/// per project, Codex one per year/month/day. Capped so a runaway tree cannot
/// turn the panel into a disk scan.
fn jsonl_under(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        if depth > 5 || out.len() > 4000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            // The listing answers for a plain entry; only a link is opened,
            // to be followed as `Path::is_dir` always followed it. The
            // file's size and mtime still come from `fs::metadata` in
            // `history_in`: the listing's copy lags while a session is
            // being written, and those two are the cache key.
            if crate::dir_entries::is_dir(&entry) {
                walk(&path, out, depth + 1);
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out, 0);
    out
}

/// The samples of one file, from the cache when its `(len, mtime)` still
/// match, parsed otherwise.
fn samples_for(agent: &str, file: &Path, len: u64, mtime: i64) -> Arc<[Sample]> {
    let previous = {
        let mut cache = cache().lock();
        if let Some(hit) = cache.get(file) {
            if hit.len == len && hit.mtime == mtime {
                return hit.samples.clone();
            }
        }
        // Taken out, not cloned: the entry carries every message id the file
        // has seen, and the new entry is built from it.
        cache.remove(file)
    };
    let entry = scan_file(agent, file, len, mtime, previous);
    let samples = entry.samples.clone();
    cache().lock().insert(file.to_path_buf(), entry);
    samples
}

/// Brings one file's samples up to date. Only a file that grew is resumed
/// from `previous`, and only when the bytes already read are still there
/// (`Bookmark::reopen`); anything else (same size with a new mtime,
/// shorter, rewritten, unreadable) is parsed from byte 0, as it always was.
fn scan_file(agent: &str, file: &Path, len: u64, mtime: i64, previous: Option<CachedFile>) -> CachedFile {
    let resumed = previous
        .filter(|p| len > p.len && p.scan.is_for(agent))
        .and_then(|p| p.bookmark.reopen(file).map(|handle| (handle, p)));
    let (handle, mut bookmark, mut scan, mut samples) = match resumed {
        Some((handle, p)) => (Some(handle), p.bookmark, p.scan, p.samples[..p.committed].to_vec()),
        None => (File::open(file).ok(), Bookmark::default(), Scan::new(agent), Vec::new()),
    };
    let tail = handle.and_then(|handle| read_lines(handle, &mut bookmark, |line| scan.line(line, &mut samples)).ok().flatten());
    let committed = samples.len();
    // A last line with no `\n` yet counts as it reads now, as a full parse
    // counts it, but on a copy of the state: the next read starts at it again.
    if let Some(line) = tail.as_deref().and_then(parse_line) {
        scan.clone().apply(line, &mut samples);
    }
    CachedFile {
        len,
        mtime,
        samples: samples.into(),
        committed,
        bookmark,
        scan,
    }
}

/// What the scan remembers between two lines, and so between two reads.
#[derive(Clone)]
enum Scan {
    /// The API messages already counted.
    Claude(HashSet<String>),
    Codex(CodexState),
}

#[derive(Clone, Default)]
struct CodexState {
    /// From `session_meta` (or the first `turn_context` that has one).
    project: String,
    /// From the latest `turn_context`.
    model: String,
    /// The previous cumulative total, for turns that bring only that.
    prev_total: Option<TokenCounts>,
}

impl Scan {
    fn new(agent: &str) -> Self {
        match agent {
            "codex" => Scan::Codex(CodexState::default()),
            _ => Scan::Claude(HashSet::new()),
        }
    }

    fn is_for(&self, agent: &str) -> bool {
        matches!(self, Scan::Codex(_)) == (agent == "codex")
    }

    fn line(&mut self, line: &str, out: &mut Vec<Sample>) {
        if let Some(line) = parse_line(line) {
            self.apply(line, out);
        }
    }

    fn apply(&mut self, line: UsageLine, out: &mut Vec<Sample>) {
        match self {
            Scan::Claude(seen) => add_claude_line(seen, line, out),
            Scan::Codex(state) => add_codex_line(state, line, out),
        }
    }
}

/// `None` for a line that does not count before it is even parsed.
fn parse_line(line: &str) -> Option<UsageLine> {
    if line.is_empty() || line.len() > MAX_LINE {
        return None;
    }
    usage_line::parse(line)
}

fn parse_ts(timestamp: Option<&str>) -> i64 {
    timestamp
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

/// Parses one Claude Code `.jsonl` into per-message samples. The usage of an
/// API message is repeated on every content-block line it produced; it is
/// counted on the first line that carries a new `message.id`. Files go
/// through `scan_file`; this line-iterator entry point is for the tests.
#[cfg(test)]
pub(crate) fn claude_samples(lines: impl Iterator<Item = String>) -> Vec<Sample> {
    scan_lines(Scan::new("claude"), lines)
}

#[cfg(test)]
fn scan_lines(mut scan: Scan, lines: impl Iterator<Item = String>) -> Vec<Sample> {
    let mut out = Vec::new();
    for line in lines {
        scan.line(&line, &mut out);
    }
    out
}

fn add_claude_line(seen: &mut HashSet<String>, line: UsageLine, out: &mut Vec<Sample>) {
    if line.kind.as_deref() != Some("assistant") {
        return;
    }
    let Some(msg) = line.message else { return };
    let Some(delta) = claude_usage_delta(msg.id.as_deref(), msg.usage.as_ref(), seen) else {
        return;
    };
    out.push(Sample {
        at: parse_ts(line.timestamp.as_deref()),
        project: line.cwd.unwrap_or_default(),
        model: msg.model.unwrap_or_default(),
        input: delta.0,
        output: delta.3,
        cache_read: delta.1,
        cache_write: delta.2,
    });
}

/// Parses one Codex rollout `.jsonl` into per-turn samples. The folder comes
/// from `session_meta`, the model from the latest `turn_context`, and each
/// `token_count` contributes its `last_token_usage` — or, when the CLI only
/// wrote the cumulative `total_token_usage`, the difference from the previous
/// total. A line-iterator entry point for the tests, like `claude_samples`.
#[cfg(test)]
pub(crate) fn codex_samples(lines: impl Iterator<Item = String>) -> Vec<Sample> {
    scan_lines(Scan::new("codex"), lines)
}

fn add_codex_line(state: &mut CodexState, line: UsageLine, out: &mut Vec<Sample>) {
    let payload = line.payload;
    match line.kind.as_deref() {
        Some("session_meta") => {
            let cwd = payload.and_then(|p| p.cwd).unwrap_or_default();
            if !cwd.is_empty() {
                state.project = cwd;
            }
        }
        Some("turn_context") => {
            let (model, cwd) = payload.map(|p| (p.model, p.cwd)).unwrap_or_default();
            let model = model.unwrap_or_default();
            if !model.is_empty() {
                state.model = model;
            }
            if state.project.is_empty() {
                state.project = cwd.unwrap_or_default();
            }
        }
        Some("event_msg") => {
            let Some(payload) = payload else { return };
            if payload.kind.as_deref() != Some("token_count") {
                return;
            }
            let Some(info) = payload.info.filter(|i| !i.is_null()) else {
                return;
            };
            let Some(delta) = codex_delta(&info, &mut state.prev_total) else {
                return;
            };
            out.push(Sample {
                at: parse_ts(line.timestamp.as_deref()),
                project: state.project.clone(),
                model: state.model.clone(),
                input: delta.0,
                output: delta.3,
                cache_read: delta.1,
                cache_write: delta.2,
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn local(y: i32, m: u32, d: u32, h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, 0, 0).single().unwrap()
    }

    fn stamp(t: DateTime<Local>) -> String {
        t.to_rfc3339()
    }

    fn claude_line(id: &str, at: DateTime<Local>, model: &str, cwd: &str, inp: u64, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{}","cwd":"{}","message":{{"id":"{id}","model":"{model}","content":[{{"type":"text","text":"oi"}}],"usage":{{"input_tokens":{inp},"output_tokens":{out},"cache_creation_input_tokens":4,"cache_read_input_tokens":40}}}}}}"#,
            stamp(at),
            cwd.replace('\\', "\\\\"),
        )
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-costs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `days` arrives straight from IPC. A window of `u32::MAX` days used to
    /// overflow the date arithmetic and panic; it is clamped instead.
    #[test]
    fn an_absurd_day_count_does_not_panic() {
        let now = local(2026, 8, 26, 15);
        let start = window_start(now, u32::MAX);
        assert!(start <= window_start(now, 1));
    }

    #[test]
    fn the_window_starts_at_local_midnight_days_minus_one_ago() {
        let now = local(2026, 8, 26, 15);
        assert_eq!(window_start(now, 1), local(2026, 8, 26, 0).timestamp_millis());
        assert_eq!(window_start(now, 7), local(2026, 8, 20, 0).timestamp_millis());
        // `0` is not "nothing": it is treated as today, like `1`.
        assert_eq!(window_start(now, 0), local(2026, 8, 26, 0).timestamp_millis());
    }

    /// The walk that finds the session files enters every folder the way
    /// `Path::is_dir` sees it: a junction to a folder is followed (a user can
    /// link a project folder in), a folder whose name ends in `.jsonl` is
    /// still a folder, and only `.jsonl` files come out.
    #[test]
    fn the_session_walk_follows_folder_links_and_takes_only_jsonl_files() {
        let root = temp_root("walk");
        let elsewhere = temp_root("walk-linked");
        let proj = root.join("C--proj");
        std::fs::create_dir_all(proj.join("sub")).unwrap();
        std::fs::write(proj.join("a.jsonl"), "").unwrap();
        std::fs::write(proj.join("sub").join("b.jsonl"), "").unwrap();
        std::fs::write(proj.join("notes.txt"), "").unwrap();
        std::fs::create_dir_all(root.join("odd.jsonl")).unwrap();
        std::fs::write(root.join("odd.jsonl").join("c.jsonl"), "").unwrap();
        std::fs::write(elsewhere.join("d.jsonl"), "").unwrap();
        assert!(
            crate::dir_entries::testing::link_dir(&elsewhere, &root.join("linked")),
            "a junction needs no privilege"
        );

        let mut found: Vec<String> = jsonl_under(&root)
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec!["C--proj/a.jsonl", "C--proj/sub/b.jsonl", "linked/d.jsonl", "odd.jsonl/c.jsonl"]
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn claude_usage_is_counted_once_per_api_message_and_bucketed_by_local_day() {
        let now = local(2026, 8, 26, 15);
        let root = temp_root("claude-days");
        let proj = root.join("C--proj");
        std::fs::create_dir_all(&proj).unwrap();
        let today = local(2026, 8, 26, 9);
        let yesterday = local(2026, 8, 25, 22);
        let lines = [
            // The same API message on two content-block lines: one count.
            claude_line("m1", today, "claude-opus-5", r"C:\proj", 100, 10),
            claude_line("m1", today, "claude-opus-5", r"C:\proj", 100, 10),
            claude_line("m2", today, "claude-opus-5", r"C:\proj", 50, 5),
            claude_line("m3", yesterday, "claude-opus-5", r"C:\proj", 7, 3),
        ];
        std::fs::write(proj.join("s1.jsonl"), lines.join("\n") + "\n").unwrap();

        let rows = history_in(&[("claude", root.as_path())], 7, now);
        assert_eq!(rows.len(), 2, "one row per day: {rows:?}");
        let today_row = rows.iter().find(|r| r.day == "2026-08-26").unwrap();
        assert_eq!(today_row.input, 150);
        assert_eq!(today_row.output, 15);
        assert_eq!(today_row.cache_write, 8);
        assert_eq!(today_row.cache_read, 80);
        assert_eq!(today_row.agent, "claude");
        assert_eq!(today_row.project_path, r"C:\proj");
        assert_eq!(today_row.model, "claude-opus-5");
        assert_eq!(today_row.sessions, 1);
        // Opus 5: 150 in × 5 + 15 out × 25 + 8 write × 6.25 + 80 read × 0.5, per million.
        let expected = (150.0 * 5.0 + 15.0 * 25.0 + 8.0 * 6.25 + 80.0 * 0.5) / 1_000_000.0;
        assert!((today_row.cost_usd.unwrap() - expected).abs() < 1e-12);
        let y = rows.iter().find(|r| r.day == "2026-08-25").unwrap();
        assert_eq!((y.input, y.output), (7, 3));
    }

    #[test]
    fn a_line_dated_before_the_window_does_not_count_even_in_a_fresh_file() {
        let now = local(2026, 8, 26, 15);
        let root = temp_root("claude-window");
        let proj = root.join("C--proj");
        std::fs::create_dir_all(&proj).unwrap();
        let lines = [
            claude_line("old", now - Duration::days(3), "claude-sonnet-5", r"C:\proj", 1000, 1000),
            claude_line("new", now, "claude-sonnet-5", r"C:\proj", 1, 1),
        ];
        std::fs::write(proj.join("s.jsonl"), lines.join("\n") + "\n").unwrap();

        let rows = history_in(&[("claude", root.as_path())], 1, now);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].input, rows[0].output), (1, 1));
    }

    #[test]
    fn distinct_sessions_of_the_same_day_and_model_merge_and_are_counted() {
        let now = local(2026, 8, 26, 15);
        let root = temp_root("claude-sessions");
        let proj = root.join("C--proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("a.jsonl"),
            claude_line("a1", now, "claude-haiku-4-5", r"C:\proj", 10, 1) + "\n",
        )
        .unwrap();
        std::fs::write(
            proj.join("b.jsonl"),
            claude_line("b1", now, "claude-haiku-4-5", r"C:\proj", 20, 2) + "\n",
        )
        .unwrap();

        let rows = history_in(&[("claude", root.as_path())], 1, now);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sessions, 2);
        assert_eq!((rows[0].input, rows[0].output), (30, 3));
    }

    #[test]
    fn codex_usage_takes_the_turn_delta_and_the_model_of_the_turn_context() {
        let now = local(2026, 8, 26, 15);
        let at = stamp(local(2026, 8, 26, 10));
        let lines = vec![
            format!(r#"{{"timestamp":"{at}","type":"session_meta","payload":{{"id":"s1","cwd":"C:\\repo","model_provider":"openai"}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"turn_context","payload":{{"turn_id":"t1","cwd":"C:\\repo","model":"gpt-5.3-codex"}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":0,"output_tokens":100}},"last_token_usage":{{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":0,"output_tokens":100}}}}}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1500,"cached_input_tokens":900,"cache_write_input_tokens":0,"output_tokens":160}},"last_token_usage":{{"input_tokens":500,"cached_input_tokens":300,"cache_write_input_tokens":0,"output_tokens":60}}}}}}}}"#),
            // A token_count without `info` (rate limits only) is not usage.
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":null,"rate_limits":{{}}}}}}"#),
        ];
        let samples = codex_samples(lines.into_iter());
        assert_eq!(samples.len(), 2, "{samples:?}");
        assert_eq!(samples[0].project, r"C:\repo");
        assert_eq!(samples[0].model, "gpt-5.3-codex");
        assert_eq!((samples[0].input, samples[0].cache_read, samples[0].output), (1000, 600, 100));
        assert_eq!((samples[1].input, samples[1].cache_read, samples[1].output), (500, 300, 60));

        // Through the whole scan: an OpenAI model is outside the price table,
        // so the tokens are there and the cost is honestly absent.
        let root = temp_root("codex");
        let day_dir = root.join("2026").join("08").join("26");
        std::fs::create_dir_all(&day_dir).unwrap();
        let text = {
            let at = stamp(local(2026, 8, 26, 10));
            [
                format!(r#"{{"timestamp":"{at}","type":"session_meta","payload":{{"id":"s1","cwd":"C:\\repo"}}}}"#),
                format!(r#"{{"timestamp":"{at}","type":"turn_context","payload":{{"model":"gpt-5.3-codex"}}}}"#),
                format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5}}}}}}}}"#),
            ]
            .join("\n")
        };
        std::fs::write(day_dir.join("rollout-2026-08-26T10-00-00-abc.jsonl"), text).unwrap();
        let rows = history_in(&[("codex", root.as_path())], 1, now);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent, "codex");
        assert_eq!(rows[0].model, "gpt-5.3-codex");
        assert_eq!((rows[0].input, rows[0].output), (10, 5));
        assert_eq!(rows[0].cost_usd, None);
    }

    #[test]
    fn codex_falls_back_to_the_cumulative_delta_when_the_turn_delta_is_missing() {
        let at = stamp(local(2026, 8, 26, 10));
        let lines = vec![
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":10,"cache_write_input_tokens":0,"output_tokens":20}}}}}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":130,"cached_input_tokens":15,"cache_write_input_tokens":2,"output_tokens":25}}}}}}}}"#),
        ];
        let samples = codex_samples(lines.into_iter());
        assert_eq!(samples.len(), 2);
        assert_eq!((samples[0].input, samples[0].output), (100, 20));
        assert_eq!((samples[1].input, samples[1].cache_read, samples[1].cache_write, samples[1].output), (30, 5, 2, 5));
    }

    /// The scan as it was before it became typed and incremental, verbatim:
    /// every line through `serde_json::Value`, every file from byte 0. It is
    /// the oracle the resumed scans are held against, so the numbers in
    /// "Custos e uso" cannot drift from what they always were.
    mod value_oracle {
        use super::super::{Sample, MAX_LINE};
        use crate::agents::tokens::{claude_delta, codex_delta};
        use std::collections::HashSet;
        use std::io::{BufRead, BufReader};
        use std::path::Path;

        fn parse_ts(v: &serde_json::Value) -> i64 {
            v.get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.timestamp_millis())
                .unwrap_or(0)
        }

        fn text(v: Option<&serde_json::Value>, key: &str) -> String {
            v.and_then(|o| o.get(key))
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string()
        }

        pub(crate) fn claude_samples(lines: impl Iterator<Item = String>) -> Vec<Sample> {
            let mut out = Vec::new();
            let mut seen_messages = HashSet::new();
            for line in lines {
                if line.is_empty() || line.len() > MAX_LINE {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                    continue;
                }
                let Some(msg) = v.get("message") else { continue };
                let Some(delta) = claude_delta(msg, &mut seen_messages) else { continue };
                out.push(Sample {
                    at: parse_ts(&v),
                    project: text(Some(&v), "cwd"),
                    model: text(Some(msg), "model"),
                    input: delta.0,
                    output: delta.3,
                    cache_read: delta.1,
                    cache_write: delta.2,
                });
            }
            out
        }

        pub(crate) fn codex_samples(lines: impl Iterator<Item = String>) -> Vec<Sample> {
            let mut out = Vec::new();
            let mut project = String::new();
            let mut model = String::new();
            let mut prev_total: Option<(u64, u64, u64, u64)> = None;
            for line in lines {
                if line.is_empty() || line.len() > MAX_LINE {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let payload = v.get("payload");
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("session_meta") => {
                        let cwd = text(payload, "cwd");
                        if !cwd.is_empty() {
                            project = cwd;
                        }
                    }
                    Some("turn_context") => {
                        let m = text(payload, "model");
                        if !m.is_empty() {
                            model = m;
                        }
                        if project.is_empty() {
                            project = text(payload, "cwd");
                        }
                    }
                    Some("event_msg") => {
                        if text(payload, "type") != "token_count" {
                            continue;
                        }
                        let Some(info) = payload.and_then(|p| p.get("info")).filter(|i| !i.is_null()) else {
                            continue;
                        };
                        let Some(delta) = codex_delta(info, &mut prev_total) else { continue };
                        out.push(Sample {
                            at: parse_ts(&v),
                            project: project.clone(),
                            model: model.clone(),
                            input: delta.0,
                            output: delta.3,
                            cache_read: delta.1,
                            cache_write: delta.2,
                        });
                    }
                    _ => {}
                }
            }
            out
        }

        /// The whole file, from byte 0, as `samples_for` used to read it.
        pub(crate) fn samples_of(agent: &str, file: &Path) -> Vec<Sample> {
            let Ok(f) = std::fs::File::open(file) else { return Vec::new() };
            let lines = BufReader::new(f).lines().map_while(Result::ok);
            match agent {
                "codex" => codex_samples(lines),
                _ => claude_samples(lines),
            }
        }
    }

    /// One refresh of the panel over `file` as it is now, held against a
    /// full re-parse by the oracle. `mtime` is passed in so a rewrite of the
    /// same size inside one millisecond still reads as a change.
    fn refresh_matches_a_full_reparse(agent: &str, file: &Path, mtime: i64) -> Arc<[Sample]> {
        let len = std::fs::metadata(file).unwrap().len();
        let got = samples_for(agent, file, len, mtime);
        let expected = value_oracle::samples_of(agent, file);
        assert_eq!(&*got, &expected[..], "{agent} {} at mtime {mtime}", file.display());
        got
    }

    fn append(file: &Path, text: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(file).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn codex_total(at: &str, input: u64, output: u64) -> String {
        format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{},"cache_write_input_tokens":0,"output_tokens":{output}}}}}}}}}"#, input / 2)
    }

    #[test]
    fn a_file_that_grew_by_whole_lines_reads_as_a_full_reparse() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("grow-lines");
        let file = root.join("s.jsonl");
        std::fs::write(&file, [claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1), claude_line("m2", at, "claude-opus-5", r"C:\p", 20, 2)].join("\n") + "\n").unwrap();
        refresh_matches_a_full_reparse("claude", &file, 1);
        append(&file, &(claude_line("m3", at, "claude-sonnet-5", r"C:\q", 30, 3) + "\n"));
        let grown = refresh_matches_a_full_reparse("claude", &file, 2);
        assert_eq!(grown.len(), 3);
    }

    /// The writer is caught in the middle of a line: the half line does not
    /// count now and counts once it is whole, like a full re-parse says.
    #[test]
    fn a_file_caught_mid_line_reads_as_a_full_reparse_before_and_after() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("grow-mid");
        let file = root.join("s.jsonl");
        let third = claude_line("m3", at, "claude-opus-5", r"C:\p", 30, 3);
        let (first_half, second_half) = third.split_at(40);
        std::fs::write(&file, [claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1), claude_line("m2", at, "claude-opus-5", r"C:\p", 20, 2)].join("\n") + "\n" + first_half).unwrap();
        assert_eq!(refresh_matches_a_full_reparse("claude", &file, 1).len(), 2);
        append(&file, second_half);
        // Whole, but with no `\n` yet: it already counts.
        assert_eq!(refresh_matches_a_full_reparse("claude", &file, 2).len(), 3);
        append(&file, &("\n".to_string() + &claude_line("m4", at, "claude-opus-5", r"C:\p", 40, 4) + "\n"));
        // ...and counts once, not again now that its line is complete.
        assert_eq!(refresh_matches_a_full_reparse("claude", &file, 3).len(), 4);
    }

    /// The usage of one API message is repeated on each of its content-block
    /// lines. A repeat that lands after the boundary of the previous read
    /// must still be recognised as a repeat.
    #[test]
    fn a_message_id_repeated_across_the_read_boundary_counts_once() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("grow-dedup");
        let file = root.join("s.jsonl");
        std::fs::write(&file, claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1) + "\n").unwrap();
        refresh_matches_a_full_reparse("claude", &file, 1);
        append(&file, &[claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1), claude_line("m2", at, "claude-opus-5", r"C:\p", 5, 5)].join("\n"));
        let grown = refresh_matches_a_full_reparse("claude", &file, 2);
        assert_eq!(grown.iter().map(|s| s.input).collect::<Vec<_>>(), [10, 5]);
    }

    /// Codex may write only the cumulative totals: each turn is the
    /// difference from the previous total, and the previous total, the
    /// folder and the model all come from before the boundary.
    #[test]
    fn codex_cumulative_totals_across_the_read_boundary_read_as_a_full_reparse() {
        let at = stamp(local(2026, 8, 26, 10));
        let root = temp_root("grow-codex");
        let file = root.join("rollout.jsonl");
        std::fs::write(&file, [
            format!(r#"{{"timestamp":"{at}","type":"session_meta","payload":{{"id":"s1","cwd":"C:\\repo"}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"turn_context","payload":{{"model":"gpt-5.3-codex"}}}}"#),
            codex_total(&at, 100, 10),
            codex_total(&at, 150, 16),
        ].join("\n") + "\n").unwrap();
        refresh_matches_a_full_reparse("codex", &file, 1);
        append(&file, &([
            codex_total(&at, 190, 20),
            format!(r#"{{"timestamp":"{at}","type":"turn_context","payload":{{"model":"gpt-5.4"}}}}"#),
            codex_total(&at, 260, 31),
        ].join("\n") + "\n"));
        let grown = refresh_matches_a_full_reparse("codex", &file, 2);
        assert_eq!(grown.iter().map(|s| (s.input, s.model.as_str())).collect::<Vec<_>>(), [
            (100, "gpt-5.3-codex"),
            (50, "gpt-5.3-codex"),
            (40, "gpt-5.3-codex"),
            (70, "gpt-5.4"),
        ]);
        assert!(grown.iter().all(|s| s.project == r"C:\repo"));
    }

    #[test]
    fn a_file_rewritten_to_the_same_size_reads_as_a_full_reparse() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("rewrite-same");
        let file = root.join("s.jsonl");
        std::fs::write(&file, claude_line("m1", at, "claude-opus-5", r"C:\p", 11, 1) + "\n").unwrap();
        refresh_matches_a_full_reparse("claude", &file, 1);
        std::fs::write(&file, claude_line("m9", at, "claude-opus-5", r"C:\q", 22, 2) + "\n").unwrap();
        let rewritten = refresh_matches_a_full_reparse("claude", &file, 2);
        assert_eq!((rewritten[0].input, rewritten[0].project.as_str()), (22, r"C:\q"));
    }

    #[test]
    fn a_truncated_file_reads_as_a_full_reparse() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("truncate");
        let file = root.join("s.jsonl");
        std::fs::write(&file, (1..=5).map(|i| claude_line(&format!("m{i}"), at, "claude-opus-5", r"C:\p", i, i)).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        refresh_matches_a_full_reparse("claude", &file, 1);
        std::fs::write(&file, claude_line("m7", at, "claude-opus-5", r"C:\p", 7, 7) + "\n").unwrap();
        assert_eq!(refresh_matches_a_full_reparse("claude", &file, 2).len(), 1);
    }

    /// A rewrite that also made the file longer passes the "it grew" test;
    /// the bytes already read no longer being the same is what sends it back
    /// to a full re-parse.
    #[test]
    fn a_file_rewritten_longer_reads_as_a_full_reparse() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("rewrite-longer");
        let file = root.join("s.jsonl");
        std::fs::write(&file, [claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1), claude_line("m2", at, "claude-opus-5", r"C:\p", 20, 2)].join("\n") + "\n").unwrap();
        refresh_matches_a_full_reparse("claude", &file, 1);
        std::fs::write(&file, [claude_line("m1", at, "claude-opus-5", r"C:\p", 90, 9), claude_line("m2", at, "claude-opus-5", r"C:\p", 20, 2), claude_line("m3", at, "claude-opus-5", r"C:\p", 30, 3)].join("\n") + "\n").unwrap();
        let rewritten = refresh_matches_a_full_reparse("claude", &file, 2);
        assert_eq!(rewritten[0].input, 90);
    }

    /// The old reader stopped for good at a line that is not UTF-8; appending
    /// after it changes nothing.
    #[test]
    fn a_line_that_is_not_utf8_stops_the_count_before_and_after_growth() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("not-utf8");
        let file = root.join("s.jsonl");
        let mut bytes = (claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1) + "\n").into_bytes();
        bytes.extend_from_slice(b"{\"type\":\"assistant\xff\"}\n");
        bytes.extend_from_slice((claude_line("m2", at, "claude-opus-5", r"C:\p", 20, 2) + "\n").as_bytes());
        std::fs::write(&file, bytes).unwrap();
        assert_eq!(refresh_matches_a_full_reparse("claude", &file, 1).len(), 1);
        append(&file, &(claude_line("m3", at, "claude-opus-5", r"C:\p", 30, 3) + "\n"));
        assert_eq!(refresh_matches_a_full_reparse("claude", &file, 2).len(), 1);
    }

    /// What makes a refresh cheap: the cache keeps where the complete lines
    /// of each file end, so the next refresh parses only what came after.
    /// The half line at the end is not part of it; it is read again.
    #[test]
    fn the_cache_keeps_where_the_complete_lines_of_a_file_end() {
        let at = local(2026, 8, 26, 10);
        let root = temp_root("resume-point");
        let file = root.join("s.jsonl");
        let first = claude_line("m1", at, "claude-opus-5", r"C:\p", 10, 1) + "\n";
        std::fs::write(&file, first.clone() + "{\"type\":\"assist").unwrap();
        refresh_matches_a_full_reparse("claude", &file, 1);
        let resume_point = |file: &Path| cache().lock().get(file).map(|hit| hit.bookmark.offset());
        assert_eq!(resume_point(&file), Some(first.len() as u64));

        append(&file, "ant\"}\n");
        refresh_matches_a_full_reparse("claude", &file, 2);
        assert_eq!(resume_point(&file), Some(std::fs::metadata(&file).unwrap().len()));
    }

    /// Every real session on this machine, read by the typed scan from byte
    /// 0 and resumed after its last 16 KiB were appended (cut anywhere, mid
    /// line included), must give what the `Value` scan gives. `--nocapture`
    /// prints the time each path took; in the old code a refresh of a grown
    /// file was a full parse.
    #[test]
    #[ignore = "probe of the local machine; run explicitly with cargo test -- --ignored"]
    fn the_typed_resumable_scan_matches_the_value_scan_on_every_real_session() {
        use std::time::{Duration, Instant};
        // Copies of real transcripts: the guard removes them even when an
        // assertion below fails.
        let guard = crate::agents::probe_scratch::ProbeScratch::new(&temp_root("probe"));
        let scratch = guard.path();
        let (mut files, mut bytes, mut samples) = (0usize, 0u64, 0usize);
        let (mut old_full, mut new_full, mut new_refresh) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);
        for agent in ["claude", "codex"] {
            let Some(root) = crate::agents::resolver::sessions_root(agent) else { continue };
            for live in jsonl_under(&root) {
                // A frozen copy: a session still being written would hand the
                // oracle and the scan two different files.
                let Ok(data) = std::fs::read(&live) else { continue };
                let file = scratch.join("snapshot.jsonl");
                std::fs::write(&file, &data).unwrap();
                let clock = Instant::now();
                let expected = value_oracle::samples_of(agent, &file);
                old_full += clock.elapsed();
                let clock = Instant::now();
                let fresh = scan_file(agent, &file, data.len() as u64, 0, None);
                new_full += clock.elapsed();
                assert_eq!(&*fresh.samples, &expected[..], "{}", live.display());

                let copy = scratch.join("grown.jsonl");
                let cut = data.len().saturating_sub(16 * 1024);
                std::fs::write(&copy, &data[..cut]).unwrap();
                let before = scan_file(agent, &copy, cut as u64, 0, None);
                {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new().append(true).open(&copy).unwrap();
                    f.write_all(&data[cut..]).unwrap();
                }
                let clock = Instant::now();
                let after = scan_file(agent, &copy, data.len() as u64, 1, Some(before));
                new_refresh += clock.elapsed();
                assert_eq!(&*after.samples, &expected[..], "{} resumed", live.display());

                files += 1;
                bytes += data.len() as u64;
                samples += expected.len();
            }
        }
        println!(
            "\n--- {files} session files, {:.1} MB, {samples} samples ---\n  cold scan: Value {old_full:?} | typed {new_full:?}\n  refresh after 16 KiB appended to every file: before (full Value re-parse) {old_full:?} | now {new_refresh:?}",
            bytes as f64 / 1_048_576.0
        );
    }

    /// Lines the typed scan must read exactly as the `Value` scan did:
    /// fields of the wrong type, duplicated keys, a lone surrogate or an
    /// out-of-range number inside content nobody reads (the old parser
    /// dropped such a line whole, usage included), CRLF endings.
    #[test]
    fn odd_lines_count_exactly_as_the_value_scan_counted_them() {
        let at = stamp(local(2026, 8, 26, 10));
        let claude = [
            format!(r#"{{"type":"assistant","timestamp":"{at}","cwd":5,"message":{{"id":"a1","model":null,"usage":{{"input_tokens":1}}}}}}"#),
            format!(r#"{{"type":"assistant","timestamp":7,"message":{{"id":"a2","usage":{{"input_tokens":2}},"content":[{{"type":"text","text":"\ud800"}}]}}}}"#),
            format!(r#"{{"type":"assistant","timestamp":"{at}","message":{{"id":"a3","usage":{{"input_tokens":3}},"content":[1e999]}}}}"#),
            format!(r#"{{"type":"user","type":"assistant","timestamp":"{at}","message":{{"id":"a4","usage":{{"input_tokens":4.5,"output_tokens":4}}}}}}"#),
            format!(r#"{{"type":"assistant","timestamp":"{at}","message":{{"id":"a5","usage":{{"input_tokens":5}}}},"message":"gone"}}"#),
            format!("{{\"type\":\"assistant\",\"timestamp\":\"{at}\",\"message\":{{\"id\":\"a6\",\"usage\":{{\"input_tokens\":6}}}}}}\r"),
            format!(r#"{{"type":"assistant","timestamp":"not a date","message":{{"usage":{{"input_tokens":7}}}}}}"#),
            format!(r#"{{"type":"assistant","message":{{"id":"a8","usage":[1]}}}}"#),
            "[]".to_string(),
        ];
        let codex = [
            format!(r#"{{"timestamp":"{at}","type":"session_meta","payload":{{"cwd":7}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"turn_context","payload":{{"model":"gpt-5","cwd":"C:\\late"}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":1}},"extra":"\ud800"}}}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":null,"total_token_usage":{{"input_tokens":9}}}}}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":5}}}}"#),
            format!(r#"{{"timestamp":"{at}","type":"event_msg","payload":"token_count"}}"#),
        ];
        let lines = |set: &[String]| set.iter().cloned().collect::<Vec<_>>().into_iter();
        assert_eq!(claude_samples(lines(&claude)), value_oracle::claude_samples(lines(&claude)));
        assert_eq!(codex_samples(lines(&codex)), value_oracle::codex_samples(lines(&codex)));
        assert!(!claude_samples(lines(&claude)).is_empty() && !codex_samples(lines(&codex)).is_empty());
    }

    #[test]
    fn a_line_that_does_not_parse_or_carries_no_usage_is_simply_skipped() {
        let at = local(2026, 8, 26, 10);
        let lines = vec![
            "not json".to_string(),
            r#"{"type":"user","message":{"role":"user","content":"oi"}}"#.to_string(),
            claude_line("m1", at, "claude-sonnet-5", r"C:\p", 1, 2),
            // An assistant line without `usage` (a synthetic message).
            format!(r#"{{"type":"assistant","timestamp":"{}","message":{{"id":"m2","model":"claude-sonnet-5","content":[]}}}}"#, stamp(at)),
        ];
        let samples = claude_samples(lines.into_iter());
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].model, "claude-sonnet-5");
        assert_eq!(samples[0].project, r"C:\p");
    }
}
