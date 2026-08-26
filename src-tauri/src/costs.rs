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
//! transcripts. Everything is failure-tolerant: a line that does not parse is
//! a line that does not count, never an error that empties the panel.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, Local, TimeZone};
use parking_lot::Mutex;
use serde::Serialize;

use crate::agents::sessions::{estimate_cost, SessionUsage};

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

#[derive(Clone)]
struct CachedFile {
    len: u64,
    mtime: i64,
    samples: Vec<Sample>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedFile>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
    let back = i64::from(days.saturating_sub(1));
    let first = now.date_naive() - chrono::Duration::days(back);
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
            if path.is_dir() {
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
fn samples_for(agent: &str, file: &Path, len: u64, mtime: i64) -> Vec<Sample> {
    if let Some(hit) = cache().lock().get(file) {
        if hit.len == len && hit.mtime == mtime {
            return hit.samples.clone();
        }
    }
    let samples = match File::open(file) {
        Ok(f) => {
            let lines = BufReader::new(f).lines().map_while(Result::ok);
            match agent {
                "codex" => codex_samples(lines),
                _ => claude_samples(lines),
            }
        }
        Err(_) => Vec::new(),
    };
    let mut cache = cache().lock();
    if cache.len() >= CACHE_MAX_FILES && !cache.contains_key(file) {
        cache.clear();
    }
    cache.insert(
        file.to_path_buf(),
        CachedFile {
            len,
            mtime,
            samples: samples.clone(),
        },
    );
    samples
}

fn parse_ts(v: &serde_json::Value) -> i64 {
    v.get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

fn num(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn text(v: Option<&serde_json::Value>, key: &str) -> String {
    v.and_then(|o| o.get(key))
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Parses one Claude Code `.jsonl` into per-message samples. The usage of an
/// API message is repeated on every content-block line it produced; it is
/// counted on the first line that carries a new `message.id`.
pub(crate) fn claude_samples(lines: impl Iterator<Item = String>) -> Vec<Sample> {
    let mut out = Vec::new();
    let mut last_id = String::new();
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
        let id = text(Some(msg), "id");
        if !id.is_empty() && id == last_id {
            continue;
        }
        let Some(u) = msg.get("usage") else { continue };
        if !id.is_empty() {
            last_id = id;
        }
        out.push(Sample {
            at: parse_ts(&v),
            project: text(Some(&v), "cwd"),
            model: text(Some(msg), "model"),
            input: num(u, "input_tokens"),
            output: num(u, "output_tokens"),
            cache_read: num(u, "cache_read_input_tokens"),
            cache_write: num(u, "cache_creation_input_tokens"),
        });
    }
    out
}

/// `(input, cached input, cache write, output)` of a Codex usage object.
fn codex_quad(u: &serde_json::Value) -> (u64, u64, u64, u64) {
    (
        num(u, "input_tokens"),
        num(u, "cached_input_tokens"),
        num(u, "cache_write_input_tokens"),
        num(u, "output_tokens"),
    )
}

/// Parses one Codex rollout `.jsonl` into per-turn samples. The folder comes
/// from `session_meta`, the model from the latest `turn_context`, and each
/// `token_count` contributes its `last_token_usage` — or, when the CLI only
/// wrote the cumulative `total_token_usage`, the difference from the previous
/// total.
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
                let total = info.get("total_token_usage").map(codex_quad);
                let delta = match (info.get("last_token_usage"), total, prev_total) {
                    (Some(last), _, _) => codex_quad(last),
                    (None, Some(t), Some(p)) => (
                        t.0.saturating_sub(p.0),
                        t.1.saturating_sub(p.1),
                        t.2.saturating_sub(p.2),
                        t.3.saturating_sub(p.3),
                    ),
                    (None, Some(t), None) => t,
                    (None, None, _) => continue,
                };
                if total.is_some() {
                    prev_total = total;
                }
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

    #[test]
    fn the_window_starts_at_local_midnight_days_minus_one_ago() {
        let now = local(2026, 8, 26, 15);
        assert_eq!(window_start(now, 1), local(2026, 8, 26, 0).timestamp_millis());
        assert_eq!(window_start(now, 7), local(2026, 8, 20, 0).timestamp_millis());
        // `0` is not "nothing": it is treated as today, like `1`.
        assert_eq!(window_start(now, 0), local(2026, 8, 26, 0).timestamp_millis());
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
