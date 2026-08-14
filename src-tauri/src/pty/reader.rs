//! PTY reading and coalesced emission to the UI (§5.3).
//!
//! There are two threads per PTY, and the split is deliberate:
//!
//! - **reader** stays blocked on `read()`. It only does the minimum: stitch the
//!   UTF-8 boundary, push into the scrollback and the emit buffer.
//! - **pump** wakes on a timer and decides *when* to talk to the UI.
//!
//! If it were a single thread, the blocked `read()` would hold the timers:
//! an agent stuck on a spinner would never trigger the disk flush or the
//! activity heartbeat. And emitting one IPC event per `read()` floods the
//! WebView main thread — hence the coalescing.

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::emit::PtyEvents;
use super::scrollback::Scrollback;
use crate::events;

/// Emit interval while the panel is visible.
const COALESCE_MS: u64 = 16;
/// Interval while the panel is hidden: does not flood the WebView, but keeps
/// the "agent finished" detector (idle ~4.5 s) at sufficient resolution.
const HIDDEN_MS: u64 = 450;
/// If this much accumulates before the tick, emit immediately.
const COALESCE_BYTES: usize = 32 * 1024;
/// Cap per IPC payload: a single 4 MB string chokes the JSON bridge.
const MAX_EMIT_CHUNK: usize = 256 * 1024;
/// Cap of the emit buffer. `type huge_file.txt` must not become
/// memory pressure — the scrollback (4 MB) remains the source of truth.
const EMIT_BUF_CAP: usize = 2 * 1024 * 1024;
/// Period of the scrollback flush to disk.
const FLUSH_MS: u64 = 250;
/// Period of the `pty://activity` heartbeat.
const ACTIVITY_MS: u64 = 450;
/// Silence that means "the agent finished responding" (§5.7).
const IDLE_THRESHOLD_MS: u64 = 4_500;

/// State shared by reader and pump.
pub struct PtyShared {
    /// Bytes ready to go to the UI (already validated as UTF-8).
    pub emit_buf: Mutex<Vec<u8>>,
    /// Bytes discarded by `emit_buf` overflow — the UI is notified.
    pub dropped: AtomicU64,
    /// Epoch ms of the last byte read.
    pub last_byte_at: AtomicI64,
    /// Total bytes already read (used only for telemetry/state).
    pub total_bytes: AtomicU64,
    /// The UI reports whether the panel is on screen.
    pub visible: AtomicBool,
    /// Is the reader still alive?
    pub reading: AtomicBool,
    /// Signals the pump to stop after draining.
    pub stopping: AtomicBool,
    /// Have we already notified idle for this activity cycle?
    pub idle_notified: AtomicBool,
    /// `true` when the terminal is an agent (enables the idle detector).
    pub is_agent: AtomicBool,
}

impl PtyShared {
    pub fn new(is_agent: bool) -> Arc<Self> {
        Arc::new(Self {
            emit_buf: Mutex::new(Vec::with_capacity(8 * 1024)),
            dropped: AtomicU64::new(0),
            last_byte_at: AtomicI64::new(now_ms()),
            total_bytes: AtomicU64::new(0),
            visible: AtomicBool::new(true),
            reading: AtomicBool::new(true),
            stopping: AtomicBool::new(false),
            idle_notified: AtomicBool::new(true), // only arms after real activity
            is_agent: AtomicBool::new(is_agent),
        })
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// How many leading bytes of `b` are valid UTF-8. The rest is the tail of a
/// multibyte character split by `read()` — without holding that tail for the
/// next read, the UI fills with `?` in the middle of accents and emojis (§5.3).
pub fn valid_utf8_prefix_len(b: &[u8]) -> usize {
    match std::str::from_utf8(b) {
        Ok(s) => s.len(),
        Err(e) => e.valid_up_to(),
    }
}

/// Reader thread. Exits when the PTY gives EOF (which only happens because
/// the `slave` was dropped right after spawn).
pub fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    shared: Arc<PtyShared>,
    scrollback: Arc<Mutex<Scrollback>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::new();

        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    tracing::debug!(error = %e, "leitura do pty terminou");
                    break;
                }
            };

            carry.extend_from_slice(&buf[..n]);
            let valid = valid_utf8_prefix_len(&carry);
            if valid == 0 {
                // Entire chunk is a split tail (rare, at most 3 bytes).
                // Sanity guard: if the tail grows, the stream is not UTF-8;
                // emit as lossy so the terminal does not hang.
                if carry.len() > 4 {
                    let text = String::from_utf8_lossy(&carry).into_owned();
                    carry.clear();
                    absorb(&shared, &scrollback, text.as_bytes());
                }
                continue;
            }

            let chunk: Vec<u8> = carry.drain(..valid).collect();
            absorb(&shared, &scrollback, &chunk);
        }

        shared.reading.store(false, Ordering::Release);
    });
}

