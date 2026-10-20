# Architecture

> The code is the final truth; this spec records the design and the contracts
> it follows. The modules and names below exist in `src-tauri/src/` and `src/`.

## 1. Overview

```
┌─────────────────────────────  WebView2 (React/TS)  ─────────────────────────────┐
│  TitleBar · Sidebar (projects/groups) · WorkspaceGrid (splits) · Modals         │
│  XTermView (xterm.js + canvas)  ·  Zustand stores (projects/terminals/ui)       │
└───────────────▲───────────────────────────────────────────────▲─────────────────┘
        invoke() commands                                emit() events
                │                                               │
┌───────────────┴───────────────────  Rust (Tauri)  ────────────┴─────────────────┐
│ events.rs (bus)             state.rs (AppState: registries + db)                │
│ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ ┌─────────────────────────┐ │
│ │ pty/          │ │ agents/      │ │ git/          │ │ persistence/            │ │
│ │  spawn        │ │  resolver    │ │  status       │ │  db.rs (SQLite)         │ │
│ │  reader       │ │  sessions    │ │  worktrees    │ │  workspace.rs           │ │
│ │  scrollback   │ │  usage/cost  │ │               │ │  prefs.rs · backup.rs   │ │
│ │  teardown     │ └──────────────┘ └───────────────┘ └─────────────────────────┘ │
│ │ process_tree  │  resources.rs (RAM/CPU, suspend)     watcher.rs (notify)      │
│ └──────────────┘  paths.rs · logging.rs · single_instance                       │
└──────┬──────────────────┬───────────────────┬──────────────────┬────────────────┘
       │ ConPTY           │ Job Objects       │ git CLI          │ %APPDATA%
   pwsh/cmd/agent     (tree kill)         (worktree add…)    app.db + scrollback/
```

## 2. Rust modules (`src-tauri/src/`)

