//! Scrollback: 4 MB in-memory ring + append-only file on disk (§5.2).
//!
//! The whole point of this module is to **never rewrite the entire ring on flush**.
//! An agent running a spinner emits a few bytes per second; if every flush
//! rewrote the ring's 4 MB, a single terminal would generate tens of MB/s of
//! idle I/O. So:
//!
//! - `ring`    — window of the last 4 MB, and what `attach` repaints;
//! - `pending` — only what has not yet gone to disk; flush writes **that** and clears;
//! - the `.bin`  — grows by append until 8 MB and is then compacted to the 4 MB tail.
//!
//! And the flush the pump runs four times a second stays cheap in the two
//! ways that are not about bytes: the `.bin` stays open between flushes (on
//! Windows every close after a write can wake the antivirus to scan the file),
//! and the compaction, 4 MB written and fsynced, runs on its own thread
//! instead of under the lock the reader takes on every read, which used to
//! stall the child writing into the terminal every 4 MB of output.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

/// Cap of the in-memory ring and of the tail kept on compaction.
pub const RING_CAP: usize = 4 * 1024 * 1024;
/// When the file exceeds this (2x the ring), compact to the `RING_CAP` tail.
pub const FILE_CAP: u64 = 8 * 1024 * 1024;

pub struct Scrollback {
    path: PathBuf,
    ring: VecDeque<u8>,
    pending: Vec<u8>,
    file_len: u64,
    /// The `.bin`, open for appending from the first flush until the last
    /// one (`flush_and_close`). Dropped on any write error, so the next flush
    /// opens it afresh, as every flush used to.
    file: Option<File>,
    /// A compaction writing the new `.bin` on its own thread (see
    /// `flush_in_background`), with the new file's length. Nothing is
    /// appended while it runs: its rename is about to replace the file.
    compaction: Option<JoinHandle<std::io::Result<u64>>>,
    /// The last append failed (`append`): the disk is not taking bytes right
    /// now, and `pending` is kept within the ring's size until it does.
    refused: bool,
    /// Bytes fell out of `pending` before reaching the disk (`trim_pending`):
    /// the `.bin` no longer ends where what is still pending begins, so the
    /// next flush that appends rewrites it as the ring instead of leaving a
    /// gap in the history.
    torn: bool,
}

impl Scrollback {
    /// Opens the scrollback of a PTY. If a `.bin` already exists on disk, its
    /// tail is loaded into the ring — that is what makes a resumed terminal
    /// appear with the previous session's history above.
    pub fn open(id: &str) -> Self {
        Self::open_at(crate::paths::scrollback_file(id))
    }

    /// `open` at an explicit path (see `at` for why tests want one).
    fn open_at(path: PathBuf) -> Self {
        let (ring, file_len) = match read_tail(&path, RING_CAP) {
            Ok((bytes, len)) => (VecDeque::from(bytes), len),
            Err(_) => (VecDeque::new(), 0),
        };
        let mut sb = Self::at(path);
        sb.ring = ring;
        sb.file_len = file_len;
        sb
    }

    /// Creates an empty scrollback, deleting whatever is on disk. Used when
    /// spawning a new terminal (a new id never collides, but restart reuses the id).
    pub fn fresh(id: &str) -> Self {
        let path = crate::paths::scrollback_file(id);
        let _ = std::fs::remove_file(&path);
        Self::at(path)
    }

    /// An empty scrollback at an explicit path. The path comes in as a
    /// parameter so a test does not have to touch `YARD_DATA_DIR` — env vars
    /// are process-global, and cargo runs tests in parallel.
    pub fn at(path: PathBuf) -> Self {
        Self {
            path,
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
            file: None,
            compaction: None,
            refused: false,
            torn: false,
        }
    }

    /// The `.bin` this scrollback appends to.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The whole ring, byte for byte — what an export wants when the disk
    /// has nothing to offer (`snapshot` is the lossy UTF-8 view the UI paints).
    pub fn bytes(&self) -> Vec<u8> {
        self.copy_from(0)
    }

    /// The ring from `start` to the end, copied as the (at most two) runs of
    /// memory it lives in: a byte-by-byte iterator over 4 MB is what `attach`
    /// used to spend its time on.
    fn copy_from(&self, start: usize) -> Vec<u8> {
        let (front, back) = self.ring.as_slices();
        let mut out = Vec::with_capacity(self.ring.len() - start);
        if start < front.len() {
            out.extend_from_slice(&front[start..]);
            out.extend_from_slice(back);
        } else {
            out.extend_from_slice(&back[start - front.len()..]);
        }
        out
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        self.trim_pending();
        // From the slice itself, which the ring copies as (at most two) runs
        // of memory.
        self.ring.extend(bytes);
        self.trim_ring();
    }

