# Vision and stack

> Origin: the project's kickoff blueprint (August 2026), revised for
> publication. The actual implementation status lives in the
> [roadmap](./05-roadmap.md) and in the [README](../../README.md).

## 1. What we are building

A **local-first** desktop application for running, organizing and resuming
**multiple coding agents** (Claude Code, Codex, OpenCode, Gemini CLI,
Cursor CLI, etc.) and ordinary shells **in parallel**, each in its own real
terminal (PTY), organized into projects, groups and split panes, with history
and layout persisted to disk. The long-term goal is to reach the level of an
"ADE" (Agent Development Environment): a single place where you dispatch tasks
to several agents, follow their progress, review the result and merge the
winner.

The central thesis: **the entire core in Rust** (PTY, processes, git,
persistence, watchers, resources) and the **UI as a thin rendering layer** in
WebView2 — because there is no mature terminal widget for native Rust GUIs
today, and xterm.js is the industry's de facto standard (it is VS Code's
terminal).

From that thesis follows the app's **golden rule**: the UI **never** owns
process state — the backend is the source of truth, and the UI rebuilds
everything via "attach" (detailed in the
[architecture](./02-architecture.md#4-ipc-contract-commands--events)).

## 2. Stack decision (and why)

### Choice: Tauri 2 + Rust + WebView2 + React/TypeScript + xterm.js

Rust does **100% of the heavy lifting**: spawning and managing PTYs (ConPTY via
`portable-pty`), the process tree and Job Objects, scrollback on disk, SQLite,
git/worktrees, file watchers, the resource supervisor, credentials in the
Windows Credential Manager. TypeScript is restricted to rendering: xterm.js
paints the bytes, React organizes the panes, Zustand holds UI state. Objective
reasons:

1. **Rust goes where it matters.** In an app like this, the value is in the
   engine (processes, I/O, persistence, reliability), not in the CSS. Tauri
   puts Rust exactly there.
2. **The existing terminal integration is substantial.** Native terminal
   widgets do exist: [egui_term](https://github.com/kemokempo/egui_term) uses
   `alacritty_terminal` and reports Windows support, while explicitly describing
   incomplete terminal features. A native prototype can reuse a VT engine;
   it still needs to validate input, selection, IME, reflow, accessibility,
   image protocols and the agent CLIs against Yard's current xterm behavior.
3. **Weight and distribution on Windows.** Tauri uses the installed WebView2
   runtime instead of bundling Chromium. That reduces distribution duplication,
   but does not remove browser, renderer and GPU processes at runtime. Installer
   size is not a RAM benchmark. Measure the whole owned process tree and separate
   UI, embedded browsers and agent processes.
4. **Ready-made ecosystem:** `tauri-plugin-updater` (signed auto-update),
   `single-instance`, `notification`, `dialog` — all officially maintained.

### Memory review (2026-10-16)

An isolated production build was measured through the native WebView2 debugger,
with no agent processes or browser portals. Each stopped terminal had 20,000
lines of synthetic output. Figures below sum the working sets of the owned Yard
and WebView2 processes, in MiB; shared pages can be counted more than once. These
are individual local samples, not a cross-product benchmark or a RAM guarantee.

| Scenario | Before stopped-view retention | After stopped-view retention |
| --- | ---: | ---: |
| Empty workspace | 418.5 | 405.0 |
| Twelve stopped tabs, first history selected | 1013.1 | 489.0 |
| Same tabs, selecting the last history | 1040.1 | 553.6 |

The original empty sample had a 4.3 MiB JavaScript heap, 13.2 MiB of private
native-process memory and 238.1 MiB of private memory across WebView2 processes.
Heap, private committed memory and working set are different metrics and must
not be added together. Terminal backing arrays and graphics allocations are
not represented by the JavaScript object heap alone.

The measured defect was eager restoration of all stopped terminal buffers.
Tabbed panes now retain at most two stopped views and preserve live views;
`npm run test:native-terminal-memory` guards history recovery and background
process identity in the actual application. Visiting all twelve histories in
the updated build left two views mounted and a 625.2 MiB summed working set;
browser caches and allocator behavior still affect total memory. This change
does not optimize live-agent memory or canvas-card retention.

Recommendation: keep Rust, SQLite and the current UI while addressing measured
retention and portal lifecycle costs. Swapping React alone preserves the WebView2
process floor. For a substantially lower idle footprint, evaluate a small native
UI/terminal prototype before committing to a full migration. A prototype must
compare equivalent terminal workloads, clipboard, IME, accessibility, editor
behavior and embedded-browser support. [PhotoCraft's architecture](https://github.com/storytold/photocraft#under-the-hood)
shows an egui/wgpu approach, but its advertised native architecture is not proof
of a memory advantage on Yard's workloads. Embedded browser content would still
need a browser engine in a native Yard.

Portal optimization should examine inactive-view suspension and environment
sharing when the chosen storage mode permits shared cookies and logins. Keep
instance isolation explicit. See Microsoft's [WebView2 performance guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance).

### Alternatives considered and discarded

| Alternative                             | Why not (for now)                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron + Node**                     | Bundles Chromium and adds a Node host. It would not address the retained terminal buffers or remove browser and agent memory costs. |
| **Native Rust GUI** (egui, iced, Slint) | Viable for a measured prototype using an existing VT engine. Adopting it requires replacing the UI and validating terminal/editor/browser feature parity; it is not a drop-in renderer change. |
| **GPUI (Zed's framework)**              | Technically the most beautiful, but still unstable as a standalone framework and with Windows support still maturing. Reassess in a year.                                  |
| **wezterm-term/termwiz as the emulator** | Not a GUI — it is WezTerm's VT emulation _library_ in Rust. Discarded for F1, but **noted as F7**: it is the path to a headless terminal in the backend, 100% Rust.        |

### Target versions

Rust stable ≥ 1.80 (**MSVC** toolchain), Tauri 2.x, Node 20 LTS, React 18
(not 19 — it fits better with `react-resizable-panels` and the rest of the UI
ecosystem), TypeScript 5.x, Vite 7, `@xterm/xterm` 5.5 stable with
`@xterm/addon-canvas` (the WebGL addon works in WebView2, but canvas is the
proven-stable path — WebGL sits behind a flag in "Configurações" (Settings) →
Terminal).

## External references

- Tauri 2: `tauri.app` (guides on custom windows, updater, capabilities, NSIS bundling)
- `portable-pty` (WezTerm's crate): `docs.rs/portable-pty`
- `wezterm-term` / `termwiz` (F7 horizon): VT emulation in Rust
- xterm.js: `xtermjs.org` (fit/canvas/search/unicode11 addons)
- ConPTY: Microsoft's "Windows Pseudo Console (ConPTY)" doc
- Job Objects: the Win32 doc for `CreateJobObjectW` / `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
- `react-resizable-panels`, `zustand`, `dnd-kit` — foundations of the UI
