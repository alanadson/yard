# Roadmap by phase

Every phase ends with a verifiable acceptance criterion. Don't move on with a
criterion still pending — that is the difference between an app and a demo.

> **Status as of 2026-08-13.** F0–F4 are delivered. On top of them grew two
> things this plan never anticipated and that define the product today — the
> **canvas mode** and the **agent↔app bridge** (the `yard` CLI) — documented in
> §8.1. Out of F5 came `git status` (a changes panel with a per-file diff) and
> **floors** (one worktree per task); "landing" (merging back onto the ground)
> and automatic fan-out remain open. F6 (product: updater, release CI, code
> signing, CSP) is still entirely open.

## F0 — Bootstrap

- [x] Project created (`create tauri-app`), `npm run tauri dev` runs
- [x] Undecorated window + custom `TitleBar` with min/max/close
      (`getCurrentWindow().minimize()` etc.) and a drag region
      (`data-tauri-drag-region`)
- [x] Base dark theme, shell layout (sidebar + empty central area)
- [x] `logging.rs` with `tracing` writing to `%APPDATA%\Yard\logs`

**Acceptance:** the app opens, drags, minimizes, closes; the log shows up on
disk.

## F1 — Terminal vertical slice ← the heart

- [x] PTY engine (`src-tauri/src/pty/`) with spawn/write/resize/attach/kill
      working with `pwsh.exe`
- [x] `XTermView` with input, resize (debounced), ANSI colors, unicode
- [x] Attach-before-spawn rule; closing the view does not kill the process
- [x] Full scrollback (4 MB ring + append-only `.bin` + compaction)
- [x] Output coalescing and `pty://activity`
- [x] Job Object on spawn + `kill_pty` killing the whole tree
- [x] `restart_pty` and an exit banner with the reason

**Acceptance:** run `claude` inside; survive a UI reload; `kill` leaves no
orphan `node.exe` in Task Manager; `type big_file.txt` does not freeze the UI.

## F2 — Workspace

- [x] Projects (root folder) → groups → terminals; navigable sidebar
- [x] **Tabs by default:** creating a terminal never splits the screen — each
      CLI takes the whole pane and the new one joins the tab bar at the top
- [x] `WorkspaceGrid` with `react-resizable-panels`: splitting is still
      possible, but only on purpose (drag the tab to another pane) — automatic
      layouts (1/2/4), custom grid, spotlight (1 large + the rest small)
- [x] "Novo terminal" (New terminal) modal: a grid of brands (the CLIs on this
      machine and the shells) and, below it, the little that needs saying —
      name, where to open, directory, extra arguments as free text **and** a
      checkbox for the flag that waives the chosen CLI's permission prompts
      (`lib/termArgs.ts`)
- [x] Shortcuts: new terminal, switch tab (Ctrl+1..9, Ctrl+Tab), close view,
      search (search addon)
- [x] Tab drag & drop: any tab (CLI, file, browser) moves between panes and
      reorders on the bar — dropping on the left/right half of another tab
      inserts before/after (`lib/tabDrag.ts`)

**Acceptance:** 6 terminals in 2 groups, rearrangeable, each with independent
state.

## F3 — Persistence and resume

- [x] `persistence/db.rs` with the schema from
      [architecture §5](./02-architecture.md#5-persistence) + versioned
      migrations
- [x] `save_workspace` with a monotonic revision guard; debounced autosave
- [x] On app open: restore projects/groups/layout; dead terminals show the
      `.bin` scrollback + a "retomar" (resume) button
- [x] `suspend_pty` / suspend a group with a visual indicator
- [x] Export/import a `.zip` backup (db + scrollbacks)
- [x] Confirmation on exit with live agents ("close and keep running" does not
      exist in Tauri — kill cleanly via Job Objects)

**Acceptance:** close the app with 4 terminals, reopen, see everything in
place and resume one with a click.

## F4 — Agent integration

- [x] `agents/resolver.rs`: detect Claude Code, Codex, OpenCode, Gemini CLI,
      Cursor CLI via `which` + npm's `.cmd`/`.ps1` shims (see
      [Windows pitfalls, item 3](./04-windows-pitfalls.md)) + version
      (`--version`)
