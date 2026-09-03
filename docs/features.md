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
`Ctrl+Shift+G`). `Ctrl+Shift+P` opens **Configurações** (Settings), a centered
window with a menu of categories — Interface, Terminal, Editor de código, Agentes,
Comportamento, Atalhos, Dados e backup and Servidores MCP (Interface, Terminal,
Code editor, Agents, Behavior, Shortcuts, Data & backup and MCP servers).
Everything that ships with the Yard switched off — the colour themes, the file
icon themes, the minimap, Prettier, Mermaid, KaTeX, the images in the terminal
— is a row on the page of the surface it changes. There was a store shelf of
its own (`Ctrl+Shift+X`) until 2026-08-27; it was retired, and its switches
moved into Configurações with the state they were in.

**Status bar.** The window's footer reads the whole workspace at once, not
only the group on screen: agents *waiting on you* (yellow, pulsing — the chip
is a button and runs the same tour as `Ctrl+Shift+A`), running and finished;
the active project's branch (the front's worktree branch when on a front) with
the changed-file count and `+/−` line totals, opening the Controle tab; any
flow still walking, opening its card on the canvas; and RAM pressure with the
sidebar HUD's thresholds (`src/lib/ramPressure.ts`, shared by both). On the
right, the three surfaces that had no button until then: Busca (`Ctrl+P`), the
prompt composer (`Ctrl+Enter`) and the shortcut map (`Ctrl+Shift+H`).
Right-click gives the same map the title bar's menu offers — with the bar's own
entry on it — and **Configurações → Interface** hides it; the Busca action
"Barra de status" toggles it too. The readings are pure functions
(`src/components/StatusBar/statusBar.ts`) so each rule — a blocked agent is
*also* `finished`, an exited process still has a row — is locked by a test.

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
fronts, a resumed session — get the same thing applied straight to their argv
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
- **Where it runs: Windows, WSL or SSH.** In WSL the card is spawned as
  `wsl.exe [-d <distro>] --cd <windows path> -- <cli> …` — the bare command,
  because the `claude.cmd` shim npm installed on Windows does not exist inside
  the distro, and the project folder handed over as a Windows path for WSL
  itself to translate. The choice is only clickable when `wsl.exe` answers with
  at least one registered distro (`wsl_status`, which decodes the **UTF-16**
  output of `wsl -l -q`); the CLI still has to be installed inside that distro.
  Over SSH the card is spawned as
  `ssh.exe -tt <host> "cd '<remote folder>' && exec <cli> <args…>"` — the same
  bare command, the folder now the *remote* one typed in Settings (empty = the
  login shell's home), every argument single-quoted for the POSIX shell on the
  other side (a role brief with spaces stays one argument), `-tt` because a
  ConPTY is a pipe from ssh's point of view and the CLIs want a tty, and `exec`
  so the exit banner means the CLI and not a shell that outlived it. The host
  is whatever `ssh` itself reads — an alias from `~/.ssh/config` (offered in
  the field; `ssh_status` reads the `Host` lines, skipping wildcards, `Match`
  blocks and `Include`) or `user@host`. The choice is only clickable when an
  `ssh.exe` exists on this machine.
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

**Canvas.** The canvas is the **quadros** (boards), and nothing else.

*A **quadro** (board)* is the canvas as its own container: it belongs to
**no project**, so it can hold cards from several folders at once, a Claude
in `yard` next to a Codex in another repo, each card carrying its own folder.
Boards live in their own section of the sidebar, shown while the user is on
the canvas side, and the **Canvas** row above the tree (under **Busca**) is
the door: it opens the board visited last (else the first, else it makes one)
and, pressed on the canvas side, comes back to the project's group the user
left. The canvas is a **side** of the app (`canvasSide` in the store), not a
property of the active group: deleting the last board leaves the user there,
with the boards section empty and the workspace asking for a new board, never
on the projects tree. A board has no panes
and no fronts, and "Nova CLI neste quadro" asks for a **folder** instead of
a project, offering the last card's, which is the one question that only
exists here. Modeled as a group with no project (`terminals` still hang off
it), so cards, wires, roles, routines, flows and portals all work there
unchanged.

*A project's group has no canvas.* It shows its panes, and only its panes,
with the Auto/Grade/Holofote you pinned; the surface is derived from what the
group is (`surfaceOf` in `src/lib/surface.ts`), never flipped, and a CLI is
born on the surface of its group: a card on a board, a tab in a project.
Taking the screen to a CLI (the tree, the search, `Ctrl+P`) is a change of
group. What is project-bound stays off the board: the changes panel and the
bench, with their two doors in the title bar and their shortcuts, leave while
a board is up; the fronts control stands in the status bar under a project's
group; `yard recruit --floor` opens a tab of the front; a score (partitura)
is saved from a board and lands on a board, in the folder of its last card.
On the first boot after the change, a group that was showing its canvas comes
out as a board with its cards, and every project's group goes back to its
panes (`extractBoards` in `src/lib/boards.ts`).

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
state right there), groups and fronts, projects, everything on the canvas
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

Any row also opens **as a tab beside the CLIs** — `ScmPane.tsx (Alterações)`,
`(Preparado)`, or `(64726be)` for a file inside a commit — the way VS Code's
diff editor does, from the row's hover button or its menu ("Abrir o diff numa
aba"). The tab is a document without a file behind it (`OpenDoc.diff`,
`src/lib/diffTab.ts`): read-only, dragged and restored like any other tab, and
it follows the repository — every write of the Source Control tab and every new
`git status` re-read it, so the diff keeps up with the agent. Unified or side
by side, whole-file context and wrapping are the review viewer's own settings.

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
  connections and role. `recruit --floor "Frente"` makes the recruit spawn on the
  front's canvas, with its worktree as cwd.
- `floor list` / `floor create` / `floor land` / `floor compare` / `floor fanout`
  — fronts from the CLI. Creation is silent: the user's screen doesn't switch
  groups.
- `role` — a role per card and a library of reusable roles
  (`--scope global|current`). Setting a live agent's role hands it the
  instructions on the spot.
- `routine` — scheduled prompts, delivered only while the target is running and
  idle.
- `trigger` — "when X happens to a CLI, do Y": `--when finished|blocked|exited
  --on "Agent"|any`, then `--ask "Target" "prompt"`, `--notify "text"` or
  `--flow "Flow" "task"`; `{name}` and `{ask}` in the text become who fired and
  the question it stopped at. Same gate as `ask`.
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

**A project's children are branches, not folders.** What hangs off a project
in the tree is the **ground** (the project's own root, on whatever branch is
checked out there) and its **fronts**, a `git worktree` each. "Novo grupo",
which made a bare sibling of the ground sharing its files and its branch (the
same working copy under two names, with nothing on screen saying so), is gone
from every door: the project row's button, the project menu and the group menu
all open "Abrir frente" now. The ground row **is** its branch: it prints the
branch checked out at the project root and cannot be renamed in the tree, since
the name is git's and `git branch -m` (in Controle) is what moves it. A front
keeps the name of its task, with its own branch beside it. Both come from one
`git worktree list` per project (`stores/worktreesStore.ts`), which also names
the branch of the root; the rule is `groupLabel`/`isBranchNamed` in
`lib/floors.ts`, shared by the tree, the title bar crumb and the fronts
popover.

**Where a CLI is born.** "Nova aba" carries a destination picker built by
`lib/destination.ts`: the ground (with its branch), each front (with its own),
every worktree of the repository the Yard has not opened yet, and "Nova
frente…". With nothing chosen the ground wins: a CLI asked for with no branch
and no worktree runs in the project's root. The folder the process is spawned
in is the destination's own, which is the promise the dialog used to break: a
CLI opened inside a front ran in the *project's* root, so the tab said
"fix-login" and the agent edited the files of `main`. Picking a free worktree
adopts it as a front on the spot.

