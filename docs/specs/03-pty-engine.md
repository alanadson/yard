# The PTY engine on Windows — the heart of the app

> Specification of the behavior implemented in `src-tauri/src/pty/` (and its
> neighbors `process_tree.rs`, `resources.rs`). The acceptance criteria are
> covered by `pty::engine_tests`, which spin up real PowerShell.

## 1. Spawn (ConPTY)

`portable-pty` uses **ConPTY** on Windows 10 1809+ (our minimum). Flow:
`native_pty_system().openpty(PtySize)` → `CommandBuilder` with
program/args/cwd/env → `slave.spawn_command(cmd)` → **`drop(slave)`
immediately** (without it, EOF never reaches the reader when the process dies)
→ `master.try_clone_reader()` for the reader thread and
`master.take_writer()` for input. Minimal env: `TERM=xterm-256color` and
inherit the rest. Default shell: `pwsh.exe` if present, otherwise
`powershell.exe` (resolved via `which`), with `cmd.exe` as an option.

Right after the spawn, create a **Job Object** (§5) and assign the root PID —
it is the life insurance against orphan processes.

The inherited environment is sanitized: color vetoes (`NO_COLOR`,
`FORCE_COLOR`, `CLICOLOR*`) exported by whoever launched the app are removed —
color is this terminal's decision, not that of the terminal that opened Yard —
and so are agent session markers (`CLAUDECODE`, `CLAUDE_CODE_*`), so that a
nested agent behaves as a first-class session and keeps writing its
transcript.

## 2. Scrollback: 4 MB ring + append-only on disk