- [x] `agents/sessions.rs`: list local sessions per project (e.g.
      `%USERPROFILE%\.claude\projects\<slug>\*.jsonl`) → feeds "resume
      session" with `claude --resume <id>` / `codex resume`
- [x] Cost/tokens aggregated per session (parsing the same files), a discreet
      HUD per pane
- [x] "Agent finished" detector + native notification + unread badge
- [x] `watcher.rs` (`notify`) watching the session directories → the
      `agents://changed` event

**Acceptance:** open a project → see old Claude Code sessions → resume one in
a new pane → when the reply finishes, a Windows notification fires.

## F5 — Git and parallel worktrees

- [x] `git status --porcelain=v2` (subprocess with cache): branch + dirty count
      per project — delivered in the files/changes panel, with a per-file diff
- [x] One worktree per task — delivered as **floors** (§8.1): each floor is a
      `git worktree` at `<project>\.yard\floors\<slug>` with its own group and
      canvas
- [x] **Land** — merge the floor back onto the ground, with a conflict preview
      (`worktree_preview` / `worktree_land`; refuses a dirty tree and aborts a
      merge that conflicts anyway)
- [x] "New task" flow: name → worktree → new group → N agents on the same
      prompt (fan-out)
- [x] Simple comparison view: diffstat per worktree side by side, with "ficar
      com este" (keep this one) landing the winner

**Acceptance:** fire the same task at 2 agents in 2 worktrees, compare the
diffstat, delete the loser with one click.

## F6 — Product

- [ ] `tauri-plugin-updater` with our own signing key + an endpoint on GitHub
      Releases
