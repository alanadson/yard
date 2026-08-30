//! Searching what the terminals *said* — across every terminal at once.
//!
//! The app already had two searches over output and neither answers the
//! question the product promises to answer. xterm's own search walks a
//! single, currently mounted terminal; the Busca (`Ctrl+P`) finds a terminal
//! by its *name*. Nothing found the sentence an agent printed two hours ago
//! in a pane that is now closed — which is exactly what "never lose anything
//! that happened in any terminal" is supposed to mean.
//!
//! The rules that matter here, and that the tests below lock down:
//!
//! - the bytes on disk are raw PTY output, so **escapes come off first**
//!   (`pty_export::strip_ansi`, the same one the plain export uses) — a hit
//!   must never carry `ESC[32m` into the result list, and a spinner's forty
//!   frames are one line, not forty;
//! - a hit is a **line**, numbered from the top of what is on disk, and the
//!   text is windowed around the match: one minified bundle printed into a
//!   terminal is a single 2 MB line, and it is not going through IPC;
//! - **caps everywhere**, per terminal and in total. A one-letter query over
//!   twenty terminals matches everything; the search has to answer it in
//!   milliseconds and with a payload the palette can paint.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// How much of a line comes back around the match. Wide enough to read the
/// sentence, short enough that a minified line is not a payload.
pub const SNIPPET: usize = 240;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    /// 1-based, counted over the whole `.bin` (which is capped at 8 MB and
    /// compacted to its 4 MB tail — so it is the true line of what exists).
    pub line: u32,
    /// 0-based character offset of the match **inside `text`**, not inside the
    /// original line: the window may have cut a prefix off.
    pub col: u32,
    /// The line, windowed around the match and with the escapes gone.
    pub text: String,
    /// Whether `text` is a window cut out of a longer line.
    pub clipped: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHits {
    pub terminal_id: String,
    pub hits: Vec<Hit>,
    /// Matches beyond `per` that were not returned — the UI says "e mais N".
    pub more: u32,
}

/// Searches text that has already been stripped of escapes.
pub fn hits_in(plain: &str, needle: &str, max: usize) -> Vec<Hit> {
    let mut out = Vec::new();
    if needle.is_empty() || max == 0 {
        return out;
    }
    let folded_needle = needle.to_lowercase();
    for (index, line) in plain.lines().enumerate() {
        let Some(at) = line.to_lowercase().find(&folded_needle) else {
            continue;
        };
        // `find` answered in the lowercased copy. For ASCII (every terminal
        // line that matters here) the offsets agree; when they do not, the
        // window still lands on the right character because it is rebuilt
        // from the original line's char boundaries.
        let at_char = line
            .char_indices()
            .position(|(byte, _)| byte >= at)
            .unwrap_or(0);
        let (text, col, clipped) = window(line, at_char, needle.chars().count());
        out.push(Hit {
            line: index as u32 + 1,
            col: col as u32,
            text,
            clipped,
        });
        if out.len() >= max {
            break;
        }
    }
    out
}

/// Cuts `SNIPPET` characters out of `line` around the match, keeping the whole
/// match inside whenever it fits.
fn window(line: &str, at: usize, len: usize) -> (String, usize, bool) {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= SNIPPET {
        return (line.to_string(), at, false);
    }
    // A third of the window before the match: the eye reads the context on
    // the left, and the match itself is what was asked for.
    let lead = SNIPPET / 3;
    let start = at.saturating_sub(lead);
    let end = (start + SNIPPET).min(chars.len());
    let start = end.saturating_sub(SNIPPET);
    let text: String = chars[start..end].iter().collect();
    let _ = len;
    (text, at - start, true)
}

/// Searches raw PTY bytes: escapes off, then line by line.
pub fn hits_in_bytes(raw: &[u8], needle: &str, max: usize) -> Vec<Hit> {
    let plain = crate::pty_export::strip_ansi(raw);
    hits_in(&String::from_utf8_lossy(&plain), needle, max)
}

/// The `.bin` of one terminal under `dir`.
pub fn bin_path_in(dir: &Path, id: &str) -> PathBuf {
    dir.join("scrollback")
        .join(format!("{}.bin", crate::paths::sanitize_id(id)))
}

/// Searches the terminals `ids`, in that order, stopping at `total` hits.
/// `read` hands over the bytes of one terminal — the live ring when the
/// process is up, the file when it is not (that decision belongs to the
/// caller, which is the only one holding `AppState`).
pub fn search_with<F>(ids: &[String], needle: &str, per: usize, total: usize, read: F) -> Vec<TerminalHits>
where
    F: Fn(&str) -> Vec<u8>,
{
    let mut out: Vec<TerminalHits> = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut budget = total;
    for id in ids {
        if budget == 0 {
            break;
        }
        let bytes = read(id);
        if bytes.is_empty() {
            continue;
        }
        // One more than the cap, so "more" can say there is a rest without
        // counting every match in an 8 MB file.
        let room = per.min(budget);
        let mut hits = hits_in_bytes(&bytes, needle, room + 1);
        if hits.is_empty() {
            continue;
        }
        let more = if hits.len() > room {
            hits.truncate(room);
            1
        } else {
            0
        };
        budget -= hits.len();
        out.push(TerminalHits {
            terminal_id: id.clone(),
            hits,
            more,
        });
    }
    out
}

