//! Live tap on an agent session `.jsonl` — feeds the "Ao Vivo" overlay.
//!
//! While `sessions.rs` reads the trail *after the fact* (listing, usage),
//! this module follows the file *as it grows*: parse each appended line into
//! a compact typed event and emit batches to the UI. The heavy JSON stays on
//! this side; the front receives only what it draws.
//!
//! One tail per overlay. Starting a tail with an id that already exists
//! replaces the previous thread (its stop flag is raised). Polling by offset
//! (350 ms) instead of notify: the file only ever grows, a partial-line
//! buffer handles writes that land mid-line, and truncation (len < offset)
//! resets the parse with `reset: true` so the UI starts over.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use super::sessions::SessionUsage;

/// Polling cadence. One agent turn writes many times per second; at 350 ms
/// the feed reads as "live" without waking the UI for every write.
const POLL: Duration = Duration::from_millis(350);
/// Backfill batch size — a long session arrives in a few big paints,
/// not thousands of small ones.
const BATCH: usize = 500;
/// Line cap. Above this (a pasted binary, a colossal edit) the line is
/// skipped — losing one event is better than ballooning memory.
const MAX_LINE: usize = 4 * 1024 * 1024;
/// Bound each disk read so opening a multi-gigabyte transcript does not need
/// a same-sized allocation before the first event can be painted.
const READ_CHUNK: usize = 256 * 1024;
/// Preview caps: the timeline shows openings, not documents.
const TEXT_CAP: usize = 400;
const DETAIL_CAP: usize = 120;

/// Stop flag of a running tail. Dropping the registry entry does not kill
/// the thread — raising the flag does, on the next poll.
pub type TailStop = Arc<AtomicBool>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: String,
}

/// One event of the feed. A fat struct with optional fields instead of an
/// enum: the UI switches on `kind` and TypeScript mirrors this shape 1:1.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEvent {
    /// `prompt` | `say` | `think` | `tool` | `result` | `usage` | `notify`
    pub kind: String,
    /// Epoch ms of the line's own timestamp (0 when absent).
    pub at: i64,
    /// Line written by a sub-agent transcript (isSidechain).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub side: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    // -- tool --------------------------------------------------------------
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Classified: `edit` | `write` | `read` | `run` | `search` | `agent`
    /// | `plan` | `todo` | `skill` | `other`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    // -- plan (TaskCreate/TaskUpdate/TodoWrite) ----------------------------
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todos: Option<Vec<TodoItem>>,
    // -- result ------------------------------------------------------------
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    // -- usage (cumulative totals of the session so far) -------------------
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFeed {
    pub tail_id: String,
    /// `true` on the first batch (and after truncation): the UI clears state.
    pub reset: bool,
    /// `false` during backfill, `true` once the tail caught up with the file.
    pub live: bool,
    pub events: Vec<FeedEvent>,
}

/// Parser state that survives across lines: usage dedup (each API message
/// repeats its usage on every content-block line) and running totals.
/// `pub(crate)` so the environment probe (`env_tests`) can run the parser
/// against real sessions on this machine.
#[derive(Default)]
pub(crate) struct Cursor {
    last_usage_msg: String,
    totals: SessionUsage,
}

pub fn start<R: Runtime>(app: AppHandle<R>, tail_id: String, file: String) -> TailStop {
    let stop: TailStop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    std::thread::spawn(move || {
        tracing::info!(tail = %tail_id, file = %file, "grampo de sessao ligado");
        run(app, &tail_id, &file, &flag);
        tracing::info!(tail = %tail_id, "grampo de sessao desligado");
    });

    stop
}