    /// Keeps `pending` within `RING_CAP` while the disk is not taking it: a
    /// `.bin` that refuses every write (disk full, a folder in the way, an
    /// antivirus holding the file) must not turn every byte the terminal
    /// prints into RAM. What falls out is older than the ring anyway, and
    /// `torn` makes the next successful flush rewrite the file as the ring.
    ///
    /// Only after a flush has failed: with the disk fine, everything pushed
    /// between two flushes reaches the file, however much it is (and a
    /// compaction in flight waits for the bytes behind it past `RING_CAP`,
    /// see `flush_detaching`).
    fn trim_pending(&mut self) {
        if !self.refused || self.compaction.is_some() || self.pending.len() <= RING_CAP {
            return;
        }
        let mut cut = self.pending.len() - RING_CAP;
        // 0b10xxxxxx is a continuation byte: advance until a character start.
        while cut < self.pending.len() && self.pending[cut] & 0b1100_0000 == 0b1000_0000 {
            cut += 1;
        }
        self.pending.drain(..cut);
        self.torn = true;
    }

    /// Drops the head of the ring until it fits in `RING_CAP`, stopping only at
    /// a UTF-8 character start — otherwise `attach` would begin with `?`.
    fn trim_ring(&mut self) {
        if self.ring.len() <= RING_CAP {
            return;
        }
        let excess = self.ring.len() - RING_CAP;
        self.ring.drain(..excess);
        // 0b10xxxxxx is a continuation byte: advance until a character start.
        while let Some(&b) = self.ring.front() {
            if b & 0b1100_0000 == 0b1000_0000 {
                self.ring.pop_front();
            } else {
                break;
            }
        }
    }

    /// Writes `pending` to the end of the `.bin` and clears it. Cheap by construction.
    ///
    /// Everything is on disk when this returns: a compaction in flight is
    /// waited for, and one this flush makes necessary runs right here. That
    /// is what an export reading the file next, and the last flush of a
    /// terminal, need. The pump's periodic flush is `flush_in_background`.
    pub fn flush(&mut self) -> std::io::Result<()> {
        let settled = self.settle();
        if self.append()? && self.needs_compaction() {
            self.compact_now()?;
        }
        settled
    }

    /// Past the file cap, or with a gap in it (`torn`): the file is rewritten
    /// as the ring either way.
    fn needs_compaction(&self) -> bool {
        self.file_len > FILE_CAP || self.torn
    }

    /// `flush` for the pump, which comes back every 250 ms anyway: a
    /// compaction goes to its own thread instead of running under the lock
    /// the reader takes on every read. While it runs, the bytes stay in
    /// `pending` (the file they would go to is about to be replaced) and
    /// `has_pending` says so; they are appended to the new file by the first
    /// flush after it. Past `RING_CAP` of them the flush waits for it, as
    /// every flush used to, so memory stays bounded however slow the disk.
    pub fn flush_in_background(&mut self) -> std::io::Result<()> {
        self.flush_detaching(write_compacted)
    }

    /// `flush_in_background` with the compaction's writer as a parameter, so
    /// a test can hold it mid-write.
    fn flush_detaching<W>(&mut self, write: W) -> std::io::Result<()>
    where
        W: FnOnce(&Path, &[u8]) -> std::io::Result<u64> + Send + 'static,
    {
        let mut settled = Ok(());
        if let Some(job) = &self.compaction {
            if !job.is_finished() && self.pending.len() < RING_CAP {
                return Ok(());
            }
            settled = self.settle();
        }
        if self.append()? && self.needs_compaction() {
            // The rename replaces the file this handle points at.
            self.file = None;
            let (path, tail) = (self.path.clone(), self.bytes());
            let job = std::thread::Builder::new()
                .name("yard-scrollback".into())
                .spawn(move || write(&path, &tail));
            match job {
                Ok(job) => self.compaction = Some(job),
                // No thread to be had: compact here, as it always was.
                Err(_) => self.compact_now()?,
            }
        }
        settled
    }