/// The disk half: reads a terminal's `.bin` whole (it is capped at 8 MB by
/// construction) and searches it.
pub fn read_bin(dir: &Path, id: &str) -> Vec<u8> {
    std::fs::read(bin_path_in(dir, id)).unwrap_or_default()
}

/// Why these rules matter: this search is the app keeping the promise that
/// nothing said in a terminal is lost. A result that carries escapes, that
/// numbers lines wrong, or that hands the UI a 2 MB minified line is a search
/// nobody uses twice.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hit_carries_the_line_it_was_found_on() {
        let text = "primeira\nsegunda com erro\nterceira\n";
        let hits = hits_in(text, "erro", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].text, "segunda com erro");
        assert_eq!(hits[0].col, 12);
        assert!(!hits[0].clipped);
    }

    #[test]
    fn case_does_not_decide_whether_something_was_said() {
        let hits = hits_in("Error: build failed\n", "error", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].col, 0);
    }

    #[test]
    fn an_empty_needle_matches_nothing_instead_of_everything() {
        assert!(hits_in("uma linha\noutra\n", "", 10).is_empty());
    }

    #[test]
    fn the_cap_stops_a_one_letter_query() {
        let text = "e\n".repeat(1000);
        assert_eq!(hits_in(&text, "e", 5).len(), 5);
    }

    #[test]
    fn one_line_gives_one_hit_even_when_it_says_it_twice() {
        let hits = hits_in("erro aqui e erro ali\n", "erro", 10);
        assert_eq!(hits.len(), 1, "a hit is a line, not an occurrence");
    }

    /// The regression this locks down: a webpack build prints its bundle on a
    /// single line. Sent whole, one hit was megabytes over IPC.
    #[test]
    fn a_very_long_line_comes_back_as_a_window_around_the_match() {
        let line = format!("{}ACHOU{}", "x".repeat(5000), "y".repeat(5000));
        let hits = hits_in(&line, "achou", 10);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].clipped);
        assert_eq!(hits[0].text.chars().count(), SNIPPET);
        let col = hits[0].col as usize;
        let found: String = hits[0].text.chars().skip(col).take(5).collect();
        assert_eq!(found, "ACHOU", "the window has to contain the match");
    }

    #[test]
    fn escapes_never_reach_the_result() {
        let raw = b"\x1b[32mtudo certo\x1b[0m\r\nerrado\r\n";
        let hits = hits_in_bytes(raw, "certo", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "tudo certo");
        assert_eq!(hits[0].line, 1);
    }

    /// A spinner rewrites its line with CR. `strip_ansi` resolves the
    /// overwrite, so the search sees the last frame and nothing before it.
    #[test]
    fn a_spinner_is_one_line_with_its_last_frame() {
        let raw = b"buscando |\rbuscando /\rbuscando pronto\r\n";
        assert_eq!(hits_in_bytes(raw, "buscando", 10).len(), 1);
        assert!(hits_in_bytes(raw, "pronto", 10).len() == 1);
        assert!(
            hits_in_bytes(raw, "buscando |", 10).is_empty(),
            "an overwritten frame was never on screen"
        );
    }

    #[test]
    fn a_terminal_that_never_matched_is_not_in_the_answer() {
        let out = search_with(
            &["a".into(), "b".into()],
            "erro",
            5,
            50,
            |id| match id {
                "a" => b"tudo bem\n".to_vec(),
                _ => b"deu erro\n".to_vec(),
            },
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].terminal_id, "b");
    }

    /// The regression: one noisy build log filled the whole result list and
    /// the other five terminals never appeared.
    #[test]
    fn no_single_terminal_eats_the_whole_result() {
        let noisy = "erro\n".repeat(500);
        let out = search_with(
            &["ruidoso".into(), "quieto".into()],
            "erro",
            3,
            50,
            |id| {
                if id == "ruidoso" {
                    noisy.clone().into_bytes()
                } else {
                    b"um erro so\n".to_vec()
                }
            },
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].hits.len(), 3);
        assert_eq!(out[0].more, 1, "the rest is announced, not returned");
        assert_eq!(out[1].hits.len(), 1);
        assert_eq!(out[1].more, 0);
    }

    #[test]
    fn the_total_budget_stops_the_sweep() {
        let ids: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
        let out = search_with(&ids, "erro", 5, 7, |_| b"erro\nerro\nerro\n".to_vec());
        let found: usize = out.iter().map(|t| t.hits.len()).sum();
        assert_eq!(found, 7);
        assert!(out.len() < 10, "the sweep stopped before the last terminal");
    }

    #[test]
    fn reads_the_bin_of_the_terminal_it_was_asked_about() {
        let dir = std::env::temp_dir().join(format!("yard-sbsearch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("scrollback")).unwrap();
        std::fs::write(bin_path_in(&dir, "abc"), b"\x1b[31mfalhou aqui\x1b[0m\n").unwrap();

        let hits = hits_in_bytes(&read_bin(&dir, "abc"), "falhou", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "falhou aqui");
        assert!(read_bin(&dir, "nao-existe").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