| Module                               | Responsibility                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `main.rs` / `lib.rs`                 | Tauri bootstrap, command registration, plugins, `AppState`                                       |
| `state.rs`                           | `PtyRegistry`, SQLite connection, caches — all behind `Mutex`/`RwLock`                           |
| `pty/mod.rs`                         | Public API of the engine: spawn, write, resize, attach, kill, suspend, restart                   |
| `pty/reader.rs`                      | Reader thread per PTY: UTF-8 boundary, coalescing, event emission                                |
| `pty/pages.rs`                       | The PTY channel to each page: output, exit, heartbeat and idle in engine order, addressed per subscription (§4) |
| `pty/scrollback.rs`                  | 4 MB ring in memory + append-only `.bin` with compaction ([PTY engine §2](./03-pty-engine.md#2-scrollback-4-mb-ring--append-only-on-disk)) |
| `pty/teardown.rs`                    | Shutdown states, exit watcher, registry cleanup                                                  |
| `process_tree.rs`                    | Parent→children map via `sysinfo` (2 s cache, threads filtered out), Job Objects                 |
| `agents/resolver.rs`                 | Discover the CLIs installed on Windows: `where`, npm `.cmd` shims, registry                      |
| `agents/sessions.rs`                 | Read the agents' local sessions (`~/.claude/projects/*.jsonl`, `~/.codex/sessions`…) for "resume" |
| `agents/tail.rs`                     | Tail of the agent's active session → `session://feed` event (feeds the "Ao Vivo" (Live) overlay) |
| `git.rs`                             | *Reading* the repository: `git status --porcelain=v2` (with both sides — index and disk — per file), per-file diff, the fronts' worktrees, and `worktree_preflight` — the read-only answer to "what would happen if I created this?" that the front dialog is built on. Creating goes through `worktree_provision`, which takes the base and the folder the plan froze, bounds `worktree add` with a deadline (`YARD_WORKTREE_ADD_TIMEOUT_MS`, floor 180 s), carries `-c core.longpaths=true` on Windows, sets `push.autoSetupRemote` when nobody else has, and copies the ignored paths listed in `.worktreeinclude` into the new worktree; undoing goes through `branch_delete_if_unchanged` (`git update-ref -d <ref> <old-oid>`), which refuses a branch that moved |
| `scm.rs`                             | *Writing* to the repository (the "Controle" (Source Control) tab): stage/unstage/discard, commit, branch, merge/rebase/revert/reset, stash, tags, fetch/pull/push, `git apply` of a single hunk, per-side diff. Every path goes through `rel_paths` and every name through `check_branch_name` |
| `persistence/db.rs`                  | SQLite (bundled rusqlite), migrations, monotonic write guard                                      |
| `persistence/workspace.rs`           | Snapshot/restore of projects, groups, layouts and terminals                                      |
| `bridge.rs`                          | Named pipe for the `yard` CLI — transport of the agent↔app bridge                                |
| `watcher.rs`                         | `notify` on the agents' session files and on open files                                          |
| `resources.rs`                       | `sysinfo`: RAM/CPU per PTY tree, spawn gate, group suspension                                    |
| `paths.rs`                           | Central resolution of `%APPDATA%\Yard\…` (never scatter paths around)                            |
| `events.rs`                          | Topic names and typed payloads (a single place defines the contract)                             |
| `lanes.rs`                           | Ordered lanes: the blocking sync commands leave the UI thread and keep their arrival order (see §4) |

## 3. Frontend (`src/`)

```
src/
├── main.tsx · App.tsx
├── stores/            # Zustand — sliced by domain
│   ├── projectsStore.ts     # projects, groups, layout (persisted through the backend)
│   ├── terminalsStore.ts    # id → status/title/activity (mirror of the backend)
│   ├── changesStore.ts      # git status/diffs for the changes panel
│   ├── scmStore.ts          # "Controle" tab: header, branches, stash, history and the writes
│   ├── worktreesStore.ts    # `git worktree list` per project: the branch of each row, the fronts to adopt
│   ├── liveStore.ts         # reduction of the session feed ("Ao Vivo" overlay)
│   └── uiStore.ts           # theme, modals, focused pane, zoom
├── lib/provision/     # opening a front, from the plan to the rollback
│   ├── plan.ts              # git's answers + what the app knows → the plan the dialog shows
│   ├── batch.ts             # runs it one row at a time; journal, compensation, policies
│   ├── journal.ts           # what this operation wrote — the only thing a rollback may read
│   ├── errors.ts            # the stable catalogue of refusals (code, severity, sentence)
│   └── effects.ts           # the boundary: ipc + stores, one call per method, no opinions
├── components/
│   ├── TitleBar/            # custom bar (decorations: false), min/max/close buttons
│   ├── StatusBar/           # footer: agents waiting, branch, flows, RAM; Busca/composer/shortcuts buttons
│   ├── ProjectSidebar/      # tree: projects → ground/fronts (branches) → terminals
│   ├── WorkspaceGrid/       # react-resizable-panels: automatic/grid/spotlight layouts
│   ├── CanvasView/          # the boards: infinite canvas (cards, notes, drawing)
│   ├── TerminalPane/        # frame: title, sub-tabs, actions (restart/suspend/kill)
│   ├── XTermView/           # the xterm itself (attach, resize, input)
│   ├── Settings/            # Settings (Ctrl+Shift+P): centered sheet, category menu + page
│   └── modals/              # NewTerminalModal, ScoresModal, RoutinesModal…
├── hooks/                   # useGlobalEvents, useKeybindings, useRoutines…
└── lib/
    ├── ipc.ts               # typed invoke/listen wrappers (the §4 contract in TS)
    ├── ptyStream.ts         # the page's half of the PTY channel (§4): decode, address, dispatch
    └── bridge.ts            # the brains of the agent↔app bridge (see §4.1)
```

### 3.1 Strings and language

The UI's source language is Brazilian Portuguese, and the Portuguese
sentence is the dictionary key: `t("Salvar")` (`src/lib/i18n.ts`) returns
"Salvar" in pt-BR and the line `src/i18n/en/<area>.ts` holds for it in
English — or the Portuguese again, recorded once, when that line does not
exist yet. No invented ids: the source stays readable and the tests keep
asserting the Portuguese text. `stores/langStore.ts` resolves the `lang`
preference (`pt-BR` | `en` | `system`) against `navigator.language`, is
the only writer of the active language and of `<html lang>`, and
`hooks/useT.ts` gives components the same `t` plus the subscription that
re-renders them (to the active language, `lib/i18n.subscribeActiveLang`, not
to the resolved preference). The English lines are a chunk of their own,
fetched only when English is resolved (`lib/i18n.loadEnglish`), and
`setActiveLang` refuses English until they have arrived: a switch to English
(`langStore.startLanguage`) waits for the dictionary and then writes the
active language, `<html lang>` and the memory for the next boot together.
That memory is the last language shown, kept in `localStorage` under
`yard.lang`, so an English boot waits for the lines before the first render
(`main.tsx` calls `langStore.restoreLanguage`) and never shows
Portuguese; the remembered language stands in for the preference until `App`
has read the prefs (`releaseRememberedLang`). `tn(count, singular, plural)`
handles plurals with both Portuguese forms as keys; `locale()` replaces
hard-coded `"pt-BR"` in `toLocale*` calls. Module-level tables (shortcuts,
settings categories, palette rows, menu builders) keep their Portuguese and
are translated at the point of rendering. The `yard` CLI's own output is
not translated: it is read by agents. `scripts/i18n-scan.mjs` lists the
sentences not yet wrapped, per area; `src/i18n/en/index.test.ts` refuses
empty lines, lines equal to their key and the same key translated two ways.

## 4. IPC contract (commands + events)

A single file of truth on each side (`events.rs` ↔ `lib/ipc.ts`). The core's
minimum set:

**Commands (`invoke`)**

| Command                                    | Input                                          | Output                                    | Note                                                           |
| ------------------------------------------ | ---------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `spawn_pty`                                | `{ id, program, args, cwd, rows, cols, env? }` | `Result<()>`                              | Goes through the RAM gate ([engine §4](./03-pty-engine.md#4-ram-gate-on-spawn)) |
| `write_pty`                                | `{ id, data }`                                 | `Result<()>`                              | Keyboard/paste input                                           |
| `resize_pty`                               | `{ id, rows, cols }`                           | `Result<()>`                              | Debounced on the front (~50 ms)                                |
| `attach_pty`                               | `{ id, wants? }`                               | `Result<AttachResult>`                    | The scrollback plus `alive`/`exit`/`altScreen`; not alive and no exit = needs spawning. `wants` (what the view will read) leaves out a dead history it discards and sends a live alternate screen only the tail it scans ([engine §2](./03-pty-engine.md#2-scrollback-4-mb-ring--append-only-on-disk)) |
| `kill_pty`                                 | `{ id }`                                       | `Result<()>`                              | Kills the **tree** (Job Object)                                |
| `suspend_pty`                              | `{ id }`                                       | `Result<()>`                              | Kills while preserving scrollback + resume metadata            |
| `restart_pty`                              | `{ id }`                                       | `Result<()>`                              | kill + respawn with the same command/cwd                       |
| `list_ptys` / `pty_exists`                 | — / `{ id }`                                   | snapshot / `bool`                         | Reconciliation after a UI reload                               |
| `pty_activity`                             | `{ id }`                                       | `ActivityPayload \| null`                 | The heartbeat the pump would send now; a listener that registered after the last one asks once (`ptyWatch.ts`) |
| `get_pty_tree_info`                        | `{ id }`                                       | `{ pids, rssMb, cpu }`                    | Feeds the resources HUD                                        |
| `save_workspace` / `load_workspace`        | JSON snapshot                                  | `Result`                                  | With a monotonic revision guard                                |
| `detect_agents`                            | —                                              | `[{ id, name, bin, version, resumeCmd }]` | CLI detection                                                  |
| `list_agent_sessions`                      | `{ agent, projectPath }`                       | sessions to resume                        | Parsers for `~/.claude`, `~/.codex`…                           |
| `read_prefs` / `write_prefs`               | kv                                             | kv                                        | The SQLite `kv` table                                          |

**Where a command runs.** Tauri runs a command declared without `async` inline,
on the main (UI) thread, in arrival order; an `async` one goes to a pool that
keeps no order. Neither is right for a command that blocks *and* has an order
to keep, so `lanes::dispatch` wraps the generated handler and sends those to a
lane (`lanes.rs`): a FIFO thread per key, fed from the UI thread in arrival
order, running the unchanged command wrapper. Same arguments, result, error
text, and the promise still settles when the work is done.

| Lane               | Commands                                                                 | Why the order matters                                            |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `db`               | every sync command that locks `state.db` (workspace, prefs, notes), plus the window geometry writes | An older snapshot must never land after a newer one; a read sees the writes issued before it |
| `pty:{id}`         | `write_pty`, `clear_pty`, `forget_pty`                                   | Keystrokes keep their order; a stuck console blocks only itself; clearing and forgetting a terminal queue behind its own writes |
| `pty-control`      | `kill_pty`, `suspend_pty`, `suspend_group`                               | The intent the exit watcher reports follows the order asked     |
| `portal-shot`      | `portal_screenshot`, `portal_grab_shot`                                  | Two shots in one second share a file name                        |
| `watch:{projectId}` | `watch_project`, `unwatch_project`                                      | A drop that overtook its watch would leave a watcher nobody wants |
| `lsp:{id}`         | `lsp_start`, `lsp_send`, `lsp_stop`                                      | The editor fires its messages without awaiting them; a `didChange` is a diff against the version before it |

Blocking commands with nothing to order (`attach_pty`, `get_pty_tree_info`,
`is_directory`, `reveal_path`, `open_external`, `list_shells`, `default_shell`)
are `async fn` + `spawn_blocking`. A routed command has to be a plain `fn`: for
an `async fn` the lane would only hand a future to the runtime, and order
nothing (a test in `lanes.rs` reads the source for that). The exit path and `restart_app` tear down
through `lanes::before_teardown`, which drains the `db` lane first, so a save
that arrived before them still reaches the disk; a forced geometry flush (the
close path) likewise returns only after its write ran. Tests in `lanes.rs` read
`lib.rs` and fail if a sync command that locks `state.db` is not on the `db`
lane, or if either teardown path kills anything before that drain.

**The PTY channel (`pty/pages.rs` ↔ `src/lib/ptyStream.ts`)**

A terminal's own events do not travel on the event bus. Each page opens one
ordered `tauri::ipc::Channel` (`pty_events_open`) and subscribes per listener
(`pty_events_subscribe` / `pty_events_unsubscribe`); `on.output`, `on.exit`,
`on.activity` and `on.agentIdle` in `ipc.ts` keep their signatures and hand
out the same payloads as before. The page answers for every output chunk it
takes off the channel (`ack_pty_output`), listener or none: the engine sends
at most eight chunks (2 MB) per terminal that the page has not answered for,
because Tauri keeps every chunk sent until the page's JS fetches it, with no
bound of its own ([engine §3](./03-pty-engine.md#3-reading-utf-8-and-coalescing)).

| Kind       | Payload                       | When                                                                  |
| ---------- | ----------------------------- | --------------------------------------------------------------------- |
| `output`   | `{ data: string }`            | Output chunks (coalesced ~8–16 ms; 450 ms if the pane or the main window is hidden) |
| `exit`     | `{ id, code?: number, reason }` | Root process exited (`reason`: normal/killed/suspended/restarted)   |
| `activity` | `{ id, lastByteAt, idleMs }`  | On a 450 ms tick, only with news: a new last byte, or still writing (`idleMs` < 1 s). A quiet terminal sends nothing ([engine §3](./03-pty-engine.md#3-reading-utf-8-and-coalescing)) |
| `idle`     | `{ id, title, idleMs }`       | An agent went quiet after working (every terminal, like the old `pty://idle`) |

Why a channel: an emit is JSON pasted into a script the WebView compiles on
its main thread, and every ESC of terminal output becomes a six-character
escape. A chunk of 1 KiB or more now goes as its own bytes, fetched as an
`ArrayBuffer` (text bytes, a JSON trailer `{ to, id }`, the trailer's length as
a little-endian u32); smaller messages stay short JSON scripts
(`{ to, output | exit | activity | idle }`). Why one channel for all four:
the page puts messages back in send order, so an exit or an idle can never
overtake the output it is about (the exit clears the prompt tail and the
announced addresses). Every message names the subscriptions that held when it
was sent (`to`), as the bus fixed its listeners at emit time: a view that
remounts while a chunk is on its way to the old one does not paint that chunk
twice. A reload is a new page token, and its first link closes the old
page's; an HMR copy of `ipc.ts` keeps the token and gets a link of its own.

**Events (`listen`)**

| Topic                 | Payload                       | When                                                                  |
| --------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `agents://changed`    | —                             | The watcher saw a new/updated agent session                           |
| `session://feed`      | session entries               | Tail of the agent's JSONL ("Ao Vivo" overlay)                         |
| `resources://tick`    | `{ totalRssMb, perPty }`      | Every ~2 s while the main window is on screen, for the HUD and the supervisor |
| `window://shown`      | `{ shown: boolean }`          | Every change of whether the main window is on screen (hidden to the tray or minimized is not) |
| `bridge://request`    | JSON line from the `yard` CLI | Request from an agent over the bridge (answered via `bridge_respond`) |
| `queue://changed`     | `()`                           | Any queue write that changed `queue.items` (enqueue, patch, retry, remove, reconciliation, delivery state) |
| `flow://changed`      | `()`                           | A native flow run record changed                                      |
| `routine://changed`   | `()`                           | A routine run record (`routine.run.*`) changed                        |
| `checkpoint://notices` | `()`                          | The pending checkpoint notices changed (a failure recorded or acknowledged) |

The four automation topics come from one place: `kv_set`/`kv_delete` skip
writes that would not change the stored value and note the ones that did, and
whoever ran the work (the IPC command wrapper, the scheduler tick or lane job,
the bridge flow CLI) emits the matching topics. The page reads the snapshot
once at boot, again on each topic and when the window comes back on screen,
and keeps a 30 s safety read only while the window is shown
(`src/lib/liveRead.ts`).

**Golden rule:** the UI **never** assumes that creating/destroying a component
creates/destroys a process. Mounted an `XTermView` → call `attach_pty`; if
scrollback came back, just repaint; if `None` came back, then and only then
`spawn_pty`. Closing a pane ≠ killing the process (that is an explicit action).
This is what makes HMR, reload and UI restarts painless.

Tabbed panes keep all live or auto-starting `XTermView` instances attached.
Stopped tabs load their terminal history only when selected, and each pane
retains at most its two most recently selected stopped views. Selecting a third
stopped tab disposes the oldest stopped view without deleting its history or
touching a process. Selecting an evicted tab reconstructs it from the backend's
saved scrollback; its old selection and scroll position are not retained.
This bounds the cost of browsing stopped sessions rather than allocating a
20,000-line xterm buffer for every saved tab at boot. Canvas cards currently
keep their existing view lifecycle.

### 4.1 The agent↔app bridge

The `yard` CLI talks to the app over a named pipe (one JSON line out, one
back) → `bridge://request` event → `src/lib/bridge.ts` answers via
`bridge_respond`. The Rust side is a dumb transport **on purpose**: all
workspace state lives in the frontend, and duplicating it in the backend would
create two truths. The connections drawn on the canvas are the access control:
an agent only reaches what is wired to it.

Both the named pipe and the optional loopback TCP transport authenticate the
exact terminal ID and its process credential before creating a pending request
or emitting an event. A new `YARD_TOKEN` is generated with the operating
system's cryptographic random provider for each process spawn. It is registered
before launch, removed before dispatch and revoked on failed startup, requested
termination or natural exit. Restart keeps the terminal ID and issues a new
credential. Custom environment values cannot override this identity pair.
SSH launch arguments store markers; expansion receives the same credential
as the local process environment. `bridge_remote` returns the listener port
and a compatibility marker, never an app-wide accepted credential.

**The client.** `yard.cmd` (cmd and PowerShell callers) and `yard` (Git Bash)
in `<data>\bin` only forward, as `%*` and `"$@"`, to a small native console
program (or to `yard.ps1` when that exe has gone since startup, say an
antivirus quarantined it mid-session; the exe's line stays the batch file's
last, so its exit code is still the caller's):
`src-tauri/src/yard_cli.rs`, std only, compiled by `build.rs` with a
bare `rustc` into its own exe, embedded in the app with `include_bytes!` and
written beside the shims as `yard-cli-<hash of its bytes>.exe` (a new version
never overwrites a client that is still running a ten-minute `yard ask`). It
replaced a hop through Windows PowerShell 5.1 (`yard.ps1`) that cost 0.5 to
0.7 s of cold start under every Claude Code hook; the exe answers in about
20 ms. The contract is still `yard.ps1`'s: the arguments split by
powershell.exe's command-line rules, `--timeout` read the way `[double]` read
it, `--file`/`--stdin`, the one-line JSON request, `Connect(4000)`, the
messages and the exit codes; a test runs both clients against the same
stand-in pipe and requires the same request. What changed on purpose is the
encoding of UTF-8 text: standard output and `--file` are UTF-8, and so is
standard input whenever it is valid UTF-8 or carries a byte order mark (a
Claude Code hook payload, Git Bash, pwsh 7), where the PowerShell client read
and wrote the console's code page and mangled every accent. Standard input
that is not UTF-8 is still read in the console's input code page, as
`yard.ps1` read it: that is what cmd.exe's `echo` and older console tools
write into a pipe (`echo ação| yard note write N --stdin` under code page 850).
Two more differences are deliberate, both fixes. Arguments that the `-File`
parameter binder of powershell.exe rewrote now arrive verbatim: a lone `-`
(which ended the script with exit 1), `--%` and `-x:` (which vanished),
`-a:b:c` (which was split) and `-note: text` (which became two arguments).
And in the edge paths where `yard.ps1` died with a localized PowerShell error
record (an invalid `--timeout`, an empty or unreadable `--file`, a reply that
is not JSON, a failed write to the pipe) the client prints one `yard: ...`
line instead, with the same exit code; the connect failure keeps its prefix,
suffix and exit 2, with the OS reason in the parentheses instead of .NET's.

At startup the setup thread writes `yard.ps1`, the manual and the Claude hooks
file, and makes sure the shims work (missing or orphaned ones become the
PowerShell pair). A background thread then writes the exe, **probes** it once
(`--yard-cli-probe`, hidden, bounded) and points the shims at it, or keeps
PowerShell when anything fails on the way (the write, an antivirus, Smart App
Control refusing an unsigned program). A failure is remembered for that build
in `yard-cli-<hash>.blocked` (the Unix second it happened) and the exe is kept:
later starts go straight to PowerShell, without writing or running anything,
and try the same build again only a day later (a new build is always tried),
so a machine that refuses the client does not raise its block at every start.
The first PTY spawn seals the shims
without waiting for that choice (`bridge::seal_launchers`), because cmd.exe
reads a batch file as it runs it and rewriting `yard.cmd` under a running hook
would run half of each version; once a terminal exists the shims are left
alone. The choice is normally made long before the window asks for a
terminal. When a terminal wins the race (the first run of a freshly written
exe, while the antivirus looks at it), the choice still in flight is dropped
and that session keeps the shims the setup thread checked (the earlier
session's compatible client or PowerShell); the next start finds the exe in place and
already scanned, so its probe is fast and it adopts the client.

A native client from another build is replaced by the updated PowerShell fallback
before any terminal may seal the launchers. This prevents pre-authentication
clients from breaking hooks during the first startup after an update.

**The limit of that gate.** Changing `YARD_PTY_ID` without the matching
credential cannot borrow another card's connections. Stopped terminal rows
have no active credential. The bridge authenticates possession of a process
credential, not the operating-system identity of the pipe peer. Processes
with the same user's privileges or remote root access may be able to read
another process's environment. Obtaining that other process's credential
remains outside this boundary; the bridge is not a sandbox for same-user
processes or a remote machine administrator.

### 4.2 Durable work requests

`work.rs` stores task requests independently of a terminal's lifetime. Schema v9
adds `work_tasks`, `work_task_events` and `work_task_deliveries`. Each task retains the original request,
acceptance criteria, project and terminal references, queue identity, latest
delivery, revision and timestamps. Mutations and timeline entries commit in one
SQLite transaction. An outdated revision returns a structured `conflict` error.

The work panel is available through Search as **Tarefas e entregas**. Creating a
task requires a title and request. Sending it to a registered agent atomically
records the queued task and its prompt. Repeating the same enqueue identity
returns the existing operation. Before input reaches ConPTY, `task_claim`
checks the task, assigned terminal and persisted sending queue head.

The native commands are `task_create`, `task_list`, `task_get`, `task_events`, `task_deliveries`,
`task_transition`, `task_enqueue`, `task_retry_delivery`, `task_claim`, `task_submit`, `task_link` and `task_approve`.
They run on the database lane. Lists use a bounded page and an `(updatedAt, id)`
cursor, with stable ordering when timestamps match.
`task_list` also accepts `attention: true`, selecting `blocked`, `failed` and
`in_review` directly in SQLite. `attentionTotal` counts these states across the
complete ledger, independently of the selected page. The work panel preserves
loaded attention pages while refreshing their current status, discards completed
work and ignores responses from superseded filters.

An assigned agent can inspect and report its work:

```text
yard task show TASK_ID
yard task history TASK_ID
yard task link TASK_ID --file reference.json
yard task submit TASK_ID --attempt ATTEMPT_ID --file delivery.json
yard task submit TASK_ID --attempt ATTEMPT_ID --stdin
```

The delivery document is:

```json
{
  "delivery": {
    "summary": "Compatibility verified",
    "artifacts": ["src/api.ts"],
    "checks": [
      { "name": "Regression suite", "passed": true, "evidence": "test-result.txt" }
    ]
  },
  "evidence": { "criterion-1": ["test-result.txt"] }
}
```

Use the criterion identities returned by `show`. CLI reads and submissions
require an explicit terminal assignment. Submission moves work to `in_review`.
Reports for queued agent work must identify the attempt received in the prompt
(`links.queueItemId` in `show`), through `--attempt` or `attemptId` in the JSON.
An earlier attempt cannot submit a report for a later execution. The CLI never
fills this value from the latest task automatically. Manual work without a
queue identity keeps the existing submission contract.
The reported checks and references are evidence for the reviewer to inspect.
Explicit approval in the work panel requires evidence for every criterion and
passing validation with references. Reopening a review retains its previous
report and evidence. Submission alone does not complete work.

Each accepted submission records a separate delivery snapshot and the acceptance
evidence from that revision. A corrected report cannot overwrite an earlier
report. The work panel exposes previous snapshots under **Histórico de entregas**.
When upgrading a database without history, the most recent saved report is
recovered once; reports overwritten before this feature cannot be reconstructed.

The active `executorTerminalId` is separate from the list of participants who
can read the request and history. Only that executor can submit a CLI report.
Closing its process marks unsubmitted running work as `blocked` and records an
`interrupted` event. Closing a former participant does not interrupt current work.
Startup recovery runs in the application setup callback, after single-instance
ownership, and marks unfinished agent work for attention without replaying input.
Manual work with no agent assignment and reports awaiting review are preserved.
Queued work whose persisted prompt is missing becomes blocked with `queue_missing`
and requires review. Recovery never reconstructs or automatically resends it.
Running-work recovery commits before inspecting the queued prompt mirror, so an
unreadable queue cannot leave interrupted execution marked as running. An invalid
queue snapshot remains untouched and its recovery error is logged.
An explicit resend from the work panel requires confirmation, keeps the original
request and evidence, replaces its previous queue prompt and records `resumed`.
Explicit retry of an uncertain delivery reserves a fresh queue identity, rejects
the previous claim and retains the original request. Removing a pending linked
prompt cancels its queued or blocked task before updating the frontend mirror;
removing a stale prompt does not cancel work already running or awaiting review.

`queue_patch` executes on the ordered database lane and applies the caller's
observed before/after lists inside an immediate SQLite transaction. Items the
caller never observed remain in the queue. Changed records and FIFO order require
the observed version, with idempotent repeated edits accepted only when their
content matches. Duplicate identities, malformed records and per-terminal
capacity overflow are rejected before commit. Store mutations, delivery
reservations, acknowledgements and linked-task synchronization use this contract.
The frontend merges acknowledged records while preserving later local edits.
`enqueue` resolves only after native persistence acknowledges the prompt. The
composer and agent CLI callers await that result before claiming acceptance or
clearing a draft. Failed persistence retains the request. While a queue save is
pending, repeated composer submission is suppressed; an acknowledgement clears
only the unchanged submitted draft and does not close a newly selected destination.
Direct submission and manual handoff apply the same draft comparison after native
acknowledgement. A newer draft stays open, and focus changes only when the original
destination still owns the unchanged request. Focus resolves the current terminal
position instead of using the group and slot captured before delivery.

Reviewed plain retries use `queue_retry` with the observed attempt timestamp and
a fresh identity. Native persistence retains the authoritative request body and
FIFO position, and rejects a changed attempt, a pending item or linked task.
`queue_remove` also checks the reviewed timestamp for an interrupted delivery;
an active reservation cannot be removed without that observation. These commands
accept a persisted `sending` item after the renderer restores it as `uncertain`,
so reloading does not strand the recovery controls. Linked prompts use the task
transition first, and repeated removal of an already absent item is idempotent.
Queue removals and replaced attempts record `queue.retired.<id>` in the same
transaction. Later queue patches or task enqueues refuse an ended identity,
including across reloads and backups, instead of reconstructing consumed work.

Prompt injection sends `write_pty` with an explicit `submitPrompt` boolean. Rust
frames multiline pastes, flushes the text and completes Enter under one writer
lock. The operation continues after a WebView reload and cannot interleave a
second writer between paste and submission. `false` retains manual submission;
omitting the field preserves the raw keystroke protocol.

Codex token records retain the reported counters when pricing validation fails.
Known counters must be unsigned integers, cache categories must fit within raw
input, and each cumulative increment must satisfy the same budget. A malformed
previous total invalidates the next dependent increment even outside the displayed
day. Such usage remains visible but has no dollar estimate; known custom rates
cannot turn an inconsistent provider record into a valid cost.

Queue and routine delivery runs in the native scheduler. Pipeline stages also
belong to the backend and retain their own durable execution record. Renderer
reloads reconcile these records without replaying input. Legacy preference
adapters retain the prior frontend executors and conservative recovery.

### Previous terminal output

Starting from scratch preserves the previous active `.bin` before preparing the
new session. `Scrollback::fresh` is fallible: it claims a unique archive name
with an exclusive create, then moves the previous output there with a rename on
the same volume, so no bytes are copied. Only when the rename is refused (for
example, another program holds the file without delete sharing) is the output
copied to a temporary file, synced and renamed into place before the active file
is removed. Failure aborts before a child process is launched. Each terminal
keeps its 5 newest archives; older ones are deleted when a new one is written.
Resuming with `keepScrollback` retains the existing active output. Clearing the
active output leaves earlier session archives available.

**Histórico de saída** is available in Search and the terminal menu. The global
view also discovers archives belonging to removed terminal cards. Preview reads
at most 64 KiB from the end, starts at a UTF-8 boundary and removes terminal
escapes for display. Export preserves the complete raw ANSI record or produces
plain text; plain conversion is limited to 16 MiB. Larger records support raw
export. Export writes and syncs a separate temporary file before replacing the
destination, preserving an archived source referenced by an external hard link.

`pty_archives`, `pty_archive_preview`, `pty_archive_export` and
`pty_archive_delete` use the ordered `output-history` lane, independently of live
terminal input. Archive names identify their terminal and creation time; reads,
exports and removals validate that identity and accept regular files only.
Incomplete temporary archives are excluded from discovery and backup.

Removing a terminal for good (`forget_pty`) deletes its active `.bin` only; its
archives stay discoverable in the global view. They are not kept forever: at
startup, a background pass deletes archives older than 30 days (by the creation
time in their name) whose terminal no longer exists in the workspace database.
Archives of existing terminals follow only the 5-per-terminal rule. If the
terminal list cannot be read, that pass deletes nothing. Users can also remove
one selected record or preview records older than 30, 90 or 365 days and confirm
their removal. The default selects no period. Current output and other terminals'
archives are preserved when deleting a selected record. Manual backups include
complete archive `.bin` files with the same inventory integrity and restore
guarantees as the other managed files; automatic backups leave them out.

## 5. Persistence

```
%APPDATA%\Yard\
├── app.db                  # SQLite — structural state
├── scrollback\{ptyId}.bin  # append-only, compacted at 8 MB
├── scrollback-archives\    # completed output of previous sessions (5 per terminal)
├── partituras\{name}.json  # scores: saved group arrangements that can be reapplied
├── bin\                    # yard CLI (shims, yard-cli-<hash>.exe, yard.ps1) + bridge manual (YARD-BRIDGE.md)
├── logs\yard.log           # tracing + daily rotation
├── checkpoints\            # local task recovery archives and manifests
├── attachments\            # durable pasted images referenced by prompts
└── backups\                # .zip exports: manual (everything) and automatic yard-auto-* (light)
```

A manual backup export carries everything: the database, current and archived
output, scores, checkpoints and attachments. Automatic backups (`yard-auto-*`,
kept several times over by their retention count) are light: `app.db` (with the
preferences), attachments and scores, without terminal output, archived
sessions or code checkpoints. Entries that are already compressed (`.zip`,
`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) are stored instead of deflated again.

Backup export includes a versioned `manifest.json` with the byte count and
SHA-256 digest of every owned file, and a `folders` list naming the owned
folders the backup covers. A restore replaces exactly those folders (plus
`app.db`) and leaves the others as they are, so restoring a light backup keeps
the live output and checkpoints. A manifest without `folders` (written before
the list existed) covers every owned folder, and an archive without a manifest
replaces only the folders it carries. Manual backups use inventory version 1;
light backups use version 2, which builds from before the `folders` list refuse
instead of emptying the folders it leaves out. Import accepts legacy archives without a
manifest, validates SQLite integrity and migrates the staged workspace before
arming a restore, and rejects unowned
paths or names that alias on Windows. Validation runs before extraction.
Metadata JSON entries are limited to 16 MiB, other entries to 2 GiB, the
expanded archive to 4 GiB and the inventory to 100,000 entries. A failed import
retains any previously validated pending restore. Adoption prepares copies
before swapping files and records a durable journal. Interrupted, uncommitted
swaps are rolled back on the next boot; `restore-previous` and `app.db.bak`
retain recovery copies. A failed recovery that leaves a journal blocks opening
the disk database, rather than creating an empty replacement over recoverable
data. New archives record their source data root. After integrity validation,
managed image references in staged preferences, notes, workspace metadata, work
requests and scores are rebased to the restore destination. External project
references are preserved. Legacy archives without a source root retain their
existing references.

SSH transport normalization treats quoted prompts and folder names as data.
Only the generated environment prefix and its bridge forwarding are refreshed.
If the optional TCP listener is unavailable, that forwarding and credential
prefix are omitted so the remote agent can still launch. Maintenance of legacy
score files is best-effort and cannot replace a valid workspace connection with
an empty database.

Base schema of `app.db` (versioned migrations in `persistence/db.rs`):

```sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  -- Nullable since v7: a group with no project IS a board ("quadro"), the
  -- canvas as its own container, holding cards from several projects at once.
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, layout_json TEXT NOT NULL DEFAULT '{}',
  suspended INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL DEFAULT 0,           -- which pane, on the grid
  surface TEXT NOT NULL DEFAULT 'grid',      -- 'grid' (a tab) | 'canvas' (a card)
  title TEXT, kind TEXT NOT NULL,            -- 'shell' | 'agent'
  program TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL, resume_json TEXT,       -- how to resume (e.g. claude --resume <id>)
  sort INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_sessions (   -- index of what the agents save locally
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_path TEXT NOT NULL,
  external_id TEXT NOT NULL, title TEXT, updated_at INTEGER NOT NULL, cost_usd REAL
);
```

The canvas, the fronts, the routines and the roles live inside the group's
`layout_json` (`layoutJson.canvas`, `layout_json.floor`) — that is what let the
whole canvas fit with almost no schema. It is also what carries the model of a
project's children: a group with no `floor` (or `kind: "ground"`) is the
project's own root, and one with `kind: "isolated"` is a `git worktree` with a
branch of its own. Bare folder-groups are no longer created anywhere; the ones
already in the file (`kind: "plain"`) keep working and are shown as running in
the root. `floor.adopted` marks a worktree that was on the disk before the
front and must survive it. The golden rule of `normalizeFloor` applies: a
field it does not copy is gone on the next save, and this one decides whether
closing a front deletes a folder the app never made. The one column it did end up costing is
`terminals.surface` (schema v6): the canvas and the pane grid used to draw the
**same** terminals, and separating them needs each row to say which of the two
it belongs to. `layoutJson` carries the other half of the split —
`{ mode: auto|grid|spotlight, surface: grid|canvas }`, where `mode` used to hold
`"canvas"` as a fourth value and wiped the pinned grid every time the user
looked at the board (`src/lib/surface.ts`). Since 2026-09-02 `surface` is a
readout, not a choice: a board shows the canvas and a project's group its
panes (`surfaceOf`), the store enforces it on every write, and a terminal is
born on the surface of its group.

The second column it cost is `groups.project_id` becoming nullable (v7). A
group with no project is a **board**: one rule, so no second flag can disagree
with it, and every existing mechanism that hangs off a group — terminals,
canvas JSON, roles, routines, flows — keeps working on a board with no changes.
`projectOfGroup` and `rootOfGroup` already answered `undefined`/`null`, which
is why the blast radius was small. The one-way trip out of the old model is
`extractBoards` (`src/lib/boards.ts`): every group carrying a canvas with
something on it becomes a board named `<projeto> · <grupo>`, taking its cards
and drawings. Its board ids are **derived** (`board-<groupId>`), not minted, so
the migration is idempotent — `load` runs more than once.

Strategy: hot state lives in memory in Rust; snapshots go to SQLite with a
revision counter in `kv('workspace_rev')` — the backend **refuses** to save a
revision lower than the current one (protects against a lagging UI overwriting
newer state). `tauri-plugin-single-instance` guarantees a single process
writing.

### Editor drafts and file revisions

Editor autosave serializes acknowledged preference snapshots. The `write_prefs`
IPC command accepts `entries: [string, string][]` and writes all changed keys in
one SQLite transaction. `write_pref` remains available for individual settings.
Failed batches do not advance the writer's acknowledged snapshot. Existing
per-draft and aggregate size limits still apply.

Application close awaits `editorStore.flush()`, including edits made while a
write is pending. A failure keeps the window open and reports a toast. Draft
persistence does not write the user's source file; explicit file saving retains
the existing disk-conflict checks.

Git summary identity is separate from diff content revision. Watcher activity,
explicit refresh and mutations invalidate content and notify open diff views.
Superseded asynchronous reads cannot publish or clean up a newer request.

The project watcher uses bounded, nonblocking intake. A positive `dropped`
count also means the consumer must resynchronize: invalidate root diffs,
refresh loaded directories and clean open documents, mark dirty drafts stale,
and age or repeat the file index. Shared directory exclusions retain explicit
watcher/index differences.

### Reported cache duration in cost estimates

Codex records total input including cache reads and reported cache writes. Token normalization first
calculates the increment against raw cumulative totals, then separates cached
reads and writes from ordinary input. This keeps the category totals disjoint and prevents
charging cached tokens at both input and cache rates, matching the
[Codex usage formatter](https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs)
and the [OpenAI caching calculation](https://developers.openai.com/api/docs/guides/prompt-caching).

Custom rates are stored in `kv` under `pricing.customRates.v1`, separately from
the official reference. `pricing_settings_save` validates all five USD-per-million
categories and commits a compare-and-set revision in an immediate transaction.
Rates become active only after that transaction succeeds. Invalid persisted rates
produce a read error and are retained, rather than rewritten. Startup loads the
acknowledged settings before background services begin. Session reads reprice the
cached token ledger, daily history captures one rate snapshot for its result and
new live events use the active rates. Removing an override returns that exact
model to the reference table, or to an unpriced value when no reference exists.
Release overrides also apply to optional dated snapshots of that release; an exact
dated override takes precedence. Other releases do not inherit the price. Codex
session scans retain each turn's model across incremental reads, so a model change
does not retroactively change the earlier turn's rates.

The editor captures its reviewed revision when opened. A delayed earlier read
cannot replace acknowledged settings, and a stale editor cannot silently adopt
a newer revision. Custom rows are labelled separately and do not inherit official
source or verification metadata. The costs panel identifies active custom rates.

`pricing_reference` exposes the same rate table used by the estimator, including
version, provider, currency, API scope and per-model provenance. Current rows were
checked on 2026-10-06; three Claude 3 legacy rows are marked as inherited from
2026-08-12 instead of receiving a current verification date. Cache-read rates are
model-specific. Explicit release IDs and optional date suffixes match the table;
bare ambiguous family names do not select a later release's price. The frontend
reference store preserves the last acknowledged snapshot on errors and ignores
superseded reads. Its modal can be searched and returns to its parent costs panel.

Accepted Claude usage records retain `usage.cache_creation.ephemeral_1h_input_tokens`
alongside total cache writes, per model and per message ID. Session summaries,
incremental daily history and the live tail price reported one-hour writes at twice
base input cost, while the existing five-minute reference remains 1.25 times input.
The one-hour subtotal remains part of total cache writes. Inconsistent duration
totals remain unpriced. Duplicate API messages do not add duration counts twice.

Records without duration metadata retain the existing five-minute reference;
their actual cache lifetime cannot be reconstructed. These are reference-price
estimates, with unknown model prices represented as missing values and aggregate
costs presented as lower bounds. The public pricing and duration fields are
documented by the [Claude pricing reference](https://platform.claude.com/docs/en/about-claude/pricing)
and [prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

### Agent integration diagnostics

`agentCapabilities` describes the adapters implemented in Yard separately from
executable availability. Resume and continuation follow explicit catalog metadata;
transcript discovery, MCP configuration management, native hook injection and
account-limit reads describe the local Windows environment. Local catalog paths
and versions do not establish availability inside WSL or SSH. Settings shows this
scope beside the selected agent's integration table and offers an explicit refresh.

Agent discovery keeps the last catalog on failure, exposes pending and error
states and ignores results from superseded reads. A newer successful discovery
clears the error and supplies the current executable and version diagnostics.

### Native CLI hook state

Authenticated Claude and Codex hook requests update native automation state before
their acknowledgment. A closed or reloading page cannot delay the provider's hook.
The event stream and boot snapshot carry monotonic sequence numbers and the
original event time. A late snapshot cannot replace a newer permission, and an
old completion cannot become a fresh completion simply because the page reloaded.
Process startup and exit discard the previous native hook state.

The frontend applies native work and permission before inferring state from
terminal silence. A repeated attach to the same PID preserves that information;
a newly started process clears the previous process's state. The isolated native
check unloads the page, invokes the real authenticated CLI, and confirms hook
acknowledgments and the subsequent native snapshot.

`yard task show`, `history`, `link` and `submit` also execute natively. The authenticated
terminal must belong to the task's explicit assignments. Submission additionally
checks the current executor and exact attempt, retains immutable delivery history
and enters human review. A missing page cannot block the agent's request, report
or history reads. Workspace and canvas commands retain their frontend dispatcher.

Task links retain typed `front`, `flow`, `checkpoint`, `diff` and `pull_request`
references with an ID, optional root and display label. `task_link` requires the
current task revision; native CLI linking requires the current executor. Pull
request references accept HTTPS review URLs. Checkpoint and diff navigation use
the saved directory rather than the active project's directory. Removed fronts
remain recorded but cannot be opened.

Both bridge transports share 64 connection slots. Incomplete request reads and
unconsumed replies expire after five seconds. A slot remains owned through the
authenticated request and is returned when the connection closes.

### Native queue delivery ownership

The native preference transport submits a queue identity and destination to
`queue_dispatch`. Rust reads the authoritative head, commits a `sending`
reservation, claims its exact managed task, writes the complete prompt and
submission through one PTY operation, and only then removes and retires that
identity. The command shares the destination's input lane, while database locks
cover only the short persistence operations. Independent queue entries survive
every boundary. Invalid task references refuse persistence.

Reservations carry `owner: "native"`. A renderer reload preserves an active
native reservation and polls `queue_read` to reconcile its outcome without
replaying input. The in-memory operation registry distinguishes an active write
from a finished operation whose acknowledgment could not be recorded. The latter
requires review; native process startup also changes unfinished reservations to
`uncertain`. A failed managed input blocks only its matching execution attempt.
Legacy preference adapters retain the existing renderer delivery contract.

Queue selection runs in the native process, including while the page is
unloaded. The loop keeps a two-second cadence only while work is pending
(queued items without a delivery, an active flow run, or a due routine waiting
on a live terminal); otherwise it waits on a condition variable until the next
routine deadline, at most 30 s, and is woken at once by IPC commands that
changed the queue, a flow or the pause, by `save_workspace`, by the bridge
flow CLI and by hook, idle and exit events (`scheduler::next_wait`,
`scheduler::Wakeup`). `execution_resources` is skipped while the queue is
empty, and a repeated loop error is logged once until it changes or clears. One eligible head per terminal enters its existing
input lane. Pending lane jobs keep their identities reserved and the current
dispatch budget limits simultaneous input jobs to two. The configured global
agent limit (one through sixteen, default two) also counts active agent turns
and pending input jobs. A live executor with a durable task still in `running`
retains its slot and remains unavailable for automatic delivery until an accepted
report, cancellation or interruption changes that task state. Quiet output or a
completion hook alone cannot release an unreported managed execution.
Directory protection is enabled by default: canonical
initial working directories are held by active turns and pending jobs, and
selection reserves only one head per free directory.
Unconfirmed deliveries retain their live terminal's slot and directory until
explicit queue review, even when the readiness heuristic considers it idle.
Jobs recheck admission before and after checkpoint preparation. These limits control automatic queue,
routine and native flow execution (a flow stage only gets the slots left by
agents already busy with automation), and trigger prompts, which travel
through the queue tagged `source: "trigger"`; direct user input remains
available.

**Automation pause.** The kv record `automation.paused`
(`{"reason":"budget"|"quota"|"user","at":<ms>}`; anything that is not a JSON
object reads as running) stops every automatic sender. The native scheduler
delivers no queue item and enqueues no routine occurrence (queued work stays
queued), `flows::schedule` starts no new stage (a running one is still
observed), and the front end refuses trigger asks and the agent-to-agent
commands of the `yard` CLI. The page writes it when the daily budget is
exceeded (`budgetPauseAutomation`, default on) or when a provider's five-hour
window reaches `quotaPausePct` (default 90); only the user resumes it, from the
status bar, and a resumed reason does not pause again that local day
(`automation.resumedToday`). Agents without
native completion hooks use the existing quiet-output readiness heuristic.
Readiness combines live process
state, recent input and output, native hooks and a bounded permission-prompt scan.
The native adapter's frontend timer reconciles state without dispatching work;
legacy adapters retain their prior renderer scheduler.

The same native timer reads saved routine definitions. A due routine on a ready
terminal with an empty queue reserves one occurrence and its queue request in
one SQLite transaction. Execution records use definition-specific identities
under `routine.run.*`; they supplement the canvas instead of overwriting edits.
Delivery acknowledgment records `lastRunAt` in the transaction that retires the
queue request. Uncertain occurrences block automatic repetition and retain the
explicit reviewed retry contract. Pending occurrences are cancelled when their
definition is paused, removed, replaced or its group is suspended. Repeating
occurrences cancelled by the user wait for the next interval. A consumed one-time
routine must be explicitly rearmed with a fresh deadline. Repeating routines
run at least five minutes apart (`routine_due` clamps a smaller `everyMin`),
and a repeating routine missed by more than one full interval while the app was
closed is re-armed at startup instead of being caught up; a one-time reminder
is still delivered. `routine_snapshot`
reports the current execution result; the native frontend reads it only while
the routines sheet is open (on `routine://changed`), while legacy adapters
retain their prior routine timer.

Retired queue identities live in the `queue_retired` table (pruned after 30
days at boot, where saved `queue.retired.*` kv rows are moved into it), a
routine edit deletes the run record it superseded unless queued work still
references it, the checkpoint notice history keeps its newest 200 entries,
and `read_prefs` leaves out the internal prefixes `queue.retired.`,
`native.flow.run.`, `routine.run.` and `checkpoint.notice.`.

### Native pipeline execution

`flows.rs` freezes the accepted request, stage definitions and labels in
`native.flow.run.*` records. The native timer schedules one operation per flow on
its executor's input lane. A stage's full briefing, output baseline, process
identity and unique attempt are committed before its stamp reaches ConPTY.
Database locks are released during input. Process identity includes both PID
and creation time; a recycled PID cannot continue an earlier execution.

`flow_start`, `flow_snapshot`, `flow_cancel`, `flow_resume` and `flow_dismiss`
provide the interface contract. A typed first stage is appended and submitted
on the same input lane before subsequent keystrokes. Acceptance is acknowledged
only after persistence. An unconfirmed response never causes an automatic extra
Enter. The carry handed to the next stage keeps at most its last 8000
characters. The interface reads authoritative snapshots on `flow://changed`, ignores superseded reads
and preserves the current language for generated stage labels.

The task panel can start a connected pipeline with `taskId` and `taskRevision`.
Acceptance atomically binds its original request, executor and flow reference.
`links.executionId` identifies the task execution independently of individual
stage delivery attempts. Every reviewed resume gets a new execution ID, even
when another interruption occurs before input. Pipeline-owned interrupted work
cannot bypass review through the queue API, and another running task protects
its executor from pipeline acceptance. Cancellation propagates in both directions.

The final briefing asks the executor to submit structured evidence with
`yard task submit`. Finishing without that report records the received summary
for human review with no claimed validation results or criterion evidence.
Approval still requires evidence for every criterion and passing checks.

Authenticated `yard flow run`, `stage`, `status` and `cancel` execute natively.
Stage reads are assigned to the executor. Cancellation requires the executor
or an existing canvas connection. Status uses the saved run even after its
canvas definition changes. Other canvas commands retain their frontend routing.

Stage completion requires output newer than its baseline and a ready process.
Native hooks prevent advancement during work or permission requests; adapters
without hooks retain the quiet-output heuristic. The last summary is carried
to the next stage. A permission question pauses the stage. An hour without
output interrupts it for review instead of leaving silent work indefinitely.

A renderer reload does not stop execution. Backend startup or executor loss
preserves completed stages and marks the current stage interrupted. An
unacknowledged write becomes uncertain and is never sent again automatically.
Interrupted work reserves its live executor against automatic queue delivery
until reviewed. Resumption requires explicit confirmation, an observed attempt
and a fresh input window; it reissues only the current stage and retains the
original request and prior evidence. Cancellation and replaced executions reject
late acknowledgments. Dismissing a finished result persists its hidden state
without deleting the identity needed to reject stale actions.

### MCP configuration context

Project and local MCP mutations capture their source project. Their completion
can refresh or report an error only while that project remains selected. A new
project clears the previous project's rows immediately; a failed refresh within
the same project keeps its last successful listing. User-scope mutations refresh
the currently selected project because their configuration is shared.

Editors capture both the source root and a selection generation. Delayed secret
reads cannot replace a newer editor. Saving a project-scoped form after changing
projects refuses the write and preserves the form for review. The native MCP
check holds a real save acknowledgment, switches projects, and verifies both
configuration files and the visible listing after the acknowledgment completes.

The explicit connection check starts the selected local stdio command or opens
its configured Streamable HTTP endpoint. It negotiates initialization, sends
`notifications/initialized`, and reads the advertised tool list without calling
tools. Tool pagination is bounded to 32 pages and each message to 64 KiB. The
connection has a ten-second deadline. Stdio children belong to a Windows Job
Object and are reaped on completion or failure. HTTP requests retain the negotiated
session and protocol headers, accept JSON or SSE responses, and attempt session
termination with a bounded DELETE. Redirects are disabled. Failures return fixed
codes rather than remote bodies or configuration secrets. Configuration refreshes
invalidate the displayed diagnostic. Legacy separate-endpoint SSE and WebSocket
probes are not implemented by this check.

Protocol behavior follows the [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
and [transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

### Terminal chat topics and delivery recovery

Each terminal owns seven durable topics in `chat.terminal.<terminalId>` preferences.
Optional topic names retain their numeric CLI identity. Clearing messages preserves
the chosen name. JSON and Markdown exports include only the selected topic and its
attachment references, without copying unrelated conversations or attachment files.

The request and its turn identifier reach SQLite before PTY input. Delivery advances
from `sending` to `waiting` only after the input write completes. A failed write or
interrupted process retains the request as `uncertain`; hydration also changes a
saved `sending` reservation to `uncertain`. Reloading a still-live process preserves
its matching reply reservation. `yard chat reply` must identify the exact terminal,
topic and turn, including for a late reply after an unconfirmed write.

Interruption sends Escape but does not assert that the provider stopped. The user
reviews the terminal before releasing the reservation. Release restores the request
as a draft only when there is no newer draft, retains the original transcript and
never sends automatically. A reply received before release wins and is preserved.
Malformed saved data blocks editing instead of replacing the transcript with a
new conversation. Names, requests and exports travel with the existing backup.

Topics can reference a task explicitly assigned to their terminal. Association
checks the native assignment before persisting and refuses a choice made stale by
a topic switch. Each subsequent request and reply retains its original `taskId`,
so relinking a topic does not rewrite older work. The prompt points the agent to
`yard task show`; chat replies never transition, submit or approve that task.
The work panel derives related conversations from current associations and saved
message references. Opening one selects its exact topic and reveals its owning
card; a different pending topic or a removed terminal refuses navigation.

### Canvas item sizing

All canvas cards expose resize grips and a maximize/restore control. Resizing
changes world coordinates; camera zoom only scales the gesture's screen delta.
Media content fits inside the resized body without cropping or changing its
aspect ratio. Content clipping belongs to the card body so external grips stay
reachable. Selected vector shapes, lines, arrows and freehand strokes also have
resize grips; text retains its proportional corner scaling.

Box items may persist a `restore: { x, y, w, h }` rectangle in `layoutJson`.
Maximize retains all content metadata, and restoring returns the saved geometry
even after a camera move or workspace reload. Loading discards invalid restore
rectangles. Reconciliation includes restore geometry, including toggles that do
not change the displayed rectangle. Pinned items reject sizing gestures.

Sizing commits use the canvas undo history. Keyboard modifiers are read directly
from native events, preserving Ctrl+Z and Ctrl+Shift+Z. Native portals are covered
while another item is maximized so their child windows cannot obscure it.
