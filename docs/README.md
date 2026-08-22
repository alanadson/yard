# Yard documentation

The [root README](../README.md) is the short version; [`features.md`](./features.md)
is the full tour of what the app does today. Everything else lives here:

## Specs

They were born from the project's kick-off blueprint (August 2026) and revised
as the implementation moved forward. The code is the final truth; the specs
record the design, the contracts and the reasoning behind the decisions.

| Spec                                                        | Contents                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| [01 — Vision and stack](./specs/01-vision-and-stack.md)      | What we are building; why Tauri 2 + Rust + xterm.js; target versions        |
| [02 — Architecture](./specs/02-architecture.md)              | Rust and frontend modules, IPC contract, agent↔app bridge, persistence      |
| [03 — PTY engine](./specs/03-pty-engine.md)                  | ConPTY, scrollback, UTF-8/coalescing, RAM gate, Job Objects, suspension     |
| [04 — Windows pitfalls](./specs/04-windows-pitfalls.md)      | Survival checklist: npm shims, SmartScreen, HiDPI, antivirus…               |
| [05 — Roadmap](./specs/05-roadmap.md)                        | Phases F0–F7 with acceptance criteria and status; canvas and bridge (§8.1)  |
| [06 — Test discipline](./specs/06-tdd.md)                    | TDD per layer (TS and Rust) and the seams that make testable what seemed not to be |

## Guides

- [`AGENTS.md`](../AGENTS.md) (at the root) — **how work is done here**:
  mandatory TDD, the cycle, where tests live, the definition of done. Applies
  to agents and humans alike.
- [Features](./features.md) — everything the app does, phase by phase.
- [Development](./development.md) — environment setup, launcher, tests,
  CI/CD, licence.

## Product and design contracts

- [`PRODUCT.md`](./PRODUCT.md) — product contract (users, purpose,
  principles, constraints).
- [`DESIGN.md`](./DESIGN.md) — the design system as it was built (tokens,
  materials, named rules). The implementation lives in `src/styles.css`; the
  direction comment in `index.html` points here.