fn run<R: Runtime>(app: AppHandle<R>, tail_id: &str, file: &str, stop: &AtomicBool) {
    let mut offset: u64 = 0;
    let mut rem: Vec<u8> = Vec::new();
    let mut cur = Cursor::default();
    let mut backfilling = true;
    let mut reset_pending = true;

    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }

        let len = match std::fs::metadata(file) {
            Ok(m) => m.len(),
            Err(_) => {
                // File missing (rotation, network drive hiccup) — keep trying.
                std::thread::sleep(POLL);
                continue;
            }
        };

        // Truncated/replaced: start over and tell the UI to do the same.
        if len < offset {
            offset = 0;
            rem.clear();
            cur = Cursor::default();
            backfilling = true;
            reset_pending = true;
        }

        if len > offset {
            match read_chunk(file, offset) {
                Ok((bytes, chunk)) => {
                    if bytes == 0 {
                        std::thread::sleep(POLL);
                        continue;
                    }
                    offset += bytes;
                    rem.extend_from_slice(&chunk);
                    let mut batch: Vec<FeedEvent> = Vec::new();
                    let mut reset = reset_pending;
                    let mut consumed = 0;
                    for pos in 0..rem.len() {
                        if rem[pos] != b'\n' {
                            continue;
                        }
                        let line = String::from_utf8_lossy(&rem[consumed..pos]);
                        let line = line.trim();
                        consumed = pos + 1;
                        if line.is_empty() || line.len() > MAX_LINE {
                            continue;
                        }
                        parse_line(line, &mut cur, &mut batch);
                        if batch.len() >= BATCH {
                            emit(
                                &app,
                                tail_id,
                                reset,
                                !backfilling,
                                std::mem::take(&mut batch),
                            );
                            reset = false;
                        }
                    }
                    if consumed > 0 {
                        rem.drain(..consumed);
                    }
                    // A malformed/embedded payload without a newline must not
                    // grow the tail's memory forever. It is skipped just like
                    // any complete line over `MAX_LINE`.
                    if rem.len() > MAX_LINE {
                        rem.clear();
                    }
                    if !batch.is_empty() || reset {
                        emit(&app, tail_id, reset, !backfilling, batch);
                    }
                    reset_pending = false;
                    if backfilling && offset >= len {
                        // Backfill reached the end of the file: from here on
                        // it is live — even if the session is idle.
                        emit(&app, tail_id, false, true, Vec::new());
                        backfilling = false;
                    }
                }
                Err(e) => {
                    tracing::warn!(tail = %tail_id, error = %e, "falha lendo a sessao");
                }
            }
        } else if backfilling {
            // Empty file: still announce the reset so the UI leaves "loading".
            emit(&app, tail_id, reset_pending, true, Vec::new());
            reset_pending = false;
            backfilling = false;
        }

        if offset < len {
            continue;
        }
        std::thread::sleep(POLL);
    }
}

fn read_chunk(file: &str, offset: u64) -> std::io::Result<(u64, Vec<u8>)> {
    let mut f = File::open(file)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(READ_CHUNK);
    f.take(READ_CHUNK as u64).read_to_end(&mut buf)?;
    let n = buf.len() as u64;
    Ok((n, buf))
}

fn emit<R: Runtime>(
    app: &AppHandle<R>,
    tail_id: &str,
    reset: bool,
    live: bool,
    events: Vec<FeedEvent>,
) {
    let _ = app.emit(
        crate::events::SESSION_FEED,
        SessionFeed {
            tail_id: tail_id.to_string(),
            reset,
            live,
            events,
        },
    );
}

// ---------------------------------------------------------------------------
// line -> events
// ---------------------------------------------------------------------------

pub(crate) fn parse_line(line: &str, cur: &mut Cursor, out: &mut Vec<FeedEvent>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let at = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or(0);
    let side = v
        .get("isSidechain")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);
    let cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");

    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => assistant_line(&v, at, side, cwd, cur, out),
        Some("user") => user_line(&v, at, side, out),
        _ => {}
    }
}

