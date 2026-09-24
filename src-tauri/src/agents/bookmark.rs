//! Where the last read of an append-only session `.jsonl` stopped.
//!
//! The CLIs only ever append to these files, and the usage scans
//! (`costs.rs`, `sessions::usage`) used to read a file from byte 0 again
//! every time it grew by one line: an active 6 MB Claude session, or a
//! 280 MB Codex rollout, re-parsed whole on every "Custos e uso" refresh and
//! every 5-minute budget check. A bookmark lets the next read start where the
//! complete lines ended.
//!
//! The rules keep a resumed read indistinguishable from reading the file
//! from the start with `BufRead::lines().map_while(Result::ok)`, which is
//! what the scans did:
//!
//! - lines are handed over exactly as `lines` hands them (without the `\n`,
//!   and without a `\r` right before it);
//! - a trailing line with no `\n` yet is returned apart and **not**
//!   consumed: the writer may be in the middle of it, and the next read must
//!   see it whole;
//! - a complete line that is not UTF-8 stops the read for good, as it
//!   stopped `lines` (the file only grows, so it stays there);
//! - an I/O error stops the read where it stopped `lines`, and is returned:
//!   an answer that never saw the end of the file is not one to keep;
//! - a file is resumed only when it still starts with the bytes that were
//!   read: the bookmark keeps a hash of the first 4 KiB and of the end of the
//!   last line read, and `reopen` refuses a file whose bytes there changed
//!   (truncated, rewritten), so the caller reads it from the start.
//!
//! The caller still decides *when* to resume: only a file that grew since
//! the last read. A file of the same size with a new mtime was rewritten (or
//! touched), and reading it again is the only honest answer.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// How many bytes each of the two checked spans covers, at most.
const WINDOW: u64 = 4096;

/// FNV-1a, 64 bits. Streaming (the head hash grows read by read while the
/// file is shorter than `WINDOW`) and deterministic across runs; it guards
/// against a file that changed, not against an adversary.
const FNV_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Bookmark {
    /// Bytes of complete lines already handed over.
    offset: u64,
    /// Hash of the first `min(WINDOW, offset)` bytes.
    head: u64,
    /// Hash of the `last_len` bytes that end at `offset`: the end (at most
    /// `WINDOW` bytes) of the last line handed over.
    last: u64,
    last_len: u64,
    /// The line at `offset` is complete and not UTF-8: nothing after it
    /// is ever handed over.
    halted: bool,
}

impl Default for Bookmark {
    /// The start of a file: nothing read, nothing to check.
    fn default() -> Self {
        Self {
            offset: 0,
            head: FNV_BASIS,
            last: FNV_BASIS,
            last_len: 0,
            halted: false,
        }
    }
}

impl Bookmark {
    /// Where the complete lines end; the tests check that the scans keep it.
    #[cfg(test)]
    pub(crate) fn offset(&self) -> u64 {
        self.offset
    }

    /// The file, positioned right after the bytes this bookmark covers, when
    /// those bytes are still the ones on disk. `None` when the file is gone,
    /// shorter than the bookmark or changed where it was checked: read it
    /// from the start instead.
    pub(crate) fn reopen(&self, path: &Path) -> Option<File> {
        let mut file = File::open(path).ok()?;
        let head_len = self.offset.min(WINDOW) as usize;
        let mut buf = vec![0; head_len.max(self.last_len as usize)];
        file.read_exact(&mut buf[..head_len]).ok()?;
        if fnv(FNV_BASIS, &buf[..head_len]) != self.head {
            return None;
        }
        file.seek(SeekFrom::Start(self.offset - self.last_len)).ok()?;
        let last = &mut buf[..self.last_len as usize];
        file.read_exact(last).ok()?;
        (fnv(FNV_BASIS, last) == self.last).then_some(file)
    }
}

