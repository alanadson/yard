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
2. **There is no mature terminal widget for native Rust GUIs.** egui/iced/Slint
   would require implementing a VT emulator (ANSI escape parser, grid, reflow,
   selection, IME, ligatures…) — months of work before the first feature.
   xterm.js solves that today, at VS Code quality.
3. **Weight and distribution on Windows.** WebView2 already ships with
   Windows 10/11 → a ~10 MB installer and less baseline RAM than the ~150 MB
   typical of an equivalent Electron app.
4. **Ready-made ecosystem:** `tauri-plugin-updater` (signed auto-update),
   `single-instance`, `notification`, `dialog` — all officially maintained.

### Alternatives considered and discarded

| Alternative                             | Why not (for now)                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron + Node**                     | Core in Node, not Rust; binary and RAM ~10× larger; it would have to be rewritten later to meet the "in Rust" goal.                                                       |
| **Native Rust GUI** (egui, iced, Slint) | No terminal widget; reimplementing VT100 + rendering is a project in itself.                                                                                               |
| **GPUI (Zed's framework)**              | Technically the most beautiful, but still unstable as a standalone framework and with Windows support still maturing. Reassess in a year.                                  |
| **wezterm-term/termwiz as the emulator** | Not a GUI — it is WezTerm's VT emulation _library_ in Rust. Discarded for F1, but **noted as F7**: it is the path to a headless terminal in the backend, 100% Rust.        |

### Target versions

Rust stable ≥ 1.80 (**MSVC** toolchain), Tauri 2.x, Node 20 LTS, React 18
(not 19 — it fits better with `react-resizable-panels` and the rest of the UI
ecosystem), TypeScript 5.x, Vite 6, `@xterm/xterm` 5.5 stable with
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