/// Pushes bytes into the scrollback and the emit buffer.
fn absorb(shared: &Arc<PtyShared>, scrollback: &Arc<Mutex<Scrollback>>, bytes: &[u8]) {
    scrollback.lock().push(bytes);

    {
        let mut out = shared.emit_buf.lock();
        out.extend_from_slice(bytes);
        if out.len() > EMIT_BUF_CAP {
            let excess = out.len() - EMIT_BUF_CAP;
            out.drain(..excess);
            // Do not let the buffer start in the middle of a character.
            let cut = out
                .iter()
                .position(|b| b & 0b1100_0000 != 0b1000_0000)
                .unwrap_or(0);
            out.drain(..cut);
            shared
                .dropped
                .fetch_add((excess + cut) as u64, Ordering::Relaxed);
        }
    }

    shared
        .total_bytes
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    shared.last_byte_at.store(now_ms(), Ordering::Release);
    shared.idle_notified.store(false, Ordering::Release);
}

/// Pump thread: coalesces output, flushes scrollback, heartbeats activity and
/// detects the end of the agent's response.
pub fn spawn_pump(
    sink: Arc<dyn PtyEvents>,
    id: String,
    title: String,
    shared: Arc<PtyShared>,
    scrollback: Arc<Mutex<Scrollback>>,
) {
    std::thread::spawn(move || {
        let mut last_emit = Instant::now();
        let mut last_flush = Instant::now();
        let mut last_activity = Instant::now();

        loop {
            let visible = shared.visible.load(Ordering::Acquire);
            let period = if visible { COALESCE_MS } else { HIDDEN_MS };
            std::thread::sleep(Duration::from_millis(period.min(COALESCE_MS.max(8))));

            let finished = !shared.reading.load(Ordering::Acquire);
            let pending_len = shared.emit_buf.lock().len();
            let due = last_emit.elapsed() >= Duration::from_millis(period)
                || pending_len >= COALESCE_BYTES
                || (finished && pending_len > 0);

            if due && pending_len > 0 {
                let payload = {
                    let mut out = shared.emit_buf.lock();
                    std::mem::take(&mut *out)
                };
                let dropped = shared.dropped.swap(0, Ordering::Relaxed);
                if dropped > 0 {
                    sink.output(
                        &id,
                        format!(
                            "\r\n\x1b[33m[yard: {} KB de saida omitidos — fluxo rapido demais para exibir; scrollback preservado]\x1b[0m\r\n",
                            dropped / 1024
                        ),
                    );
                }
                emit_in_chunks(sink.as_ref(), &id, &payload);
                last_emit = Instant::now();
            }

            if last_flush.elapsed() >= Duration::from_millis(FLUSH_MS) {
                if let Err(e) = scrollback.lock().flush() {
                    tracing::warn!(id = %id, error = %e, "falha ao gravar scrollback");
                }
                last_flush = Instant::now();
            }

            if last_activity.elapsed() >= Duration::from_millis(ACTIVITY_MS) {
                let last = shared.last_byte_at.load(Ordering::Acquire);
                let idle_ms = (now_ms() - last).max(0) as u64;
                sink.activity(events::ActivityPayload {
                    id: id.clone(),
                    last_byte_at: last,
                    idle_ms,
                });

                // "Agent finished" detector (§5.7): prolonged silence
                // *after* real activity. Fires once per cycle.
                if shared.is_agent.load(Ordering::Acquire)
                    && idle_ms >= IDLE_THRESHOLD_MS
                    && !shared.idle_notified.swap(true, Ordering::AcqRel)
                {
                    sink.idle(events::IdlePayload {
                        id: id.clone(),
                        title: title.clone(),
                        idle_ms,
                    });
                }
                last_activity = Instant::now();
            }

            if finished && shared.emit_buf.lock().is_empty() {
                let _ = scrollback.lock().flush();
                break;
            }
            if shared.stopping.load(Ordering::Acquire) {
                let _ = scrollback.lock().flush();
                break;
            }
        }
    });
}

/// Slices large payloads: each `emit` becomes a JSON string, and a 4 MB one
/// chokes the bridge. Cuts respect the UTF-8 boundary.
fn emit_in_chunks(sink: &dyn PtyEvents, id: &str, payload: &[u8]) {
    let mut start = 0usize;
    while start < payload.len() {
        let mut end = (start + MAX_EMIT_CHUNK).min(payload.len());
        if end < payload.len() {
            while end > start && payload[end] & 0b1100_0000 == 0b1000_0000 {
                end -= 1;
            }
            if end == start {
                end = (start + MAX_EMIT_CHUNK).min(payload.len());
            }
        }
        sink.output(id, String::from_utf8_lossy(&payload[start..end]).into_owned());
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixo_utf8_para_no_corte() {
        // "á" = C3 A1. Cut in the middle, only what came before is valid.
        let bytes = [b'a', 0xC3];
        assert_eq!(valid_utf8_prefix_len(&bytes), 1);
        let completo = "aá".as_bytes();
        assert_eq!(valid_utf8_prefix_len(completo), completo.len());
    }
}