In memory, per PTY: a `VecDeque<u8>` capped at 4 MB (drops from the front on
overflow) **plus** a `Vec<u8> pending` holding what has not yet gone to disk.
Every 250 ms (or on close), **only the `pending`** is written, appended to
`scrollback/{id}.bin` — never the whole ring. Without that, a mere agent
spinner (a few bytes/s) would force a 4 MB rewrite on every flush (~16 MB/s of
I/O per terminal). The 250 ms tick is armed only while there is something
pending, so a quiet terminal neither writes nor wakes; the `.bin` stays open
for appending between flushes (every close after a write can make the
antivirus scan the file) and is closed by the terminal's last flush. When the
`.bin` exceeds 8 MB, only the 4 MB tail is rewritten atomically (`.bin.tmp`
written and fsynced, then renamed over it). That tail is the ring itself (right
after a flush it is byte for byte the file's tail), and the pump's flush hands
the rewrite to its own thread instead of doing it under the lock the reader
takes on every read: the output keeps flowing, waits in `pending` and is
appended to the new file once the rename lands (past 4 MB of it, the flush
waits for the rewrite, so memory stays bounded). On `attach_pty`: if the PTY is
alive, return the in-memory ring; if it is dead/suspended, read the tail of
the `.bin`. The view says first what it will read (`AttachWants`, decided by
`XTermView/attachPlan.ts`, cut by `pty::history_cut`): a dead terminal set to
auto-start spawns on a clean screen, so its `.bin` is not even opened (after a
restart, that is every terminal that was running); a live alternate screen
gets its frame from a repaint and only scans the end of the history, so it
receives a suffix holding the last `altTail` UTF-16 units
(`Scrollback::tail_utf16`: three bytes per unit, cut back to a character
start, so the view's own `slice` lands on the same text). Asking nothing
returns everything, as before. Acceptance: a spinner running all night must not generate more
than ~KB/s of I/O.

## 3. Reading: UTF-8 and coalescing

The reader thread keeps a `carry: Vec<u8>`. On each `read()`:
`carry.extend(chunk)`; compute
`valid = from_utf8(&carry).map(|s| s.len()).unwrap_or_else(|e| e.valid_up_to())`;
emit only `carry[..valid]` and keep the tail (0–3 bytes of a character split
by the buffer boundary — without this, the UI fills up with `�`). Coalescing:
accumulate and emit every ~8–16 ms **or** at ≥ 32 KB, whichever comes first —
one IPC message per byte kills the WebView. The messages go to the pages over
one ordered IPC channel each (`pty/pages.rs`, [architecture §4](./02-architecture.md#4-ipc-contract-commands--events)):
a chunk of 1 KiB or more as its own bytes, fetched as an `ArrayBuffer`, not as
JSON pasted into a script. Every chunk is whole characters, so the page
decodes each one on its own. Hidden pane (`set_pty_visible(false)`
coming from the UI), or a main window hidden to the tray or minimized (one
flag for the whole app, `AppState::window_shown`, kept by `window_state.rs`
and the resources tick): downgrade to 1 emission/450 ms while keeping the ring
always up to date. The window coming back wakes every pump. The "agent finished" detector does not depend on what
reaches the page: it runs inside the pump (§7), hidden or not. Payloads are
sliced into 256 KB pieces, with a 2 MB cap on the emission buffer and a
visible warning when the output is too fast to display.

The page answers for each chunk it takes off the channel (`ack_pty_output`),
and the pump sends at most `INFLIGHT_CAP` (8, so 2 MB) per terminal that it
has not answered for. Tauri parks every chunk sent until the page's JS
fetches it, with no bound of its own, so without the window a page stalled
for ten seconds under an agent printing 20 MB/s left 200 MB in the bridge.
While the page owes, the output waits in the emission buffer, which drops
its oldest bytes past the cap with the same warning; an answer that never
comes (a page reloaded with chunks on their way) is written off after 3 s,
so a terminal nobody is watching is never silenced by the window.

The bytes are not copied more than that needs. When nothing is carried (nearly
always) the read buffer itself goes out and only the split tail is copied; the
alternate-screen scan walks the chunk once, back from its end, and joins only
the few bytes around the read boundary; and a payload that fits in one message
becomes that message's text in place (its bytes, on the raw path).

The `activity` heartbeat (`{ id, lastByteAt, idleMs }`, a message on the same
page channel as the output) ticks every
450 ms but only goes out when it has news: a `lastByteAt` the front end has not
been told, or `idleMs` under a second (the "still writing" window
`ptyWatch.ts` uses to clear a stale "blocked"; the backend's `WRITING_MS` is
the same second). Everything the front end reads from it is either
`lastByteAt` itself or that window, so the beats that stopped going out changed
nothing anyone reads. A listener that registers after the last beat (a webview
reload) asks `pty_activity` once for the current one. The pump's own timers
follow the same rule: armed only while there is a frame to paint, bytes to
flush, a beat with news or an agent's silence still being timed, and resumed on
their old phase when armed again, so a quiet terminal costs no wakeups at all.

## 4. RAM gate on spawn

Before spawning an agent: if `sysinfo` reports < 400 MB of available RAM on
the system, wait in 1 s polls for up to 45 s; after that, proceed anyway (a
rare crash is better than locking the user out forever). The reason: a
Node/agent process born without RAM kills itself on its first allocation.
**Never** try to "reserve" memory based on `available_memory()` — on Windows
it only sees free physical RAM, not the commit limit (RAM + paging), and the
maneuver makes the problem worse. Only read, never allocate on purpose.

## 5. Tree kill: Job Objects (+ fallback)

Agents spawn trees (pwsh → node → mcp servers → git…). `child.kill()` kills
only the root. The canonical solution on Windows:

```text
CreateJobObjectW(NULL, NULL)
  → SetInformationJobObject(job, JobObjectExtendedLimitInformation,
        { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE })
  → AssignProcessToJobObject(job, hRootProcess)   // right after the spawn
kill_pty  ⇒ TerminateJobObject(job, 1)            // whole tree, atomic
Yard crash ⇒ job handle closes ⇒ the OS kills the tree by itself (KILL_ON_JOB_CLOSE)
```

Via the `windows-sys` crate (features `Win32_System_JobObjects`,
`Win32_Foundation`, `Win32_System_Threading`; the process `HANDLE` comes from
`OpenProcess(PROCESS_ALL_ACCESS, …, pid)`). Defensive fallback if the assign
fails (rare, e.g. a process already in another job without nesting
permission): walk the tree via `process_tree.rs` and kill leaves→root; as a
last resort, `taskkill /PID <pid> /T /F`. In the `sysinfo` tree, **filter out
entries with `thread_kind().is_some()`** (threads show up as "PIDs" in the map
— without the filter, the tree kill balloons and gets slow) and cache the
parent→children map for 2 s.

## 6. Suspend and resume

`suspend_pty` = flush the scrollback → kill the tree → mark `alive=0` while
preserving `program/args/cwd/resume_json`. "Retomar" (Resume) re-spawns: a
plain shell comes back as a fresh shell with the history visible above; an
agent comes back with its own resume command (`claude --resume <sessionId>`,
`codex resume`, `opencode` with a session) — the IDs come from the parsers in
`agents/sessions.rs`. "Suspender grupo" (Suspend group) applies this to every
terminal in the group at once — it is the app's RAM relief valve.

## 7. The "agent finished" detector

Without an API from the agents, the heuristic that works: if a PTY marked
`kind='agent'` has gone ≥ 4.5 s without emitting bytes **after** a period of
activity, fire a native notification ("Claude terminou em api-server" —
"Claude finished in api-server") + a badge on the pane. The detector runs in
the pump, on the same 450 ms tick as the `activity` heartbeat, so it
works with the pane in the background; for an agent the tick stays armed until
that one event has fired, and only then does its pump go quiet.

## Appendix: ConPTY's `ESC[6n`

Discovered while writing the engine tests, and worth knowing: during the
handshake conhost emits `ESC[6n` (DSR-CPR) and **holds back all of the
application's output until it receives the reply**. Whoever answers is the
emulator on the other side — xterm.js does it on its own, and that is why the
app works. A headless reader hangs: the process stays alive, mute and stalled,
with no error. The tests include a minimal terminal that answers `ESC[1;1R`.
If one day the F7 horizon of the [roadmap](./05-roadmap.md) brings a Rust
emulator, it will need to do the same.
