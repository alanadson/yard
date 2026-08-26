# Test discipline (TDD)

> The operational law — the cycle, the checklist and what is forbidden — is in
> the root [`AGENTS.md`](../../AGENTS.md), and it applies to everyone who
> writes code here. This spec is the **how**: the recipe per layer, the seams
> that already exist in the code to make testable what looked impossible, and
> the contracts that must never be touched without a test in front.

## 1. Why TDD here, and not "tests afterwards"

Three reasons that belong to this project, not to general folklore:

1. **The failures are silent.** A wire pointing at a terminal that already died
   simply is not drawn; an orphan `node.exe` only shows up in Task Manager; a
   `save` that overwrites another warns nobody. None of that breaks the
   screen — it only breaks the user's trust, weeks later.
2. **There is a public contract.** The `yard` CLI is used by agents that have
   already written their scripts. Name dedup (`claude (2)`), note reach, the
   named pipe name — changing any of them breaks third-party automation. The
   test is where that contract is written down in executable form.
3. **The edge is Windows.** ConPTY, Job Objects, window regions, npm's `.cmd`
   shims. Expensive to reproduce by hand and easy to regress. A test that spawns
   a real PowerShell costs seconds; finding out in production costs an
   afternoon.

Writing the test **first** still brings a fourth benefit, the most underrated
one: the code is born with seams. That is how the PTY engine got the
`PtyEvents` trait — testing the heart of the app could not depend on bringing
up a GUI.

## 2. What the suite covers today

| Suite                  | Command                          | Size                            | Covers                                                                                              |
| ---------------------- | -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Front end (vitest)     | `npm test`                       | 115 files, 1412 tests, ~5 s     | canvas rules, bridge/CLI, fronts, flow, notes and markdown, editor, stores, preferences, extensions |
| Core (cargo)           | `cd src-tauri; cargo test --lib` | ~21 modules + `engine_tests`    | PTY engine, scrollback, agents, persistence/migrations, git, explorer, portals, bridge              |
| Types                  | `npm run typecheck`              | —                               | the IPC contract between `src/lib/ipc.ts` and the Rust commands, in the developer's hands          |

The `pty::engine_tests` tests are the F1 acceptance criteria from the
[roadmap](./05-roadmap.md) written as code: output reaches the scrollback and
the UI, `write` executes, `kill` leaves no orphan in the tree, `suspend`
preserves history, `restart` reuses the id, 6 MB of output does not overflow
the ring.

## 3. Recipe per layer

### 3.1 Pure front-end logic (`src/lib/*.ts`)

The normal case, and where every rule should migrate to. A sibling test file,
with the same name, starting with a comment that says what is at stake:

```ts
/**
 * Flow mode — the pure rules the run engine trusts blindly: what travels
 * between stage turns, which wire binds a CLI to a flow card…
 */
import { describe, expect, it } from "vitest";
import { extractCarry, CARRY_MARK } from "./flow";

describe("extractCarry", () => {
  it("uses the LAST summary — a block from an earlier turn must not win", () => {
    const out = `${CARRY_MARK}\nold\n...\n${CARRY_MARK}\nnew`;
    expect(extractCarry(out)).toBe(`${CARRY_MARK}\nnew`);
  });
});
```

Everything in a test file is English — the top comment, the test names, the
helpers. The only Portuguese a test may contain is a product UI string it
asserts on: the UI is intentionally Brazilian Portuguese, and those strings are
kept verbatim.

When the input is large (a canvas, a `TerminalRow`), write a **local builder**
at the top of the file (`function term(id: string)`, `function canvas(items)`)
instead of repeating the whole object in every test. That is the convention in
`flow.test.ts`, `bridgeCore.test.ts` and `lifecycle.test.ts`.

When the subject is text with a cursor, invent a readable notation and convert
it — `mdedit.test.ts` marks the cursor with `|` and the selection with `«…»`,
and the test reads like what the user sees.

### 3.2 Zustand store (`src/stores/*.ts`)

A store is global state: the test has to reset it, and the real rules
(parsing, filtering, deadlines) must be exported functions, testable without
touching the store.

```ts
function reset() {
  useBench.setState({ tasks: [], prompts: [], taskFilter: "project" });
}
```

Pattern: export `parseTasks`, `relevantTasks`, `daysUntil`… and test those; use
`useBench.getState()` only when the behaviour **is** the state transition.