/// Hands every complete line from the file's current position (the
/// bookmark's offset: `reopen`, or a fresh `File::open` with a default
/// bookmark) to `on_line`, moving the bookmark past each. Returns the
/// trailing line that has no `\n` yet, when it is UTF-8; it is left
/// unconsumed, so the next read starts at it again.
///
/// An I/O error ends the read where `lines().map_while(Result::ok)` ended
/// it: the lines before it were handed over and the bookmark covers them,
/// nothing past the last complete line is consumed. The error is returned,
/// so a caller that keeps answers can tell a file read to its end from one
/// that was not.
pub(crate) fn read_lines(
    file: impl Read,
    bookmark: &mut Bookmark,
    mut on_line: impl FnMut(&str),
) -> std::io::Result<Option<String>> {
    if bookmark.halted {
        return Ok(None);
    }
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    // The last line handed over: its end is what the next `reopen` checks.
    let mut last = Vec::new();
    let mut tail = None;
    let mut failed = None;
    loop {
        line.clear();
        let n = match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) => {
                failed = Some(error);
                break;
            }
        };
        if line.last() != Some(&b'\n') {
            tail = String::from_utf8(std::mem::take(&mut line)).ok();
            break;
        }
        let mut end = n - 1;
        if end > 0 && line[end - 1] == b'\r' {
            end -= 1;
        }
        let Ok(text) = std::str::from_utf8(&line[..end]) else {
            bookmark.halted = true;
            break;
        };
        on_line(text);
        if bookmark.offset < WINDOW {
            let in_head = (WINDOW - bookmark.offset).min(n as u64) as usize;
            bookmark.head = fnv(bookmark.head, &line[..in_head]);
        }
        bookmark.offset += n as u64;
        std::mem::swap(&mut line, &mut last);
    }
    if !last.is_empty() {
        let span = last.len().min(WINDOW as usize);
        bookmark.last = fnv(FNV_BASIS, &last[last.len() - span..]);
        bookmark.last_len = span as u64;
    }
    match failed {
        Some(error) => Err(error),
        None => Ok(tail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-bookmark-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    /// Reads from the bookmark (or from the start) and returns the lines
    /// handed over plus the trailing line.
    fn read(path: &Path, bookmark: &mut Bookmark) -> (Vec<String>, Option<String>) {
        let file = if bookmark.offset() == 0 {
            File::open(path).unwrap()
        } else {
            bookmark.reopen(path).expect("the file only grew")
        };
        let mut lines = Vec::new();
        let tail = read_lines(file, bookmark, |line| lines.push(line.to_string()))
            .expect("a local file reads to its end");
        (lines, tail)
    }

    /// What the scans read before bookmarks existed.
    fn std_lines(path: &Path) -> Vec<String> {
        BufReader::new(File::open(path).unwrap()).lines().map_while(Result::ok).collect()
    }

    #[test]
    fn lines_come_out_exactly_as_bufread_lines_hands_them_over() {
        let bytes = b"one\r\ntwo\n\n\r\nthree\rstill three\n\rfour\r\r\nlast\r";
        let path = temp_file("shapes.jsonl", bytes);
        let mut bookmark = Bookmark::default();
        let (mut lines, tail) = read(&path, &mut bookmark);
        assert_eq!(tail.as_deref(), Some("last\r"), "no `\\n` yet: nothing is stripped");
        lines.extend(tail);
        assert_eq!(lines, std_lines(&path));
        assert_eq!(bookmark.offset(), (bytes.len() - "last\r".len()) as u64);
    }

    #[test]
    fn a_resumed_read_hands_over_only_what_was_appended() {
        let path = temp_file("grow.jsonl", b"a\nb\npar");
        let mut bookmark = Bookmark::default();
        assert_eq!(read(&path, &mut bookmark), (vec!["a".into(), "b".into()], Some("par".into())));

        append(&path, b"tial\nc\n");
        let (lines, tail) = read(&path, &mut bookmark);
        assert_eq!(lines, ["partial", "c"], "the partial line was not consumed");
        assert_eq!(tail, None);
        assert_eq!(bookmark.offset(), std::fs::metadata(&path).unwrap().len());

        // Nothing new: nothing handed over, the bookmark stays put.
        let before = bookmark;
        assert_eq!(read(&path, &mut bookmark), (vec![], None));
        assert_eq!(bookmark, before);
    }

    /// `lines().map_while(Result::ok)` stops at the first line that is not
    /// UTF-8, and nothing after it ever counted, however much the file grew.
    #[test]
    fn a_complete_line_that_is_not_utf8_ends_the_read_for_good() {
        let path = temp_file("halt.jsonl", b"a\n\xff\xfe\nb\n");
        let mut bookmark = Bookmark::default();
        assert_eq!(read(&path, &mut bookmark), (vec!["a".into()], None));
        append(&path, b"c\n");
        assert_eq!(read(&path, &mut bookmark), (vec![], None));
        assert_eq!(std_lines(&path), ["a"]);
    }

    /// Hands over `bytes`, then fails: a network drive that dropped, an
    /// offline cloud placeholder, a range another handle locked.
    struct FailsAfter(std::io::Cursor<Vec<u8>>);

    impl Read for FailsAfter {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.0.read(buf)? {
                0 => Err(std::io::Error::other("the drive went away")),
                n => Ok(n),
            }
        }
    }

    /// `lines().map_while(Result::ok)` stopped at an I/O error with the
    /// lines before it counted, and so does the read; but it says the file
    /// was not read to its end, so a caller that keeps answers does not keep
    /// this one as the file's.
    #[test]
    fn an_io_error_mid_file_is_reported_and_keeps_the_lines_before_it() {
        let bytes = b"a\nb\npar".to_vec();
        let failing = || FailsAfter(std::io::Cursor::new(bytes.clone()));
        let mut bookmark = Bookmark::default();
        let mut lines = Vec::new();
        let read = read_lines(failing(), &mut bookmark, |line| lines.push(line.to_string()));
        assert!(read.is_err(), "the error is reported, not taken for the end of the file");
        let before: Vec<String> = BufReader::new(failing()).lines().map_while(Result::ok).collect();
        assert_eq!(lines, before);
        assert_eq!(lines, ["a", "b"]);
        assert_eq!(bookmark.offset(), 4, "nothing past the last complete line is consumed");
    }

    /// A multi-byte character cut by the writer mid-line is not a broken
    /// file: once the line is complete it is read like any other.
    #[test]
    fn a_trailing_line_cut_inside_a_character_is_not_a_halt() {
        let path = temp_file("cut.jsonl", b"a\n\xe2\x82");
        let mut bookmark = Bookmark::default();
        assert_eq!(read(&path, &mut bookmark), (vec!["a".into()], None));
        append(&path, b"\xac\n");
        assert_eq!(read(&path, &mut bookmark), (vec!["\u{20ac}".into()], None));
        assert_eq!(std_lines(&path), ["a", "\u{20ac}"]);
    }

    #[test]
    fn reopen_refuses_a_file_that_no_longer_starts_with_what_was_read() {
        let body: Vec<u8> = (0..400).flat_map(|i| format!("{{\"n\":{i:05}}}\n").into_bytes()).collect();
        let path = temp_file("rewrite.jsonl", &body);
        let mut bookmark = Bookmark::default();
        read(&path, &mut bookmark);
        assert_eq!(bookmark.offset(), body.len() as u64);

        append(&path, b"{\"n\":\"more\"}\n");
        assert!(bookmark.reopen(&path).is_some(), "an append is resumable");

        // Truncated below the bookmark.
        std::fs::write(&path, &body[..body.len() - 3]).unwrap();
        assert!(bookmark.reopen(&path).is_none());

        // The first line changed, the length did not.
        let mut head = body.clone();
        head[6] = b'9';
        std::fs::write(&path, &head).unwrap();
        assert!(bookmark.reopen(&path).is_none());

        // The last line read changed, and the file grew.
        let mut end = body.clone();
        let at = end.len() - 3;
        end[at] = b'7';
        end.extend_from_slice(b"{\"n\":\"more\"}\n");
        std::fs::write(&path, &end).unwrap();
        assert!(bookmark.reopen(&path).is_none());

        std::fs::remove_file(&path).unwrap();
        assert!(bookmark.reopen(&path).is_none(), "a missing file is not resumable");
    }
}
