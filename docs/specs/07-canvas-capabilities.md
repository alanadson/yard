# Canvas capabilities and interaction contracts

This inventory records the Windows canvas behavior as of September 2026.
Boards remain independent of project grids and Git worktree fronts. The
existing project architecture and agent connection permissions still apply.

## Capability inventory

| Area | Available behavior | Implementation |
| --- | --- | --- |
| Navigation | Infinite board, pan and zoom, minimap, fit, search, keyboard travel, selection and alignment | `CanvasView`, `canvas`, `canvasKeys`, `arrange` |
| Navigation additions | Drag empty space with the secondary mouse button; an ordinary secondary click opens the menu | `canvasPan` |
| Card organization | Groups, pinning, stacking, maximize and restore, labels, color, saved arrangements | `canvasGroups`, `cardChrome`, `scores` |
| Edge docking | One card on each lateral edge, stable size during pan and zoom, release restores its canvas rectangle | `canvasDock`, `DockFrame` |
| Content concealment | Hide terminal output or note body while retaining its content, position, process and connections | `cardChrome`, `TerminalCard`, `DomItems`, `BinderCard` |
| Connections | Explicit permission graph, direct agent messaging, transitive note and portal access, connection manager | `bridgeCore`, `ConnectionsDialog` |
| Cable routing | Rope and orthogonal circuit styles, shared draggable clamps, keyboard clamp movement and release | `circuit`, `wireClamps`, `WireClampHandle` |
| Composer | Per-target drafts, queue, prompt library, send or paste without submitting | `Composer`, `queueStore` |
| Composer references | Connected agents, notes and portals with `@`; files in the target folder with `#`; file picker and pasted image previews | `Composer/references`, `Composer/attachments` |
| Notes | Editable notes, Markdown, tasks, locks and tabs; separate file-backed document cards | `NoteBody`, `binder`, `DocCard`, `bridge` |
| Binder additions | New notes first, draggable tabs, common color including later notes, access through a connected binder | `binder`, `BinderCard`, `bridgeCore` |
| Browser portals | WebView2 cards, browser automation, screenshots, device viewport and user-agent presets | `PortalCard`, `bridgePortal`, `portal` |
| Android portals | Authorized physical devices and emulators, screenshots, touch and swipe, navigation keys, text and app controls | `devicePortal`, `DevicePortalCard`, `devices.rs` |
| Files | File-tree cards, documents and media, file previews, editor integration and search | `TreeCard`, `DocCard`, `MediaCard` |
| Agent orchestration | Roles, recruitment, routines, triggers, flow pipelines, status and usage monitoring | `roles`, `RoutinesModal`, `triggers`, `flow`, `bridge` |
| Workspace management | Saved arrangements, project fronts, Git operations, local shells, WSL and SSH launch profiles | `scores`, `Floors`, `NewTerminalModal` |

## Docking and concealment

The card context menu offers **Encaixar na lateral**, with left, right and
release actions. Terminal, note, portal, tree, binder, document and media
cards can dock. Choosing an occupied edge releases its previous owner.
The canvas stores `dock: "left" | "right"` alongside the original rectangle;
it does not replace that rectangle with viewport coordinates.

Docked cards stay at a readable screen size and are excluded from canvas
movement. Duplicated cards and imported arrangements use their original
canvas rectangles, without claiming an existing dock. The release control
restores the card even after the board was panned or zoomed.

Terminal and note menus offer **Ocultar conteúdo** and **Mostrar conteúdo**.
`contentHidden` is presentation state. It does not erase text, stop a process,
revoke an agent's access or act as a security boundary. A hidden note also
stays hidden when displayed inside a binder.

## Cable routing

Connections store an optional `style: "rope" | "circuit"`; missing means rope.
The connection manager and cable context menu both edit this setting. Circuit
hit testing follows its actual orthogonal segments, including vertical ports.

Select at least two cables, open the context menu and choose
**Agrupar cabos com prendedor**. The shared `clamp: { id, x, y }` changes the
route only. It never joins endpoints or expands the permission graph.
Drag the clamp, or focus it and use the arrow keys. Shift uses a smaller
step. Delete or **Soltar cabos do prendedor** releases the routing while
leaving the connections intact. Clamps participate in persistence and undo.
Copies and imported arrangements receive independent clamp IDs and translated
coordinates. Invalid saved coordinates are discarded without deleting cables.

## Composer references and attachments

`@` lists only resources reachable by the target's current connection rules.
An agent mention can address a connected teammate. A note or portal reference
includes its current label and stable ID, for example
`@note("Briefing", id="note-id")`. These references do not copy the note body
into the draft, and do not accidentally address agents called `note` or `portal`.
Agents can use the stable ID with the existing `yard note` and `yard portal`
commands to read current content.