**Fronts.** An isolated copy of the work per task: each front is a
`git worktree` at `<project>\.yard\floors\<slug>` (branch `yard/<slug>` by
default), with its own group, and the ground stays untouched. It opens on
its panes: "Clonar o layout do chão" copies the ground's *grid* — which
CLIs, in which pane, in the bar's order, under the same Grade/Holofote —
stopped and rooted at the front's worktree (`lib/groundClone.ts`). A front
has no canvas (the canvas is the boards), and opening a front never takes
anybody there.

"Abrir frente" is where a project grows one, and it does not write anything
while it is open. Every keystroke asks the backend what it *would* do —
`worktree_preflight`, a read-only command that resolves the base to a commit,
runs the name past `git check-ref-format`, says where a branch is already
checked out and whether the folder is free — and `lib/provision/plan.ts` turns
that, plus what the app knows about its own fronts and agents, into the plan
block at the foot of the dialog: for every row, the commit it grows from, the
branch, the folder, and every reason it would be refused. Read it and walk
away and the repository is exactly as it was found.

The shape is one column, and the order is the order a person decides in:
which project (a picker, so opening a front somewhere else is not "close
this, find the project, open it again"), where it runs, what the front is
called or what it is made from, which agent, what to ask of it. Everything the
app fills in correctly on its own, the branch, the base, the folder, the setup
commands, sits behind "Avançado", because a value that is derived is not a
question. `Ctrl+Enter` confirms, and the chord is printed on the button so it
can be found without being looked up. A batch still gets the three rail
workbench, and the switch that turns one into the other sits in the footer,
beside the button it changes.

**Nome ou origem.** The dialog asks one question in the middle, with two ways
of answering it. **Nome**: type one, and the front grows a branch of its own
off the ground's branch. **Branch**: point at one, and it is where the front
*starts from*, which is the answer the old form could not give without typing
a base by hand. Under the branch sits one checkbox, **"Reutilizar a branch"**,
and it is the whole model: unchecked, a new branch grows from the one you
picked; checked, the front is opened on that branch itself, wherever it
already lives.

Where it lives is the only thing that changes what "reuse" means, and the
picker says it in the heading above each branch. Free: the front checks it out
in a worktree of its own. On the ground: git gives no second worktree to the
branch the project root has open, so the front *is* that copy, nothing is
created, no branch is swapped, and the warnings say the agent is about to edit
the files you have open. In a worktree already on the disk: that worktree is
adopted, nothing is written, and closing the front never deletes it
(`layout_json.floor.adopted`). In another front: the checkbox is held down and
says why, because taking it would pull the files out from under whoever is
working there; growing a new branch from it is still fine, and stays offered.

There is no tab for "worktree" any more, and that is the point. The four
shapes still exist in the model (`TargetKind`, and the plan is built from
them), but they are outcomes, not questions: a person picking a place to work
should not have to know which git noun the app is about to use. The matrix
under "Criar vários" still names them directly in its own column, because a
table with a row per agent has no room for a picker with a checkbox under it,
and it is read by somebody who already knows what the four words mean.

**What a front is born with.** A fresh worktree is a clean checkout, and a
clean checkout is missing everything the repository ignores (the `.env`, the
local config), so the CLI opened there starts in a project that cannot run.
A `.worktreeinclude` at the repository root (the same file other worktree
tools read) names the paths that have to travel with every new front: literal
files and folders, anchored at the root, and **only the ones git ignores**:
carrying an untracked file git would show turns the front dirty the second it
is born. Globs, negations, `..` and absolute paths are dropped rather than
guessed at, and a failure to copy is a log line, never a front that fails to
exist. The branch is created with `--no-track` (a front is a place to work,
not a mirror of its base), so the front also gets `push.autoSetupRemote=true`
unless the person already answered that question somewhere: without it the
first `git push` an agent runs inside a front dies asking for an upstream.
On Windows the checkout carries `-c core.longpaths=true` at command scope
(never written to anybody's config): a front lives two folders below a ground
that already fits, and that is where a deep repository crosses MAX_PATH. And
`git worktree add` has a deadline of 180 s, stretchable with
`YARD_WORKTREE_ADD_TIMEOUT_MS` and never shrinkable, because a folder backed
by a cloud sync can stall a checkout for as long as the service likes, and the
journal is what makes killing it safe.

"Criar vários" turns the dialog into a matrix: one row per agent, each with
its own destination, base, branch, folder and request, named from a pattern
(`exp-{agent}-{index}`) that is made unique as it expands. The collisions git
cannot see are caught here — it is asked one row at a time and tells all four
rows asking for one branch that the branch is free.

Confirming hands the plan to `lib/provision/batch.ts`, and the dialog becomes
the progress screen instead of vanishing: one row at a time (they share a
repository, and git serialises `worktree add` anyway), each phase named, with
"cancelar o que falta", "tentar de novo" for the failed rows only, and
"abrir". Every effect is journalled before it happens, so a failure undoes
only what *this* operation wrote — never "the folder at that path", which may
be a week old. A branch it created is deleted through
`git update-ref -d <ref> <old-oid>`, git's own compare-and-swap: the moment an
agent has committed, the OID no longer matches, the branch is kept and the row
ends in `precisa de limpeza` with a sentence, never in silence. An agent that
fails to start does not take its front down with it — the worktree is built,
and "tentar de novo" reuses it. What to do with the rows after a failure is a
choice, not a default buried in a `catch`: carry on, stop the ones that have
not started, or undo the ones already created.

A "camadas" (layers) button in the bottom-right corner of the canvas, beside
the camera, and only there — off the board that corner belongs to the code
editor's footer, and a front is something you move between boards: open (with
the option to clone the ground's layout, with terminals spawned stopped in the
worktree's cwd), unload (suspends the PTYs, preserving the session),
**land** (preview of the merge onto the ground; refuses a dirty tree or a
predicted conflict; a merge that conflicts anyway is aborted) and close
(refused with uncommitted work; option to delete the branch, which is a
request and not a promise: the delete is `git branch -d`, so a branch holding
commits the ground does not have is kept and said out loud). **Nova tarefa**
(New task) fires the same request on N fronts, one agent each; **Comparar
frentes** (Compare fronts) shows the diffstat side by side and lands the winner
(the others from the same task are closed). Optional setup/run/teardown hooks
run in the worktree with `YARD_FLOOR_*` in the environment, and what happens
when the setup fails is its own choice: hold the agent back, warn and start it
anyway, or skip the setup entirely. The file pane and `git status` follow the
active group: on a front, they show the worktree, not the ground. The metadata
lives in `layout_json.floor`; a project without git still gets a "front"
(`kind: plain`), just without isolation, the one case that still ends in a
folder, and the dialog says so before the click. From the CLI:
`yard floor create --adopt PATH`, `yard floor create --dry-run/--json`,
`yard floor land`, `yard floor compare`,
`yard floor fanout`.

**What the server knows about a front.** Nothing here pushes on anybody's
behalf: a front's branch is born with `--no-track`, landing is a local merge,
and neither of them reaches the remote. What the fronts do say now is where
that leaves each branch. The popover reads one `git for-each-ref` per project
and prints it on the row: `só aqui` for a branch that exists on this disk
only, `N por enviar` for one holding commits the server has not seen,
`publicada` when the two agree, `sumiu do servidor` when the upstream was
deleted somewhere else. The ground answers for its own branch too, which is
what makes an "aterrissar" nobody has pushed yet visible. Closing a front can
take the published copy with it (`git push <remote> --delete`), and only ever
after the local delete really happened: `git branch -d` refusing means the
branch holds commits the ground does not have, and then the copy on the server
is the last place that work exists. "Abrir frente" reads the same listing to
say when the chosen base is behind its upstream, or is a remote-tracking ref
as new as the last fetch, with a "Buscar do servidor" beside the sentence: the
dialog is the last moment when fixing that costs nothing, and after the front
is born it is a rebase. The rules are pure, in `lib/floorSync.ts`.

There is one door and no way round it. `yard floor create`, "Nova aba"
adopting a worktree and the fan-out all go through `lib/provision/run.ts`, the
same road the dialog takes, so the preflight, the collisions between rows, the
base frozen as a commit and the journal belong to every caller instead of to
one. A plan that is not valid never reaches the effects, whoever asked.
`--dry-run` stops after the plan and writes nothing; `--json` prints that same
plan (or result) with stable error codes rather than a Portuguese sentence a
script has to grep; the exit code separates "all done" (0) from "the plan was
refused" (2), "partial" (3), "something this run made is still on the disk"
(4) and "cancelled" (5).

At boot the app checks what it believes about its fronts against
`git worktree list` and the disk (`lib/provision/reconcile.ts`). A front whose
folder somebody deleted while the app was closed is marked orphaned; one whose
folder is there but git no longer lists is `repair_required`
(`git worktree repair`); a worktree nobody opened is offered for adoption; an
entry pointing at a folder that is gone is named as prunable. It reads and
reports, and it never prunes, adopts or removes: by then the journal that
would say what belonged to whom is gone with the process that wrote it, and
"the folder looks like ours" is a guess.

**File editor, with a face for markdown.** Clicking a file in the tree opens
**a tab in the same bar as the CLIs**, the size of the pane: the file sits next
to the agent that's working on it, one click away, and not in a window over the
app (CodeMirror 6, language loaded on demand). With no group open, a project
whose panes were all closed, the welcome screen on, the click makes the group
instead of falling back to a window: there is always a bar for the tab
(`lib/docHost.ts`). On the canvas, which has no tab bar, the same editor comes
up as an overlay, and `Esc` tucks it away. Half of
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
doesn't execute what an agent wrote into a file. The chrome around the text is
a **document header** rather than a toolbar: the path reads as a title (folder
dimmed, name lit) and clicking it opens the file's menu — save, reload from
disk, copy path, show in folder, line wrapping, close — while the row keeps
only the four modes, the outline and search; *Salvar* appears with the first
unsaved keystroke and leaves with the write. The formatting bar is a floating
capsule in the page's top margin, the same instrument the canvas note wears.

**Where you were, and where you are.** Every teleport the editor had (`Ctrl+P`,
`F12`, a hit in the project search, a `Ctrl+click` on a path the build printed)
was one-way. **`Alt+←` goes back** and `Alt+→` forward, on the browser's model:
a trail behind, a trail ahead, and a jump from the middle of the trail
abandons the part ahead. Only travel joins the trail, never the arrow keys
walking a function (`src/lib/navHistory.ts`). Switching tabs preserves the
scroll position as well as the caret and the undo history, the fold state
outlives the window, and the document header shows the **symbols the caret is
inside** (`class Fila › push`), each one clickable.

**Line marks.** `Ctrl+F2` marks the line and `Alt+F2` walks the marks of the
file (`Shift+Alt+F2` backwards, both wrapping). The mark is painted on the
line number itself, so it costs no width; the set survives a restart
(`src/lib/bookmarks.ts`). **Column guides** are free text in Configurações
("80, 120"): faint rules at the columns you name, and nothing at all when the
field is empty.

**The git calha does something now.** Clicking one of its marks opens what the
line **was**, right under it, with *Reverter este trecho* and *Copiar o do
HEAD*; `Alt+F5` walks from one change to the next (`Shift+Alt+F5` back). The
revert writes the smallest change that undoes the hunk, so it is one undo step
and the caret stays put, and it refuses outright when the hunk no longer fits
the buffer. From the file's own menu: **Comparar com o HEAD**, and **Comparar
com o salvo**, the one comparison git cannot answer, built in the front end
from the two texts already in the store (`src/lib/unified.ts`).

**The tabs.** `Ctrl+Shift+T` reopens the last file tab you closed, in the pane
it was in and as the comparison it was showing. A tab can be **pinned** (kept
at the front of the bar and left alone by every "close the others"), and a
single click on the tree opens a **preview** tab, drawn in italic, that the
next single click replaces: browsing a tree of four thousand files no longer
costs one tab per file glanced at. Typing in it, or a double click on the tab,
makes it permanent. The tab's menu also closes every saved tab, reveals the
file in the tree, renames it and deletes it.

**Quick fixes, and the problems of the whole project.** `Ctrl+.` asks the
language server what it can do about the line under the caret and applies what
you pick, in this file and in the others the fix touches (which are left
unsaved, for you to read). Only actions carrying an edit are offered: an entry
that looks like a fix and does nothing is worse than a shorter menu. The
**Problemas** tab of the bench lists what every server has found across the
project, not only in the files that happen to be open, worst file first, with
a filter for errors alone. The outline rail reads `documentSymbol` from the
server when one is answering, and falls back to the regex outline when none
is; `:` in the Busca finds a symbol anywhere in the project
(`workspace/symbol`), asked only of the servers already running.

**The project search grew up.** Regex, an include list and an exclude list
(globs: `*.ts`, `src/**`, `**/*.test.ts`), and **Substituir tudo**, which
rewrites exactly what the result list showed. It refuses to run from a list
that stopped at a cap: a truncated list is shorter than the truth, and a
replace from it would rewrite files that were never on screen. Search and
replace share one compiled matcher, so they cannot disagree about what
matched; the replace works line by line, keeps each file's own line endings,
and never rewrites a file that is not valid UTF-8.

**Line endings and encodings.** The footer's `LF`/`CRLF` is a button: pressing
it chooses what the next save writes, and the tab goes dirty like any other
change. The file menu reopens the file in **UTF-8, UTF-16 LE, UTF-16 BE or
Windows-1252**, and the save writes it back in the same one rather than
quietly turning every file into UTF-8, refusing outright when a character
would not fit. UTF-16 is recognised from its BOM (and is no longer mistaken
for a binary because of the zero bytes); Windows-1252 is never guessed, only
chosen, because it decodes any byte sequence at all.

**Snippets.** A short table per language (JavaScript/TypeScript, Rust, Python,
Go) under everything else in the completion list: a server's suggestion is
about this project, a snippet only about the language.


**Anotações (Notes) — the markdown notebook (`Ctrl+Shift+N`).** Knowledge that
belongs to no project — decisions, studies, plans, bug recipes — gets a
notebook of its own, in the **central area** of the workspace or as a **pane
tab** beside the CLIs (never a sheet over the window: a portal's page is an OS
window no HTML backdrop covers), with three panes: **nestable notebooks** (with
an icon and a count for the whole branch), **colored tags** and **note status**
(active, on hold, done, discarded — resolved ones drop out of the everyday list
and come back through their own row or the list's eye icon) on the left; the
list with preview, task progress (`- [ ]`), relative date and pinned ones at the
top in the middle; and the note in the **same markdown editor as the files** on
the right (four modes, formatting bar, Mermaid/KaTeX when those rows are on, an
image pasted from the clipboard embedded in the note). Search understands
qualifiers — `caderno:` (notebook), `tag:`, `status:`, `titulo:` (title), a
quoted phrase, `-term` to exclude — accent-insensitive and by substring, with
the hits lit up in the list. Everything saves on its own (SQLite, row by row,
debounced per note), the trash holds what was deleted until you decide, and
`.md` goes in and out via export and copy. Notes show up in Search (`Ctrl+P`) as
a section of their own, and the palette opens straight onto the note it found —
even if a filter would have hidden it.

**Links in the output.** Ctrl+click on what a process prints: a web address
(`http://…`, `localhost:5173/…`, `127.0.0.1:8080`) or a file path
(`src/lib/x.ts:42:7`, tsc's `src/x.ts(12,3)`, rustc's `--> src/x.rs:12:3`,
`C:\…`, `./…`, `../…`, the Git Bash `/c/…`, a bare `README.md`). An address
opens beside the terminal — a browser tab in the same pane, or a portal wired
to the card on the canvas, the same object the globe creates. A file opens as
an editor tab at that line; the path is resolved against the **process's own
folder** first (a `cargo` inside `src-tauri/` says `src/pty/mod.rs`), then
said from the group's root, and a file outside every root goes to the system's
default application, because the editor only reads inside a root. The matcher
(`src/lib/termLinks.ts`) is deliberately conservative — `12:30:45`, `v7.0.4`,
`and/or`, `e.g.`, an e-mail and `github.com` are not links — and only hover
asks it anything; a plain click keeps focusing and selecting. Limits, on
purpose: one buffer row at a time (a path wrapped over two rows is not
matched), the spawn folder rather than a shell's later `cd`, and POSIX
absolute paths (`/home/…` from WSL), which the app cannot place on this
machine.

**Keyboard broadcast** (`Ctrl+Shift+U`). What you type into one CLI goes to
every other **live** CLI of the same group — tabs and canvas cards alike —
for the moments a team waits on the same answer: the `y` after a fan-out, a
`/clear` before the next task, one short instruction to five recruits. One
group is armed at a time, and the mode is **session-only on purpose**: it is
never written to `kv`, because a broadcast that came back on at boot would
type into terminals nobody was looking at. It also follows the group out of
the workspace (a front closed, a group deleted). While armed, every terminal
of the group wears a yellow strip — `⇶ Transmitindo para N CLIs ·
Ctrl+Shift+U desliga` — that counts the receivers and says so when the count
is zero; the palette has the same toggle ("Transmitir teclado para o grupo").
The receiver rule is pure in `src/lib/broadcast.ts`; the extra `write_pty`
per target happens in `XTermView`'s `onData`, after the flow intercept, so a
pipeline still owns its Enter.

**Save a terminal's output.** "Salvar saída…" in the CLI's menu (and "Salvar
saída do terminal em foco…" in Search) writes the scrollback to a file — the
in-memory ring of a live terminal after a flush of what the reader thread had
not written yet (the `.bin` may hold more history than the 4 MB ring), or the
`.bin` alone for a terminal that already died, which is usually the one whose
output someone wants. The extension chosen in the save dialog decides the
shape (`src/lib/termExport.ts`): `.txt` is what a human reads — escapes gone,
a carriage return keeping only the last frame of its line so a spinner becomes
its final word, backspaces applied, CRLF line endings on the way out
(`pty_export::strip_ansi`) — and `.ansi` keeps every byte for whoever wants
to replay it with the colors. An empty scrollback is refused before any file
is created: a zero-byte `.txt` looks like a bug. Cursor movements that reach
other lines (`ESC[2A`, `ESC[K`) are dropped, not replayed — this is a
transcript, not a screen recording.

**Light appearance** (2026-08-26). The app was dark-only by design, and dark
is still the default — the product's identity, and the CSS that paints with no
help. **Configurações → Interface → Tema** now offers *Escuro · Claro ·
Sistema* (kv `theme`), and Search has "Alternar tema claro/escuro". Light and
system stamp `<html data-theme="light">` (`lib/theme.ts` is the pure rule,
`stores/themeStore.ts` owns the OS query and is where the terminal well reads
the resolved value); `src/theme-light.css`, loaded on boot right after
`styles.css`, redefines the same tokens for paper. Dark is the *absence* of the
attribute, so whoever never opens the setting keeps the exact CSS they had.
What changes is the paper, the ink and the veils — white veils vanish on a
light surface, so each hand-painted white relief in the dark sheet has a
black twin — never the system blue, the radii or the semantic hues' meaning.
The terminal gets a second ANSI palette (`lib/termTheme.ts`: paper well,
body text at 7:1, every hue at 3:1), the editor's syntax reads `--syn-*`
tokens with the dark values as fallbacks, and the canvas keeps its elevation
steps with daylight values; a colour scheme still wins over both.
Details and the token table in [DESIGN.md](./DESIGN.md#light-theme).
**Tray icon, summon hotkey, close to the tray.** Yard runs for hours behind
other windows, so it gained the two things a background app owes its user. An
icon in the notification area (`src-tauri/src/tray.rs`): a left click brings
the window back, the right button opens *Mostrar o Yard* / *Sair*, and the
tooltip is the only place the agents' state still shows while nobody is
looking — `Yard — 1 agente bloqueado · 2 rodando`, pushed from the runtime
mirror through `hooks/useTray.ts` (debounced, only when the numbers change;
the wording is the pure `tooltip` in Rust). A **global hotkey** (`Ctrl+Alt+Y`
by default, editable in **Configurações → Atalhos** with inline validation —
`lib/tray.ts` turns the user's spelling into the accelerator the
global-shortcut plugin accepts and refuses a bare key, which would take that
key from every application) that brings the window from anywhere in Windows,
and hides it when it is already in front — the decision is `summon_action`:
only *visible and focused and not minimized* hides, so a window behind a game
comes forward instead of vanishing. And **Fechar para a bandeja**
(**Configurações → Comportamento**, off by default): the X hides the window
and the CLIs go on; quitting is then *Sair* in the tray menu or in Search,
which run the window's own exit flow — save the workspace, ask about live
agents — through `lib/quit.ts`, so leaving from the tray saves exactly what
the X does.

**First run.** A fresh install used to open on an empty workspace and say
nothing. Now the first boot with no project and no `onboarding.done` in `kv`
opens a welcome sheet, once: the CLIs the app found on this machine (with
their versions, the missing ones greyed), the folder of the first project —
the same door as "Novo projeto", `src/lib/projectCreate.ts`, so the two never
drift — and the six shortcuts worth learning on day one, plus one line saying
`yard` is on the PATH of every terminal. Every way out (Começar, Pular, Esc,
the ×, the backdrop) writes the key; an install that already had projects
when it upgraded is marked done silently instead of being greeted as a
newcomer (`firstRunDecision` in `src/lib/onboarding.ts`). The sheet comes back
from Search as "Boas-vindas".

**Relatar um problema — the support bundle.** The log in `%APPDATA%\Yard\logs`
only ever helped the author. **Configurações → Dados e backup** now has
*Relatar um problema*: *Gerar pacote…* writes a `.zip` with the log files of
the last two days (today and yesterday — a crash at 00:05 lives in
yesterday's file), `about.json` (build version, OS, data directory, whether
`YARD_DATA_DIR` is set) and `agents.json` (the CLIs detected on the machine,
with versions) — and **nothing else**: no database, no scrollback, no `kv`,
no notes, no session files, nothing from the projects. The screen lists the
zip's entries afterwards, because the contents *are* the privacy contract.
*Copiar link do rastreador* puts the tracker's new-issue URL and a short
skeleton (version, what happened, steps, "attach the bundle") on the
clipboard — copied, never opened: nothing in the app launches a browser.
Backend in `src-tauri/src/support.rs` (`bundle_in`, tested against a fake
data dir that also holds an `app.db` and a scrollback, to prove they stay
out); the pure text in `src/lib/support.ts`.

**Updates that install themselves** (2026-08-26). The app asks GitHub for a
newer release half a minute after boot and every six hours after that — never
on the boot's critical path, never a toast when there is nothing — and what it
finds shows up as a thin blue bar over the workspace and as a card in
**Configurações → Dados e backup**: *Instalar e reiniciar* or *Ignorar esta
versão* (per version: the next one is offered again). Only what the updater
key signed is installed: the public key sits in `tauri.conf.json`, a Rust test
fails the build if it goes missing, and the release workflow signs the
artifacts and writes the `latest.json` the app reads. Installing over live
agents asks first, in the exit confirmation's words, because the restart takes
them along. The rules — is it newer (a pre-release is older than its release),
is it due, was it ignored, what the progress line says — are pure in
`src/lib/updater.ts`; the store (`updaterStore.ts`) is the only caller of the
plugin. *Verificar agora* also lives in the palette.

**Automatic backups.** The `.zip` export in Configurações → Dados e backup
used to be something to remember; now it can be a calendar: *Desligado /
Diário / Semanal*, how many copies to keep (7 by default) and where (the
`backups` folder of the data directory unless another one is chosen). A
minute after boot and then once an hour the app asks one pure question —
`backupDue`, in `src/lib/autoBackup.ts` — and, when the period has elapsed
since the stamp kept in the kv (`backup.lastAutoAt`), writes
`yard-auto-<date-time>.zip` through the same path as the manual export (same
WAL checkpoint, same database lock) and then prunes the oldest **automatic**
copies beyond the retention. Manual exports and anything else in that folder
are never touched: the retention rule only matches names it wrote itself
(`persistence/autobackup.rs`). Success is silent, a failure is an error toast
(nobody is watching a timer), and "Fazer agora" writes a copy even while the
schedule is off.

**Custos e uso** (`Ctrl+Alt+U`, 2026-08-26). The per-session estimate and the
usage-window meter never answered the question that decides whether a fan-out
was worth it: *how much did I spend today, and on what*. The panel reads the
same trail the session list reads — Claude Code's `~/.claude/projects/**/*.jsonl`
(usage counted once per `message.id`, like the live tail) and Codex's
`~/.codex/sessions/**/*.jsonl` (`token_count` events, the turn's
`last_token_usage`, the model from the preceding `turn_context`) — and buckets
it by **local day × agent × project × model** (`src-tauri/src/costs.rs`; each
file parsed once per `(len, mtime)` and cached). Three windows (Hoje · 7 dias ·
30 dias), a totals strip, one bar per day (cost, or tokens when nothing in the
window has a price) and three tables: por projeto, por agente, por modelo. The
folding is pure in `src/lib/costs.ts` and carries the honesty rule of the
estimate one step further: a bucket that mixes priced and unpriced rows shows
its cost as a **floor** (`≥`) rather than pretending the Codex tokens were free,
and a model outside the price table shows tokens and no number. OpenCode is not
scanned — its per-message usage is not in a file whose format could be verified.

**Ombro (Shoulder) and the transcript** (`Ctrl+Shift+O`). "Ao Vivo" follows
one agent as it works; the Ombro is the glance over the shoulder at all of
them *after the fact*: one sheet per group, one row per agent CLI, read from
the session the CLI keeps on disk — the last thing it said, the files it
touched (edits, writes and reads told apart), the commands it ran, sub-agents,
failed tool calls, the plan's progress and the estimated cost. The numbers are
the overlay's own: the feed reducer moved out of `liveStore` into
`src/lib/liveModel.ts` and both read through it, so the digest and Ao Vivo can
never disagree on a count (`src/lib/shoulder.ts` adds the few a summary needs).
A CLI that writes no session to disk says so instead of waiting; a folder with
no trail says so; a session that cannot be read spoils its own row and never
the sheet. Which trail is the terminal's is `src/lib/sessionFind.ts`: the id a
resumed terminal carries in its command line wins, otherwise the newest — the
same rule the overlay starts from.

The **transcript** reads a session from the start as a document, without
resuming the process: prompts as cards, the assistant's text as text, the
tools between them as compact rows (each call glued to its result by id,
consecutive calls in one block), thinking folded, a search field at the top
that counts and steps with Enter (accent-insensitive, like the rest of the
app), and *Copiar como markdown*. It opens from the Ombro, from the Sessões
sheet (beside *Retomar*), from the tab and card menus of any agent that keeps
a session, and from Search. The backend command `session_events` reads the
whole file once with the **same parser the tail uses** (`agents/read.rs` over
`tail::parse_line`) and refuses anything above 64 MB with a sentence that
says so. The blocks and the search are `src/lib/transcript.ts`.
**Gatilhos (triggers) — when X happens, do Y** (2026-08-26). Routines fire by
the clock and `yard wait` blocks on the agent's side; nothing on the app's side
said "when Claude finishes, send the review prompt to Codex", "when anyone
stops at a question, notify me", "when the test agent exits, run flow F". A
trigger is that sentence, stored in the group's canvas next to the routines
(`TriggerDef` in `src/lib/canvas.ts`, `normalizeCanvas` drops a crooked one on
load): a source (one CLI or `*`, any CLI of the group), an event and an
action — type a prompt into another CLI, a native notification plus a toast, or
a flow started on the terminal that fired, with the text as the task. `{name}`
and `{ask}` in the text become who fired and the question it stopped at.

What decides is pure and lives in `src/lib/triggers.ts`; the delivery is
`hooks/useTriggers.ts`, a subscription to the runtime mirror. Two rules keep
it honest. **Edges, not states**: the mirror repeats `finished: true` until the
terminal is read, so a fire needs the flag to go up (or `finishedAt` to move —
a second idle without the flag ever dropping is a second finish), a stop at a
question is `blocked` and never `finished`, and `exited` needs a process that
was live in this session (a dead terminal found at boot never "went down"
now). **A prompt goes through the same gate as a routine** (`lib/sendable`):
alive, idle, not frozen on a question — it waits up to 12 s and reports the
failure as a toast instead of typing into a busy agent. The stamp
(`lastRunAt`, off after a one-shot) is written *before* the delivery, so a
second edge meanwhile finds the trigger spent; `--cooldown` is the floor
between two fires, and a trigger whose `ask` lands on its own source waits at
least a minute (`SELF_ASK_MIN_COOLDOWN_SEC`) — the loop guard for "when I
finish, tell me to go on".

On screen they share the routines' sheet — "Rotinas e gatilhos…" in the card
menu (with the armed count) and in Search for the CLI in focus: a second
section with the list (`Quando … → …`, pause/remove) and a form (Quando ·
Origem: esta CLI ou qualquer CLI do grupo · Então: mandar prompt a / notificar /
rodar fluxo · só uma vez · intervalo mínimo). From the CLI: `yard trigger
list|create|pause|resume|delete`, with the `ask` gate — source and target must
be you or someone wired to you, and a flow must be reachable by cable.
**Servidores MCP, num lugar só.** Each CLI keeps its MCP servers in a file
of its own and a shape of its own — `~/.claude.json` (user scope at the top,
local scope under `projects[<path>]`) and `<project>/.mcp.json` for Claude
Code; `[mcp_servers.<name>]` in `~/.codex/config.toml` for Codex; `mcpServers`
in `~/.gemini/settings.json` / `.gemini/settings.json` for Gemini (`httpUrl`
is HTTP, `url` is SSE); `~/.cursor/mcp.json` / `.cursor/mcp.json` for Cursor;
`mcp` in `opencode.json` for OpenCode (`command` is an array there). Every one
of those was checked against the CLI's own documentation, and the CLIs whose
format was not (aider, goose, Grok, Copilot) say so on screen instead of
guessing. **Configurações → Servidores MCP** lists them all — one card per
CLI, the scopes that apply to the active project, a chip for the transport —
with add, edit, remove, on/off where the CLI has a native flag (Codex,
OpenCode) and **copy to another CLI**, which is the point: the same entry
lands in the other file in its dialect, and what the target cannot say (SSE
in Cursor or Codex, WebSocket anywhere but Claude Code) is said out loud. The
readers and writers (`src-tauri/src/mcp.rs`) are pure over text and **keep
what they do not understand** — an entry's `timeout` or `oauth`, the rest of
the document, and, for TOML, the comments and layout (`toml_edit`). The
listing never carries env or header values, only their names; the form asks
for them one server at a time. The neutral model, the validation and the
screen's order live in `src/lib/mcp.ts`.
**Agents over SSH — what does not travel.** A CLI told to run on another
machine is a real card like any other: scrollback on disk, the exit banner,
suspend and restart, the role typed in as the first message, the cache flags
on the command line. What stays behind is everything that lives in the
process environment on *this* machine: the `yard` shim and the `YARD_*`
variables are not on the remote PATH, so the remote CLI cannot `yard ask` the
others on the canvas, and the `ENABLE_PROMPT_CACHING_*` variables Claude Code
reads do not cross either (aider's cache, which is flags, does). The password
is the other honest limit: with a key that logs in without one, the role and
the cache reach the CLI as they do locally; with a password prompt, the prompt
is drawn in the terminal and works, but the role brief typed by Yard arrives
while ssh is still asking and is lost — the screen says so next to the field.
The rules are in `lib/agentDefaults.ts` (`sshLaunch`, `shQuote`) and
`src-tauri/src/ssh.rs`.

**Language servers in the editor (LSP).** The file editor talks to the
language server of the file's language when one is installed on the
machine — completion from the project, diagnostics as you type, hover,
go to definition (`F12`), references (`Shift+F12`), rename (`F2`), format
(`Shift+Alt+F`) and signature help (`Ctrl+Shift+Space`). The catalog is
fixed and small: `typescript-language-server` (TypeScript/JavaScript),
`rust-analyzer`, `pyright-langserver`, `gopls` and the `vscode-*-language-
server` trio for CSS, HTML and JSON; **Configurações → Editor de código**
lists which ones this machine has (with version) and, for the missing
ones, the exact install line (`npm i -g typescript-language-server
typescript`, `rustup component add rust-analyzer`, `npm i -g pyright`,
`go install golang.org/x/tools/gopls@latest`, `npm i -g
vscode-langservers-extracted`), plus a switch to turn the whole thing off.
Without a server the editor keeps completing words from the file itself,
as before.

The shape follows the rest of the app: the server is a **process the
backend owns** (`src-tauri/src/lsp.rs`) — spawned with piped stdio, npm
`.cmd` shims resolved the way the agent CLIs are, put in a Job Object like
a PTY and killed on exit, so no `rust-analyzer` outlives the window — and
the Rust side only decodes the `Content-Length` framing; every message is
handed to the frontend as bare JSON (`lsp://message`), where
`@codemirror/lsp-client` owns initialization, capabilities and requests.
One client per (project root, server) is shared by every file of that
root the server takes (`src/stores/lspStore.ts`); a server that fails to
start or dies is reported once and left alone until "Procurar de novo",
and a root with no file open loses its servers after thirty seconds.

**Language.** The interface is written in Brazilian Portuguese and that
text is the *key*: every user-visible sentence goes through `t("…")`
(`src/lib/i18n.ts`) — components through `useT()`, which re-renders them
when the language flips — and the English line lives in one of the area
dictionaries under `src/i18n/en/` (`shell`, `canvas`, `modals`,
`settings`, `bench`, `editor`, `notes`, `lib`). A sentence with no English
line comes back in Portuguese and is logged once, never blank. Tables such
as the shortcuts and the settings categories keep their Portuguese and are
translated where they are rendered. **Configurações → Interface → Idioma**
offers Português (Brasil), English and Sistema (English only on an English
Windows; the terminals and the CLIs are untouched — they speak their own
language). `node scripts/i18n-scan.mjs` lists the sentences still to wrap.

**Busca na saída dos terminais** (`$` na Busca). `Ctrl+P` sempre achou o
terminal pelo **nome**; a lupa do xterm procura dentro de **um** terminal
montado. Nenhuma das duas responde "onde foi que eu vi aquele erro?", que é a
pergunta que um workspace com seis agentes produz o dia inteiro. O prefixo `$`
varre o histórico de todos os terminais, vivos e fechados, e escolher uma linha
leva ao terminal com a barra de busca já aberta nela.
`src-tauri/src/scrollback_search.rs` lê o anel vivo de quem está de pé e o
`.bin` de quem não está, tira os escapes com o mesmo `strip_ansi` da exportação
(um spinner é uma linha, com o último quadro) e janela a linha em 240
caracteres: um bundle minificado impresso no terminal é uma linha de 2 MB e não
vai passar por IPC. Tetos por terminal e no total, ordem de prioridade
(terminal em foco, grupo ativo, o resto) e um piso de duas letras, porque cada
tecla digitada é uma varredura de disco. Os agentes têm a mesma coisa em
`yard search "texto" [--all] [--limit 4]`.

**Fila de trabalho por agente.** Tudo o que uma fila precisa já existia sem
estar ligado: o portão de envio (`lib/sendable.ts`), a detecção de ocupado e
travado, e a entrega que espera o silêncio. Faltava o elo, porque mandar algo
para um agente ocupado era esperar ou desistir. Agora o compositor troca
**Enviar** por **Enfileirar** quando a CLI está trabalhando (ou travada numa
pergunta: as duas passam), o texto fica guardado e entra sozinho na primeira
janela de silêncio. Uma por vez, na ordem em que foram pedidas: dois prompts
colados de uma vez são um prompt partido. O motor é puro (`lib/queue.ts`), o
estado sobrevive ao reload no `kv` (`queue.items`), e o entregador é um tique de
2 s (`hooks/useQueueRunner.ts`), porque "pronto" é em parte uma condição de
*tempo* e o último byte de uma resposta não emite evento nenhum. A contagem
aparece na aba e no cartão, o menu da CLI limpa, e os agentes usam
`yard ask "Alvo" --queue "prompt"` e `yard queue [list] | clear`.

**Pull requests, sem sair do Yard** (`src-tauri/src/forge.rs`). Uma frente já
nascia, rodava e **aterrissava**; o que não existia era a metade de fora, a
branch virar PR, juntar comentários e voltar como trabalho. A aba Controle
mostra o PR da branch ao lado do botão de sincronizar, com a cor vindo dos
checks: uma falha decide contra nove verdes, um review pedindo mudanças decide
contra um build verde, e um repositório sem CI fica neutro, porque pintar de
verde o que o GitHub não disse é inventar fato. Abre PR pelo mesmo lugar, e o
botão direito **traz os comentários de revisão para dentro do diff**, viram as
mesmas anotações que o revisor local escreve, e daí a barra que já existia
manda tudo para o agente. Tudo pela CLI `gh`: nenhum token é guardado, pedido
ou lido pelo Yard. Sem `gh` instalado, a faixa simplesmente não aparece.

**Teto de gasto por dia.** "Custos e uso" é um retrovisor: você descobre na
quinta o que a terça custou. Configurações → Agentes → Custos aceita um teto em
dólares, e o Yard fala **uma vez** ao passar de 80% e **uma vez** ao estourar:
no rodapé, num balão, e numa borda de gatilho nova (`estourar o orçamento do
dia`), que é a única que não vem de um terminal e por isso só chega a gatilhos
armados para "qualquer CLI". Nunca na descida: o total zera à meia-noite, e um
balão dizendo "de volta ao orçamento" às 00:00 é como um recurso ganha um botão
de desligar. Um dia com modelo fora da tabela de preços é um **piso**, e diz
isso (`lib/budget.ts`).

**Aviso fora da máquina.** O perfil deste app é sessão longa, de madrugada, com
agentes que param e esperam, e o balão do Windows só serve para quem está na
frente da tela. Configurações → Agentes aceita um endereço (ntfy, Discord,
Slack, o seu) que recebe um `POST` com o mesmo aviso: agente terminou ou
travou, gatilho, fluxo, `yard notify`, orçamento. É a única coisa no Yard que
manda o que um terminal escreveu para fora da máquina, então: sem endereço, sem
requisição nenhuma; só https (ou http em localhost, onde não há fio); e o corpo
é uma frase, cortada em 400 caracteres, porque o que chega no celular tem de ser
legível na tela de bloqueio. Regras em `lib/webhook.ts`, cerca repetida em
`src-tauri/src/webhook.rs` porque o comando é alcançável pelo frontend.

**Reabrir a aba fechada** (`Ctrl+Shift+T`). Ctrl+W fica a uma tecla de Ctrl+E, e
a aba que ele fecha pode ser um arquivo três pastas abaixo. A pilha guarda as
últimas 20 aberturas de **arquivo e navegador**, com o painel de onde saíram:
reabrir num painel qualquer, num layout de quatro, é pôr a aba onde o olho não
está. CLIs ficam de fora de propósito, porque fechar uma é "Excluir CLI", uma
ação destrutiva confirmada, e "reabrir" ali significaria ressuscitar um
processo.

**Passar o bastão.** Entregar trabalho de um agente para outro sempre foi um
parágrafo digitado à mão, e errado do mesmo jeito toda vez: descreve-se a
*tarefa* e esquece-se o **estado**. O menu da CLI (e `yard handoff "Alvo"`)
monta o parágrafo a partir do que o app já tem: o papel do agente, a branch e o
diffstat, e os últimos seis turnos do transcript, com teto por turno e sem as
chamadas de ferramenta (o próximo agente vai rodar as dele). Pelo menu ele cai
no **compositor**, para ser lido e editado antes de ir, porque escolher quem
assume é a decisão que o gesto inteiro serve.

**Diário do dia.** Uma ação da Busca escreve uma nota nova com os commits do
dia, quem estava trabalhando e o custo estimado, e deixa um `## Notas` no fim. O
valor não é o relatório: é que a nota já começa preenchida, então escrever o
único parágrafo que importa não custa nada.

**A ponte atravessando o SSH.** "Roda em: SSH" foi entregue com um buraco
escrito na documentação: o `yard` e o ambiente `YARD_*` não cruzavam a conexão,
o que fazia do agente remoto um terminal, não um participante. Agora a ponte
também escuta numa **porta TCP de loopback** falando o mesmo protocolo de uma
linha JSON do named pipe e exigindo um token de sessão; o launch de SSH abre um
túnel reverso (`ssh -R`) e escreve um shim em `~/.yard/bin` da máquina remota. O
shim é Python, não shell: o pedido é JSON com texto de prompt arbitrário
dentro, e escapar isso à mão em `sh` é como se ganha uma ponte que funciona até
alguém usar aspas. O id do terminal não existe quando a linha de comando é
montada, então vai como `{{YARD_PTY_ID}}` e o spawn substitui
(`pty::expand_pty_id`). **Por agente e desligado por padrão**: o túnel deixa
este workspace alcançável pelo loopback daquela máquina, protegido por um token
que vive no ambiente do processo remoto. Precisa de `python3` no host.

**Fumaça de boot** (`npm run smoke`). Não clica em nada, mas cobre o caminho que
nenhum teste de unidade cobre e que quebra calado: o binário de verdade subindo
com um diretório de dados vazio, criando e migrando o SQLite, botando a ponte de
pé e saindo sem panic. Um marcador que some é falha; uma linha nova no log não
é, senão o teste vira o primeiro a ser comentado.

**One bar, one order** (2026-08-31). The pane's bar used to be painted in
sections — the CLIs, then the files, then the pages, then the notebook — and a
drag could only land inside its own section: a CLI could not be put between
`docker-compose.yml` and `AGENTS.md`, however far the tab was carried. The
sections are gone. Any tab drops anywhere in any bar, and the order the user
arranges is saved with the group's layout (`GroupLayout.tabOrder`, one list of
ids per pane) because no tab store can hold an order that interleaves the other
two. `lib/paneBar.ts` is the single authority: the bar, the keyboard
(Ctrl+Tab, Ctrl+1..9) and "Mover para a esquerda/direita" all read it, so a tab
opened after the arranging goes to the end of the bar and a pin still holds the
front — of the whole bar now, there being no section left to be at the front
of. The drag itself was rebuilt around it: the tab leaves the bar when it is
picked up, the tabs after the drop point slide aside to open a hole exactly as
wide as what is coming (no more caret line, the hole *is* the answer), the
strip scrolls itself when the tab is held at its edge, and the ghost settles
into the hole on release instead of blinking out.

**The board as a place you move through** (2026-09-02). The camera stopped
teleporting: fit, centre, zoom-to and "go to the agent asking" glide there
(`lib/cameraTween.ts`, log-space zoom so a 4x and a 0.25x take the same time),
and a pan released with speed keeps sliding and decays. With nothing selected
the arrow keys pan; with a card selected `Ctrl+arrows` jump to the nearest
card in that direction (`lib/spatialNav.ts`: a cone first, the half-plane as
the fallback, side distance weighted twice) and `Enter` enters it. Every
canvas key is rebindable in Configurações → Atalhos (`lib/keymap.ts`,
`stores/keymapStore.ts`, kv `keys.canvas`; the toolbar tooltips read the
binding). Snap to grid is a preference, `Alt` bypasses it for one gesture
(`snapBoxToGrid`, `snapResizeToGrid` in `lib/arrange.ts`), and "focus the
largest card on screen" is another (`largestVisible` in `lib/culling.ts`).
Cards far outside the viewport are not painted at all (`visibleIds`, one
viewport of margin so a pan does not blink), and the xterm inside a card is
rendered at a step of the zoom, not at 1x stretched (`lib/renderScale.ts`).

**Card chrome** (2026-09-02). Every card has a z-order (`raiseNode`,
`lowerNode` in `lib/cardChrome.ts`), a pin that fixes its place (a pinned card
refuses drags, arranges and `yard canvas move`), maximize/restore against the
current viewport (the previous rectangle travels in `node.restore`), a rename
on `F2` for every kind (`lib/rename.ts` keeps each kind's own limit and
default), "copiar caminho" and "mostrar na pasta" where the card is a file
(`lib/cardPath.ts` joins with the root's own separator). A CLI that reported a
permission prompt through its hook reads "pedindo permissão" instead of
"travado", on the card and in the HUD (`CanvasView/hud.ts`).

**Guided placement** (2026-09-02). A card created without a point (the
toolbar, `yard recruit`, a drop with no coordinates) is offered up to six
numbered spots that do not overlap anything (`lib/placement.ts`: the free
rectangles of the viewport carved by the existing boxes, a 40 px gap,
ranked by size and distance to the centre); the first is taken by default,
the number picks another, `F` places freely. Off by a switch in Interface.

**Drops** (2026-09-02). Files and folders dragged from the OS land on the
board (Tauri's drag-drop event: an image or video becomes a media card, a
folder a tree, anything else a doc), rows of a tree card are draggable, and a
path dropped on a terminal card is pasted quoted for that shell
(`lib/canvasDrop.ts`: the plan, the step of 40 px between many, the quoting,
the internal MIME).

**The doc card** (2026-09-02). A text file opened on the board as a card
(`doc` item, `lib/docNode.ts`, `DocCard.tsx`) through the editor store's
`loadDoc`, with the same body as the editor tab and none of its chrome. It
renders text; `.docx` is not rendered.

**Fronts on the board** (2026-09-02). A card wears the colour of the front it
belongs to (`lib/floorColor.ts`: a hash of the group id, or the colour chosen
in the fronts popover and saved in `FloorMeta.color`), and a click on the chip
dims every other front (the lens). The popover gained a swatch per front, a
PR pill when the branch has one open (copies the URL) and "atualizar do chão"
(`lib/floorMenu.ts`).

**Portals** (2026-09-02). Viewport presets (phone, tablet, desktop:
`PORTAL_VIEWPORTS` in `lib/portals.ts`), a screenshot button, the element an
agent clicks or types into ringed for a moment inside the page
(`MARK_JS` in `lib/portalDriver.ts`), URL suggestions from the visit history
(`lib/urlHistory.ts`, capped at 300) and bookmarks with a star
(`lib/portalBookmarks.ts`, both in `stores/portalWebStore.ts`).

**The board itself** (2026-09-02). A background per board (grid style, colour,
image and its opacity: `CanvasBackground` in `lib/canvas.ts`), the saved
scores offered on an empty board, and the minimap painting each CLI in its
brand colour.

**`yard canvas`** (2026-09-02). The agent lays out its own corner:
`list`, `move`, `resize`, `arrange`, `align`, `frame`, `pin`/`unpin`, `focus`,
`zoom` (`lib/bridgeCanvasCmd.ts`), limited to what it reaches and never a
pinned element; `focus` and `zoom` move the user's camera through
`CANVAS_CAMERA_EVENT`.

**Native CLI hooks** (2026-09-02). The silence detector guesses; the CLIs that
have hooks now tell. Claude Code is launched with `--settings
<data>\bin\claude-hooks.json` (written beside the shims by `bridge.rs`,
nothing in the user's home folder) and Codex with `-c
notify=["yard","hook","codex"]`; both flags come from `launchFor` in
`lib/agentDefaults.ts`, never doubled, never across WSL or SSH. The shim
receives `yard hook prompt|stop|permission|tool|session --stdin`
(`lib/hookEvents.ts` parses both dialects) and the bridge moves the runtime
mirror: a turn starting lifts the block, a tool running means the permission
was granted, a permission prompt is a block with `permission: true`. Off by a
switch in Configurações → Agentes.

**Workers** (2026-09-02). A front opened for a task with one agent card in it
is one object for the CLI (`lib/workerRuns.ts`): `yard worker create "Name"
--task "…" [--agent x]` (the same road as "Nova tarefa", the front named
exactly as asked), `list [--json]`, `inspect`, `wait`, `send`, `review` (the
branch against the ground: files, counts, predicted conflicts), `apply`
(land and close, `--keep-front`, `--close-siblings`), `keep` (the task goes,
the front stays as an ordinary one), `discard` (the front goes, refused from
inside it) and `stop`. The state is one word read from the runtime mirror:
`starting`, `working`, `done`, `blocked`, `permission`, `stopped`, `exited`.

**The canvas is the boards** (2026-09-02). A project's group stopped having
the canvas as its other surface: the surface is derived from the group
(`surfaceOf`, `lib/surface.ts`; `updateLayout` and `addTerminal` enforce it),
the pane menu, the palette and the sidebar's Canvas row stopped flipping it
(`canvasDoor` leads to the board visited last, `lastBoardId` in the store),
and the first load carries the cards of a group that was showing its canvas
into a board and puts the group back on its panes (`extractBoards`). Off the
board, projects stay out of the canvas: "Nova CLI neste quadro" asks for a
folder, never a project (`lib/boardFolder.ts` offers the last card's, else
the home folder); a score only applies on a board (`applyScore` throws
otherwise); `yard recruit --floor` opens a tab of the front, with no
rectangle drawn anywhere. Off the canvas, the board stays out of the
projects: the changes panel and the bench leave with their doors and their
shortcuts while a board is up (`projectPanelsShown`, `lib/layoutControls.ts`),
and the fronts control moved from the corner of a project's canvas to the
status bar (`Floors/place.ts`). The canvas side is state of its own
(`canvasSide`): deleting the last board keeps the user on it, with the
boards section empty and a "Novo quadro" face in the workspace, and "Nova
aba" there asks for a board before anything else.

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
  The picker says exactly that where the choice is made. The agent drives it
  with `yard portal snapshot/click/fill/…`.
- **A second window.** One window, one workspace. Every side-effecting
  subscription in the app is per-window, the bridge's `bridge://request`, the
  triggers, the routine scheduler, the work queue, and Tauri broadcasts its
  events to every window, so a second one would run all of them **twice**: one
  `yard ask` typed into the target two times over. Detaching a group to a
  second monitor is worth having, and it starts with a leader-window flag
  gating those subscriptions, not with a new window.
- **Inline screenshots in the composer** — a deliberate decision: the CLIs
  expect a file path, and there's no good way to paste an image into a PTY.
- **F6, Product.** The updater artifacts *are* signed (minisign, through
  `TAURI_SIGNING_PRIVATE_KEY`); what is missing is **Windows code signing**,
  and only the certificate. `release.yml` already imports a `.pfx` from
  `WINDOWS_CERT_PFX`/`WINDOWS_CERT_PASSWORD` and hands the thumbprint to the
  bundler when those secrets exist, and builds unsigned when they do not, so
  the day a certificate is bought, nothing but the two secrets changes. Until
  then SmartScreen asks once. The CSP is set (`src-tauri/tauri.conf.json`) and the Tauri capabilities
  are down to window controls, dialogs and notifications.
- **Left out of the board work of 2026-09-02**, each on purpose: tabs inside
  one portal card (one page per card, as before); `.docx` in the doc card
  (text only); maximize for items (cards only, items have no viewport to
  restore against); an icon per board in the sidebar; an onboarding tour;
  docking and resizing the minimap. `yard worker review` prints the diffstat
  and the predicted conflicts, not the patch: the patch is the worktree's own
  `git diff`, which the caller can run.

Validated end to end with the real app: boot → restore workspace from SQLite →
attach → spawn → live PTY → scrollback on disk → an app crash leaves no orphan.
UI interaction (clicking, dragging, resizing) still hasn't been exercised
automatically, only the logic behind it, plus `npm run smoke`, which starts
the real binary against a temporary data directory and checks the boot
contract: log, SQLite, bridge up, no panic, clean exit.

## Cost estimates

The prices per million tokens are in `agents/sessions.rs` and were checked on
2026-08-12 (Opus 5: US$ 5/25; Sonnet 5: 3/15; Haiku 4.5: 1/5; cache write 1.25×
input, read 0.1×). A model outside the table gets no estimate at all — better no
number than a made-up one. **Check the table when prices change.** The
"Custos e uso" panel (`Ctrl+Alt+U`) applies the same table per day, project,
agent and model, and marks a sum with an unpriced part as a floor.

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
