# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop: Tauri 2 + WebView2 on Windows. The visual language is the app's own —
an undecorated window with a custom title bar — not the system's.)

## Users

Developers on Windows who run several coding agents (Claude Code, Codex,
OpenCode…) and shells in parallel, in long sessions, often at night. The
primary user today is the author himself. *(inferred from the README and the
project history; not confirmed in an interview — the author granted full
freedom)*

## Product Purpose

Orchestrate coding agents: each agent/shell in a real terminal (PTY), organised
as projects → groups → terminals, with a pane grid, an infinite canvas mode
(cards, notes, drawing, connections), persistence of the layout and the
scrollback, and a CLI bridge (`yard`) through which agents talk to each other
and to the app. Success = the user follows and coordinates N agents without
losing anything that happened in any terminal.

## Positioning

The connections drawn on the canvas **regulate** who talks to whom over the
CLI — the drawing is the real topology of the collaboration between agents, not
decoration. Terminals survive HMR/F5/layout switches because the UI never owns
the process.

## Operating Context

- Long sessions with 2–6+ terminals visible; the terminal content is the
  absolute protagonist of the screen.
- Flows: create project/group, open CLIs, split panes, canvas with notes and
  connections, prompt composer (Ctrl+Enter), files/git panel on the right,
  floors (isolated worktrees), scores (saved arrangements).
- Keyboard shortcuts everywhere (Ctrl+T, Ctrl+B, Ctrl+1..6, V H P E R O L
  A T N C on the canvas).

## Capabilities and Constraints

- xterm.js (canvas/WebGL) repaints constantly: heavy chrome over the terminal
  costs frames — expensive effects only on transient surfaces.
- ANSI colours inside xterm are semantic and need contrast.
- Process states: running (green), starting (yellow), error (red),
  exited/idle (neutral) — the chrome's only semantic chroma.
- Canvas zoom is `transform: scale`; resize grips have their own math
  (`--cv-grab`/`--cv-z`) whose behaviour must not change.
- Window with `decorations: false`: dragging depends on `data-tauri-drag-region`.
- The app has to work offline (no fonts/resources fetched from the network at runtime).

## Brand Commitments

- Name: **Yard**; the mark is a "Y" in a rounded square.
- Visual direction **pinned by the author on 2026-08-13**: "modern premium,
  glass and mini-windows", with full freedom granted for the rest. It replaces the
  previous world ("deep monochrome", white as the action colour).
- UI language: Brazilian Portuguese.

## Evidence on Hand

- README.md describes real features (F0–F4, canvas, bridge, floors,
  scores) — nothing needs to be invented.
- Token prices/costs come from `agents/sessions.rs`; never fabricate numbers.

## Product Principles

1. The chrome never competes with the terminal content — depth comes from
   material and light, not from saturation.
2. Chroma is semantic: process state and diffs; the rest of the chrome is neutral.
3. State is visible without hover: focus, live process, locked note, active floor.
4. No network at runtime; everything is bundled.
5. Numbers that change on their own don't dance (tabular-nums).

## Accessibility & Inclusion

Contrast ≥ 4.5:1 for chrome text over the surfaces; visible keyboard focus on
everything clickable; `prefers-reduced-motion` respected.