### 3.3 Code that talks to the backend (`ipc`)

The process boundary is the only place where a mock is welcome. The pattern
here uses `vi.hoisted()` so the functions exist before `vi.mock` comes up:

```ts
const { ptyExists, killPty, saveWorkspace } = vi.hoisted(() => ({
  ptyExists: vi.fn(async () => false),
  killPty: vi.fn(async () => undefined),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 2 })),
}));
vi.mock("./ipc", () => ({ ipc: { ptyExists, killPty, saveWorkspace, /* … */ } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));
```

And assert on the **combined effect**, not on the isolated call: that the saved
`layoutJson` no longer has the card, the role, the routine or the wire — which
is exactly the regression `lifecycle.test.ts` locks down.

### 3.4 React component

There is no component renderer in the suite, and that is deliberate (§7). So:
**the rule leaves the JSX**. If the component decides something — what to show,
how to sort, which label in which state, what to count — that decision becomes
a pure function in a module next door (`src/components/X/rule.ts`) with its own
test, and the `.tsx` keeps the markup and the events. That is how
`components/FileTree/filter.ts`, `components/Palette/model.ts` and
`components/CodeEditor/shine.ts` were born.

### 3.5 Pure Rust

`#[cfg(test)] mod tests` at the end of the same file, with a short helper to
keep the assertion brief:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: f64, y: f64, w: f64, h: f64) -> Bounds { Bounds { x, y, w, h } }

    #[test]
    fn clips_what_overflows_the_canvas_edge() {
        let spec = region_spec(b(-50.0, 20.0, 400.0, 300.0), Some(b(0.0, 0.0, 300.0, 800.0)), &[], 1.0)
            .expect("region");
        assert_eq!(spec.base, [50, 0, 350, 300]);
    }
}
```

### 3.6 Rust with state (AppState + SQLite)

In-memory database, always:

```rust
let db = rusqlite::Connection::open_in_memory().expect("in-memory sqlite");
let state = Arc::new(AppState::new(db));
```

A migration is tested **back to front**: build the old schema with
`execute_batch`, run the migration, and check that the old data was adopted —
that is what `persistence/db.rs` does with the prototype's database.

### 3.7 Rust that talks to the operating system

Two strategies, in this order of preference:

**(a) Extract the calculation.** Clipping geometry, a sanitised file name, the
decision to suspend — all of that is arithmetic and strings, and needs no Win32
at all to be tested. `region_spec` (portals) and `file_for` (scores) are the
examples to copy.

**(b) Inject the bus.** When the effect is unavoidable, put the outside world
behind a trait and pass an in-memory collector:

```rust
pub trait PtyEvents { fn output(&self, id: &str, data: String); /* … */ }

