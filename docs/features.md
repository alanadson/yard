# Yard in detail

Everything the app does today, phase by phase, with the design decisions that
shaped it. The short version is in the [README](../README.md); the roadmap that
produced this list is [spec 05](./specs/05-roadmap.md).

## What's done

**F0 — Bootstrap.** Undecorated window with its own title bar (drag,
minimize, maximize, close), dark theme, `tracing` writing to
`%APPDATA%\Yard\logs` with daily rotation, single instance.

**F1 — PTY engine** (`src-tauri/src/pty/`). The heart of it:

- Spawn via ConPTY (`portable-pty`), with an immediate `drop(slave)` — without
  it the EOF never arrives when the process dies.
- **UTF-8 boundary** stitched across `read()`s: the 0–3-byte tail of a split
  character is kept for the next read.
- **Scrollback**: 4 MB ring in memory + an append-only `.bin` that receives only
  the delta every 250 ms, compacted down to the last 4 MB once it passes 8 MB.
- **Coalescing**: ~16 ms/32 KB while the pane is visible, 450 ms while it's
  hidden; payloads sliced at 256 KB; 2 MB ceiling on the emit buffer with a
  visible warning when output is too fast to display.
- **Job Objects** (`KILL_ON_JOB_CLOSE`) attached at spawn — `kill` takes down the
  whole tree, and a Yard crash makes the OS do it on its behalf. Fallback to a
  process-tree walk and `taskkill` if the job can't be created.
- RAM gate before booting an agent (400 MB free, waits up to 45 s).
- Explicit exit states: `normal` / `killed` / `suspended` /
  `restarted` / `failed`.
- "Agent stopped" detector (idle ≥ 4.5 s after activity) → native Windows
  notification. Silence says *that* it stopped; the tail of the output
  (`src/lib/blocked.ts`) says *why*: a menu with the cursor under a question,
  a `(y/N)` or a `Password:` on the last line turn into **blocked** — a pulsing
  yellow badge, the question in the notification and priority in `Ctrl+Shift+A` —
  instead of the green "finished". It clears on its own when the process writes
  again. The two balloons have separate switches in **Configurações → Agentes**
  (Settings → Agents): turning off the "finished" one (the noisy one) doesn't
  silence the "blocked" one (the one that costs dead time to ignore).

**F2 — Workspace.** Projects → groups → terminals in the sidebar; grid with
`react-resizable-panels` in three modes (automatic, fixed grid of 1–6 panes,
spotlight); sub-tabs per pane; drag & drop of terminals between panes; search in
the scrollback; shortcuts (`Ctrl+T`, `Ctrl+B`, `Ctrl+1..6`, `Ctrl+Shift+P`,
`Ctrl+Shift+G`). `Ctrl+Shift+P` opens **Configurações** (Settings), a full-screen
view with a menu of categories — Interface, Terminal, Editor de código, Agentes,
Comportamento, Atalhos, Dados e backup and Extensões (Interface, Terminal, Code
editor, Agents, Behavior, Shortcuts, Data & backup and Extensions).

