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
//!
//! The pump's timers are armed only while they have work: a frame waiting to
//! be painted, bytes the disk has not seen, a heartbeat with something new to
//! say, an agent's silence still being timed. A terminal with none of that
//! (a shell at its prompt, an agent that already reported "finished") sleeps
//! until a byte, the UI or the end of the process wakes it, instead of waking
//! six times a second to find nothing to do.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

use super::emit::PtyEvents;
use super::scrollback::{into_text, Scrollback};
use crate::events;

/// Emit interval while the panel is visible.
const COALESCE_MS: u64 = 16;
/// Interval while the panel is hidden: does not flood the WebView, but keeps
/// the "agent finished" detector (idle ~4.5 s) at sufficient resolution.
const HIDDEN_MS: u64 = 450;
/// If this much accumulates before the tick, emit immediately.
const COALESCE_BYTES: usize = 32 * 1024;
/// Cap per message to the page. Set for the JSON event bus, where a single
/// 4 MB string choked the bridge; on the page channel (`pages.rs`) it keeps
/// the pieces every listener reads (xterm's writes, the address scanner, the
/// prompt tail) exactly what they always were.
const MAX_EMIT_CHUNK: usize = 256 * 1024;
/// Cap of the emit buffer. `type huge_file.txt` must not become
/// memory pressure — the scrollback (4 MB) remains the source of truth.
const EMIT_BUF_CAP: usize = 2 * 1024 * 1024;
/// What an empty emit buffer starts with: a frame of ordinary output fits
/// without growing it.
const EMIT_START: usize = 8 * 1024;
/// Chunks a page may owe an acknowledgement for before the pump holds its
/// output back (in the emit buffer, which drops the oldest past its cap with
/// a notice). Tauri queues every chunk sent until the page's JS fetches it,
/// with no bound of its own: a page stalled under an agent printing 20 MB/s
/// used to park the whole stall's worth of output in the bridge. Eight
/// chunks of `MAX_EMIT_CHUNK` is 2 MB in flight at most, per terminal.
pub const INFLIGHT_CAP: u32 = 8;
/// How long an owed acknowledgement is waited for before being written off:
/// a page reloaded with chunks on their way never answers for them, and a
/// terminal must not go silent for that.
const ACK_GRACE_MS: u64 = 3_000;
/// Period of the scrollback flush to disk.
const FLUSH_MS: u64 = 250;
/// Period of the `activity` heartbeat.
const ACTIVITY_MS: u64 = 450;
/// Silence that means "the agent finished responding" (§5.7).
const IDLE_THRESHOLD_MS: u64 = 4_500;
/// Idle time under which a heartbeat still means "writing right now": the
/// second `ptyWatch.ts` (`WRITING_MS`) reads as "bytes arrived between two
/// beats" to clear a stale "blocked". The front end acts on every beat inside
/// it, so those keep going out even when the last byte did not move.
const WRITING_MS: u64 = 1_000;

/// State shared by reader and pump.
pub struct PtyShared {
    wake: Condvar,
    /// Bytes ready to go to the UI (already validated as UTF-8). A ring, not
    /// a `Vec`: at the cap every read drops as much from the front as it
    /// adds at the back, and dropping from a ring costs what is dropped,
    /// where the `Vec` moved the whole 2 MB left behind on every read.
    pub emit_buf: Mutex<VecDeque<u8>>,
    /// Bytes discarded by `emit_buf` overflow — the UI is notified.
    pub dropped: AtomicU64,
    /// Epoch ms of the last byte read.
    pub last_byte_at: AtomicI64,
    /// Total bytes already read (used only for telemetry/state).
    pub total_bytes: AtomicU64,
    /// The UI reports whether the panel is on screen.
    pub visible: AtomicBool,
    /// Whether the main window is on screen: one flag for the whole app
    /// (`AppState::window_shown`), read by every pump. See `emit_period`.
    window_shown: Arc<AtomicBool>,
    /// Is the reader still alive?
    pub reading: AtomicBool,
    /// Bytes went into the scrollback that the pump has not flushed yet. The
    /// flush tick is armed only while this is up: a quiet terminal has nothing
    /// to write down and no reason to wake four times a second.
    pub unflushed: AtomicBool,
    /// Signals the pump to stop after draining.
    pub stopping: AtomicBool,
    /// Have we already notified idle for this activity cycle?
    pub idle_notified: AtomicBool,
    /// `true` when the terminal is an agent (enables the idle detector).
    pub is_agent: AtomicBool,
    /// `true` while the application is painting on the **alternate screen**
    /// (`\e[?1049h`). See `scan_screen_mode`.
    pub alt_screen: AtomicBool,
    /// Chunks a page took (`PtyEvents::output` said so) and has not
    /// acknowledged yet (`ack`). At `INFLIGHT_CAP` the pump holds its output.
    pub inflight: AtomicU32,
    /// `ACK_GRACE_MS`, as a field so a test does not have to wait three seconds.
    pub ack_grace_ms: AtomicU64,
    /// How many times the pump came out of its wait: what an idle terminal
    /// costs the CPU, which only a test can see.
    #[cfg(test)]
    pub pump_wakes: AtomicU64,
}

impl PtyShared {
    /// A terminal of its own, in a window that is always on screen.
    pub fn new(is_agent: bool) -> Arc<Self> {
        Self::with_window(is_agent, Arc::new(AtomicBool::new(true)))
    }