fn assistant_line(
    v: &serde_json::Value,
    at: i64,
    side: bool,
    cwd: &str,
    cur: &mut Cursor,
    out: &mut Vec<FeedEvent>,
) {
    let Some(msg) = v.get("message") else { return };

    if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        let clean = t.trim();
                        if !clean.is_empty() {
                            out.push(FeedEvent {
                                kind: "say".into(),
                                at,
                                side,
                                text: Some(cap(clean, TEXT_CAP)),
                                ..Default::default()
                            });
                        }
                    }
                }
                Some("thinking") => {
                    if let Some(t) = block.get("thinking").and_then(|t| t.as_str()) {
                        let clean = t.trim();
                        if !clean.is_empty() {
                            out.push(FeedEvent {
                                kind: "think".into(),
                                at,
                                side,
                                text: Some(cap(clean, TEXT_CAP)),
                                ..Default::default()
                            });
                        }
                    }
                }
                Some("tool_use") => {
                    if let Some(ev) = tool_event(block, at, side, cwd) {
                        out.push(ev);
                    }
                }
                _ => {}
            }
        }
    }

    // Usage arrives repeated on every content-block line of the same API
    // message; count each message once, then publish cumulative totals.
    let msg_id = msg.get("id").and_then(|i| i.as_str()).unwrap_or("");
    if !msg_id.is_empty() && msg_id != cur.last_usage_msg {
        if let Some(u) = msg.get("usage") {
            cur.last_usage_msg = msg_id.to_string();
            cur.totals.input_tokens += num(u, "input_tokens");
            cur.totals.output_tokens += num(u, "output_tokens");
            cur.totals.cache_creation_tokens += num(u, "cache_creation_input_tokens");
            cur.totals.cache_read_tokens += num(u, "cache_read_input_tokens");
            cur.totals.messages += 1;
            let model = msg
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or_default()
                .to_string();
            if !model.is_empty() && !cur.totals.models.iter().any(|m| m == &model) {
                cur.totals.models.push(model.clone());
            }
            out.push(FeedEvent {
                kind: "usage".into(),
                at,
                side,
                model: if model.is_empty() { None } else { Some(model) },
                in_tokens: Some(cur.totals.input_tokens),
                out_tokens: Some(cur.totals.output_tokens),
                cache_read: Some(cur.totals.cache_read_tokens),
                cache_write: Some(cur.totals.cache_creation_tokens),
                cost_usd: super::sessions::estimate_cost(&cur.totals),
                ..Default::default()
            });
        }
    }
}

fn user_line(v: &serde_json::Value, at: i64, side: bool, out: &mut Vec<FeedEvent>) {
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
        return;
    };

    // Plain-string content = a prompt typed by the user.
    if let Some(s) = content.as_str() {
        push_prompt(s, at, side, out);
        return;
    }

    let Some(blocks) = content.as_array() else {
        return;
    };
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("tool_result") => {
                let text = result_text(block);
                let mut ev = FeedEvent {
                    kind: "result".into(),
                    at,
                    side,
                    tool_id: block
                        .get("tool_use_id")
                        .and_then(|i| i.as_str())
                        .map(|s| s.to_string()),
                    ok: Some(
                        !block
                            .get("is_error")
                            .and_then(|e| e.as_bool())
                            .unwrap_or(false),
                    ),
                    ..Default::default()
                };
                if let Some(t) = &text {
                    // "Task #7 created" — lets the UI map plan cards to ids.
                    if let Some(id) = t
                        .strip_prefix("Task #")
                        .and_then(|r| r.split_whitespace().next())
                    {
                        ev.task_id = Some(id.trim_end_matches(':').to_string());
                    }
                    ev.text = Some(cap(t, DETAIL_CAP));
                }
                out.push(ev);
            }
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    push_prompt(t, at, side, out);
                }
            }
            _ => {}
        }
    }
}

/// User text becomes `prompt`; harness wrappers (`<command-name>…`) are not
/// prompts — except task notifications, which close background sub-agents.
fn push_prompt(raw: &str, at: i64, side: bool, out: &mut Vec<FeedEvent>) {
    let clean = raw.trim();
    if clean.is_empty() {
        return;
    }
    if clean.starts_with('<') {
        if clean.contains("task-notification") {
            out.push(FeedEvent {
                kind: "notify".into(),
                at,
                side,
                text: Some(cap(strip_tags(clean).trim(), DETAIL_CAP)),
                ..Default::default()
            });
        }
        return;
    }
    if clean.starts_with("Caveat:") {
        return;
    }
    out.push(FeedEvent {
        kind: "prompt".into(),
        at,
        side,
        text: Some(cap(clean, TEXT_CAP)),
        ..Default::default()
    });
}

