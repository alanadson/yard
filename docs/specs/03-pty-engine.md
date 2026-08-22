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
I/O per terminal). When the `.bin` exceeds 8 MB, only the 4 MB tail is
rewritten atomically (`.bin.tmp` → rename). On `attach_pty`: if the PTY is
alive, return the in-memory ring; if it is dead/suspended, read the tail of
the `.bin`. Acceptance: a spinner running all night must not generate more
than ~KB/s of I/O.

## 3. Reading: UTF-8 and coalescing

The reader thread keeps a `carry: Vec<u8>`. On each `read()`:
`carry.extend(chunk)`; compute
`valid = from_utf8(&carry).map(|s| s.len()).unwrap_or_else(|e| e.valid_up_to())`;
emit only `carry[..valid]` and keep the tail (0–3 bytes of a character split
by the buffer boundary — without this, the UI fills up with `�`). Coalescing:
accumulate and emit every ~8–16 ms **or** at ≥ 32 KB, whichever comes first —
one IPC event per byte kills the WebView. Hidden pane (`set_pty_visible(false)`
coming from the UI): downgrade to 1 emission/450 ms while keeping the ring
always up to date, and keep emitting `pty://activity/{id}` for the "agent
finished" detector. Payloads are sliced into 256 KB pieces, with a 2 MB cap on
the emission buffer and a visible warning when the output is too fast to
display.

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
"Claude finished in api-server") + a badge on the pane. The 450 ms
`pty://activity/{id}` event exists precisely so this works with the pane in
the background.

## Appendix: ConPTY's `ESC[6n`

Discovered while writing the engine tests, and worth knowing: during the
handshake conhost emits `ESC[6n` (DSR-CPR) and **holds back all of the
application's output until it receives the reply**. Whoever answers is the
emulator on the other side — xterm.js does it on its own, and that is why the
app works. A headless reader hangs: the process stays alive, mute and stalled,
with no error. The tests include a minimal terminal that answers `ESC[1;1R`.
If one day the F7 horizon of the [roadmap](./05-roadmap.md) brings a Rust
emulator, it will need to do the same.