    /// A terminal of the app whose main window is `window_shown`.
    pub fn with_window(is_agent: bool, window_shown: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            wake: Condvar::new(),
            emit_buf: Mutex::new(VecDeque::with_capacity(EMIT_START)),
            dropped: AtomicU64::new(0),
            last_byte_at: AtomicI64::new(now_ms()),
            total_bytes: AtomicU64::new(0),
            visible: AtomicBool::new(true),
            window_shown,
            reading: AtomicBool::new(true),
            unflushed: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            idle_notified: AtomicBool::new(true), // only arms after real activity
            is_agent: AtomicBool::new(is_agent),
            alt_screen: AtomicBool::new(false),
            inflight: AtomicU32::new(0),
            ack_grace_ms: AtomicU64::new(ACK_GRACE_MS),
            #[cfg(test)]
            pump_wakes: AtomicU64::new(0),
        })
    }

    /// The page drained `chunks` more chunks of this terminal's output: the
    /// pump may send that many again. More acknowledgements than chunks (a
    /// module reloaded in place holds two links, and both answer) only
    /// bring the count to zero.
    pub fn ack(&self, chunks: u32) {
        let _ = self
            .inflight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |owed| Some(owed.saturating_sub(chunks)));
        self.wake_pump();
    }

    /// The pace this terminal's output goes out at right now: its pane and
    /// the window both decide (`emit_period`).
    pub(crate) fn emit_period(&self) -> Duration {
        emit_period(
            self.visible.load(Ordering::Acquire),
            self.window_shown.load(Ordering::Acquire),
        )
    }

    /// Synchronize notifications with the pump's decision to wait.
    pub fn wake_pump(&self) {
        let _guard = self.emit_buf.lock();
        self.wake.notify_one();
    }
}

/// How often the pump sends output. The pane only knows it is placed on the
/// canvas; whether anyone can see it also depends on the window, which may be
/// hidden to the tray (the page calls `hide()`, and nothing tells the pane) or
/// minimized. Either one off the screen means the hidden pace.
fn emit_period(pane_visible: bool, window_shown: bool) -> Duration {
    if pane_visible && window_shown {
        Duration::from_millis(COALESCE_MS)
    } else {
        Duration::from_millis(HIDDEN_MS)
    }
}

/// How long the pump may sleep: until the nearest deadline that is armed.
/// `period` is the emit pace (`emit_period`); `since_flush` / `since_activity` are `None` when that tick has nothing to
/// do, and `None` back means nothing at all is armed: sleep until woken (a
/// byte, the UI, the end of the process all notify the pump).
fn pump_wait(
    period: Duration,
    pending: usize,
    since_emit: Duration,
    since_flush: Option<Duration>,
    since_activity: Option<Duration>,
) -> Option<Duration> {
    if pending >= COALESCE_BYTES {
        return Some(Duration::ZERO);
    }
    let flush = since_flush.map(|s| Duration::from_millis(FLUSH_MS).saturating_sub(s));
    let activity = since_activity.map(|s| Duration::from_millis(ACTIVITY_MS).saturating_sub(s));
    let emit = (pending > 0).then(|| period.saturating_sub(since_emit));
    [flush, activity, emit].into_iter().flatten().min()
}

/// Whether this tick's heartbeat has anything to say (see `WRITING_MS`):
/// a last byte the front end has not been told about, or "still writing".
/// `last_sent` is the `last_byte_at` of the last beat that went out.
fn heartbeat_due(last_sent: Option<i64>, last_byte_at: i64, idle_ms: u64) -> bool {
    last_sent != Some(last_byte_at) || idle_ms < WRITING_MS
}

/// The latest tick of a `period` grid that started at `anchor`, as of `now`.
///
/// A tick nobody waits on (nothing to flush, nothing to report) is not polled
/// at all; when it is armed again it resumes here, on the phase it would have
/// had if it had kept ticking. So a byte after a long silence is flushed and
/// reported as late as it always was (anywhere within one period), with no
/// new phase and no tick fired early just because the pump slept.
fn grid_floor(anchor: Instant, period: Duration, now: Instant) -> Instant {
    let ticks = now.saturating_duration_since(anchor).as_nanos() / period.as_nanos();
    anchor + Duration::from_nanos((ticks * period.as_nanos()) as u64)
}

/// `(last_byte_at, idle_ms)` right now: what a heartbeat carries.
pub fn activity_now(shared: &PtyShared) -> (i64, u64) {
    let last = shared.last_byte_at.load(Ordering::Acquire);
    (last, (now_ms() - last).max(0) as u64)
}

/// Does the activity tick have work at its next beat? A heartbeat with
/// something to say, or an agent whose "finished" detector is still waiting
/// for the silence to reach `IDLE_THRESHOLD_MS` (it fires once per cycle and
/// disarms itself until the next byte).
/// Whether the page owes enough acknowledgements for the pump to hold back.
fn page_owes(shared: &PtyShared) -> bool {
    shared.inflight.load(Ordering::Acquire) >= INFLIGHT_CAP
}

fn ack_grace(shared: &PtyShared) -> Duration {
    Duration::from_millis(shared.ack_grace_ms.load(Ordering::Relaxed))
}