fn tool_event(block: &serde_json::Value, at: i64, side: bool, cwd: &str) -> Option<FeedEvent> {
    let name = block.get("name").and_then(|n| n.as_str())?;
    let input = block.get("input").cloned().unwrap_or_default();
    let mut ev = FeedEvent {
        kind: "tool".into(),
        at,
        side,
        tool_id: block
            .get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.to_string()),
        tool: Some(name.to_string()),
        ..Default::default()
    };

    let path_of = |key: &str| {
        input
            .get(key)
            .and_then(|p| p.as_str())
            .map(|p| relative_path(cwd, p))
    };
    let str_of = |key: &str| {
        input
            .get(key)
            .and_then(|s| s.as_str())
            .map(|s| cap(s.trim(), DETAIL_CAP))
    };

    match name {
        "Edit" | "NotebookEdit" => {
            ev.op = Some("edit".into());
            ev.path = path_of("file_path").or_else(|| path_of("notebook_path"));
            ev.removed = Some(lines_of(&input, "old_string"));
            ev.added = Some(lines_of(&input, "new_string"));
        }
        "Write" => {
            ev.op = Some("write".into());
            ev.path = path_of("file_path");
            ev.added = Some(lines_of(&input, "content"));
        }
        "Read" => {
            ev.op = Some("read".into());
            ev.path = path_of("file_path");
        }
        "Bash" | "PowerShell" => {
            ev.op = Some("run".into());
            ev.detail = str_of("description").or_else(|| str_of("command"));
        }
        "Grep" | "Glob" => {
            ev.op = Some("search".into());
            ev.detail = str_of("pattern");
        }
        "WebSearch" | "WebFetch" => {
            ev.op = Some("search".into());
            ev.detail = str_of("query").or_else(|| str_of("url"));
        }
        "Agent" | "Task" | "Workflow" => {
            ev.op = Some("agent".into());
            ev.agent_type = input
                .get("subagent_type")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            ev.detail = str_of("description").or_else(|| str_of("name"));
        }
        "TaskCreate" => {
            ev.op = Some("plan".into());
            ev.detail = str_of("subject");
            ev.status = Some("pending".into());
        }
        "TaskUpdate" => {
            ev.op = Some("plan".into());
            ev.task_id = input
                .get("taskId")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            ev.status = input
                .get("status")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            ev.detail = str_of("subject");
        }
        "TodoWrite" => {
            ev.op = Some("todo".into());
            ev.todos = input.get("todos").and_then(|t| t.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(TodoItem {
                            content: cap(t.get("content")?.as_str()?, DETAIL_CAP),
                            status: t
                                .get("status")
                                .and_then(|s| s.as_str())
                                .unwrap_or("pending")
                                .to_string(),
                        })
                    })
                    .collect()
            });
        }
        "Skill" => {
            ev.op = Some("skill".into());
            ev.detail = str_of("skill");
        }
        _ => {
            ev.op = Some("other".into());
            // MCP names carry server + tool; keep the readable tail.
            let pretty = name
                .strip_prefix("mcp__")
                .unwrap_or(name)
                .replace("__", " · ");
            ev.detail = Some(cap(&pretty, DETAIL_CAP));
        }
    }
    Some(ev)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn num(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn lines_of(input: &serde_json::Value, key: &str) -> u32 {
    input
        .get(key)
        .and_then(|s| s.as_str())
        .map(|s| {
            if s.is_empty() {
                0
            } else {
                s.lines().count() as u32
            }
        })
        .unwrap_or(0)
}

/// `tool_result.content` is sometimes a string, sometimes text blocks.
fn result_text(block: &serde_json::Value) -> Option<String> {
    let content = block.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.trim().to_string());
    }
    for b in content.as_array()? {
        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                return Some(t.trim().to_string());
            }
        }
    }
    None
}

