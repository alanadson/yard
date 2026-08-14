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

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

/// Cap of the in-memory ring and of the tail kept on compaction.
pub const RING_CAP: usize = 4 * 1024 * 1024;
/// When the file exceeds this (2x the ring), compact to the `RING_CAP` tail.
pub const FILE_CAP: u64 = 8 * 1024 * 1024;

pub struct Scrollback {
    path: PathBuf,
    ring: VecDeque<u8>,
    pending: Vec<u8>,
    file_len: u64,
}

impl Scrollback {
    /// Opens the scrollback of a PTY. If a `.bin` already exists on disk, its
    /// tail is loaded into the ring — that is what makes a resumed terminal
    /// appear with the previous session's history above.
    pub fn open(id: &str) -> Self {
        let path = crate::paths::scrollback_file(id);
        let (ring, file_len) = match read_tail(&path, RING_CAP) {
            Ok((bytes, len)) => (VecDeque::from(bytes), len),
            Err(_) => (VecDeque::new(), 0),
        };
        Self {
            path,
            ring,
            pending: Vec::new(),
            file_len,
        }
    }

    /// Creates an empty scrollback, deleting whatever is on disk. Used when
    /// spawning a new terminal (a new id never collides, but restart reuses the id).
    pub fn fresh(id: &str) -> Self {
        let path = crate::paths::scrollback_file(id);
        let _ = std::fs::remove_file(&path);
        Self {
            path,
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        self.ring.extend(bytes.iter().copied());
        self.trim_ring();
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
    pub fn flush(&mut self) -> std::io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        f.write_all(&self.pending)?;
        self.file_len += self.pending.len() as u64;
        self.pending.clear();

        if self.file_len > FILE_CAP {
            self.compact()?;
        }
        Ok(())
    }

    /// Rewrites the file with only the `RING_CAP`-byte tail, via tmp+rename
    /// so a `.bin` is never left truncated if the process dies mid-way.
    fn compact(&mut self) -> std::io::Result<()> {
        let (tail, _) = read_tail(&self.path, RING_CAP)?;
        let tmp = self.path.with_extension("bin.tmp");
        {
            let mut f = File::create(&tmp)?;
            f.write_all(&tail)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        self.file_len = tail.len() as u64;
        tracing::debug!(path = %self.path.display(), len = self.file_len, "scrollback compactado");
        Ok(())
    }

    /// What `attach_pty` returns for the UI to repaint.
    pub fn snapshot(&self) -> String {
        let (a, b) = self.ring.as_slices();
        let mut buf = Vec::with_capacity(a.len() + b.len());
        buf.extend_from_slice(a);
        buf.extend_from_slice(b);
        String::from_utf8_lossy(&buf).into_owned()
    }

    pub fn len(&self) -> usize {
        self.ring.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ring.is_empty()
    }

    /// Clears memory and disk (explicit user action: "clear terminal").
    pub fn clear(&mut self) {
        self.ring.clear();
        self.pending.clear();
        self.file_len = 0;
        let _ = std::fs::remove_file(&self.path);
    }

    /// Removes the `.bin` from disk — used when the terminal is deleted for good.
    pub fn delete_file(id: &str) {
        let _ = std::fs::remove_file(crate::paths::scrollback_file(id));
    }

    /// Reads the tail of the `.bin` without needing a live `Scrollback`. This is
    /// the path used to show the history of a dead/suspended terminal.
    pub fn read_from_disk(id: &str) -> String {
        let path = crate::paths::scrollback_file(id);
        match read_tail(&path, RING_CAP) {
            Ok((bytes, _)) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => String::new(),
        }
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
    fn ring_respeita_teto_e_fronteira_utf8() {
        let mut sb = Scrollback {
            path: PathBuf::from("nao-existe.bin"),
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
        };
        // "ç" is 2 bytes; pushing well past the cap forces a discard.
        let blob = "ç".repeat(RING_CAP);
        sb.push(blob.as_bytes());
        assert!(sb.ring.len() <= RING_CAP);
        // If the cut respected the boundary, no U+FFFD in the snapshot.
        assert!(!sb.snapshot().contains('\u{FFFD}'));
    }

    #[test]
    fn pending_zera_no_flush_e_ring_nao() {
        let dir = std::env::temp_dir().join("yard-test-sb");
        std::fs::create_dir_all(&dir).unwrap();
        let mut sb = Scrollback {
            path: dir.join("t.bin"),
            ring: VecDeque::new(),
            pending: Vec::new(),
            file_len: 0,
        };
        sb.push(b"ola mundo");
        assert_eq!(sb.pending.len(), 9);
        sb.flush().unwrap();
        assert_eq!(sb.pending.len(), 0);
        assert_eq!(sb.snapshot(), "ola mundo");
        assert_eq!(sb.file_len, 9);
        let _ = std::fs::remove_file(sb.path.clone());
    }
}