fn activity_armed(shared: &PtyShared, last_sent: Option<i64>) -> bool {
    let (last, idle_ms) = activity_now(shared);
    (shared.is_agent.load(Ordering::Acquire) && !shared.idle_notified.load(Ordering::Acquire))
        || heartbeat_due(last_sent, last, idle_ms)
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

/// Sequences that move the application onto (and off) the alternate screen.
const ALT_ON: [&[u8]; 3] = [b"\x1b[?1049h", b"\x1b[?1047h", b"\x1b[?47h"];
const ALT_OFF: [&[u8]; 3] = [b"\x1b[?1049l", b"\x1b[?1047l", b"\x1b[?47l"];
/// Longest of the sequences above minus one: what has to be carried between
/// two reads so a switch split across `read()` boundaries is still seen.
const ALT_TAIL: usize = 7;

/// Tracks whether the application is on the **alternate screen**.
///
/// This is the difference between a scrollback that can be replayed and one
/// that cannot. A shell writes lines: the byte log *is* the history, and
/// repainting it reproduces the screen. A full-screen CLI (every agent, and
/// anything built on Ink) enters the alternate screen once, at boot, and from
/// then on emits **incremental redraws** — "erase this line, move the cursor
/// there, write these three cells" — each of which only makes sense against
/// the exact frame that preceded it, at the exact size it was drawn for.
/// Replaying that log into a fresh terminal of another size does not rebuild
/// the screen; it paints a handful of surviving fragments over a black pane,
/// which is what "switching from the canvas empties the CLI" was.
///
/// So `attach` reports this, and the UI stops pretending: the real frame is
/// asked of conhost instead (see `repaint`).
///
/// Only the last switch counts (the state is the final one), and a switch that
/// starts in `bytes` is later than any that starts in the carried `tail`. So
/// `bytes` is searched first, backwards from its end, stopping only at `ESC`;
/// the tail is searched only when `bytes` has no switch, joined to the few
/// bytes a switch split across the boundary can reach into. No copy of the
/// chunk and one pass over it, where there used to be a concatenated copy and
/// six scans.
fn scan_screen_mode(tail: &mut Vec<u8>, bytes: &[u8], shared: &PtyShared) {
    let found = last_switch(bytes, bytes.len()).or_else(|| {
        // Never more than `ALT_TAIL` by construction (see below); the cut
        // only keeps a broken invariant from turning into a panic.
        let tail = &tail[tail.len().saturating_sub(ALT_TAIL)..];
        let reach = bytes.len().min(ALT_TAIL);
        let mut seam = [0u8; 2 * ALT_TAIL];
        seam[..tail.len()].copy_from_slice(tail);
        seam[tail.len()..tail.len() + reach].copy_from_slice(&bytes[..reach]);
        last_switch(&seam[..tail.len() + reach], tail.len())
    });
    if let Some(on) = found {
        shared.alt_screen.store(on, Ordering::Release);
    }

    // The last `ALT_TAIL` bytes of tail + bytes.
    if bytes.len() >= ALT_TAIL {
        tail.clear();
        tail.extend_from_slice(&bytes[bytes.len() - ALT_TAIL..]);
    } else {
        tail.extend_from_slice(bytes);
        let excess = tail.len().saturating_sub(ALT_TAIL);
        tail.drain(..excess);
    }
}

/// The last alternate-screen switch that starts before `starts_before` in
/// `hay`: `Some(true)` for on, `Some(false)` for off. At most one sequence
/// can start at a given place (they differ inside), so the first hit walking
/// back is the last one.
fn last_switch(hay: &[u8], starts_before: usize) -> Option<bool> {
    let mut end = starts_before.min(hay.len());
    while let Some(at) = hay[..end].iter().rposition(|&b| b == 0x1b) {
        let rest = &hay[at..];
        // Every switch opens with `ESC [ ?`; nearly every other sequence
        // an agent paints fails right here.
        if rest.starts_with(b"\x1b[?") {
            if ALT_ON.iter().any(|seq| rest.starts_with(seq)) {
                return Some(true);
            }
            if ALT_OFF.iter().any(|seq| rest.starts_with(seq)) {
                return Some(false);
            }
        }
        end = at;
    }
    None
}

/// What one `read()` brought, stitched to the `carry` the previous one left:
/// hands `deliver` the text that can go out now and keeps the tail of a
/// character split by the read boundary for the next call (§5.3).
///
/// Nearly always nothing was carried over, and then the read buffer itself is
/// what goes out: only the split tail (0-3 bytes) is copied, to wait for the
/// next read. With a carry, the two are joined as they always were.
fn stitch(carry: &mut Vec<u8>, fresh: &[u8], mut deliver: impl FnMut(&[u8])) {
    if carry.is_empty() {
        let used = deliver_valid(fresh, &mut deliver);
        carry.extend_from_slice(&fresh[used..]);
    } else {
        carry.extend_from_slice(fresh);
        let used = deliver_valid(carry, &mut deliver);
        carry.drain(..used);
    }
}

/// Delivers what of `bytes` can go out now and says how many bytes that used.
fn deliver_valid(bytes: &[u8], deliver: &mut impl FnMut(&[u8])) -> usize {
    let valid = valid_utf8_prefix_len(bytes);
    if valid > 0 {
        deliver(&bytes[..valid]);
        valid
    } else if bytes.len() > 4 {
        // Nothing valid up front and more than a split character's worth:
        // the stream is not UTF-8 here. Emit it lossy so the terminal does
        // not hang waiting for a character that will never complete.
        deliver(String::from_utf8_lossy(bytes).as_bytes());
        bytes.len()
    } else {
        // At most a split character: wait for the rest.
        0
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
        // Carried between reads so `\e[?1049h` split by a `read()` boundary is
        // still recognized.
        let mut mode_tail: Vec<u8> = Vec::new();

        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    tracing::debug!(error = %e, "leitura do pty terminou");
                    break;
                }
            };

            stitch(&mut carry, &buf[..n], |chunk| {
                scan_screen_mode(&mut mode_tail, chunk, &shared);
                absorb(&shared, &scrollback, chunk);
            });
        }

        shared.reading.store(false, Ordering::Release);
        shared.wake_pump();
    });
}