    /// Waits for a compaction in flight and takes its result: the new file's
    /// length, or the error the flush that started it would have returned (the
    /// file then stays as it was, over the cap, and the next flush that
    /// appends tries again, as before).
    fn settle(&mut self) -> std::io::Result<()> {
        let Some(job) = self.compaction.take() else {
            return Ok(());
        };
        match job.join() {
            Ok(Ok(len)) => {
                self.file_len = len;
                self.torn = false;
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(std::io::Error::other("the scrollback compaction panicked")),
        }
    }

    /// Appends `pending` through the handle kept open, opening it (and its
    /// folder) when there is none. `false` when there was nothing to write.
    /// On failure the bytes stay pending and the handle goes: the retry opens
    /// a fresh one, exactly as when every flush opened its own.
    fn append(&mut self) -> std::io::Result<bool> {
        let result = self.append_pending();
        self.refused = result.is_err();
        result
    }

    fn append_pending(&mut self) -> std::io::Result<bool> {
        if self.pending.is_empty() {
            return Ok(false);
        }
        let mut file = match self.file.take() {
            Some(file) => file,
            None => {
                if let Some(parent) = self.path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                OpenOptions::new().create(true).append(true).open(&self.path)?
            }
        };
        file.write_all(&self.pending)?;
        self.file = Some(file);
        self.file_len += self.pending.len() as u64;
        self.pending.clear();
        Ok(true)
    }

    /// Rewrites the file with only the `RING_CAP`-byte tail, via tmp+rename
    /// so a `.bin` is never left truncated if the process dies mid-way.
    ///
    /// The tail is the ring: right after a successful flush it is, byte for
    /// byte, what the file ends with (`after_a_flush_the_ring_is_the_tail_of_the_bin`),
    /// so there is nothing to gain from reading 4 MB back from the disk.
    fn compact_now(&mut self) -> std::io::Result<()> {
        // The rename replaces the file this handle points at.
        self.file = None;
        self.file_len = write_compacted(&self.path, &self.bytes())?;
        self.torn = false;
        Ok(())
    }

    /// The last flush of a terminal: everything on disk, and the handle
    /// closed, so a terminal that ended holds nothing open and its `.bin` can
    /// be deleted or replaced at once, as before.
    pub fn flush_and_close(&mut self) -> std::io::Result<()> {
        let result = self.flush();
        self.file = None;
        result
    }

    /// What `attach_pty` returns for the UI to repaint.
    pub fn snapshot(&self) -> String {
        self.tail(self.ring.len())
    }

    /// Last `max` bytes, used by bridge polling without cloning the 4 MB ring.
    pub fn tail(&self, max: usize) -> String {
        let mut start = self.ring.len().saturating_sub(max);
        if start > 0 {
            // Start at a character, not in the middle of one. Found before the
            // copy, so the copy is the only pass over the bytes.
            start += self
                .ring
                .range(start..)
                .position(|b| b & 0b1100_0000 != 0b1000_0000)
                .unwrap_or(self.ring.len() - start);
        }
        into_text(self.copy_from(start))
    }

    /// A suffix of `snapshot()` that still holds its last `units` UTF-16 code
    /// units (all of it when it has fewer), for a view that reads only
    /// `data.slice(-units)`. That view cuts the text it received exactly where
    /// it would have cut the whole snapshot, a split surrogate pair included.
    /// `units == 0` is the whole snapshot, as `slice(-0)` is in JavaScript.
    ///
    /// Why three bytes per unit, and why the cut moves **back**: every unit of
    /// the lossy text costs at most three bytes of ring (a 3-byte character,
    /// or the longest run one U+FFFD replaces; a 4-byte character is two
    /// units). And a byte that is not a continuation byte starts a character
    /// in the whole snapshot too, so the text decoded from there is a suffix
    /// of it. Moving forward instead (what `tail` does) could skip the very
    /// units the view reads: the second half of an emoji, or a run of stray
    /// continuation bytes that the snapshot shows as replacement characters.
    pub fn tail_utf16(&self, units: usize) -> String {
        let reach = units.saturating_mul(3);
        if units == 0 || reach >= self.ring.len() {
            return self.snapshot();
        }
        let from = self.ring.len() - reach;
        let start = self
            .ring
            .range(..=from)
            .rposition(|b| b & 0b1100_0000 != 0b1000_0000)
            .unwrap_or(0);
        into_text(self.copy_from(start))
    }

    pub fn len(&self) -> usize {
        self.ring.len()
    }

    /// Bytes pushed that have not reached the `.bin` yet.
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        self.ring.is_empty()
    }

    /// Clears memory and disk (explicit user action: "clear terminal").
    pub fn clear(&mut self) {
        // A rename still on its way would bring the cleared history back.
        let _ = self.settle();
        self.file = None;
        self.ring.clear();
        self.pending.clear();
        self.file_len = 0;
        self.refused = false;
        self.torn = false;
        let _ = std::fs::remove_file(&self.path);
    }

    /// Removes the `.bin` from disk — used when the terminal is deleted for good.
    pub fn delete_file(id: &str) {
        let _ = std::fs::remove_file(crate::paths::scrollback_file(id));
    }