- [ ] NSIS installer + icons + `webviewInstallMode: downloadBootstrapper`
- [ ] Release CI (see [development](../development.md#cicd--build-and-release-by-tag))
      producing a release per tag
- [ ] Harden the CSP; review Tauri `capabilities` (bare minimum)
- [ ] Windows code signing (see
      [Windows pitfalls, item 7](./04-windows-pitfalls.md)) — or document the
      SmartScreen warning
- [ ] Minimal onboarding: first run detects agents and suggests creating the
      first project

## F7 — Horizon (after 1.0)

Headless terminal in pure Rust (`wezterm-term`) mirroring state — enables
perfect reconnection and a mobile companion over WebSocket + NaCl encryption;
MCP manager.

> The **diff annotations handed back to the agent** that this item foresaw
> shipped earlier, in §8.1 — and without waiting for the headless terminal,
> because it did not depend on it.

> The "own CLI" this item foresaw ended up being born earlier and in a
> different shape: it is not a launcher (`yard run`), it is the **bridge** that
> agents use from inside the terminals (§8.1).

## 8.1 — Canvas and bridge (outside the original roadmap)

Neither of the two was in the plan; both changed what the app is. They are
recorded here as a delivered phase, with what is still pending.

**Canvas mode** (the group's 4th layout mode). Infinite canvas with pan/zoom
(snaps to 100%), terminals as draggable/resizable cards, freehand pen and
shapes (roughjs + perfect-freehand), arrows, text, sticky notes with light
markdown, curved connections, eraser, undo/redo, single-key shortcuts.
Persisted in `layoutJson.canvas` — **no database migration**, which is why all
of this fit without touching the schema. Zoom is `transform: scale`: the
ConPTY is only resized when the card changes size.

**Multi-selection and arranging** (2026-08-15). Lasso on the empty background
(dragging the background became selection; pan stays on the wheel, on space,
on the middle button and on the hand tool), `Shift+click` to add, `Ctrl+A`,
`Tab` to cycle. Cards and items live in the same selection — align (6),
distribute (2), arrange in a grid (`Ctrl+Shift+T`, cycles grid/row/column),
drag as a block, `Alt+drag` to duplicate, copy/cut/paste, arrow keys, `Delete`
(which never kills a process). Snapping with guides on every move and resize
gesture; `Ctrl` turns it off. The math is pure in `src/lib/arrange.ts` (with
tests); the component only translates a rectangle into a commit. Minimap
(`Ctrl+Shift+M`, persisted in `kv`), frame the selection (`Shift+2`), walk
along the wire (`Ctrl+Alt+←/→`). Jumping to the agent asking for attention
(`Ctrl+Shift+A`, even with focus inside the terminal) started here and left
the canvas: it works in any layout, and in `lib/attention.ts` the queue is the
group on screen — if nobody there is waiting, the whole workspace.

**Agent↔app bridge — the `yard` CLI.** Named pipe (one JSON line in, one
out) → the `bridge://request` event → `src/lib/bridge.ts` answers through
`bridge_respond`. The Rust side is a dumb transport on purpose: **all** of the
workspace state lives in the frontend, and duplicating it in the backend would
create two sources of truth. The connections drawn on the canvas are the access
control: an agent only reaches what is wired to it. Commands: `list`, `ask`
(`--file`/`--stdin`/`--raw`/`--batch`), `check`, `note` (with a user lock),
`connect`, `recruit` (`--replace`, `--floor`, `--role`), `dismiss`, `role`
(+ library), `routine`, `score`, `floor`, `portal`, `notify`, `debug`.
Discovery: a skill in `~/.claude/skills/yard/` for Claude Code and
`<data>\bin\YARD-BRIDGE.md` + `YARD_BRIDGE_HELP` for the others.

**Search** (`Ctrl+P`, 2026-08-15). A single palette over the **whole**
workspace: terminals, groups, floors, projects, notes, portals, files (git +
feed + the tree already read), bench prompts and tasks, advertised addresses
and the app's actions. Pure ranking in `src/lib/search.ts`: folds accents,
scores per word (exact > prefix > substring) with a **coverage rule** — half
the meaningful words left unmatched drops the candidate, which is what makes
typing more improve the result — and uses subsequence only as a tie-breaker.
Prefixes `>` `@` `#` `/`. A chosen note switches the group, enters canvas mode
and centers (`uiStore.canvasReveal`, consumed by `CanvasView` in an effect:
the target canvas may not even be mounted at the moment of the click).

**Diff annotations → agent** (2026-08-15). Per-line comments in the
`DiffViewer` (gutter with `+` on hover, a card in the flow below the line),
persisted in `kv` (`review.comments`) because a review is work and a reload
halfway through must not erase it. The footer bar counts the whole project and
injects everything into a live agent as a single message, grouped by file and
ordered by line (`src/lib/review.ts`). The anchor is the line number at the
time of writing — which is why the comment carries **the text** of the line:
that is what survives when the agent edits the file.

**Advertised addresses → portal** (2026-08-15). `src/lib/advertised.ts` scans
the PTY output for loopback/private-network URLs, waiting for the end of the
line (a URL can straddle two `read()` calls) and stripping OSC/CSI first (a
colored port arrives in pieces). `XTermView` feeds the scanner with the chunks
and with the tail of the scrollback on attach — the server announces itself at
boot, almost always before anyone opens the pane. The globe on the card opens
the address in a portal created by `src/lib/portalSpawn.ts`, **connected** to
the terminal (the same function the CLI uses, so the two portals are the same
object).

**Design mode in the portal** (2026-08-15). `GRAB_*_JS` in `portalDriver.ts`
injects a picker into the page: a highlight that follows the cursor, the click
captured in the capture phase with `preventDefault` (pointing is not clicking),
`Esc` cancels. Since the app only talks to the page through one-off `eval`,
the state lives in `window.__yardGrab` and the card *polls* every 300 ms. What
comes back is validated in `src/lib/grab.ts` (the page is not ours) and becomes
a prompt in the composer of the agent wired to the portal.

**Also delivered:** the floating prompt composer (`Ctrl+Enter`, `@mentions`,
one draft per target — writing does not require any terminal: without focus
the text lives in a loose draft and the target is picked in the header
selector; only sending needs a terminal), routines (scheduled prompts, only
with the target idle), scores (a group arrangement saved in
`<data>\partituras\*.json` and reapplicable), floors (one worktree per task
with its own canvas) and the **Live** overlay (mission control for an agent,
fed by the session tail, `agents/tail.rs` → `session://feed`) — offered only
to those that write a session to disk (`AgentInfo.sessionsKind`: Claude, Codex
and OpenCode), because the other CLIs leave no file to follow and the screen
would wait forever.

**Blocked vs. finished** (2026-08-16). The only
signal the app had was the clock: 4.5 s of silence (`pty/reader.rs`) became
`agent_idle` → `finished` → green badge and notification. But silence is
ambiguous — an agent that wrote "done, 4 files" and one stuck at
`Do you want to proceed? (y/n)` were the same event, the same badge and the
same position in the `Ctrl+Shift+A` queue. And they are opposites: one costs
nothing, the other is dead time until someone shows up.

Silence says *that* it stopped; only the text on screen says *why*.
`src/lib/blocked.ts` reads the tail of the output and answers one question: is
what is drawn a request for a reply? The hot path only concatenates and trims
16 KB of raw bytes (`feedTail`, from the same `on.output` that already feeds
the address scanner); the expensive part — stripping escapes, splitting into
lines, pattern matching — runs **once per idle event**, which is once per agent
turn. A terminal in another group has no tail because it has no `XTermView`
mounted: there the tail comes from the backend (`pty_read_since`), which is
precisely the case of the agents nobody is looking at.

Each rule demands **two independent signals**, because a badge that lies
teaches the user to ignore the badge: a numbered (or radio) menu only counts
with ≥2 options, the cursor on one of them **and** a question above — without
that, every plan an agent writes as a list would become "blocked"; `(y/n)` and
`Password:` only count on the last lines, where the cursor actually waits.
`RunState` is still *process* state; `blocked`/`blockedAsk` sit beside
`finished` (always together with it), so whoever only knew `finished` did not
change. A pulsing yellow badge in all three places, a tooltip with the
question, a notification that says what it wants, `Ctrl+Shift+A` visiting the
blocked ones first and extra weight in search. It clears on its own when the
process writes again (450 ms heartbeat), because the answer may have come from
outside the pane — from `yard ask`, from a routine, from another agent.

**`yard wait`** (2026-08-16), the same idea turned toward the agents' side.
`yard check` is a snapshot, so a lead agent that recruited three could only
take snapshot after snapshot: each one costs 60 lines of someone else's
terminal in its context and still arrives a cycle late. `wait` blocks on the
reply — the bridge already tolerated a 30 min wait (`MAX_WAIT_MS`); what was
missing was someone using it. It waits on the runtime mirror
(`useTerminals.subscribe`), not on IPC: it wakes on the same event that painted
the badge, with a 1 s heartbeat underneath purely as a safety net.
`--until stopped|done|blocked` (`stopped` is the default because it is the only
one that cannot hang: asking `done` of someone stuck on a question would wait
until the timeout), `--any`/`--all`, and `--fresh` for the `ask --no-wait` +
`wait` pattern, where `finished` may still belong to the **previous** turn and
returning immediately would be the same bug as not waiting.

**"Anotações" (Notes) — the markdown notebook** (`Ctrl+Shift+N`, 2026-08-18).
Knowledge that belongs to no project got a home of its own: a full-screen
surface with three panels — nestable notebooks (emoji icon, branch count),
colored tags and note status (active/on hold/done/discarded; resolved ones
vanish from daily use and come back through their own collection or the eye
on the list) → a list with a markdown-free preview, `- [ ]` progress, relative
date and pinned notes at the top → the note in the **same engine as the file
editor** (four modes, `mdLive`, `MarkdownToolbar`, `MarkdownPreview` with
Mermaid/KaTeX; a clipboard image goes in as a `data:` URL inside the note
itself). Search with qualifiers (`caderno:`/`book:`, `tag:`, `status:`,
`titulo:`, quotes, `-term`), accent-insensitive and by fragment — the engine is
pure in `src/lib/notes.ts` (with tests), the state in `notesStore.ts` (per-note
writes with a 600 ms debounce, flushed on close). Persistence is **schema v5**:
tables `notes`, `notebooks` and `note_tags` (`persistence/notes.rs`), operation
by operation — no blob rewritten. Trash is a soft delete with `deleted_at`;
deleting a notebook moves its children and notes up one level (nothing is lost
by accident). Exports `.md` (`note_export` + native dialog) and copies as
markdown. In Search (`Ctrl+P`) notes are the "Anotações" section, and opening
from the palette lands in the collection where the note is visible — trash or
status — never in a list that hides it. The canvas notes section was renamed
"Notas do canvas" (Canvas notes) so the two things don't get confused.

**Notes — three places for the same notebook** (2026-08-18). The notebook is
still a single one (the editor surface requires a single instance), but now it
lives wherever the user says (`notesStore.place`, kv `notes.place`):
**overlaid** (the usual modal sheet), **in a tab** — a pane tab, next to the
CLIs, files and browsers, draggable between panes like any other (`tabDrag`
kind `notes`, sentinel id `yard-anotacoes` in `activeBySlot`) — or **in the
central area**, taking the whole middle of the workspace with no modal, with
the sidebar and the side panels working alongside. The place selector lives in
the notebook's own bar (and in the tab's context menu); the palette gained
"Anotações em aba" (Notes in a tab) and "Anotações na área central" (Notes in
the central area), and the "Nova aba" (New tab) grid gained the "Anotações"
tile. `Ctrl+Shift+N` is still "summon/dismiss": it toggles the sheet or the
central area, and with the notebook docked it jumps to the tab (a group in
canvas mode answers with the sheet, because there is no tab bar there).
Closing the tab restores the default place; a group deleted or pruned at boot
does too (`prune`/`dropGroups`, like the browsers). In a narrow pane the
notebook gives up columns through a container query — the rail goes first,
then the list — instead of crushing the editor.

**Pending on this line:**

- [x] **Land** — merge the floor back onto the ground with a conflict preview
      (see F5). `yard floor land` / `compare` / `fanout`.
- [x] **Portals** — a browser card on the canvas (a Tauri child webview
      positioned over the card's rectangle) that the agent drives with
      `yard portal open/goto/snapshot/click/fill`. Gained **design mode** and
      opening straight from the address the process advertised.
- [ ] **"Shoulder"** — a per-group digest of what each agent did, from the
      JSONL files `agents/sessions.rs` already reads (parsed in
      `spawn_blocking`).
- [x] **Paste an image into the terminal and the composer** (2026-08-15). It
      sat here as "not planned" for the right reason — CLIs expect a file path
      and a PTY does not carry image bytes — and the way out is precisely to
      accept that: `Ctrl+V` writes the image to `%TEMP%\yard-clipboard\` and
      pastes **the path**, which is what Claude Code and Codex recognize to
      attach the picture on their own. WebView2 already delivers the image in
      the `paste` event (a Win+Shift+S capture, "copy image" from a browser,
      `Ctrl+C` on a file in Explorer), so there is no native clipboard read on
      the main path; the context menu, which has no such event, tries
      `navigator.clipboard.read()` and falls back to the usual warning when
      the host denies it. Text wins over image (copying from a page brings
      both). The file extension comes from the **signature** of the bytes, not
      from the MIME type the page reported, and pastes older than 24 h are
      deleted on the next write. `src-tauri/src/clipboard.rs` +
      `src/lib/clipboardImage.ts`, both with tests.
- [x] **Markdown editor with preview** (2026-08-15): a file opens as a tab and
      a `.md` gains a formatting bar, a table of contents of headings and four
      modes (*Editar*, *Fonte*, *Dividido*, *Ler* — Edit, Source, Split,
      Read). The decision that holds up the rest: **there is no intermediate
      model**. The buffer is still the file, character by character — the
      *Editar* mode only decorates (`mdLive.ts` hides the marker on lines the
      cursor is not on, and draws the task checkbox and the rule), and the
      rendered page is a data tree React paints (`mddoc.ts` +
      `MarkdownPreview.tsx`), never injected HTML. A true WYSIWYG would keep
      its own state and rewrite the file on the way back, which in an app
      where **agents edit the same files** means rewriting lines nobody asked
      for. The commands are the same as the canvas note's (`lib/mdedit.ts`,
      a single grammar, now with headings up to 6, image, table and footnote)
      and reach CodeMirror as the **smallest** span that changes
      (`changedSpan`), so that pressing "bold" undoes like typing. A project
      image comes in through the `yardfile` protocol (the CSP won't let
      `<img>` read disk or network); a relative link opens another tab, a web
      address opens a portal on the canvas.
- [x] **The file is a tab, not a window** (2026-08-16). The editor used to
      open as an overlay over the app; now it joins the **pane's own tab bar**,
      next to the CLI and at its size — which is the point of this app: the
      file and the agent that touches it on the same surface. An `OpenDoc`
      gained `groupId` + `slot` (the same two coordinates as a terminal), the
      layout's `activeBySlot` now accepts a document id, and `TerminalPane`
      draws the file tabs after the CLIs; the terminals stay mounted
      underneath (`.pane-doc` covers, it does not unmount), otherwise the PTY
      attach would die on every file open. `CodeEditor` became only the canvas
      frame — the one place without a tab bar — and all the guts are
      `EditorBody`, which does not know where it is hung. `Ctrl+Tab` and
      `Ctrl+1..9` walk through the file tabs too, because on screen they are
      the same row.
- [x] **Files you look at: image, video, audio and PDF** (2026-08-16).
      Clicking a `.png` in the tree gave "arquivo binário — sem texto para
      editar" (binary file — no text to edit), which is true and useless: half
      of what gets opened in a project is the screenshot the agent saved, the
      icon someone swapped, the video of the bug. Now the editor has a second
      face — `MediaView` — with zoom and actual size for images,
      `<video>`/`<audio>` with controls, PDF in a frame, and for the rest
      (`.zip`, `.docx`, a codec WebView2 won't play) a card with name, type,
      size and **open in the default application**. What decides the face is
      the MIME type `explorer.rs` returns from the extension
      (`TextFile.media`), so an `.svg` — image *and* text — opens rendered with
      a button for the code, and an 800 MB video is never even read in search
      of a zero byte. The bytes **do not go through IPC**: a protocol of our
      own, `yardfile://` (`src-tauri/src/media.rs`, on Windows
      `http://yardfile.localhost`), serves 2 MB chunks with `Range`, which is
      what makes a movie open instantly and the progress bar move — the
      `fs_read_data_url` that did base64 over IPC is gone, and the markdown
      preview switched to the same protocol (goodbye 12 MB ceiling per image).
      The fence has two turns, because a URL lives inside an `<img>` and the
      markdown is written by agents: the root must be one the app opened in
      this session, and the path goes through the same `explorer::resolve` as
      the file commands.
- [x] **Role: the CLI is born knowing what is its own** (2026-08-16). The role
      already existed on the card, but it was just a label: it served another
      agent's `yard list` and told the process nothing. Now it is name +
      instructions, chosen **before** the click that creates the terminal
      (`RoleField`, on the *Papel* (Role) tab of "Novo terminal") and reusable
      by name — a library scoped to the group (`canvas.rolePresets`) or global
      (`kv.rolePresets`), with a color that tints the card.

      The delivery avoids the obvious path — writing a copy of the
      instructions to a file inside the project and asking the user to put it
      in `.gitignore`. Here nothing is written into someone else's repository:
      the text goes in through the CLI's own front door — the flag when it has
      one (Claude Code's `--append-system-prompt`, table in `lib/roles.ts`),
      and as the **first typed message** when it doesn't (`lib/roleBrief.ts`),
      which is what the user would do by hand. The briefing waits for the same
      two conditions as a scheduled routine — process up and silence after
      writing — because input that arrives in the middle of the CLI's banner
      gets swallowed; and it gives up instead of insisting forever.

      On a terminal that already exists (card or tab menu, and `yard role set`)
      the role lands twice on purpose: typed into the running session, since a
      live process's command line cannot be rewritten, and swapped into the
      line's `args` for every subsequent start (`applyRoleToProcess`, a single
      function for both paths, otherwise the CLI and the UI diverge). In the
      persisted data, `roles[id]` became `{ name, text }` — the paragraph does
      not fit in the card's chip — and `normalizeRole` still accepts the string
      from old boards.
- [x] **Browser as a pane tab + screen crop in design mode** (2026-08-18). A
      pane's tab bar opens an embedded browser next to the CLIs and files
      (`BrowserPane`, tabs in `browsersStore`, kv `panes.browsers`): it is the
      same engine as the canvas portals — tab and card are two faces of the
      same object in the `portal.rs` registry — so the "live" view, the UA,
      the cookie scope and design mode come along. The tab is born at
      `about:blank` with the address bar focused (new browser tab, no modal),
      takes part in `retainLivePortals` (otherwise orphan reconciliation would
      close the live tab next to a canvas undo), and only the active tab mounts
      its body — unmounting hides, never closes: session, scroll and history
      live in the backend. `window.open` becomes a new tab in the same pane;
      navigation in a group that is not on screen still moves the stored URL
      (a global listener in `watchPaneBrowserEvents`), otherwise the next mount
      would navigate the page back to the old address.

      Design mode (now shared in `useGrabMode` + `grabDeliver`) also started
      sending **a PNG crop of the screen around the element**:
      `portal_grab_shot` captures the WebView2 child window (BitBlt of the
      client area) and cuts out the element's rectangle — CSS px × page zoom ×
      monitor scale, with 8 px of context — right in the portal's host, so the
      crop does not depend on where the card is in the window. Portal
      screenshots became PNG in-process (BMP, the old format, isn't even
      accepted by the agent APIs). The crop's path goes into the prompt right
      below the page's line, in the same convention as a screenshot pasted into
      the composer: the agent opens the file. The capture happens **before**
      the composer opens, because the composer covers the workspace and the
      portal blanks out underneath it — one frame later there would be nothing
      to photograph.
- [x] **The editor's search bar moves up and becomes a real bar**
      (2026-08-19). `Ctrl+F` opened the bar that ships with CodeMirror: two
      raw fields, four buttons and three checkboxes **stuck to the foot** of
      the editor — the last place the eye goes when the question is "where is
      this word?". Now it floats at the **top** of the surface, in the menus'
      material: a rounded field with the search glyph inside, the modifiers in
      a segmented control (`Aa` · `ab` · `.*`), the two arrows, and the replace
      line folded behind a disclosure triangle — the shape of Xcode's bar.
      `Ctrl+H` opens the same bar with that line already open and the cursor
      in it, and the choice is remembered for the next file.

      The piece the stock bar never had is the **counter inside the field**:
      "2 de 12" (2 of 12) while stepping with Enter, "12 ocorrências" (12
      matches) before the first, "sem ocorrências" (no matches) in amber when
      there is nothing (not finding is information, not an error) and "regex
      inválida" (invalid regex) in red when it is. The count comes from the
      same cursor the commands use (`SearchQuery.getCursor`), so what the
      badge says and what Enter does cannot diverge; it stops at a ceiling of
      a thousand matches — a twenty-thousand-line file would be swept on every
      keystroke — and the total gets a `+` when it stopped. With no match, the
      arrows and the replace buttons are disabled instead of answering a click
      with silence. The commands are still CodeMirror's; only the clothing is
      ours (`CodeEditor/searchPanel.ts`, counting in `searchCore.ts`). The
      same bar serves the file editor and the notebook.