`#` searches indexed files below the target terminal's working folder.
Selecting a file inserts its quoted absolute path. The attachment button also
accepts files outside that folder. Quoted local paths appear in a removable
attachment strip, and supported images have previews. Pasting an image saves
it to a temporary PNG and inserts that local path. Removing an attachment
removes its path from the draft. Attachments remain local file references;
this does not upload files to SSH hosts or provide a remote transfer protocol.

## Binder access and color

Filing places a note at the first tab and activates it. Reordering tabs keeps
the current note active. A binder's color picker applies the chosen color to
its current notes and sets `colorNotes: true`, so later filed notes inherit it.
Binders that have never had a common color chosen retain existing note colors.

A wire to a binder grants access through the notes it contains. This adds
implicit binder-to-note edges to the existing graph traversal. Agent nodes
still stop transitive traversal: one agent's private notes cannot become
reachable simply because another agent is connected to it.

## Android transport and CLI

The portal creation dialog offers **Dispositivo Android**. Discovery reads
`adb devices -l` and shows offline and unauthorized entries, while allowing
creation only for an authorized online device. Install Android SDK
Platform-Tools and configure PATH, ANDROID_HOME or ANDROID_SDK_ROOT. The default
Windows SDK directory is also recognized. Enable USB debugging and authorize
the computer on the physical device, or start an Android emulator.

```text
yard portal devices
yard portal create --device emulator-5554 "Android"
yard portal screenshot "Android"
yard portal snapshot "Android"
yard portal click "Android" 120,240
yard portal swipe "Android" 120,600 120,200 300
yard portal type "Android" "hello world"
yard portal key "Android" back
yard portal navigate "Android" https://example.com
yard portal launch "Android" com.example.app
yard portal stop "Android" com.example.app
```

Device operations use the same connected-portal gate as browser automation.
`snapshot` returns UI Automator XML. Coordinates are native screen pixels;
the card converts pointer positions while accounting for image letterboxing.
Supported keys are back, home, recents, enter, delete, power, volumeUp and
volumeDown. Text input supports printable ASCII without literal `%s`.
Browser CSS selectors, JavaScript, user-agent settings and browser live reload
are rejected for device portals. The `deviceSerial` field selects this
transport and prevents opening a WebView2 instance for the device.

The card refreshes screenshots approximately every 800 ms after a capture
finishes, with pause and manual refresh controls. This is screenshot polling,
not a low-latency video stream. Requests use a 15-second process deadline,
concurrently drain stdout and stderr, limit captured output and quote text for
the Android shell. Concurrent hierarchy dumps use separate remote filenames.
Saved screenshots return a local PNG path. No new runtime dependency is bundled.

## Platform boundaries

Browser user-agent presets remain WebView2 and do not provide real Firefox,
Safari or iOS rendering engines. Android requires external SDK tools and an
authorized device. iOS simulator control, APFS worktree cloning, Spotlight
integration and Apple Foundation Models are not Windows canvas capabilities.

The application does not add a mobile remote-control service, TLS pairing,
Docker sandbox management or tmux session hosting in this change. Existing
local, WSL and SSH profiles remain the available process launch mechanisms.
The composer uses a text editor with suggestions and attachment previews;
it does not provide rich-text mention chips or automatic remote file upload.

## Regression evidence

Each changed decision was first exercised by a failing test. Representative
failures included `copyWireRouting is not a function`, a device screenshot
returning `browser.png`, missing dock state on an automatically placed terminal,
and a newly filed note retaining `#fff` instead of the binder's chosen color.

The changed existing binder test now requires a newly filed note at index zero,
instead of appending it at the end. This is an intentional tab-order contract
change. Existing agent permission boundaries and all previous tests are retained.

The pointer tab regression, `reorders tabs from a pointer drop while keeping
the same note visible`, failed with `tabDropIndex is not a function` before
implementation. Native validation then confirmed the tab moved and its note
remained active. Image previews also have a regression test for registering
the selected file's root before constructing its media URL.

Validation on September 14, 2026:

- Frontend: 305 files and 3,256 tests passed; TypeScript checking passed.
- Rust: 401 tests passed and four previously ignored tests remained ignored.
- Clippy with warnings denied and the production frontend build passed.
- Native window: hiding and restoring note content, docking across zoom
  changes, releasing the dock, moving a shared clamp, changing cable style,
  releasing the clamp without deleting connections, filing a new note first,
  reordering tabs while retaining the active note, connected references, local
  file search, image preview and attachment removal were exercised.
- Visual corrections: the dock release button stays at the card corner, cards
  cover cables beneath them, and connection names remain readable beside their
  style selectors. These CSS changes have no new unit test; they were checked
  in the native application.

`npm run app -- -NoLaunch` refused to rebuild because the user's application
was already open. Native validation therefore used the debug executable with
Vite and a separate temporary `YARD_DATA_DIR`, preserving the running user
session and its database.

No Android SDK or authorized device was available. The missing-ADB dialog and
disabled creation action were checked, but physical-device gestures, hierarchy
capture and screenshots still require validation with a ready device.
Transport tests are not a substitute for that hardware check.
