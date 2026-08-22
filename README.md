<p align="center">
  <img src="public/yard-app-icon.png" width="96" alt="Yard" />
</p>

<h1 align="center">Yard</h1>

<p align="center">
  A Windows desktop app that runs several coding agents side by side —
  Claude Code, Codex, OpenCode and plain shells — each in its own real
  terminal, organized in projects, groups, split panes and an infinite canvas.
</p>

<p align="center">
  <a href="https://github.com/alanadson/yard/actions/workflows/ci.yml"><img src="https://github.com/alanadson/yard/actions/workflows/ci.yml/badge.svg" alt="ci" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4.svg" alt="Windows" />
</p>

---

Yard is **Tauri 2 + Rust at the core, React/TypeScript + xterm.js on the
surface**. Every terminal is a real ConPTY session with a Job Object attached,
scrollback on disk and a persisted layout, so closing the window, reloading the
UI or switching layouts never disturbs an agent in the middle of a task.

> The product UI is in Brazilian Portuguese. Code, comments, tests and docs are
> in English.

## Highlights

- **Real terminals, many at once.** ConPTY + Job Objects: kill takes the whole
  process tree, an app crash leaves no orphan, scrollback survives restarts.
- **Projects → groups → panes.** Automatic, fixed grid, spotlight, and an
  **infinite canvas** where terminals are cards you can wire together, annotate
  with sticky notes, drawings and arrows.
- **The `yard` CLI — an agent↔app bridge.** Every terminal Yard opens has
  `yard` on its PATH: agents ask each other questions, wait on one another,
  share notes as memory, recruit teammates, schedule routines — and the wires
  drawn on the canvas decide who may talk to whom.
- **Floors.** One `git worktree` per task, with its own group and canvas; fan
  a request out to N floors, compare the results, land the winner.
- **A bench beside the terminals.** Files, tasks, prompts and full source
  control (stage by hunk or by line, branches, stash, history) one shortcut
  away. A file or markdown document opens as a tab next to the agent editing it.
- **Browser portals.** Embedded WebView2 tabs and cards the agent can drive,
  with a design-mode picker that hands an element's selector, styles and a PNG
  crop straight to the agent's prompt.
- **Agent awareness.** Detects 8 CLIs, resumes local sessions, estimates cost,
  tells "finished" from "blocked on a question", and shows each provider's
  remaining usage window in the title bar.

The full tour, phase by phase, is in [`docs/features.md`](./docs/features.md).

## Install

Download the NSIS installer from the
[latest release](https://github.com/alanadson/yard/releases) and run it
(Windows 10/11, x64; WebView2 is installed on demand). The installer is not yet
code-signed, so SmartScreen will ask once.

## Build from source

Prerequisites: Rust stable (MSVC toolchain), Visual Studio Build Tools with the
C++ workload, Node 20+.

```powershell
npm install
npm run tauri dev          # development build with HMR
npm run tauri build        # NSIS installer in src-tauri/target/release/bundle
```

For day-to-day use, `npm run app` rebuilds only what changed and launches the
app; `npm run app:shortcut` puts it on the Desktop and in the Start Menu. The
launcher, the environment variables (`YARD_DATA_DIR`, `YARD_LOG`) and the
variables injected into every terminal are described in
[`docs/development.md`](./docs/development.md).

## Tests

Development is test-first, in TypeScript and in Rust — the rule, the cycle and
the definition of done are in [`AGENTS.md`](./AGENTS.md).

```powershell
npm test                                          # vitest
npm run typecheck                                 # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib   # spawns a real PowerShell
```

## Documentation

- [`docs/features.md`](./docs/features.md) — what the app does, in detail.
- [`docs/specs/`](./docs/specs) — vision and stack, architecture, the PTY
  engine, Windows pitfalls, roadmap, test discipline.
- [`docs/development.md`](./docs/development.md) — environment, launcher,
  tests, release CI.
- [`docs/PRODUCT.md`](./docs/PRODUCT.md) and [`docs/DESIGN.md`](./docs/DESIGN.md)
  — product and design contracts.

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md)
first — no production code lands without a test that failed first. Security
issues go through [`SECURITY.md`](./SECURITY.md), not the public tracker.

## License

[Apache-2.0](./LICENSE) — see [`NOTICE`](./NOTICE) for bundled third-party
assets.
