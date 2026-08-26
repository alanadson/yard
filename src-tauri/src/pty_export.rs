//! Saving a terminal's output to a file (`pty_export`).
//!
//! The scrollback already lives in two places — the 4 MB ring while the
//! process is up and the append-only `.bin` on disk (`pty/scrollback.rs`) —
//! but nothing let the user take it *out* of the app: to attach to an issue,
//! to grep at leisure, to hand to another agent. Two shapes come out of here:
//!
//! - **raw** — every byte the PTY produced, escapes included, for whoever
//!   wants to replay it in a terminal or keep the colors;
//! - **plain** — what a human would read: escapes gone, a carriage return
//!   keeping only the last frame of its line (so a spinner becomes its final
//!   word), backspaces applied, `\r\n` line endings on the way out.
//!
//! Every function that reads the data directory has an `_in(app_dir)` twin,
//! the way `persistence/backup.rs` does it: `YARD_DATA_DIR` is process-global
//! and cargo runs tests in parallel, so the tests drive their own folder.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::pty::scrollback::Scrollback;
use crate::state::AppState;

/// Strips terminal control sequences and resolves the in-line overwrites a
/// human never sees on screen. Not a replay: cursor movements that reach
/// *other* lines (`ESC[2A`, `ESC[K`) are simply dropped.
pub fn strip_ansi(bytes: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    // Where the current line starts inside `out`: a lone CR rewinds to it
    // (the next frame overwrites this one) and a backspace never crosses it.
    let mut line_start = 0usize;
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        let b = bytes[i];
        match b {
            0x1b => {
                i += 1;
                let Some(&next) = bytes.get(i) else { break };
                match next {
                    // CSI: parameters and intermediates (0x20..=0x3f), then one
                    // final byte. A truncated sequence just ends the input.
                    b'[' => {
                        i += 1;
                        while i < n && (0x20..=0x3f).contains(&bytes[i]) {
                            i += 1;
                        }
                        if i < n {
                            i += 1;
                        }
                    }
                    // OSC / DCS / SOS / PM / APC: a string up to BEL or ST
                    // (ESC followed by a backslash). An ESC that starts
                    // something else ends it too.
                    b']' | b'P' | b'X' | b'^' | b'_' => {
                        i += 1;
                        while i < n {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b {
                                if bytes.get(i + 1) == Some(&b'\\') {
                                    i += 2;
                                }
                                break;
                            }
                            i += 1;
                        }
                    }
                    // Charset designations (`ESC ( B`) and `ESC # 8` carry one
                    // more byte; every other two-byte escape (`ESC 7`, `ESC =`)
                    // ends here.
                    b'(' | b')' | b'*' | b'+' | b'-' | b'.' | b'/' | b'#' => i += 2,
                    _ => i += 1,
                }
            }
            b'\r' => {
                if bytes.get(i + 1) == Some(&b'\n') {
                    out.push(b'\n');
                    line_start = out.len();
                    i += 2;
                } else {
                    out.truncate(line_start);
                    i += 1;
                }
            }
            b'\n' => {
                out.push(b'\n');
                line_start = out.len();
                i += 1;
            }
            // Backspace erases the last character of the line — the whole
            // UTF-8 sequence, not one byte of it.
            0x08 => {
                if out.len() > line_start {
                    let mut k = out.len() - 1;
                    while k > line_start && out[k] & 0b1100_0000 == 0b1000_0000 {
                        k -= 1;
                    }
                    out.truncate(k);
                }
                i += 1;
            }
            b'\t' => {
                out.push(b);
                i += 1;
            }
            // Other C0 controls (BEL, SO/SI, …) and DEL say nothing on paper.
            0x00..=0x1f | 0x7f => i += 1,
            _ => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// LF → CRLF: the file opens in Notepad as lines, not as one paragraph.
fn to_crlf(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + text.len() / 32);
    for &b in text {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}

/// Writes `bytes` (raw, or stripped when `plain`) to `dest`, returning the
/// number of bytes written. An empty scrollback is refused before any file
/// is touched — a zero-byte `.txt` says nothing and looks like a bug.
pub(crate) fn export_bytes(bytes: &[u8], dest: &Path, plain: bool) -> Result<u64, String> {
    let body: Vec<u8> = if plain {
        to_crlf(&strip_ansi(bytes))
    } else {
        bytes.to_vec()
    };
    if body.is_empty() {
        return Err("sem saída para salvar: o histórico deste terminal está vazio".into());
    }
    std::fs::write(dest, &body)
        .map_err(|e| format!("não consegui gravar {}: {e}", dest.display()))?;
    Ok(body.len() as u64)
}

/// The bytes of a live terminal: everything the `.bin` holds after a flush
/// (the file may carry more history than the ring), falling back to the ring
/// when the disk has nothing to offer.
pub(crate) fn live_bytes(scrollback: &Arc<Mutex<Scrollback>>) -> Vec<u8> {
    let mut sb = scrollback.lock();
    // The reader thread flushes every 250 ms; the tail it has not written yet
    // is exactly the part the user is looking at.
    let from_disk = match sb.flush() {
        Ok(()) => std::fs::read(sb.path()).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if from_disk.is_empty() {
        sb.bytes()
    } else {
        from_disk
    }
}

/// Where a terminal's `.bin` lives under `app_dir` — the same rule as
/// `paths::scrollback_file`, with the root as a parameter.
fn bin_path_in(app_dir: &Path, id: &str) -> PathBuf {
    app_dir
        .join("scrollback")
        .join(format!("{}.bin", crate::paths::sanitize_id(id)))
}

/// Saves the output of terminal `id` — alive or dead — to `dest`.
pub fn export(state: &AppState, id: &str, dest: &Path, plain: bool) -> Result<u64, String> {
    export_in(&crate::paths::app_dir(), state, id, dest, plain)
}

pub(crate) fn export_in(
    app_dir: &Path,
    state: &AppState,
    id: &str,
    dest: &Path,
    plain: bool,
) -> Result<u64, String> {
    let handle = state.ptys.lock().get(id).cloned();
    let bytes = match handle {
        Some(handle) => {
            let scrollback = handle.lock().scrollback.clone();
            live_bytes(&scrollback)
        }
        None => std::fs::read(bin_path_in(app_dir, id)).unwrap_or_default(),
    };
    if bytes.is_empty() {
        return Err(format!("sem saída para salvar: o terminal {id} não tem histórico"));
    }
    export_bytes(&bytes, dest, plain)
}

/// Why these rules matter: the export is what leaves the app — an issue
/// attachment, a paste into another agent — and a file full of `ESC[?25l`
/// or with a spinner's forty frames on one line is worse than nothing.
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yard-export-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).expect("utf-8")
    }

    // -- strip_ansi ---------------------------------------------------------

    #[test]
    fn colors_and_cursor_sequences_vanish_and_the_text_stays() {
        let out = strip_ansi(b"\x1b[32mok\x1b[0m \x1b[?25l\x1b[1;31mfalha\x1b[m");
        assert_eq!(text(out), "ok falha");
    }

    #[test]
    fn osc_title_and_hyperlink_payloads_are_dropped() {
        // BEL-terminated title, then an ST-terminated hyperlink pair.
        let out = strip_ansi(b"\x1b]0;titulo\x07a\x1b]8;;http://x\x1b\\b\x1b]8;;\x1b\\");
        assert_eq!(text(out), "ab");
    }

    #[test]
    fn a_carriage_return_without_newline_keeps_only_the_last_frame_of_the_line() {
        let out = strip_ansi(b"loading 1\rloading 2\rdone\r\nnext");
        assert_eq!(text(out), "done\nnext");
    }

    #[test]
    fn crlf_and_lf_both_become_line_breaks_and_backspace_erases() {
        let out = strip_ansi(b"a\r\nb\nc\x08d\tz");
        assert_eq!(text(out), "a\nb\nd\tz");
    }

    #[test]
    fn single_byte_escapes_and_charset_designations_are_dropped() {
        let out = strip_ansi(b"\x1b(Bx\x1b7y\x1b8\x1b=z\x1b>");
        assert_eq!(text(out), "xyz");
    }

    #[test]
    fn utf8_survives_the_strip() {
        let out = strip_ansi("olá \x1b[1mmundo\x1b[m ✓".as_bytes());
        assert_eq!(text(out), "olá mundo ✓");
    }

    #[test]
    fn a_truncated_escape_at_the_end_drops_nothing_else() {
        assert_eq!(text(strip_ansi(b"abc\x1b[3")), "abc");
        assert_eq!(text(strip_ansi(b"abc\x1b")), "abc");
        assert_eq!(text(strip_ansi(b"abc\x1b]0;half")), "abc");
    }

    #[test]
    fn dcs_and_apc_payloads_are_dropped_up_to_the_string_terminator() {
        let out = strip_ansi(b"a\x1bPq#0;2;0;0;0\x1b\\b\x1b_G;payload\x1b\\c");
        assert_eq!(text(out), "abc");
    }

    #[test]
    fn a_backspace_erases_a_whole_multibyte_character() {
        let out = strip_ansi("caf\u{e9}\x08e".as_bytes());
        assert_eq!(text(out), "cafe");
    }

    // -- export_bytes -------------------------------------------------------

    #[test]
    fn plain_export_writes_crlf_lines_and_reports_the_size() {
        let dir = temp_dir("plain");
        let dest = dir.join("saida.txt");
        let written = export_bytes(b"\x1b[32ma\x1b[0m\nb", &dest, true).expect("export");
        let on_disk = std::fs::read(&dest).expect("file");
        assert_eq!(on_disk, b"a\r\nb");
        assert_eq!(written, on_disk.len() as u64);
    }

    #[test]
    fn raw_export_keeps_every_byte() {
        let dir = temp_dir("raw");
        let dest = dir.join("saida.ansi");
        let bytes = b"\x1b[32ma\x1b[0m\r\nb\x1b]0;t\x07";
        let written = export_bytes(bytes, &dest, false).expect("export");
        assert_eq!(std::fs::read(&dest).expect("file"), bytes);
        assert_eq!(written, bytes.len() as u64);
    }

    #[test]
    fn an_empty_scrollback_is_refused_instead_of_writing_an_empty_file() {
        let dir = temp_dir("vazio");
        let dest = dir.join("nada.txt");
        let err = export_bytes(b"", &dest, true).expect_err("must refuse");
        assert!(err.contains("sem saída"), "got: {err}");
        assert!(!dest.exists(), "no file may be created for an empty export");
        // Escapes only: plain has nothing to say either.
        let err = export_bytes(b"\x1b[0m\x1b[?25l", &dest, true).expect_err("must refuse");
        assert!(err.contains("sem saída"), "got: {err}");
        assert!(!dest.exists());
    }

    // -- where the bytes come from -----------------------------------------

    #[test]
    fn export_of_a_dead_terminal_reads_its_bin_from_disk() {
        let app = temp_dir("morto");
        let id = "t-morto";
        let bin = bin_path_in(&app, id);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"fim \x1b[1mda\x1b[0m sessao\r\n").unwrap();
        let state = AppState::new(rusqlite::Connection::open_in_memory().unwrap());
        let dest = app.join("morto.txt");
        let written = export_in(&app, &state, id, &dest, true).expect("export");
        assert_eq!(std::fs::read(&dest).unwrap(), b"fim da sessao\r\n");
        assert_eq!(written, 15);
    }

    #[test]
    fn export_of_an_unknown_terminal_says_there_is_nothing_to_save() {
        let app = temp_dir("desconhecido");
        let state = AppState::new(rusqlite::Connection::open_in_memory().unwrap());
        let dest = app.join("x.txt");
        let err = export_in(&app, &state, "nunca-existiu", &dest, false).expect_err("refuse");
        assert!(err.contains("sem saída"), "got: {err}");
        assert!(!dest.exists());
    }

    #[test]
    fn a_live_terminal_exports_what_the_bin_holds_after_a_flush() {
        let app = temp_dir("vivo");
        let bin = app.join("scrollback").join("vivo.bin");
        let sb = Arc::new(Mutex::new(Scrollback::at(bin.clone())));
        sb.lock().push(b"primeira\r\n");
        sb.lock().flush().unwrap();
        // Not flushed yet: the export must not lose the tail the reader
        // thread has not written down.
        sb.lock().push(b"segunda\r\n");
        assert_eq!(live_bytes(&sb), b"primeira\r\nsegunda\r\n");
        assert!(bin.exists(), "the flush is what puts the tail on disk");
    }

    #[test]
    fn a_live_terminal_whose_bin_cannot_be_written_falls_back_to_the_ring() {
        let app = temp_dir("vivo-ram");
        // A file where the scrollback folder should be: `create_dir_all`
        // fails, the flush fails, and the ring is still the truth.
        std::fs::write(app.join("scrollback"), b"nao sou uma pasta").unwrap();
        let bin = app.join("scrollback").join("ram.bin");
        let sb = Arc::new(Mutex::new(Scrollback::at(bin)));
        sb.lock().push(b"so na memoria");
        assert_eq!(live_bytes(&sb), b"so na memoria");
    }
}