**F3 — Persistence.** SQLite with WAL and versioned migrations; `save_workspace`
with a **monotonic revision guard** (a lagging UI doesn't overwrite newer state);
debounced autosave; projects/groups/layout restored on launch; suspend a
terminal or a whole group while preserving scrollback; `.zip` backup
export/import; confirmation on exit while terminals are alive.

**F4 — Agents.** Detection of 8 CLIs, resolving npm's `.cmd`/`.ps1` shims
(`CreateProcess` doesn't execute `.cmd` — the resolver rewrites it to `cmd.exe /c`);
listing of local Claude Code and Codex sessions per project, resumed in one
click; token counting and cost estimate; watcher (`notify`) over the session
directories.

**How each CLI opens.** Every agent is described once in **Configurações →
Agentes** (Settings → Agents) — a strip of marks at the top, one panel
underneath — and what is said there reaches **every** way that CLI is born.
"Nova aba" is a grid of marks where **one click opens the tab**: it asks
nothing, because the answers already live here (and the two it used to ask that
are per-invocation, the destination and the folder, have a right answer with
nobody to ask — the pane that asked for the tab, and the project's own path).
The ways with no dialog at all — `yard recruit` on the canvas, a fan-out of
floors, a resumed session — get the same thing applied straight to their argv
and environment. Per agent:

- **The name and the role it is born with.** The name the tab and the card
  carry (empty = the CLI's own), and the responsibility handed over at launch —
  through `--append-system-prompt` where the CLI has one, typed in as the first
  message where it does not. The role also covers `yard recruit` when the
  command carries no `--role`; either can still be changed afterwards from the
  card's menu.

- **The fixed command line.** A switch for the flag that stops the CLI asking
  permission before each edit — each one spells it differently
  (`--dangerously-skip-permissions`, `--yolo`, `--force`…) — plus a free field
  for anything else (`--model opus`, `--add-dir ../api`; quotes group, as in a
  terminal). A flag the caller already spelled is not repeated: a role's
  `--append-system-prompt` wins over the fixed line's.
- **Where it runs: Windows or WSL.** In WSL the card is spawned as
  `wsl.exe [-d <distro>] --cd <windows path> -- <cli> …` — the bare command,
  because the `claude.cmd` shim npm installed on Windows does not exist inside
  the distro, and the project folder handed over as a Windows path for WSL
  itself to translate. The choice is only clickable when `wsl.exe` answers with
  at least one registered distro (`wsl_status`, which decodes the **UTF-16**
  output of `wsl -l -q`); the CLI still has to be installed inside that distro.
- **The conversation cache.** How long the already-processed context survives a
  pause: one hour keeps coming back cheap and makes each cache write dearer,
  five minutes is the opposite, and off reprocesses everything each turn. Those
  are the only lifetimes on offer, so there is no "expires in N minutes" box.
  Each CLI is asked in its own language, and the catalog only holds what its
  documentation states: **Claude Code** through the environment
  (`ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M`,
  `DISABLE_PROMPT_CACHING`), **aider** through flags (`--cache-prompts`, and
  `--cache-keepalive-pings 12` for the ~1 h version — its caching is off until
  asked). The environment is read at spawn and the flags are added at creation,
  so either way a change applies from the next start, not to a CLI already up.
  An agent with no documented knob keeps the row and says why — Codex caches on
  its own from ~1,024 tokens with no lifetime setting — instead of a control
  that would silently do nothing.
- **Whether it is offered.** Turning an agent off takes it out of the "Nova aba"
  grid and the fan-out list, and nothing else: it stays installed, stays
  configured on this screen, and `yard recruit --agent <id>` still finds it.

Stored in `kv` under `agents.defaults`, keyed by the catalog id — as the bare
line when that is all there is to say — so an agent you configured and then
uninstalled still has a row to be erased in.

**Agent role.** When opening a CLI you can say what it's in charge of: a role is
a short name (what shows on the card and the tab) plus the instructions that go
along at launch. Roles become a library — reusable by name, kept in just the
group or across all of Yard, with a color that tints the card. The instructions
do **not** become a file in your repository: they come in through the CLI's own
door (`--append-system-prompt` in Claude Code) or as the first message typed
into the terminal, as soon as it comes up and goes quiet. You can also give (or
change) the role later, from the card's menu, next to the tab or with
`yard role set` — then it's handed to the running process and stays on the
command line for the next ones.

**Canvas.** Two things, and they are separate on purpose.

*A group's other surface*, not a fourth layout mode: its own button in the
title bar, its own CLIs, and the Auto/Grade/Holofote you pinned for the panes
waiting untouched underneath. A CLI belongs to one of the two — one opened on
the board is a card and never a tab, one opened in a pane is a tab and never a
card — and taking the screen to either (the tree, the search, `Ctrl+P`) turns
the group to the right side first.

*A **quadro** (board)*, which is the canvas as its own container: it belongs to
**no project**, so it can hold cards from several at once — a Claude in `yard`
next to a Codex in another repo, each card carrying its own folder. Boards live
in their own section at the top of the sidebar, above `PROJETOS`, because they
are not inside any project; the tree below is where you pick which project a
new card runs in. A board has no panes and no floors — it is a board — and
"Nova CLI neste quadro" asks for the folder instead of inferring it, which is
the one question that only exists here. Modeled as a group with no project
(`terminals` still hang off it), so cards, wires, roles, routines, flows and
portals all work there unchanged.

An infinite canvas with pan/zoom (snaps to 100%), terminals as draggable,
resizable cards, freehand pen and shapes (roughjs + perfect-freehand), arrows,
text, sticky notes with light markdown, curved connections, eraser, undo/redo and
single-key shortcuts (`V H P E R O L A T N W C F`). One click on a note selects
it; a second (or a double-click) opens editing — so `Delete` keeps deleting
whatever is selected instead of becoming a text key. The board itself persists in
`layoutJson.canvas`; which surface each CLI lives on is `terminals.surface`
(schema v6). Zoom is `transform: scale`; only resizing a card touches the
ConPTY's rows/columns.

**What else the board holds.** Four node types beyond the CLI card, the note,
the portal and the flow:

- **Grupos** (`Ctrl+G`) — a named frame drawn *behind* what it holds; dragging
  it carries its contents, and frames nest. Membership is **geometric**, never
  a stored list of ids: a thing is in the frame when its box is inside the
  frame's box, so no delete, paste or `yard` call can leave the group pointing
  at something that is not there. The frame's body takes no clicks at all —
  only its title band and its border — because a group that swallowed clicks
  would make every card inside it unselectable. Deleting the frame is
  "desagrupar": the cards stay exactly where they are.
- **Fichários** — several notes in one node, behind a strip of tabs. A filed
  note **is still a note**: the fichário holds ids, not copies, so
  `yard note read/write/edit`, the wires drawn to that note (they anchor on
  the fichário), its lock and the global search all keep working on it. One
  note lives in at most one fichário, and deleting the fichário puts its notes
  back on the board rather than taking them with it.
- **Arquivos** (imagem, vídeo, PDF, áudio) — a file pinned to a place on the
  board. It stores an **address**, never bytes: a 300 MB video does not become
  300 MB of `layoutJson`, and the frames travel over the same `yardfile://`
  protocol the file viewer uses, so the webview fetches its own chunks and
  seeking works. Inside the project the path is relative to it (a score
  applied in another checkout still resolves); outside, the card carries its
  own root.
- **Árvores de arquivos** — the explorer as a card, with the four modes of the
  spec: **Lista**, **Grade** (thumbnails), **Alterações** (`git status`) and
  **Histórico** (the commit graph, lanes drawn from the `parents` links;
  `src/lib/gitGraph.ts`). More than one may sit on the same board and each
  keeps its own folder, open branches, mode and selection — which is why it
  does not reuse the side panel's tree, whose state is global by design.

Notes render **tables** and **images** as well: a relative image path resolves
against the project root, `data:` URLs (a pasted screenshot) are embedded, and
anything carrying another scheme is refused and left as plain text — note text
arrives from agents through the CLI, so a `src` is untrusted input.

**Search** (`Ctrl+P`). One box over everything that finds anything in the whole
workspace — not just the active group: agents and terminals (with the process
state right there), groups and floors, projects, everything on the canvas
(notes, portals, grupos, fichários, arquivos and árvores), files
changed/touched/already open, bench prompts and tasks, addresses the processes
announced, and the app's actions. Accent-insensitive, word-by-word search
(`novo term` finds "Novo terminal") with an acronym shortcut underneath (`ctc`
finds `CanvasView/TerminalCard`); the coverage rule is what keeps typing more
words from making the result worse. Prefixes narrow it down: `>` actions,
`@` agents, `#` canvas, `/` files. Picking a note takes the group to the canvas
and centers on it. The ranking math is pure, in `src/lib/search.ts`.

**Annotate the diff and hand it back to the agent.** In the diff viewer, the
`+` that appears in the gutter comments the line; the comment sits under it,
inline. The bar at the bottom counts the whole project's review (not just the
open file) and sends it to a live agent as a single message — grouped by file,
ordered by line, with the original line quoted. The annotations live in `kv`,
so they survive a reload mid-review. Format in `src/lib/review.ts`.

**Source control on the bench** (`Ctrl+Shift+R`). A fourth tab on the bench,
next to Arquivos, Tarefas and Prompts (Files, Tasks and Prompts), that **acts**
on the repository — the file pane only reads. Both look at the same `git status`
(the watcher's, debounced), so the tab doesn't cost a second `git` for every key
an agent types.

The list separates what most panes merge: **index and disk are two independent
sides**, and a file that was staged and then touched again shows up in both
groups, with different verbs and diffs. Conflict is a third group, and each of
git's six pairs (`UU`, `DU`, `UA`…) is spelled out — "both modified" calls for
a different resolution than "they deleted".

You can **stage, unstage and discard by hunk, and even by line**: opening the
row shows the diff of the right side (staged = `HEAD`→index; changes =
index→disk — the wrong comparison produces a patch that `git apply` rejects),
with one button per hunk and clicks on the `+`/`−` lines to pick less than that.
The patch is assembled in `src/lib/scmPatch.ts`: an unpicked `+` line vanishes,
an unpicked `−` line **becomes context**, and the `@@` counts are recomputed —
the three rules `git apply` enforces and nobody gets right the first time.

The rest is there: commit (with amend, which brings the whole message back —
subject *and* body), local and remote branches with each one's tracking, merge,
rebase, revert, the three resets, stash, tags, paginated history (including a
single file's) and a remote button that changes its name with the state —
"Publicar branch" (Publish branch), "Buscar" (Fetch), or `2↓ 1↑`. A merge or
rebase stopped midway announces itself at the top, with continue and abort, and
locks whatever can't happen before it. Every irreversible gesture goes through a
warning that says what, how many and what won't come back.

**Large repository.** The list comes out in pages of 200 files per group, with a
footer saying how many were left undrawn — and the two lists (Controle and
Revisão — Source control and Review) do the same. It's not laziness: each row is
four buttons, three SVGs and four tooltips, and a repository with three thousand
modified files went past seventy thousand DOM nodes, redrawn in full on every
click. The group buttons ("Preparar tudo", "Descartar tudo" — Stage all,
Discard all) still act on the **whole** list, not on what's on screen. The diff
opened on a row stops at 1,500 drawn lines, and says how many are missing — the
rest is seen in the viewer.

**Announced addresses.** What a process prints (`Local: http://localhost:5173`)
is read from the PTY output, with the escape sequences stripped first — a
colored port number arrives split in half. Only loopback and private networks
get in: a documentation link isn't "your app is here". The terminal card gets a
globe that opens that address in a **portal already connected to the agent** —
and a connection on the canvas is the bridge's access control, so the agent that
started the server can already drive the browser showing it.

**Browser in the pane.** Besides CLIs and files, a pane's tab bar opens an
**embedded browser**: the "Nova aba" (New tab) dialog (`+`, Ctrl+T) has a
*Navegador* (Browser) tile in the grid, alongside the CLIs — one click opens it
blank with the address bar focused. The grid is
"what this tab can be", not "which terminal", and it's where other tab types
come in later. The page gets the size of the pane, next to the CLI that's
building it. It's the same engine as the canvas portals — tab and card are two
faces of the same object — so it comes with everything: address bar, back,
reload, **live** on a local address (reloads when the dev server serves
something new), UA and cookie scope via right-click, `window.open` becomes a new
tab, and the session survives switching tabs and a restart (kv `panes.browsers`).
It's born at `about:blank` with the address bar focused — a new browser tab, no
modal in the way.

**Design mode in portals.** The crosshair button arms a picker inside the page
(on the canvas card and in the browser tab): the highlight follows the cursor
and the next click describes the element instead of clicking it (pointing at a
"Buy" doesn't buy). What comes back — CSS selector, classes, parent, text, box,
computed style minus the defaults, the HTML **and a PNG crop of the screen
around the element** (`portal_grab_shot`, captured before the composer covers
the page) — lands in the composer of the agent wired to that portal (or of the
focused terminal), ending in `O que muda aqui: ` (What changes here:) for the
user to complete. The agent opens the crop by the path in the prompt, just as it
does with a pasted screenshot. `Esc` inside the page cancels.

**Agent↔app bridge — the `yard` CLI.** Every terminal opened by Yard has the
`yard` CLI on its PATH. It talks to the app over a named pipe (one JSON line
out, one back): the Rust side is just transport, and all the intelligence lives
in `src/lib/bridge.ts`. **The connections drawn on the canvas govern who talks
to whom** — an agent only reaches what's wired to it. The gate protects against
mistakes, not against an adversarial agent: the caller identifies itself by the
`YARD_PTY_ID` in its environment, and a child process can rewrite its
environment (details in
[`docs/specs/02-architecture.md` §4.1](./docs/specs/02-architecture.md)).

- `list` / `ask` / `check` — talk to connected agents (`--file`/`--stdin` for
  multi-line prompts, since `cmd.exe`'s `%*` eats line breaks).
- `wait` — block until the other one stops, instead of repeating `check` in a
  loop. `--until stopped|done|blocked`, `--any`/`--all`, and `--fresh` to require
  new output before counting (the counterpart of `ask --no-wait`). It waits on
  the runtime mirror, so it wakes on the same event that paints the badge — it
  costs no tokens at all.
- `note create|read|write|edit|delete` — canvas notes as shared memory; note
  chains work. A note **locked** by the user refuses writes from the CLI.
- `connect` / `recruit` / `dismiss` — assemble the team on your own canvas.
  `recruit --replace "Old"` swaps a card's process while preserving position,
  connections and role. `recruit --floor "Floor"` makes the recruit spawn on the
  floor's canvas, with its worktree as cwd.
- `floor list` / `floor create` / `floor land` / `floor compare` / `floor fanout`
  — floors from the CLI. Creation is silent: the user's screen doesn't switch
  groups.
- `role` — a role per card and a library of reusable roles
  (`--scope global|current`). Setting a live agent's role hands it the
  instructions on the spot.
- `routine` — scheduled prompts, delivered only while the target is running and
  idle.
- `score` — save and reapply a group's entire arrangement (scores).
- `notify` / `debug` / `help`.

Claude Code discovers the CLI on its own: the app installs
`~/.claude/skills/yard/SKILL.md`. The other agents get the same manual at
`<data>\bin\YARD-BRIDGE.md`, pointed to by `YARD_BRIDGE_HELP` in the
environment. For Codex, `~/.codex/AGENTS.md` is the user's file and the app does
**not** touch it — if you want automatic discovery there, add this by hand:

```md
- Run `yard help` (the full path to the manual is in `$YARD_BRIDGE_HELP`)
  to collaborate with the other agents on the canvas.
```

**Prompt composer** (`Ctrl+Enter`). A floating box for writing a long prompt
outside the terminal — inside the CLI, Enter sends, and ten lines become ten
submits. The text goes out through the same injection as `yard ask` (bracketed
paste + separate Enter), so it arrives whole. `@Name` autocompletes among the
agents connected to the target and sends the same prompt to them too. The draft
is kept per destination and survives closing the app (kv `composer.drafts`, with
a half-second debounce — never one write per keystroke). *Out of scope:* pasting
a screenshot inline — there's no good way to shove an image into a PTY.

**Scores.** The group's arrangement (CLIs, positions, roles, notes, connections,
drawings, routines) saved as JSON at `<data>\partituras\<name>.json` and
reapplicable in another project with fresh ids. The working folder does **not**
go along: it comes from the target project. Group or project menu →
"Partituras…" (Scores…).

**Floors.** An isolated copy of the work per task: each floor is a
`git worktree` at `<project>\.yard\floors\<slug>` (branch `yard/<slug>` by
default), with its own group and canvas — the ground stays untouched. A
"camadas" (layers) button in the bottom-right corner of the workspace: create
(with the option to clone the ground's layout — terminals spawn stopped, with
the worktree as cwd), unload (suspends the PTYs, preserving the session),
**land** (preview of the merge onto the ground; refuses a dirty tree or a
predicted conflict; a merge that conflicts anyway is aborted) and close (refused
with uncommitted work; option to delete the branch). **Nova tarefa** (New task)
fires the same request on N floors, one agent each; **Comparar andares**
(Compare floors) shows the diffstat side by side and lands the winner (the
others from the same task are closed). Optional setup/run/teardown hooks run in
the worktree with `YARD_FLOOR_*` in the environment. The file pane and
`git status` follow the active group: on a floor, they show the worktree, not
the ground. The metadata lives in `layout_json.floor`; a project without git
still gets a "floor" (`kind: plain`), just without isolation. From the CLI:
`yard floor land`, `yard floor compare`, `yard floor fanout`.

**File editor, with a face for markdown.** Clicking a file in the tree opens
**a tab in the same bar as the CLIs**, the size of the pane: the file sits next
to the agent that's working on it, one click away, and not in a window over the
app (CodeMirror 6, language loaded on demand). On the canvas — which has no tab
bar — the same editor comes up as an overlay, and `Esc` tucks it away. Half of
what gets opened here is a document — a README, a spec, a plan an agent wrote —
and raw markup is the wrong way to read a document, so `.md` arrives with a
**formatting bar**, a **table of contents** and four modes: *Editar* (Edit — the
source, drawn: the `**` vanishes on every line the cursor isn't on, a task
becomes a checkbox, `---` becomes a rule), *Fonte* (Source — the raw text, as
the agent reads it), *Dividido* (Split — source on one side, page on the other,
scrolling together) and *Ler* (Read — just the page). The buffer is always the
file, character by character: what changes is the drawing, never what gets
written. The rendered page accepts tables, nested lists, tasks that tick with a
click, footnotes, images from the project itself (embedded by the backend as a
`data:` URL — the app's CSP doesn't let `<img>` fetch a file or an outside
address) and links: a relative one opens the file in another tab, a web address
opens as a portal on the canvas. The shortcuts are the same as the canvas
note's (`Ctrl+B`, `Ctrl+1..6`, `Ctrl+Shift+8`…), by physical key — the grammar
lives in one place, `src/lib/mdedit.ts`, and the document is parsed by
`src/lib/mddoc.ts`. HTML inside markdown shows up as source: this preview
doesn't execute what an agent wrote into a file.

**Anotações (Notes) — the markdown notebook (`Ctrl+Shift+N`).** Knowledge that
belongs to no project — decisions, studies, plans, bug recipes — gets a
notebook of its own, full screen, with three panes: **nestable notebooks** (with
an icon and a count for the whole branch), **colored tags** and **note status**
(active, on hold, done, discarded — resolved ones drop out of the everyday list
and come back through their own row or the list's eye icon) on the left; the
list with preview, task progress (`- [ ]`), relative date and pinned ones at the
top in the middle; and the note in the **same markdown editor as the files** on
the right (four modes, formatting bar, Mermaid/KaTeX through the extensions, an
image pasted from the clipboard embedded in the note). Search understands
qualifiers — `caderno:` (notebook), `tag:`, `status:`, `titulo:` (title), a
quoted phrase, `-term` to exclude — accent-insensitive and by substring, with
the hits lit up in the list. Everything saves on its own (SQLite, row by row,
debounced per note), the trash holds what was deleted until you decide, and
`.md` goes in and out via export and copy. Notes show up in Search (`Ctrl+P`) as
a section of their own, and the palette opens straight onto the note it found —
even if a filter would have hidden it.

## Golden rule

The UI is **never** the owner of process state. Mounting an `XTermView` calls
`attach_pty` first; if scrollback came back, it only repaints; it spawns only if
there's nothing there. Closing a pane doesn't kill a process — killing is an
explicit action. That's what makes HMR, F5 and switching layouts painless for an
agent in the middle of a task.

## Tests

Development here is by TDD — test first, in TypeScript and in Rust. The rule
and the cycle are in [`AGENTS.md`](./AGENTS.md); the recipe per layer, in
[spec 06](./docs/specs/06-tdd.md).

```powershell
npm test                   # vitest: bridge core, canvas, markdown (note and document)
cd src-tauri
cargo test --lib           # PTY engine, agents, persistence, bridge shims
```

About 180 tests in Rust. The ones in `pty::engine_tests` start a real PowerShell and
verify F1's acceptance criteria: output reaches the scrollback and the UI,
`write` executes, `kill` leaves no orphan anywhere in the tree, `suspend`
preserves history, `restart` reuses the id, and 6 MB of output don't overflow
the ring. `bridge::tests` pins the pipe name (it goes into every PTY's
environment — changing it would break terminals already open) and guarantees
the three shims + the absence of PowerShell 7 syntax in the `.ps1`.

Tests in vitest, over the promises the CLI makes to agents: name dedup
(`claude (2)`), note chains, the connection gate, the note name derived from the
first line, `normalizeCanvas` preserving the new fields (routines, presets,
locked note), `normalizeFloor` validating floor metadata and the notes'
markdown — and the document grammar in `mddoc.ts` (nested lists, tables, link
references, footnotes, front matter) with the formatting-bar commands on top of
it.

### ConPTY's `ESC[6n`

Discovered while writing those tests, and worth knowing: during the handshake
conhost emits `ESC[6n` (DSR-CPR) and **holds all of the application's output
until it gets the reply**. Whoever replies is the emulator on the other end —
xterm.js does it on its own, which is why the app works. A headless reader
hangs: the process stays alive, mute and stalled, with no error. The tests
include a minimal terminal that replies `ESC[1;1R`. If the F7 horizon of the
[roadmap](./docs/specs/05-roadmap.md) ever brings an emulator in Rust, it needs
to do the same.

## What's not done

- **Portals** — browser card on the canvas (tool **W**). The engine is **always
  WebView2**: the "Chrome", "Firefox" and "Edge" options in the picker (and the
  CLI's `--ua`) only swap the user-agent string, not the engine — whoever needs
  to reproduce an engine bug still has to open the real browser outside Yard.
  The agent drives it with `yard portal snapshot/click/fill/…`.
- **"Shoulder"** — a panel that summarizes what each agent did and suggests the
  next step from the session JSONL that `agents/sessions.rs` already reads.
- **Inline screenshots in the composer** — a deliberate decision: the CLIs
  expect a file path, and there's no good way to paste an image into a PTY.
- **F6 — Product.** No signed updater and no code signing yet: `release.yml`
  builds the NSIS installer into a draft release, but SmartScreen still asks
  once. The CSP is set (`src-tauri/tauri.conf.json`) and the Tauri capabilities
  are down to window controls, dialogs and notifications.

Validated end to end with the real app: boot → restore workspace from SQLite →
attach → spawn → live PTY → scrollback on disk → an app crash leaves no orphan.
UI interaction (clicking, dragging, resizing) hasn't been exercised
automatically — only the logic behind it.

## Cost estimates

The prices per million tokens are in `agents/sessions.rs` and were checked on
2026-08-12 (Opus 5: US$ 5/25; Sonnet 5: 3/15; Haiku 4.5: 1/5; cache write 1.25×
input, read 0.1×). A model outside the table gets no estimate at all — better no
number than a made-up one. **Check the table when prices change.**

## Usage-limit meter

The widget in the title bar shows how much is left of the Claude, Codex and Grok
usage windows. It reads the tokens the CLIs themselves keep on the machine and
queries **unofficial endpoints** of those services — none of the three publishes
an API for this. Practical consequences:

- It can **break without warning** when the provider changes or blocks the
  endpoint; in that case the widget disappears, the rest of the app is
  unaffected.
- Use is at your own risk under each service's terms. The tokens never leave
  the app's backend — the frontend only receives percentages and reset times.
