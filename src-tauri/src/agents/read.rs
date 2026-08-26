//! One-shot read of a whole session `.jsonl` — the "Ombro" digest and the
//! transcript viewer.
//!
//! `tail.rs` follows a file *as it grows* and emits batches; this reads it
//! *once*, with the same parser, and hands the events back in one answer.
//! Two readers of the same format with two parsers would drift — the point of
//! this module is that there is exactly one `parse_line`.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::tail::{parse_line, Cursor, FeedEvent, MAX_LINE};

/// Above this the file is refused instead of parsed: a transcript this size
/// is a runaway session, and the answer would be tens of thousands of events
/// the UI cannot draw anyway.
pub const MAX_FILE: u64 = 64 * 1024 * 1024;

/// Every event of the session, in file order.
pub fn read_events(file: &Path) -> Result<Vec<FeedEvent>, String> {
    read_events_capped(file, MAX_FILE)
}

/// `read_events` with the size ceiling as a parameter — the tests do not
/// write 64 MB to prove the refusal.
pub fn read_events_capped(file: &Path, cap: u64) -> Result<Vec<FeedEvent>, String> {
    let meta = std::fs::metadata(file).map_err(|e| format!("não consegui abrir a sessão: {e}"))?;
    if meta.len() > cap {
        return Err(format!(
            "sessão grande demais para ler de uma vez ({} MB; o limite é {} MB)",
            meta.len() / (1024 * 1024),
            cap / (1024 * 1024)
        ));
    }
    let f = File::open(file).map_err(|e| format!("não consegui abrir a sessão: {e}"))?;
    let reader = BufReader::new(f);
    let mut cur = Cursor::default();
    let mut out = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() || line.len() > MAX_LINE {
            continue;
        }
        parse_line(line, &mut cur, &mut out);
    }
    Ok(out)
}

/// The whole session as events. Disk-bound, so it runs on the blocking pool.
#[tauri::command]
pub async fn session_events(file: String) -> Result<Vec<FeedEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || read_events(Path::new(&file)))
        .await
        .map_err(|e| format!("leitura interrompida: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(name: &str, lines: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-session-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut f = File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    /// The transcript is the tail's parser applied once: a prompt, the
    /// assistant's text, the tool it called, the result and the usage all
    /// come back, in file order, with the usage deduplicated per message.
    #[test]
    fn a_whole_session_comes_back_as_events_in_file_order() {
        let path = fixture(
            "whole.jsonl",
            &[
                r#"{"type":"user","timestamp":"2026-08-26T03:00:00.000Z","message":{"content":"arruma o login"}}"#,
                r#"{"type":"assistant","timestamp":"2026-08-26T03:00:01.000Z","cwd":"C:\\proj","message":{"id":"m1","model":"claude-opus-5","content":[{"type":"text","text":"vou olhar o arquivo"}],"usage":{"input_tokens":2,"output_tokens":10}}}"#,
                r#"{"type":"assistant","timestamp":"2026-08-26T03:00:02.000Z","cwd":"C:\\proj","message":{"id":"m1","model":"claude-opus-5","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"C:\\proj\\src\\a.ts","old_string":"a","new_string":"b"}}],"usage":{"input_tokens":2,"output_tokens":10}}}"#,
                r#"{"type":"user","timestamp":"2026-08-26T03:00:03.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#,
            ],
        );
        let events = read_events(&path).unwrap();
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        let order: Vec<&str> = kinds
            .iter()
            .copied()
            .filter(|k| *k != "usage")
            .collect();
        assert_eq!(order, vec!["prompt", "say", "tool", "result"]);
        assert_eq!(
            kinds.iter().filter(|k| **k == "usage").count(),
            1,
            "the same message id repeats its usage on every content line"
        );
        let tool = events.iter().find(|e| e.kind == "tool").unwrap();
        assert_eq!(tool.path.as_deref(), Some("src/a.ts"));
        assert_eq!(events[0].at, 1_787_713_200_000);
    }

    /// A blank line, a truncated tail or a line that is not JSON must not
    /// take the whole transcript down with it.
    #[test]
    fn junk_lines_are_skipped_not_fatal() {
        let path = fixture(
            "junk.jsonl",
            &[
                "",
                "not json at all",
                r#"{"type":"user","message":{"content":"oi"}}"#,
                r#"{"type":"assistant","message":{"id":"m9","content":[{"type":"text","text":"olá"}]}}"#,
            ],
        );
        let events = read_events(&path).unwrap();
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, vec!["prompt", "say"]);
    }

    /// A transcript above the ceiling is refused with a sentence that says
    /// so — not parsed halfway, not silently empty.
    #[test]
    fn a_session_above_the_size_cap_is_refused() {
        let path = fixture(
            "big.jsonl",
            &[r#"{"type":"user","message":{"content":"um prompt razoavelmente comprido"}}"#],
        );
        let err = read_events_capped(&path, 10).unwrap_err();
        assert!(err.contains("grande demais"), "{err}");
    }

    #[test]
    fn a_missing_file_is_an_error_not_an_empty_session() {
        let err = read_events(Path::new("C:/does/not/exist/session.jsonl")).unwrap_err();
        assert!(err.contains("abrir"), "{err}");
    }
}
