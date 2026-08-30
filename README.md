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

> The product UI is in Brazilian Portuguese by default, with English available
> in Configurações → Interface → Idioma. Code, comments, tests and docs are in
> English.

## Highlights

- **Real terminals, many at once.** ConPTY + Job Objects: kill takes the whole
  process tree, an app crash leaves no orphan, scrollback survives restarts.
- **Projects → branches → panes.** A project's children are the **ground** (its
  own root, on whatever branch is checked out there) and its **fronts** (a `git
  worktree` each): no loose folders, so no two of them share one working copy.
  Automatic, fixed grid, spotlight, and an **infinite canvas** where terminals
  are cards you can wire together, annotate with sticky notes, drawings and
  arrows.
- **The `yard` CLI — an agent↔app bridge.** Every terminal Yard opens has
  `yard` on its PATH: agents ask each other questions, wait on one another,
  search what any terminal printed, hand each other the baton, share notes as
  memory, recruit teammates, schedule routines, and the wires drawn on the
  canvas decide who may talk to whom. It crosses an SSH connection too, when
  you turn that on per agent.
- **Nothing said is lost.** One search box finds a line any terminal printed,
  the ones still open and the ones closed hours ago, and takes you to it.
- **Fronts, and the pull request at the end of them.** One `git worktree` per
  task, with its own group and canvas, on a new branch, on an existing one, or
  adopting a worktree that was already on the disk (which closing the front
  never deletes); fan a request out to N fronts, compare
  the results, land the winner, or open the PR from the same panel, watch its
  checks, and pull the reviewers' comments back in as annotations on the diff
  that an agent can act on. Nothing here pushes on your behalf, and every row
  says where that leaves its branch: only here, N to send, published, or gone
  from the server.
- **A bench beside the terminals.** Files, tasks, prompts and full source
  control (stage by hunk or by line, branches, stash, history) one shortcut
  away. A file or markdown document opens as a tab next to the agent editing it.
- **Browser portals.** Embedded WebView2 tabs and cards the agent can drive,
  with a design-mode picker that hands an element's selector, styles and a PNG
  crop straight to the agent's prompt.
- **Agent awareness.** Detects 8 CLIs, resumes local sessions, estimates cost,
  tells "finished" from "blocked on a question", and shows each provider's
  remaining usage window in the title bar.
- **After the fact.** The *Ombro* digest says what every agent of a group did
  while you were not looking; a session opens as a readable, searchable
  transcript; *Custos e uso* buckets tokens and estimated cost by day, project,
  agent and model.
- **Automation.** Routines fire by the clock; *gatilhos* fire on events — when
  a CLI finishes, stops at a question, exits, or the day's spend goes past the
  ceiling you set, send a prompt to another one, notify, or start a flow
  (`yard trigger` from the CLI too). A prompt for a CLI that is busy waits in
  that CLI's queue and goes in the moment it is free.
- **It can reach you when you are not there.** Every notification can also
  `POST` to an address you paste in (ntfy, Discord, Slack, your own), which is
  what makes an agent frozen on a question at 3am something you find out
  about.
- **Terminal ergonomics.** Ctrl+click opens the file (at the line) or the URL
  an agent printed; one keystroke broadcasts to every CLI of the group; a
  terminal's output saves to a file with or without the ANSI colors.
- **Editor with language servers.** Completion, diagnostics, hover, go to
  definition, rename and format through the LSP servers installed on the
  machine (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`…).
- **One place for MCP.** The MCP servers of Claude Code, Codex, Gemini CLI,
  Cursor and OpenCode, read and written in each CLI's own file and dialect,
  with "copy to another CLI".
- **Where it runs.** Each CLI opens on Windows, inside a WSL distro, or on
  another machine over SSH.
- **A desktop app that stays out of the way.** Tray icon with a global summon
  hotkey, close-to-tray, light and dark appearance, English or Portuguese,
  signed in-app updates from GitHub Releases, scheduled backups with retention,
  a first-run tour and a one-click support bundle for bug reports.

The full tour, phase by phase, is in [`docs/features.md`](./docs/features.md).

## Install

Download the NSIS installer from the
[latest release](https://github.com/alanadson/yard/releases) and run it
(Windows 10/11, x64; WebView2 is installed on demand). The installer is not yet
code-signed, so SmartScreen will ask once. From then on the app checks GitHub
Releases on its own and offers each signed update in **Configurações → Dados e
backup** ("Instalar e reiniciar").

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