    /// Reads the tail of the `.bin` without needing a live `Scrollback`. This is
    /// the path used to show the history of a dead/suspended terminal.
    pub fn read_from_disk(id: &str) -> String {
        Self::read_tail_from_disk(id, RING_CAP)
    }

    pub fn read_tail_from_disk(id: &str, max: usize) -> String {
        let path = crate::paths::scrollback_file(id);
        match read_tail(&path, max.min(RING_CAP)) {
            Ok((bytes, _)) => into_text(bytes),
            Err(_) => String::new(),
        }
    }
}

impl Drop for Scrollback {
    /// A compaction still in flight finishes first: its rename landing after
    /// another scrollback opened the same path would replace that one's file.
    /// (The last flush of a terminal already waits for it; this is the net.)
    fn drop(&mut self) {
        let _ = self.settle();
    }
}

/// Writes `tail` as the whole new `.bin`: a `.bin.tmp` written and fsynced,
/// then renamed over the old one, so a crash at any point leaves one complete
/// file or the other. Returns the new length.
fn write_compacted(path: &Path, tail: &[u8]) -> std::io::Result<u64> {
    let tmp = path.with_extension("bin.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(tail)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    tracing::debug!(path = %path.display(), len = tail.len(), "scrollback compactado");
    Ok(tail.len() as u64)
}

/// Bytes to text, exactly as `String::from_utf8_lossy` makes it, minus the
/// second copy when the bytes already are UTF-8, which is nearly always (the
/// reader stitches characters split across reads). Only bytes that are not
/// valid pay for the lossy conversion.
pub(super) fn into_text(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

/// Reads the last `max` bytes of `path`, cutting at the start of a UTF-8
/// character. Returns `(bytes, total_file_size)`.
fn read_tail(path: &PathBuf, max: usize) -> std::io::Result<(Vec<u8>, u64)> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max as u64);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;

    if start > 0 {
        let cut = buf
            .iter()
            .position(|b| b & 0b1100_0000 != 0b1000_0000)
            .unwrap_or(buf.len());
        buf.drain(..cut);
    }
    Ok((buf, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_respects_cap_and_utf8_boundary() {
        let mut sb = Scrollback {
            path: PathBuf::from("nao-existe.bin"),
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
            file: None,
            compaction: None,
            refused: false,
            torn: false,
        };
        // "ç" is 2 bytes; pushing well past the cap forces a discard.
        let blob = "ç".repeat(RING_CAP);
        sb.push(blob.as_bytes());
        assert!(sb.ring.len() <= RING_CAP);
        // If the cut respected the boundary, no U+FFFD in the snapshot.
        assert!(!sb.snapshot().contains('\u{FFFD}'));
    }

    #[test]
    fn pending_resets_on_flush_but_ring_does_not() {
        let dir = std::env::temp_dir().join("yard-test-sb");
        std::fs::create_dir_all(&dir).unwrap();
        let mut sb = Scrollback {
            path: dir.join("t.bin"),
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
            file: None,
            compaction: None,
            refused: false,
            torn: false,
        };
        sb.push(b"ola mundo");
        assert_eq!(sb.pending.len(), 9);
        sb.flush().unwrap();
        assert_eq!(sb.pending.len(), 0);
        assert_eq!(sb.snapshot(), "ola mundo");
        assert_eq!(sb.file_len, 9);
        let _ = std::fs::remove_file(sb.path.clone());
    }

    #[test]
    fn tail_respects_limit_and_utf8() {
        let mut sb = Scrollback {
            path: PathBuf::from("nao-existe.bin"),
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
            file: None,
            compaction: None,
            refused: false,
            torn: false,
        };
        sb.push("açb".as_bytes());
        assert_eq!(sb.tail(3), "çb");
        assert_eq!(sb.tail(2), "b");
    }

    /// The ring as it was copied before `as_slices`: one byte at a time, then
    /// the lossy conversion, then the owned copy of that. Kept here, verbatim,
    /// as the reference the faster copy has to match.
    fn tail_byte_by_byte(ring: &VecDeque<u8>, max: usize) -> String {
        let start = ring.len().saturating_sub(max);
        let mut buf: Vec<u8> = ring.iter().skip(start).copied().collect();
        if start > 0 {
            let cut = buf
                .iter()
                .position(|b| b & 0b1100_0000 != 0b1000_0000)
                .unwrap_or(buf.len());
            buf.drain(..cut);
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    /// A ring whose bytes wrap around the end of the `VecDeque`'s buffer, so
    /// `as_slices` hands back two halves: the case a copy that only looked at
    /// the first half would get wrong.
    fn wrapped(content: &[u8]) -> Scrollback {
        // Park the head at the last slot of the buffer: fill it, keep one
        // real byte, pop the filler in front of it (the deque never empties,
        // so the head really moves), and let the rest wrap to the start.
        let mut ring = VecDeque::with_capacity(content.len() + 1);
        let filler = ring.capacity() - 1;
        ring.extend(std::iter::repeat_n(b'-', filler));
        ring.push_back(content[0]);
        for _ in 0..filler {
            ring.pop_front();
        }
        ring.extend(content[1..].iter().copied());
        assert!(
            !ring.as_slices().1.is_empty(),
            "the ring did not wrap: {:?}",
            ring.as_slices()
        );
        Scrollback {
            path: PathBuf::from("nao-existe.bin"),
            ring,
            pending: Vec::new(),
            file_len: 0,
            file: None,
            compaction: None,
            refused: false,
            torn: false,
        }
    }

    /// What `attach` and the bridge's `read_since` paint: every tail length of
    /// a wrapped ring, cuts in the middle of a character included, reads the
    /// same text it read when the ring was copied byte by byte.
    #[test]
    fn a_wrapped_ring_reads_the_same_text_at_every_tail_length() {
        let content = "açb€ 😀 ok\r\n\x1b[1;32mverde\x1b[0m ção".as_bytes();
        let sb = wrapped(content);
        for max in 0..=content.len() + 2 {
            assert_eq!(sb.tail(max), tail_byte_by_byte(&sb.ring, max), "max {max}");
        }
        assert_eq!(sb.snapshot(), String::from_utf8(content.to_vec()).unwrap());
    }

    /// Bytes that are not UTF-8 at all (a CLI printing raw Latin-1, a stray
    /// half of a character) still come out as the same replacement
    /// characters, in the same places.
    #[test]
    fn bytes_that_are_not_utf8_come_out_as_the_same_replacement_characters() {
        let content = [b'a', 0xff, 0xfe, b'b', 0xc3, b'c', 0xe2, 0x82, b'd', 0xc3];
        let sb = wrapped(&content);
        for max in 0..=content.len() + 1 {
            assert_eq!(sb.tail(max), tail_byte_by_byte(&sb.ring, max), "max {max}");
        }
        assert_eq!(sb.snapshot(), tail_byte_by_byte(&sb.ring, content.len()));
        assert!(sb.snapshot().contains('\u{FFFD}'));
    }

    /// Whatever the bytes, the text is exactly what the lossy conversion gave:
    /// the fast path is a shortcut, never a different answer.
    #[test]
    fn any_bytes_become_the_text_the_lossy_conversion_gave() {
        for bytes in [
            Vec::new(),
            b"ola mundo".to_vec(),
            "açb€😀".as_bytes().to_vec(),
            vec![b'a', 0xff, b'b'],
            vec![0xc3],
            vec![b'x', 0xe2, 0x82],
        ] {
            assert_eq!(into_text(bytes.clone()), String::from_utf8_lossy(&bytes).into_owned());
        }
    }

    /// Up to 4 MB per attach: text that already is UTF-8 (nearly all of it)
    /// becomes the `String` in place, instead of being copied a second time.
    #[test]
    fn valid_utf8_becomes_text_without_a_second_copy() {
        let bytes = "açb€😀 ok".as_bytes().to_vec();
        let before = bytes.as_ptr();
        let text = into_text(bytes);
        assert_eq!(text.as_ptr(), before);
    }

    /// `text.slice(-n)` as JavaScript computes it on the string the view
    /// receives: over UTF-16 code units, where `slice(-0)` is the whole text.
    fn js_slice_from_end(text: &str, n: usize) -> Vec<u16> {
        let units: Vec<u16> = text.encode_utf16().collect();
        if n == 0 {
            return units;
        }
        units[units.len().saturating_sub(n)..].to_vec()
    }

    /// Histories that stress every way a byte cut can go wrong: 4-byte
    /// characters (two UTF-16 units each, a cut can split the pair), 3-byte
    /// ones (the densest bytes per unit), bytes that are not UTF-8, and a long
    /// run of stray continuation bytes (each its own U+FFFD, and no character
    /// start to cut at).
    fn awkward_histories() -> Vec<Vec<u8>> {
        let mut stray_run = b"inicio ".to_vec();
        stray_run.extend(std::iter::repeat_n(0x80, 40));
        stray_run.extend_from_slice("fim ç".as_bytes());
        vec![
            Vec::new(),
            b"ola mundo\r\n".to_vec(),
            "açb€ 😀 ok\r\n\x1b[1;32mverde\x1b[0m ção 😀😀"
                .as_bytes()
                .to_vec(),
            "€€€€€€€€€€€€".as_bytes().to_vec(),
            "😀😀😀😀😀😀".as_bytes().to_vec(),
            vec![
                b'a', 0xff, 0xfe, b'b', 0xc3, b'c', 0xe2, 0x82, b'd', 0xf0, 0x9f, 0x98, b'e', 0xc3,
            ],
            stray_run,
        ]
    }

    /// The contract with `XTermView`: whatever it does with `data.slice(-n)`
    /// on the tail, it gets exactly what it got from the whole snapshot. The
    /// tail is a suffix of the snapshot's text that still holds its last `n`
    /// UTF-16 units (all of it when there are fewer), so the view's own cut
    /// lands on the same unit, a split surrogate pair included.
    #[test]
    fn the_utf16_tail_reads_like_the_whole_history_to_the_view() {
        for content in awkward_histories() {
            let mut rings = vec![Scrollback::at(PathBuf::from("nao-existe.bin"))];
            rings[0].push(&content);
            if !content.is_empty() {
                rings.push(wrapped(&content));
            }
            for sb in rings {
                let whole = sb.snapshot();
                for n in 0..=content.len() * 2 + 2 {
                    let tail = sb.tail_utf16(n);
                    assert!(whole.ends_with(&tail), "not a suffix: {content:?} n={n}");
                    assert_eq!(
                        js_slice_from_end(&tail, n),
                        js_slice_from_end(&whole, n),
                        "{content:?} n={n}"
                    );
                    assert_eq!(tail.is_empty(), whole.is_empty(), "{content:?} n={n}");
                }
            }
        }
    }

    /// What the cut is for: an agent on the alternate screen with a full ring
    /// hands the view about three bytes per unit it reads, not 4 MB.
    #[test]
    fn the_utf16_tail_of_a_full_ring_is_a_small_fraction_of_it() {
        let mut sb = Scrollback::at(PathBuf::from("nao-existe.bin"));
        let frame = "\x1b[2K\x1b[1;1H╭─ ação ─╮ 😀 linha\r\n".as_bytes();
        while sb.len() < RING_CAP {
            sb.push(frame);
        }
        let units = 64 * 1024;
        let tail = sb.tail_utf16(units);
        assert!(tail.encode_utf16().count() >= units);
        assert!(tail.len() <= 3 * units + 3, "{} bytes", tail.len());
    }

    // -- the `.bin`: what reaches the disk, and when ---------------------------
    //
    // The file is the history a dead terminal shows and what an export saves,
    // so how it is written can change (a handle kept open, a compaction built
    // from memory, off the lock) but what it holds after each flush cannot.

    /// A fresh `.bin` path in its own temporary folder.
    fn temp_bin(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-sb-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("t.bin")
    }

    /// About `total` bytes of terminal output, in reads of irregular size cut
    /// anywhere, the middle of a character included.
    fn reads(total: usize) -> Vec<Vec<u8>> {
        let line = "linha ação 😀 € ç\r\n\x1b[1;32mverde\x1b[0m ".as_bytes();
        let mut stream = Vec::with_capacity(total + 64);
        let mut n = 0u32;
        while stream.len() < total {
            stream.extend_from_slice(line);
            stream.extend_from_slice(n.to_string().as_bytes());
            n += 1;
        }
        let (mut out, mut at, mut step) = (Vec::new(), 0usize, 1usize);
        while at < stream.len() {
            let end = (at + step).min(stream.len());
            out.push(stream[at..end].to_vec());
            at = end;
            step = (step * 7 + 13) % 40_000 + 1;
        }
        out
    }

    /// The `.bin` as the code before this one made it: every flush appended,
    /// and past `FILE_CAP` the file was rewritten with its own tail, read back
    /// from the disk.
    #[derive(Default)]
    struct OldDisk(Vec<u8>);

    impl OldDisk {
        fn flush(&mut self, pending: &[u8]) {
            self.0.extend_from_slice(pending);
            if self.0.len() as u64 > FILE_CAP {
                let start = self.0.len() - RING_CAP;
                let cut = self.0[start..]
                    .iter()
                    .position(|b| b & 0b1100_0000 != 0b1000_0000)
                    .unwrap_or(self.0.len() - start);
                self.0.drain(..start + cut);
            }
        }
    }

    fn same_bytes(path: &PathBuf, expected: &[u8]) -> bool {
        std::fs::read(path).map(|bytes| bytes == expected).unwrap_or(false)
    }

    /// Three times past the cap, flushed every few reads: after each flush
    /// the file holds exactly what the old append-and-compact left.
    #[test]
    fn the_bin_holds_what_compacting_from_the_disk_used_to_leave() {
        let path = temp_bin("modelo");
        let mut sb = Scrollback::at(path.clone());
        let (mut old, mut pending) = (OldDisk::default(), Vec::new());
        let mut compactions = 0;
        for (n, read) in reads(3 * FILE_CAP as usize).into_iter().enumerate() {
            sb.push(&read);
            pending.extend_from_slice(&read);
            if n % 25 == 24 {
                sb.flush().expect("flush");
                let before = old.0.len();
                old.flush(&pending);
                pending.clear();
                compactions += usize::from(old.0.len() < before);
                assert!(same_bytes(&path, &old.0), "the .bin differs after read {n}");
            }
        }
        assert!(compactions >= 3, "only {compactions} compactions: the test lost its point");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Why the compaction can be built from memory: after every successful
    /// flush the ring is, byte for byte, the tail the old compaction read back
    /// from the file. Including a ring loaded from a `.bin` an earlier session
    /// left, whose tail starts in the middle of a character.
    #[test]
    fn after_a_flush_the_ring_is_the_tail_of_the_bin() {
        let path = temp_bin("anel");
        // 3-byte characters with the 4 MB cut landing inside one of them.
        let mut previous = b"a".repeat(1_000);
        previous.extend("€".repeat(RING_CAP / 3 + 10).as_bytes());
        std::fs::write(&path, &previous).expect("previous session");
        let mut sb = Scrollback::open_at(path.clone());
        let tail = |sb: &Scrollback| read_tail(&sb.path().to_path_buf(), RING_CAP).expect("tail").0;
        assert!(sb.bytes() == tail(&sb), "the ring loaded is not the file's tail");

        for (n, read) in reads(2 * FILE_CAP as usize).into_iter().enumerate() {
            sb.push(&read);
            if n % 25 == 24 {
                sb.flush().expect("flush");
                assert!(sb.bytes() == tail(&sb), "ring and file tail differ after read {n}");
            }
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A flush that fails keeps its bytes, and the one after it writes them
    /// all, once, in order: whatever handle the failure left behind is not
    /// the one the retry uses.
    #[test]
    fn a_flush_that_failed_writes_everything_once_the_disk_is_back() {
        let path = temp_bin("erro");
        let blocker = path.parent().unwrap().join("scrollback");
        std::fs::write(&blocker, b"nao sou uma pasta").unwrap();
        let bin = blocker.join("t.bin");
        let mut sb = Scrollback::at(bin.clone());
        sb.push(b"antes ");
        assert!(sb.flush().is_err());
        sb.push(b"depois");
        std::fs::remove_file(&blocker).unwrap();
        sb.flush().expect("flush");
        sb.push(b" e mais");
        sb.flush().expect("flush");
        assert_eq!(std::fs::read(&bin).unwrap(), b"antes depois e mais");
        drop(sb);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The regression that motivated the cap: with the `.bin` refusing every
    /// write (disk full, a folder in the way, an antivirus holding the file)
    /// `pending` kept every byte the terminal printed, next to the ring, for
    /// as long as the terminal lived. A 300 MB build log was 300 MB of RAM.
    #[test]
    fn pending_stays_within_the_ring_cap_while_the_disk_refuses_every_write() {
        let path = temp_bin("cheio");
        let blocker = path.parent().unwrap().join("scrollback");
        std::fs::write(&blocker, b"nao sou uma pasta").unwrap();
        let bin = blocker.join("t.bin");
        let mut sb = Scrollback::at(bin.clone());
        let mut all = Vec::new();
        for (n, read) in reads(3 * RING_CAP).into_iter().enumerate() {
            sb.push(&read);
            all.extend_from_slice(&read);
            if n % 25 == 24 {
                assert!(sb.flush_in_background().is_err(), "the disk was supposed to refuse");
            }
        }
        assert!(
            sb.pending.len() <= RING_CAP,
            "pending grew to {} bytes with the disk down",
            sb.pending.len()
        );
        // What it keeps is the end of the output, whole, and once the disk is
        // back the `.bin` holds exactly the ring: no gap between what got
        // written before the failure and what came after it.
        assert_eq!(&sb.pending[..], &all[all.len() - sb.pending.len()..]);
        std::fs::remove_file(&blocker).unwrap();
        sb.flush().expect("flush");
        assert!(same_bytes(&bin, &sb.bytes()), "the .bin is not the ring after the disk came back");
        drop(sb);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Fills `sb` (and the model) until the next flush compacts: the file
    /// just under the cap, and one read in `pending` that takes it over.
    fn up_to_the_cap(sb: &mut Scrollback, old: &mut OldDisk) {
        let mut pending = Vec::new();
        for read in reads(FILE_CAP as usize - 64 * 1024) {
            sb.push(&read);
            pending.extend_from_slice(&read);
        }
        sb.flush().expect("flush");
        old.flush(&pending);
        let over = "passou do limite ç ".repeat(8 * 1024);
        sb.push(over.as_bytes());
        old.0.extend_from_slice(over.as_bytes());
    }

    /// The compaction off the lock the reader needs: the flush that crosses
    /// the cap hands the rewrite to its own thread, and output that keeps
    /// coming waits in memory and lands after it, in order, in the file the
    /// compaction left.
    #[test]
    fn bytes_pushed_while_a_compaction_writes_reach_the_bin_after_it_in_order() {
        let path = temp_bin("fundo");
        let mut sb = Scrollback::at(path.clone());
        let mut old = OldDisk::default();
        up_to_the_cap(&mut sb, &mut old);
        sb.flush_in_background().expect("flush");
        old.flush(&[]);

        for read in [&b"durante "[..], "a compactação 😀".as_bytes()] {
            sb.push(read);
            sb.flush_in_background().expect("flush");
            old.flush(read);
        }
        sb.flush().expect("flush");
        assert!(same_bytes(&path, &old.0), "the .bin is not what the old compaction left");
        assert!(!sb.has_pending());
        drop(sb);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The point of moving it: while the rewrite, the fsync and the rename
    /// are in flight (parked here at will), pushing and the pump's flush both
    /// return at once. The reader never waits on the disk, and so neither does
    /// the child writing into the terminal.
    #[test]
    fn a_compaction_in_flight_does_not_hold_up_the_bytes_behind_it() {
        use std::sync::mpsc;
        let path = temp_bin("parado");
        let mut sb = Scrollback::at(path.clone());
        let mut old = OldDisk::default();
        up_to_the_cap(&mut sb, &mut old);

        let (started, parked) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        sb.flush_detaching(move |path: &Path, tail: &[u8]| {
            let _ = started.send(());
            let _ = gate.recv();
            write_compacted(path, tail)
        })
        .expect("flush");
        old.flush(&[]);
        parked.recv_timeout(std::time::Duration::from_secs(10)).expect("the compaction never started");

        sb.push(b"enquanto grava");
        sb.flush_in_background().expect("flush");
        assert!(sb.has_pending(), "written to a file the compaction is about to replace");
        old.flush(b"enquanto grava");

        release.send(()).unwrap();
        sb.flush().expect("flush");
        assert!(same_bytes(&path, &old.0), "the .bin is not what the old compaction left");
        drop(sb);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// "Limpar terminal" in the middle of a compaction: the rename that was on
    /// its way must not bring the cleared history back.
    #[test]
    fn clearing_while_a_compaction_writes_leaves_no_old_history_behind() {
        use std::sync::mpsc;
        let path = temp_bin("limpo-no-meio");
        let mut sb = Scrollback::at(path.clone());
        up_to_the_cap(&mut sb, &mut OldDisk::default());

        let (started, parked) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        sb.flush_detaching(move |path: &Path, tail: &[u8]| {
            let _ = started.send(());
            let _ = gate.recv();
            write_compacted(path, tail)
        })
        .expect("flush");
        // Let it go as soon as it is parked: `clear` below has to wait for
        // it whichever of the two gets there first.
        std::thread::spawn(move || {
            if parked.recv_timeout(std::time::Duration::from_secs(10)).is_ok() {
                let _ = release.send(());
            }
        });
        sb.clear();
        assert!(!path.exists(), "the compaction brought the cleared history back");
        sb.push(b"novo");
        sb.flush().expect("flush");
        assert_eq!(std::fs::read(&path).unwrap(), b"novo");
        drop(sb);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// "Limpar terminal": the file goes, and what comes after starts a new one.
    #[test]
    fn a_cleared_scrollback_starts_its_bin_over() {
        let path = temp_bin("limpo");
        let mut sb = Scrollback::at(path.clone());
        sb.push(b"velho");
        sb.flush().expect("flush");
        sb.clear();
        assert!(!path.exists(), "the old history is still on disk");
        sb.push(b"novo");
        sb.flush().expect("flush");
        assert_eq!(std::fs::read(&path).unwrap(), b"novo");
        assert_eq!(sb.snapshot(), "novo");
        drop(sb);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The export reads the raw ring when the disk has nothing: a wrapped ring
    /// comes back whole and in order.
    #[test]
    fn the_raw_bytes_of_a_wrapped_ring_come_back_in_order() {
        let content: Vec<u8> = (0u8..=255).chain(0u8..40).collect();
        let sb = wrapped(&content);
        assert_eq!(sb.bytes(), content);
    }
}