/// Pushes bytes into the scrollback and the emit buffer.
fn absorb(shared: &Arc<PtyShared>, scrollback: &Arc<Mutex<Scrollback>>, bytes: &[u8]) {
    scrollback.lock().push(bytes);
    // Raised after the push, so whatever the pump's flush misses is flagged.
    // The first byte the disk has not seen wakes the pump: its flush tick was
    // not armed, and it must arm now, not whenever it next happens to wake.
    let arms_flush = !shared.unflushed.swap(true, Ordering::AcqRel);

    let wake = {
        let mut out = shared.emit_buf.lock();
        let previous = out.len();
        out.extend(bytes);
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
        previous == 0 || (previous < COALESCE_BYTES && out.len() >= COALESCE_BYTES)
    };

    shared
        .total_bytes
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    shared.last_byte_at.store(now_ms(), Ordering::Release);
    shared.idle_notified.store(false, Ordering::Release);
    if wake || arms_flush {
        shared.wake_pump();
    }
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
        let flush_period = Duration::from_millis(FLUSH_MS);
        let activity_period = Duration::from_millis(ACTIVITY_MS);
        let mut last_emit = Instant::now();
        let mut last_flush = Instant::now();
        let mut last_activity = Instant::now();
        // `last_byte_at` of the last heartbeat that went out (`heartbeat_due`).
        let mut last_sent: Option<i64> = None;
        // When the last chunk a page took went out: what the grace on its
        // acknowledgement counts from.
        let mut last_taken = Instant::now();

        loop {
            // Decided under the lock `wake_pump` takes, so a byte landing
            // between the decision and the wait still wakes it.
            let (flush_was_armed, activity_was_armed) = {
                let mut pending = shared.emit_buf.lock();
                let flush_armed = shared.unflushed.load(Ordering::Acquire);
                let activity_armed = activity_armed(&shared, last_sent);
                // Output owed acknowledgements has no frame to wait for: it
                // goes out when the page answers (`ack` wakes the pump) or
                // when the grace on that answer runs out.
                let owed = page_owes(&shared);
                let wait = pump_wait(
                    shared.emit_period(),
                    if owed { 0 } else { pending.len() },
                    last_emit.elapsed(),
                    flush_armed.then(|| last_flush.elapsed()),
                    activity_armed.then(|| last_activity.elapsed()),
                );
                let wait = if owed && !pending.is_empty() {
                    let grace = ack_grace(&shared).saturating_sub(last_taken.elapsed());
                    Some(wait.map_or(grace, |w| w.min(grace)))
                } else {
                    wait
                };
                if shared.reading.load(Ordering::Acquire) && !shared.stopping.load(Ordering::Acquire) {
                    match wait {
                        Some(wait) if wait.is_zero() => {}
                        Some(wait) => {
                            shared.wake.wait_for(&mut pending, wait);
                        }
                        None => shared.wake.wait(&mut pending),
                    }
                }
                (flush_armed, activity_armed)
            };
            #[cfg(test)]
            shared.pump_wakes.fetch_add(1, Ordering::Relaxed);
            // A tick that nobody waited on resumes on its old phase.
            let now = Instant::now();
            if !flush_was_armed {
                last_flush = grid_floor(last_flush, flush_period, now);
            }
            if !activity_was_armed {
                last_activity = grid_floor(last_activity, activity_period, now);
            }
            let period = shared.emit_period();

            let finished = !shared.reading.load(Ordering::Acquire);
            let pending_len = shared.emit_buf.lock().len();
            let due = last_emit.elapsed() >= period
                || pending_len >= COALESCE_BYTES
                || (finished && pending_len > 0);

            // A page that has not answered for a whole grace is not going
            // to (reloaded, or gone from this terminal): its debt is written
            // off, so the terminal does not stay silent for it.
            if page_owes(&shared) && last_taken.elapsed() >= ack_grace(&shared) {
                shared.inflight.store(0, Ordering::Release);
            }

            if due && pending_len > 0 && !page_owes(&shared) {
                // The full buffer leaves to become the event's text
                // (`emit_in_chunks`); the one left in its place is already
                // sized for a frame, so the next bytes do not regrow it from
                // nothing. Allocated before the lock the reader needs, and
                // made one contiguous `Vec` after it is released: that is
                // free unless the cap trimmed its front, and then it is one
                // move per emit, not one per read.
                let fresh = VecDeque::with_capacity(EMIT_START);
                let payload = Vec::from(std::mem::replace(&mut *shared.emit_buf.lock(), fresh));
                let dropped = shared.dropped.swap(0, Ordering::Relaxed);
                let mut taken = 0u32;
                if dropped > 0 {
                    taken += u32::from(sink.output(
                        &id,
                        format!(
                            "\r\n\x1b[33m[yard: {} KB de saida omitidos — fluxo rapido demais para exibir; scrollback preservado]\x1b[0m\r\n",
                            dropped / 1024
                        ),
                    ));
                }
                taken += emit_in_chunks(sink.as_ref(), &id, payload);
                if taken > 0 {
                    shared.inflight.fetch_add(taken, Ordering::AcqRel);
                    last_taken = Instant::now();
                }
                last_emit = Instant::now();
            }

            if shared.unflushed.load(Ordering::Acquire) && last_flush.elapsed() >= flush_period {
                // Lowered before the flush: a byte pushed while it runs raises
                // it again and gets the next tick.
                shared.unflushed.store(false, Ordering::Release);
                let left = {
                    let mut sb = scrollback.lock();
                    if let Err(e) = sb.flush_in_background() {
                        tracing::warn!(id = %id, error = %e, "falha ao gravar scrollback");
                    }
                    sb.has_pending()
                };
                // A failed write, or a compaction still writing the new file,
                // keeps the bytes pending: retried next tick.
                if left {
                    shared.unflushed.store(true, Ordering::Release);
                }
                last_flush = Instant::now();
            }

            if last_activity.elapsed() >= activity_period {
                let (last, idle_ms) = activity_now(&shared);
                if heartbeat_due(last_sent, last, idle_ms) {
                    sink.activity(events::ActivityPayload {
                        id: id.clone(),
                        last_byte_at: last,
                        idle_ms,
                    });
                    last_sent = Some(last);
                }

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
                let _ = scrollback.lock().flush_and_close();
                break;
            }
            if shared.stopping.load(Ordering::Acquire) {
                let _ = scrollback.lock().flush_and_close();
                break;
            }
        }
    });
}

