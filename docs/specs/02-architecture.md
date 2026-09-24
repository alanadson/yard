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

**Golden rule:** the UI **never** assumes that creating/destroying a component
creates/destroys a process. Mounted an `XTermView` → call `attach_pty`; if
scrollback came back, just repaint; if `None` came back, then and only then
`spawn_pty`. Closing a pane ≠ killing the process (that is an explicit action).
This is what makes HMR, reload and UI restarts painless.

### 4.1 The agent↔app bridge

The `yard` CLI talks to the app over a named pipe (one JSON line out, one
back) → `bridge://request` event → `src/lib/bridge.ts` answers via
`bridge_respond`. The Rust side is a dumb transport **on purpose**: all
workspace state lives in the frontend, and duplicating it in the backend would
create two truths. The connections drawn on the canvas are the access control:
an agent only reaches what is wired to it.

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
session's client or PowerShell); the next start finds the exe in place and
already scanned, so its probe is fast and it adopts the client.

**The limit of that gate.** The requester identifies itself by the
`YARD_PTY_ID` the app exported into that terminal's environment — and the
environment is something the child process controls. An agent that rewrites
the variable before calling the CLI takes on another card's address and, with
it, that card's connections. Closing that hole would require matching the PID
at the pipe's end against the PTY's process tree; until that exists, it is
worth stating what the bridge promises: it protects against **mistakes** — an
agent that gets lost and tries to talk to someone it shouldn't gets a
`"<name>" não está conectado a você` ("<name>" is not connected to you) —, not
against an adversarial agent. What sits on the other side of the gate is other
terminals of the same user, on the same machine, all already running with that
user's privileges.

## 5. Persistence

```
%APPDATA%\Yard\
├── app.db                  # SQLite — structural state
├── scrollback\{ptyId}.bin  # append-only, compacted at 8 MB
├── partituras\{name}.json  # scores: saved group arrangements that can be reapplied
├── bin\                    # yard CLI (shims, yard-cli-<hash>.exe, yard.ps1) + bridge manual (YARD-BRIDGE.md)
├── logs\yard.log           # tracing + daily rotation
└── backups\                # .zip export (db + scrollbacks)
```

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
watcher/index differences. See the [implementation record](../refactoring-2026-09.md)
for regression evidence and validation limits.

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