/// Path relative to the session's cwd, with `/` — same convention as the
/// files feed, so the UI can cross-reference without normalizing.
fn relative_path(cwd: &str, path: &str) -> String {
    let norm = path.replace('\\', "/");
    if cwd.is_empty() {
        return norm;
    }
    let cwd_norm = {
        let c = cwd.replace('\\', "/");
        c.trim_end_matches('/').to_string() + "/"
    };
    if norm.len() > cwd_norm.len() && norm[..cwd_norm.len()].eq_ignore_ascii_case(&cwd_norm) {
        norm[cwd_norm.len()..].to_string()
    } else {
        norm
    }
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut inside = false;
    for ch in s.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

fn cap(s: &str, max: usize) -> String {
    let one_line = s.replace(['\r'], "");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let cut: String = one_line.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(lines: &[&str]) -> Vec<FeedEvent> {
        let mut cur = Cursor::default();
        let mut out = Vec::new();
        for l in lines {
            parse_line(l, &mut cur, &mut out);
        }
        out
    }

    #[test]
    fn edit_becomes_an_event_with_diff_and_relative_path() {
        let evs = parse_all(&[
            r#"{"type":"assistant","timestamp":"2026-08-13T21:09:41.434Z","cwd":"C:\\proj","message":{"id":"m1","model":"claude-opus-5","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"C:\\proj\\src\\a.ts","old_string":"a\nb","new_string":"a\nb\nc"}}],"usage":{"input_tokens":2,"output_tokens":10}}}"#,
        ]);
        let tool = evs.iter().find(|e| e.kind == "tool").unwrap();
        assert_eq!(tool.op.as_deref(), Some("edit"));
        assert_eq!(tool.path.as_deref(), Some("src/a.ts"));
        assert_eq!(tool.removed, Some(2));
        assert_eq!(tool.added, Some(3));
        // cumulative usage comes along, once per API message
        let usage = evs.iter().find(|e| e.kind == "usage").unwrap();
        assert_eq!(usage.out_tokens, Some(10));
    }

    #[test]
    fn usage_is_deduplicated_per_message() {
        let line = |id: &str| {
            format!(
                r#"{{"type":"assistant","message":{{"id":"{id}","model":"claude-opus-5","content":[{{"type":"text","text":"oi"}}],"usage":{{"input_tokens":1,"output_tokens":5}}}}}}"#
            )
        };
        let l1 = line("m1");
        let l2 = line("m1");
        let l3 = line("m2");
        let evs = parse_all(&[&l1, &l2, &l3]);
        let usages: Vec<_> = evs.iter().filter(|e| e.kind == "usage").collect();
        assert_eq!(usages.len(), 2);
        assert_eq!(usages[1].out_tokens, Some(10));
    }

    #[test]
    fn result_extracts_task_id_and_error() {
        let evs = parse_all(&[
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"Task #7 created successfully: x","is_error":false}]}}"#,
        ]);
        assert_eq!(evs[0].kind, "result");
        assert_eq!(evs[0].task_id.as_deref(), Some("7"));
        assert_eq!(evs[0].ok, Some(true));
    }

    #[test]
    fn command_wrapper_is_not_a_prompt_but_a_notification_gets_through() {
        let evs = parse_all(&[
            r#"{"type":"user","message":{"content":"<command-name>/init</command-name>"}}"#,
            r#"{"type":"user","message":{"content":"<task-notification>agente terminou</task-notification>"}}"#,
            r#"{"type":"user","message":{"content":"arruma o login"}}"#,
        ]);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].kind, "notify");
        assert_eq!(evs[1].kind, "prompt");
    }

    #[test]
    fn subagent_carries_type_and_description() {
        let evs = parse_all(&[
            r#"{"type":"assistant","message":{"id":"m3","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"subagent_type":"Explore","description":"mapear o repo","prompt":"..."}}]}}"#,
        ]);
        let tool = &evs[0];
        assert_eq!(tool.op.as_deref(), Some("agent"));
        assert_eq!(tool.agent_type.as_deref(), Some("Explore"));
        assert_eq!(tool.detail.as_deref(), Some("mapear o repo"));
    }
}