/// Slices large payloads (see `MAX_EMIT_CHUNK`). Cuts respect the UTF-8
/// boundary, so every piece is whole characters: the page decodes each one on
/// its own, with no state carried from the piece before (`ptyStream.ts`).
///
/// The text is exactly `String::from_utf8_lossy` of each slice. A payload that
/// fits in one message (nearly all of them) becomes that message's `String` in
/// place: the buffer was filled for this, and copying it once more into a new
/// string only to drop it was the one copy on this path that bought nothing.
///
/// Returns how many pieces a page took (see `PtyEvents::output`).
fn emit_in_chunks(sink: &dyn PtyEvents, id: &str, payload: Vec<u8>) -> u32 {
    if payload.len() <= MAX_EMIT_CHUNK {
        if payload.is_empty() {
            return 0;
        }
        return u32::from(sink.output(id, into_text(payload)));
    }
    let mut taken = 0u32;
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
        taken += u32::from(sink.output(id, into_text(payload[start..end].to_vec())));
        start = end;
    }
    taken
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pane is what the page reports; the window is what the OS shows. A
    /// pane "on screen" inside a window hidden to the tray or minimized is on
    /// nobody's screen, and painting it 60 times a second only floods the
    /// WebView nobody is looking at.
    #[test]
    fn output_is_paced_for_the_screen_only_when_both_the_pane_and_the_window_are_on_it() {
        assert_eq!(emit_period(true, true), Duration::from_millis(COALESCE_MS));
        for (pane, window) in [(true, false), (false, true), (false, false)] {
            assert_eq!(
                emit_period(pane, window),
                Duration::from_millis(HIDDEN_MS),
                "pane {pane}, window {window}"
            );
        }
    }

    /// The pace the pump sends at, as it used to be spelled here: `true` for a
    /// pane on screen, `false` for a hidden one.
    fn pace(on_screen: bool) -> Duration {
        emit_period(on_screen, true)
    }

    // Hidden idle terminals still need persistence and activity, but no frame polling.
    #[test]
    fn hidden_pump_waits_for_the_next_required_deadline() {
        assert_eq!(
            pump_wait(
                pace(false),
                0,
                Duration::ZERO,
                Some(Duration::from_millis(100)),
                Some(Duration::from_millis(100))
            ),
            Some(Duration::from_millis(150)),
        );
        assert_eq!(
            pump_wait(
                pace(false),
                0,
                Duration::ZERO,
                Some(Duration::ZERO),
                Some(Duration::from_millis(440))
            ),
            Some(Duration::from_millis(10)),
        );
    }

    /// Nothing to write down, nothing to report, nothing to paint: the pump
    /// sleeps until a byte (or the UI) wakes it, instead of polling a clock
    /// for a terminal nobody is using.
    #[test]
    fn a_pump_with_nothing_armed_sleeps_until_woken() {
        for visible in [true, false] {
            assert_eq!(pump_wait(pace(visible), 0, Duration::from_secs(9), None, None), None);
        }
        // Output waiting for its frame still gets it, alone.
        assert_eq!(
            pump_wait(pace(true), 10, Duration::from_millis(5), None, None),
            Some(Duration::from_millis(11)),
        );
        assert_eq!(
            pump_wait(pace(false), 10, Duration::from_millis(50), None, None),
            Some(Duration::from_millis(400)),
        );
        // A full frame goes out now, whatever else is armed.
        assert_eq!(
            pump_wait(pace(false), COALESCE_BYTES, Duration::ZERO, None, None),
            Some(Duration::ZERO),
        );
    }

    /// A heartbeat tells the front end two things: when the last byte landed,
    /// and whether the process is writing right now (`ptyWatch.ts` reads
    /// `idleMs` under a second as "writing" and clears a stale "blocked"). A
    /// beat that says neither changes nothing anyone reads.
    #[test]
    fn a_heartbeat_goes_out_only_when_it_has_something_to_say() {
        // The first one always goes: nothing has been said yet.
        assert!(heartbeat_due(None, 1_000, 60_000));
        // A new last byte.
        assert!(heartbeat_due(Some(1_000), 2_000, 60_000));
        // Still inside the "writing" second, even with the same last byte:
        // each of these is a beat the front end acts on today.
        assert!(heartbeat_due(Some(1_000), 1_000, 0));
        assert!(heartbeat_due(Some(1_000), 1_000, WRITING_MS - 1));
        // Nothing new and not writing: silence.
        assert!(!heartbeat_due(Some(1_000), 1_000, WRITING_MS));
        assert!(!heartbeat_due(Some(1_000), 1_000, 3_600_000));
    }

    /// Where a stopped tick grid resumes: on the phase it would have had if it
    /// never stopped, so a heartbeat or a flush lands as late after a byte as
    /// it always did (anywhere within one period), not at a new phase.
    #[test]
    fn a_grid_nobody_waited_on_keeps_its_phase() {
        let anchor = Instant::now();
        let p = Duration::from_millis(450);
        let at = |ms: u64| anchor + Duration::from_millis(ms);
        assert_eq!(grid_floor(anchor, p, at(0)), at(0));
        assert_eq!(grid_floor(anchor, p, at(449)), at(0));
        assert_eq!(grid_floor(anchor, p, at(450)), at(450));
        assert_eq!(grid_floor(anchor, p, at(1_000)), at(900));
        // An hour later, still on the same phase (3 600 000 = 8 000 x 450).
        assert_eq!(grid_floor(anchor, p, at(3_600_100)), at(3_600_000));
        // A clock that is behind the anchor leaves it where it is.
        assert_eq!(grid_floor(at(900), p, at(100)), at(900));
    }

    #[test]
    fn alternate_screen_survives_a_split_read() {
        let shared = PtyShared::new(true);
        let mut tail = Vec::new();
        assert!(!shared.alt_screen.load(Ordering::Acquire));

        // The sequence split across two `read()`s — the case a memoryless scan
        // misses, and the one that decides whether the CLI is repainted or rebuilt.
        scan_screen_mode(&mut tail, b"ola\x1b[?104", &shared);
        assert!(!shared.alt_screen.load(Ordering::Acquire));
        scan_screen_mode(&mut tail, b"9h\x1b[2J", &shared);
        assert!(shared.alt_screen.load(Ordering::Acquire));

        // Plain text does not touch the state.
        scan_screen_mode(&mut tail, b"linha\r\n", &shared);
        assert!(shared.alt_screen.load(Ordering::Acquire));

        // The last one in the block wins, not the first.
        scan_screen_mode(&mut tail, b"\x1b[?1049l meio \x1b[?1049h", &shared);
        assert!(shared.alt_screen.load(Ordering::Acquire));
        scan_screen_mode(&mut tail, b"\x1b[?1049h meio \x1b[?1049l", &shared);
        assert!(!shared.alt_screen.load(Ordering::Acquire));
    }

    // -- the byte path, against the code it replaced ------------------------
    //
    // What leaves the reader (the scrollback, the UI, the alternate-screen
    // flag) must not change by one byte or one read when the copies go. Each
    // reference below is the previous code, verbatim, and every test feeds it
    // and the real one the same streams cut at every place a `read()` can cut.

    /// `stitch` as it was: the whole read copied into `carry`, then the
    /// valid prefix collected into a new buffer.
    fn stitch_by_copy(carry: &mut Vec<u8>, fresh: &[u8]) -> Option<Vec<u8>> {
        carry.extend_from_slice(fresh);
        let valid = valid_utf8_prefix_len(carry);
        if valid == 0 {
            if carry.len() > 4 {
                let text = String::from_utf8_lossy(carry).into_owned();
                carry.clear();
                return Some(text.into_bytes());
            }
            return None;
        }
        Some(carry.drain(..valid).collect())
    }

    /// `scan_screen_mode` as it was: tail and chunk concatenated, then six
    /// naive scans. Returns the switch it found, if any.
    fn scan_by_copy(tail: &mut Vec<u8>, bytes: &[u8]) -> Option<bool> {
        fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
            if needle.is_empty() || haystack.len() < needle.len() {
                return None;
            }
            haystack.windows(needle.len()).position(|w| w == needle)
        }
        let mut buf = Vec::with_capacity(tail.len() + bytes.len());
        buf.extend_from_slice(tail);
        buf.extend_from_slice(bytes);
        let mut last: Option<(usize, bool)> = None;
        for (needles, on) in [(ALT_ON, true), (ALT_OFF, false)] {
            for needle in needles {
                let mut from = 0;
                while let Some(at) = find(&buf[from..], needle) {
                    let at = from + at;
                    if last.is_none_or(|(prev, _)| at > prev) {
                        last = Some((at, on));
                    }
                    from = at + 1;
                }
            }
        }
        let keep = buf.len().saturating_sub(ALT_TAIL);
        tail.clear();
        tail.extend_from_slice(&buf[keep..]);
        last.map(|(_, on)| on)
    }

    /// Streams that stress each path: characters of every width, bytes that
    /// are not UTF-8 (alone, in runs, right before a split character), and
    /// every alternate-screen switch, back to back, half-written, and hiding
    /// inside a longer one.
    fn awkward_streams() -> Vec<Vec<u8>> {
        let mut stray = b"inicio ".to_vec();
        stray.extend(std::iter::repeat_n(0x80, 12));
        stray.extend_from_slice("fim ç".as_bytes());
        vec![
            b"ola mundo\r\n".to_vec(),
            "ação 😀 €\r\n\x1b[1;32mverde\x1b[0m ç".as_bytes().to_vec(),
            vec![b'a', 0xff, b'b', b'c', b'd', b'e', b'f', 0xc3, 0xa7, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80],
            vec![0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, b'x', 0xc3],
            vec![b'x', 0xc3, 0xa7, 0xff, b'y', 0xe2, 0x82],
            stray,
            b"\x1b[?1049h\x1b[2Jtela\x1b[?1049l".to_vec(),
            b"a\x1b[?47hb\x1b[?47lc\x1b[?47h".to_vec(),
            b"\x1b[?1047h\x1b[?1049l\x1b[?1047l\x1b[?1049h".to_vec(),
            b"\x1b[?1049\x1b[?47h\x1b[?104\x1b[?1049l\x1b\x1b[?47".to_vec(),
            "\x1b[?1049hção 😀\x1b[?1049lé\x1b[?47h".as_bytes().to_vec(),
            b"\x1b[?1049h\x1b[?1049h\x1b[?47l\x1b[?47l\x1b[?1047h".to_vec(),
        ]
    }

    /// Every way to cut `stream` into reads that the tests try: each single
    /// cut, every fixed read size up to 9 bytes, and a fixed irregular one.
    fn chunkings(stream: &[u8]) -> Vec<Vec<&[u8]>> {
        let mut out = Vec::new();
        for cut in 0..=stream.len() {
            out.push(vec![&stream[..cut], &stream[cut..]]);
        }
        for size in 1..=9 {
            out.push(stream.chunks(size).collect());
        }
        let mut irregular = Vec::new();
        let (mut at, mut step) = (0, 1);
        while at < stream.len() {
            let end = (at + step).min(stream.len());
            irregular.push(&stream[at..end]);
            at = end;
            step = step % 5 + 2;
        }
        out.push(irregular);
        out
    }

    #[test]
    fn stitching_reads_delivers_the_same_bytes_at_the_same_reads_as_before() {
        for stream in awkward_streams() {
            for reads in chunkings(&stream) {
                let (mut carry, mut reference_carry) = (Vec::new(), Vec::new());
                for (n, read) in reads.iter().enumerate() {
                    let mut delivered = Vec::new();
                    stitch(&mut carry, read, |chunk| delivered.push(chunk.to_vec()));
                    let expected: Vec<Vec<u8>> =
                        stitch_by_copy(&mut reference_carry, read).into_iter().collect();
                    assert_eq!(delivered, expected, "{stream:?} read {n} of {reads:?}");
                    assert_eq!(carry, reference_carry, "{stream:?} read {n} of {reads:?}");
                }
            }
        }
    }

    #[test]
    fn the_alternate_screen_flag_follows_every_read_as_before() {
        for stream in awkward_streams() {
            for reads in chunkings(&stream) {
                let shared = PtyShared::new(true);
                let (mut tail, mut reference_tail) = (Vec::new(), Vec::new());
                let mut expected = false;
                for (n, read) in reads.iter().enumerate() {
                    scan_screen_mode(&mut tail, read, &shared);
                    if let Some(on) = scan_by_copy(&mut reference_tail, read) {
                        expected = on;
                    }
                    assert_eq!(
                        shared.alt_screen.load(Ordering::Acquire),
                        expected,
                        "{stream:?} read {n} of {reads:?}"
                    );
                    assert_eq!(tail, reference_tail, "{stream:?} read {n} of {reads:?}");
                }
            }
        }
    }

    // -- the emit buffer at its cap, against the code it replaced -----------
    //
    // At the cap every read used to move the whole 2 MB left behind to the
    // front of a `Vec`. The trim now costs what it drops; what the pump
    // takes, and what the notice says was dropped, must not change by a byte.

    /// `absorb`'s emit buffer as it was: the read appended, the excess
    /// drained off the front of the `Vec`, then whatever continuation bytes
    /// were left at the front. Returns the bytes it dropped.
    fn cap_by_copy(out: &mut Vec<u8>, bytes: &[u8]) -> u64 {
        out.extend_from_slice(bytes);
        if out.len() <= EMIT_BUF_CAP {
            return 0;
        }
        let excess = out.len() - EMIT_BUF_CAP;
        out.drain(..excess);
        let cut = out
            .iter()
            .position(|b| b & 0b1100_0000 != 0b1000_0000)
            .unwrap_or(0);
        out.drain(..cut);
        (excess + cut) as u64
    }

    /// What the pump would take out of the emit buffer right now.
    fn take_pending(shared: &PtyShared) -> Vec<u8> {
        Vec::from(std::mem::take(&mut *shared.emit_buf.lock()))
    }

    /// Feeds `reads` through `absorb` and through the old buffer, taking the
    /// pending bytes out (as the pump does) after each read whose index is in
    /// `takes` and at the end, and compares both each time.
    fn same_as_before(tag: &str, reads: &[Vec<u8>], takes: &[usize]) {
        let dir = std::env::temp_dir().join(format!("yard-cap-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shared = PtyShared::new(false);
        let scrollback = Arc::new(Mutex::new(Scrollback::at(dir.join("t.bin"))));
        let mut reference = Vec::new();
        let mut reference_dropped = 0u64;
        let last = reads.len().saturating_sub(1);
        for (n, read) in reads.iter().enumerate() {
            absorb(&shared, &scrollback, read);
            reference_dropped += cap_by_copy(&mut reference, read);
            if takes.contains(&n) || n == last {
                let taken = take_pending(&shared);
                assert!(taken == reference, "{tag}: different bytes after read {n}");
                assert_eq!(
                    shared.dropped.swap(0, Ordering::Relaxed),
                    reference_dropped,
                    "{tag}: different drop count after read {n}"
                );
                reference.clear();
                reference_dropped = 0;
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Text whose characters are 1 to 4 bytes wide, `len` bytes of it cut
    /// only between characters (what `stitch` hands `absorb`), starting at
    /// character `phase` of the pattern.
    fn wide_text(len: usize, phase: usize) -> Vec<u8> {
        let chars: Vec<char> = "aç€😀 ção\r\n".chars().collect();
        let mut out = Vec::with_capacity(len + 4);
        let mut i = phase;
        loop {
            let mut buf = [0u8; 4];
            let c = chars[i % chars.len()].encode_utf8(&mut buf);
            if out.len() + c.len() > len {
                return out;
            }
            out.extend_from_slice(c.as_bytes());
            i += 1;
        }
    }

    #[test]
    fn plain_reads_past_the_cap_keep_the_same_bytes_and_drops_as_before() {
        let reads: Vec<Vec<u8>> = (0..140u8).map(|n| vec![b'a' + n % 26; 16 * 1024]).collect();
        same_as_before("ascii", &reads, &[100]);
    }

    /// The excess is a byte count, so the trim lands inside a character as
    /// often as not; the buffer must start on the next whole one, as before.
    #[test]
    fn wide_characters_cut_at_the_cap_keep_the_same_bytes_and_drops_as_before() {
        let reads: Vec<Vec<u8>> = (0..150)
            .map(|n| wide_text(16 * 1024 - 7 + n % 13, n))
            .collect();
        same_as_before("wide", &reads, &[128, 131, 140]);
    }

    /// Exactly the cap drops nothing; one byte more drops that byte; a read
    /// bigger than the whole cap keeps only its end.
    #[test]
    fn reads_right_at_the_cap_and_bigger_than_it_keep_the_same_bytes_and_drops_as_before() {
        same_as_before(
            "borda",
            &[vec![b'x'; EMIT_BUF_CAP - 1], vec![b'y'], vec![b'z']],
            &[1],
        );
        same_as_before("enorme", &[wide_text(3 * EMIT_BUF_CAP + 5, 3)], &[]);
        same_as_before(
            "enorme-depois",
            &[wide_text(EMIT_BUF_CAP / 2, 1), wide_text(EMIT_BUF_CAP + 11, 2), b"fim".to_vec()],
            &[],
        );
    }

    /// A sink that keeps each `output` call apart.
    #[derive(Default)]
    struct Chunks(parking_lot::Mutex<Vec<String>>);

    impl PtyEvents for Chunks {
        fn output(&self, _id: &str, data: String) -> bool {
            self.0.lock().push(data);
            true
        }
        fn exit(&self, _payload: events::ExitPayload) {}
        fn activity(&self, _payload: events::ActivityPayload) {}
        fn idle(&self, _payload: events::IdlePayload) {}
    }

    /// What `emit_in_chunks` hands the sink for `payload`.
    fn emitted(payload: Vec<u8>) -> Vec<String> {
        let sink = Chunks::default();
        emit_in_chunks(&sink, "t", payload);
        sink.0.into_inner()
    }

    /// `emit_in_chunks` as it was: a lossy copy of every slice.
    fn emitted_by_copy(payload: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
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
            out.push(String::from_utf8_lossy(&payload[start..end]).into_owned());
            start = end;
        }
        out
    }

    #[test]
    fn a_payload_reaches_the_sink_in_the_same_pieces_as_before() {
        let mut big = Vec::new();
        while big.len() < 2 * MAX_EMIT_CHUNK + 100 {
            big.extend_from_slice("linha ção 😀 €\r\n".as_bytes());
        }
        let mut stray = vec![b'a'; MAX_EMIT_CHUNK - 1];
        stray.extend(std::iter::repeat_n(0x80, MAX_EMIT_CHUNK + 3));
        let mut payloads = awkward_streams();
        payloads.extend([Vec::new(), big, stray]);
        for payload in payloads {
            assert_eq!(emitted(payload.clone()), emitted_by_copy(&payload), "{} bytes", payload.len());
        }
    }

    /// A sink that takes every chunk, as a page with a view on the terminal
    /// does, and counts them.
    #[derive(Default)]
    struct Taking(std::sync::atomic::AtomicUsize);

    impl PtyEvents for Taking {
        fn output(&self, _id: &str, _data: String) -> bool {
            self.0.fetch_add(1, Ordering::Relaxed);
            true
        }
        fn exit(&self, _payload: events::ExitPayload) {}
        fn activity(&self, _payload: events::ActivityPayload) {}
        fn idle(&self, _payload: events::IdlePayload) {}
    }

    impl Taking {
        fn taken(&self) -> usize {
            self.0.load(Ordering::Relaxed)
        }
    }

    /// `true` once `cond` holds, `false` when `timeout` ran out first.
    fn holds_within(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        cond()
    }

    /// A pump over a sink that counts, with `grace_ms` before an owed
    /// acknowledgement is written off, and 2 MB pushed at once: the emit
    /// buffer's whole cap, which leaves as exactly `INFLIGHT_CAP` chunks.
    fn pump_with_a_full_window(tag: &str, grace_ms: u64) -> (Arc<Taking>, Arc<PtyShared>) {
        let dir = std::env::temp_dir().join(format!("yard-pump-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sink = Arc::new(Taking::default());
        let shared = PtyShared::new(false);
        shared.ack_grace_ms.store(grace_ms, Ordering::Relaxed);
        let scrollback = Arc::new(Mutex::new(Scrollback::at(dir.join("t.bin"))));
        spawn_pump(sink.clone(), "t".into(), "t".into(), shared.clone(), scrollback.clone());
        absorb(&shared, &scrollback, &vec![b'x'; EMIT_BUF_CAP]);
        assert!(
            holds_within(Duration::from_secs(5), || sink.taken() == INFLIGHT_CAP as usize),
            "{} chunks left for the 2 MB pushed, not {INFLIGHT_CAP}",
            sink.taken()
        );
        absorb(&shared, &scrollback, &[b'y'; COALESCE_BYTES]);
        (sink, shared)
    }

    /// The regression this locks down: the page acknowledges every chunk it
    /// drained, and past `INFLIGHT_CAP` unacknowledged the pump keeps its
    /// output in the emit buffer (which drops the oldest past its cap, with a
    /// notice) instead of handing it to the IPC bridge, where nothing bounded
    /// it: an agent printing 20 MB/s into a page stalled for ten seconds used
    /// to park 200 MB of chunks there.
    #[test]
    fn the_pump_holds_its_output_while_the_page_owes_it_acknowledgements() {
        let (sink, shared) = pump_with_a_full_window("segura", 60_000);
        assert!(
            !holds_within(Duration::from_millis(300), || sink.taken() > INFLIGHT_CAP as usize),
            "a chunk went out with {INFLIGHT_CAP} still unacknowledged"
        );
        shared.ack(INFLIGHT_CAP);
        assert!(
            holds_within(Duration::from_secs(5), || sink.taken() == INFLIGHT_CAP as usize + 1),
            "the acknowledgement did not release the chunk held back ({} taken)",
            sink.taken()
        );
        shared.stopping.store(true, Ordering::Release);
        shared.wake_pump();
    }

    /// A page that never answers (reloaded with chunks on their way, or one
    /// with no view on this terminal any more) must not silence the terminal
    /// for good: past the grace, the owed acknowledgements are written off.
    #[test]
    fn an_acknowledgement_that_never_comes_is_written_off_after_the_grace() {
        let (sink, shared) = pump_with_a_full_window("perdoa", 100);
        assert!(
            holds_within(Duration::from_secs(5), || sink.taken() == INFLIGHT_CAP as usize + 1),
            "the held chunk never went out ({} taken)",
            sink.taken()
        );
        shared.stopping.store(true, Ordering::Release);
        shared.wake_pump();
    }

    /// Closing to the tray hides the window without a word to any pane, and
    /// the panes that were on the canvas kept streaming 60 messages a second
    /// into a WebView nobody could see. Behind a hidden window the pump holds
    /// its output to the hidden pace; the window coming back (the flag up and
    /// the pump woken, which is what `pty::set_window_shown` does) releases
    /// it at once instead of at the end of the hidden period.
    #[test]
    fn a_pump_behind_a_hidden_window_holds_its_output_until_the_window_shows() {
        let dir = std::env::temp_dir().join(format!("yard-pump-{}-janela", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let window = Arc::new(AtomicBool::new(false));
        let sink = Arc::new(Taking::default());
        let shared = PtyShared::with_window(false, window.clone());
        let scrollback = Arc::new(Mutex::new(Scrollback::at(dir.join("t.bin"))));
        spawn_pump(sink.clone(), "t".into(), "t".into(), shared.clone(), scrollback.clone());

        absorb(&shared, &scrollback, b"a");
        assert!(
            holds_within(Duration::from_secs(5), || sink.taken() == 1),
            "the first chunk never went out"
        );
        absorb(&shared, &scrollback, b"b");
        assert!(
            !holds_within(Duration::from_millis(150), || sink.taken() > 1),
            "a chunk went out at the on-screen pace behind a hidden window"
        );
        window.store(true, Ordering::Release);
        shared.wake_pump();
        assert!(
            holds_within(Duration::from_millis(150), || sink.taken() == 2),
            "the window came back and the held chunk still waited for the hidden pace"
        );
        shared.stopping.store(true, Ordering::Release);
        shared.wake_pump();
    }

    #[test]
    fn utf8_prefix_stops_at_the_cut() {
        // "á" = C3 A1. Cut in the middle, only what came before is valid.
        let bytes = [b'a', 0xC3];
        assert_eq!(valid_utf8_prefix_len(&bytes), 1);
        let complete = "aá".as_bytes();
        assert_eq!(valid_utf8_prefix_len(complete), complete.len());
    }
}