// emit::collect::CollectingEvents — the same trait, keeping everything in a Mutex.
let events = Arc::new(CollectingEvents::default());
pty::spawn(events.clone(), &state, opts);
assert!(events.output.lock().contains("yard-alive-42"));
```

Three rules the engine tests have already taught, and that apply to any new
test that spawns a process:

- **Isolate the data.** `YARD_DATA_DIR` to a temporary folder, before the
  first write, otherwise the test writes into the installed app's
  `%APPDATA%\Yard` — on top of the user's real work.
- **Wait for a condition, with a deadline.** No `sleep(2s)` hoping to get
  lucky:

  ```rust
  fn wait_until(timeout: Duration, label: &str, mut cond: impl FnMut() -> bool) {
      let deadline = Instant::now() + timeout;
      while Instant::now() < deadline {
          if cond() { return; }
          std::thread::sleep(Duration::from_millis(50));
      }
      panic!("timed out waiting for: {label}");
  }
  ```

- **Answer `ESC[6n`.** During the handshake, conhost emits DSR-CPR and **holds
  all output** until someone answers. In the app it is xterm.js that answers;
  in a headless test, nobody does — the process stays alive, mute and stalled,
  with no error. That is why the `Fixture` starts a thread that answers
  `ESC[1;1R`. If your new test talks to a PTY and "hangs for no reason", this
  is it.

### 3.8 Rust that talks to git

Create the repository inside the test, in a temporary folder stamped with the
PID (`format!("yard-git-{}", std::process::id())`), run the real commands and
assert on the parsed `porcelain`. That is what `git.rs` does — and it is why
the `.gitignore`, worktree and diff tests survive git version changes.

## 4. Catalogue of seams

| Seam                                   | Where it lives                       | Used for                                            |
| -------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| `PtyEvents` / `CollectingEvents`       | `src-tauri/src/pty/emit.rs`          | Seeing what the engine emitted without bringing up Tauri |
| `YARD_DATA_DIR`                        | `paths.rs`, used in `engine_tests`   | Sending scrollback and `app.db` to a temporary folder |
| `wait_until`                           | `pty/engine_tests.rs`                | Waiting on a process without a fixed `sleep`        |
| `ps(script)`                           | `pty/engine_tests.rs`                | Short, `-NoProfile`, predictable PowerShell         |
| `Connection::open_in_memory()`         | `persistence/db.rs`, `engine_tests`  | One database per test, no file                      |
| `vi.hoisted()` + `vi.mock("./ipc")`    | `src/lib/lifecycle.test.ts`          | Cutting the boundary with Rust                      |
| `vi.stubGlobal("window", …)`           | `src/lib/lifecycle.test.ts`          | The little DOM that is left in a node environment   |
| Clock as a parameter (`clock`)         | `src/lib/bridgeCore.test.ts`         | Deterministic time                                  |
| Local builders (`term`, `canvas`)      | several `*.test.ts`                  | Large input without repetition                      |

Needed a new seam? It is born **together** with the test that asked for it,
stays in production code only if it is genuinely useful there (like the
trait), and goes into this catalogue.

## 5. Contracts you do not touch without a test in front

Changing any of these starts by writing/adjusting the test that describes the
new behaviour — and explaining, in your reply, what breaks for those already
using it:

- **The bridge's named pipe name** (`bridge.rs`) — it goes into the environment
  of every PTY; changing it breaks terminals that are already open. There is
  already a test locking the name.
- **The three `yard` CLI shims** and the absence of PowerShell 7 syntax in the
  `.ps1` — the user's machine may only have Windows PowerShell 5.1.
- **The CLI rules for agents** — name dedup, note/portal reach, the connection
  gate (`bridgeCore.ts`).
- **`normalizeCanvas` / `normalizeFloor`** — they read JSON written by earlier
  versions; a new field must not wipe old data.
- **SQLite migrations** — the upgrade path has to adopt everything.
- **Scrollback format** (append-only `.bin` + compaction) — the user's history
  on disk.

## 6. Test smells

| Smell                                          | What to do                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Test passes with the implementation deleted    | It was never red; redo the RED                                       |
| Had to mock an internal module of your own     | Separate calculation from effect; test the calculation               |
| Test name is the function name                 | Rename to the behaviour (what breaks if it disappears)               |
| Assertion on how many times a mock was called  | Assert on the observable result                                      |
| `sleep` to "give it time"                      | `wait_until` with a condition and a deadline                         |
| Test fails sometimes                           | Either non-deterministic time/order, or global state without `reset()` |
| Suite got slow                                 | Someone spawned a process where a pure function would do             |
| Giant snapshot                                 | Assert on the field that matters, with the reason written next to it |

## 7. The vitest environment is node, and it stays that way

There is no `jsdom`, `happy-dom` or `@testing-library` in the project. The
consequence is a good one: the pressure pushes logic into pure modules, and the
whole suite runs in about five seconds — fast enough to sit in `test:watch`
during the cycle. If one day a test genuinely needs a DOM, that is a project
decision (new dependency, slower suite): **ask first**, do not install it in
the middle of a task.

## 8. How a new module is born

1. Create `src/lib/thing.test.ts` (or the `mod tests` in the `.rs`) **before**
   the module.
2. Write the top comment: what promise this module makes, and to whom.
3. First test: the simplest happy path, with the API you want to have.
4. `npx vitest run src/lib/thing.test.ts` → red because of a missing symbol.
5. Create `thing.ts` with the smallest implementation that passes.
6. Next behaviour. Repeat until the rule is covered: happy path, real
   variation, edge, user error.
7. Only then wire it into the `.tsx`/the Tauri command — the wiring is the last
   step, and it is the part that has no unit test.

## 9. What the suite does not cover, and how to compensate

Clicking, dragging, resizing, painting: none of that is exercised
automatically — only the logic behind it. For a change that lives in that band,
validate in the real app (`npm run app`) and **say in your reply** what was
looked at. The horizon is the usual one: every time one of those regressions
appears, extract the rule that failed into a pure module and lock it with a
test, so that class of error never again depends on someone remembering to
look.
