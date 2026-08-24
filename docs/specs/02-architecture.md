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
| `pty/scrollback.rs`                  | 4 MB ring in memory + append-only `.bin` with compaction ([PTY engine §2](./03-pty-engine.md#2-scrollback-4-mb-ring--append-only-on-disk)) |
| `pty/teardown.rs`                    | Shutdown states, exit watcher, registry cleanup                                                  |
| `process_tree.rs`                    | Parent→children map via `sysinfo` (2 s cache, threads filtered out), Job Objects                 |
| `agents/resolver.rs`                 | Discover the CLIs installed on Windows: `where`, npm `.cmd` shims, registry                      |
| `agents/sessions.rs`                 | Read the agents' local sessions (`~/.claude/projects/*.jsonl`, `~/.codex/sessions`…) for "resume" |
| `agents/tail.rs`                     | Tail of the agent's active session → `session://feed` event (feeds the "Ao Vivo" (Live) overlay) |
| `git.rs`                             | *Reading* the repository: `git status --porcelain=v2` (with both sides — index and disk — per file), per-file diff, the floors' worktrees |
| `scm.rs`                             | *Writing* to the repository (the "Controle" (Source Control) tab): stage/unstage/discard, commit, branch, merge/rebase/revert/reset, stash, tags, fetch/pull/push, `git apply` of a single hunk, per-side diff. Every path goes through `rel_paths` and every name through `check_branch_name` |
| `persistence/db.rs`                  | SQLite (bundled rusqlite), migrations, monotonic write guard                                      |
| `persistence/workspace.rs`           | Snapshot/restore of projects, groups, layouts and terminals                                      |
| `bridge.rs`                          | Named pipe for the `yard` CLI — transport of the agent↔app bridge                                |
| `watcher.rs`                         | `notify` on the agents' session files and on open files                                          |
| `resources.rs`                       | `sysinfo`: RAM/CPU per PTY tree, spawn gate, group suspension                                    |
| `paths.rs`                           | Central resolution of `%APPDATA%\Yard\…` (never scatter paths around)                            |
| `events.rs`                          | Topic names and typed payloads (a single place defines the contract)                             |

## 3. Frontend (`src/`)

```
src/
├── main.tsx · App.tsx
├── stores/            # Zustand — sliced by domain
│   ├── projectsStore.ts     # projects, groups, layout (persisted through the backend)
│   ├── terminalsStore.ts    # id → status/title/activity (mirror of the backend)
│   ├── changesStore.ts      # git status/diffs for the changes panel
│   ├── scmStore.ts          # "Controle" tab: header, branches, stash, history and the writes
│   ├── liveStore.ts         # reduction of the session feed ("Ao Vivo" overlay)
│   └── uiStore.ts           # theme, modals, focused pane, zoom
├── components/
│   ├── TitleBar/            # custom bar (decorations: false), min/max/close buttons
│   ├── ProjectSidebar/      # tree: projects → groups → terminals
│   ├── WorkspaceGrid/       # react-resizable-panels: automatic/grid/spotlight layouts
│   ├── CanvasView/          # the group's other surface: infinite canvas (cards, notes, drawing)
│   ├── TerminalPane/        # frame: title, sub-tabs, actions (restart/suspend/kill)
│   ├── XTermView/           # the xterm itself (attach, resize, input)
│   ├── Settings/            # Settings (Ctrl+Shift+P): category menu + full-screen page
│   └── modals/              # NewTerminalModal, ExtensionsModal, ScoresModal, RoutinesModal…
├── hooks/                   # useGlobalEvents, useKeybindings, useRoutines…
└── lib/
    ├── ipc.ts               # typed invoke/listen wrappers (the §4 contract in TS)
    └── bridge.ts            # the brains of the agent↔app bridge (see §4.1)
```

## 4. IPC contract (commands + events)

A single file of truth on each side (`events.rs` ↔ `lib/ipc.ts`). The core's
minimum set:

**Commands (`invoke`)**

| Command                                    | Input                                          | Output                                    | Note                                                           |
| ------------------------------------------ | ---------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `spawn_pty`                                | `{ id, program, args, cwd, rows, cols, env? }` | `Result<()>`                              | Goes through the RAM gate ([engine §4](./03-pty-engine.md#4-ram-gate-on-spawn)) |
| `write_pty`                                | `{ id, data }`                                 | `Result<()>`                              | Keyboard/paste input                                           |
| `resize_pty`                               | `{ id, rows, cols }`                           | `Result<()>`                              | Debounced on the front (~50 ms)                                |
| `attach_pty`                               | `{ id }`                                       | `Result<Option<String>>`                  | Returns the scrollback if the PTY exists; `None` = needs spawning |
| `kill_pty`                                 | `{ id }`                                       | `Result<()>`                              | Kills the **tree** (Job Object)                                |
| `suspend_pty`                              | `{ id }`                                       | `Result<()>`                              | Kills while preserving scrollback + resume metadata            |
| `restart_pty`                              | `{ id }`                                       | `Result<()>`                              | kill + respawn with the same command/cwd                       |
| `list_ptys` / `pty_exists`                 | — / `{ id }`                                   | snapshot / `bool`                         | Reconciliation after a UI reload                               |
| `get_pty_tree_info`                        | `{ id }`                                       | `{ pids, rssMb, cpu }`                    | Feeds the resources HUD                                        |
| `save_workspace` / `load_workspace`        | JSON snapshot                                  | `Result`                                  | With a monotonic revision guard                                |
| `detect_agents`                            | —                                              | `[{ id, name, bin, version, resumeCmd }]` | CLI detection                                                  |
| `list_agent_sessions`                      | `{ agent, projectPath }`                       | sessions to resume                        | Parsers for `~/.claude`, `~/.codex`…                           |
| `read_prefs` / `write_prefs`               | kv                                             | kv                                        | The SQLite `kv` table                                          |

**Events (`listen`)**

| Topic                 | Payload                       | When                                                                  |
| --------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `pty://output/{id}`   | `{ data: string }`            | Output chunks (coalesced ~8–16 ms; 450 ms if the pane is hidden)      |
| `pty://exit/{id}`     | `{ code?: number, reason }`   | Root process exited (`reason`: normal/killed/suspended/restarted)     |
| `pty://activity/{id}` | `{ lastByteAt }`              | Heartbeat for the "agent finished" detector (idle ≥ 4.5 s)            |
| `agents://changed`    | —                             | The watcher saw a new/updated agent session                           |
| `session://feed`      | session entries               | Tail of the agent's JSONL ("Ao Vivo" overlay)                         |
| `resources://tick`    | `{ totalRssMb, perPty }`      | Every ~2 s, for the HUD and the supervisor                            |
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
├── bin\                    # yard CLI + bridge manual (YARD-BRIDGE.md)
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

The canvas, the floors, the routines and the roles live inside the group's
`layout_json` (`layoutJson.canvas`, `layout_json.floor`) — that is what let the
whole canvas fit with almost no schema. The one column it did end up costing is
`terminals.surface` (schema v6): the canvas and the pane grid used to draw the
**same** terminals, and separating them needs each row to say which of the two
it belongs to. `layoutJson` carries the other half of the split —
`{ mode: auto|grid|spotlight, surface: grid|canvas }`, where `mode` used to hold
`"canvas"` as a fourth value and wiped the pinned grid every time the user
looked at the board (`src/lib/surface.ts`).

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
