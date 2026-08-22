# AGENTS.md — how work gets done in this repository

This applies to every agent (Claude Code, Codex, OpenCode…) and to every human.
Read it in full before your first `Edit`. The architecture specs live in
[`docs/`](./docs/README.md); the test discipline in detail, with the examples
that already exist in the code, is in
[`docs/specs/06-tdd.md`](./docs/specs/06-tdd.md).

---

## The rule

**No line of production code lands here without a test that failed first.**
TypeScript, Rust, it makes no difference. You write the test, watch it fail for
the right reason, and only then write the code that makes it pass.

This is not an ideal to chase when there is time left over — it is the shape of
the work. A task that is "done" with no new test is a task **not delivered**,
and reporting it as done is reporting wrong.

Why here, specifically: this app orchestrates real processes (ConPTY, Job
Objects, SQLite, git worktrees) and exposes a contract to external agents (the
`yard` CLI). Almost everything that breaks here breaks **silently** — an orphan
wire in `layoutJson`, a leftover `node.exe`, a pipe name that changed. None of
it shows up on screen. It only shows up in the test.

---

## 0. Thirty seconds before you touch anything

Run the baseline and confirm it is green. If it is already red, **that** is the
first task — do not pile new work on top of a broken suite.

```powershell
npm test                     # vitest — today: 151 files, 1824 tests, ~8 s
npm run typecheck            # tsc --noEmit
cd src-tauri; cargo test --lib   # Rust — pty::engine_tests spawns a real PowerShell
```

From the repository root, without changing directory:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

---

## 1. The cycle, step by step

### RED — write the test first

1. Say in one sentence, in the voice of behaviour, what is going to change:
   _"closing the tab also deletes the card's role and routines"_. That sentence
   becomes the test name.
2. Write the test **against the API you wish you had**, even if it does not
   exist yet. That is how you discover the good signature before spending an
   hour on the bad one.
3. Run just that test and **look at the failure**:

   ```powershell
   npx vitest run src/lib/lifecycle.test.ts -t "deletes the role"
   cd src-tauri; cargo test --lib test_name
   ```

4. The failure has to be for the right reason: an assertion that did not hold,
   or a symbol that does not exist yet. If it failed because of a broken
   import, a wrong path or a typo in a mock, **fix the test** — that is not
   RED, that is a crooked test.

> Never skip this step "because it is obvious it will fail". A test that was
> never seen red proves nothing: half of the useless tests in the world pass
> with the code deleted.

### GREEN — just enough to pass

5. Write the simplest implementation that makes that test pass. No speculative
   generality, no configuration option for the future, no case that no test
   asked for.
6. Run the test. Green.
7. Run the whole suite on that side (`npm test` or `cargo test --lib`). Green
   as well — if you broke another test, either the contract changed on purpose
   (then **say so** and update the old test explaining why) or you just
   introduced a bug.

### REFACTOR — with the safety net up

8. Now, yes: extract, rename, simplify, remove duplication — yours and the
   test's. The suite has to stay green at every step.
9. Repeat the cycle for the next behaviour. Small steps, one behaviour per lap,
   never the whole feature at once.

### One feature = many laps

Do not write twenty tests and then the code. Write one test, make it pass,
refactor, next. The order of behaviours is usually: simplest happy path → a
real variation → an edge case → the error the user provokes.

---

## 2. Where the test lives

| Layer                        | Code                         | Test                                                        | Runs with          |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------- | ------------------ |
| Pure front-end logic         | `src/lib/x.ts`               | `src/lib/x.test.ts` (sibling, same name)                    | `npm test`         |
| Zustand store                | `src/stores/xStore.ts`       | `src/stores/xStore.test.ts`                                 | `npm test`         |
| A rule inside a component    | `src/components/X/index.tsx` | extract the rule to `X/rule.ts` and test `rule.test.ts`     | `npm test`         |
| Rust module                  | `src-tauri/src/x.rs`         | `#[cfg(test)] mod tests` at the end of the same file        | `cargo test --lib` |
| Large Rust suite             | `src-tauri/src/pty/mod.rs`   | sibling file (`pty/engine_tests.rs`)                        | `cargo test --lib` |

Rule of thumb: **the test sits right next to the code it describes.** There is
no `tests/` folder in this project, and you are not to create one.

---

## 3. How the test has to be written

- **The name describes behaviour, not a function.** `distinct_names_do_not_collide_in_the_same_file`,
  not `test_file_for`. In TS: `it("uses the LAST summary — a block from an earlier turn must not win")`.
  If the name does not explain the defect the test prevents, it is weak.
- **One behaviour per test.** Several `expect`s about the same behaviour are
  fine; two behaviours in the same `it` are not — when it fails, you want to
  know which of the two.
- **A comment at the top of the file saying why these rules matter.** That is
  the convention here (see `src/lib/flow.test.ts`, `src/lib/bridgeCore.test.ts`,
  `src-tauri/src/pty/engine_tests.rs`). One sentence of context is worth more
  than ten assertions with no explanation.
- **Assert on observable behaviour**, not on the innards: what the function
  returns and what it leaves written, not how many times it called an internal
  method.
- **No mocking of what is yours.** Mock only at the process boundary: `./ipc`,
  `@tauri-apps/plugin-dialog`, and even then think twice. If testing your
  function required mocking three modules from `src/lib` itself, the design is
  wrong — separate calculation from effect.
- **Determinism, always.** No `Date.now()`, `Math.random()` or live timer loose
  inside the rule: take the clock as a parameter (that is what
  `bridgeCore.test.ts` does with `let clock = 1_000`). If you need to wait on a
  real process, wait for a condition with a deadline, as `pty::engine_tests`
  does — never a fixed `sleep` hoping it is long enough.
- **Disk and database isolation.** In Rust:
  `std::env::temp_dir().join(format!("yard-something-{}", std::process::id()))`,
  `rusqlite::Connection::open_in_memory()`, and `YARD_DATA_DIR` pointed at a
  temporary folder before any write — a test must **never** write to
  `%APPDATA%\Yard`, which is where the user's real work lives.
- **Language:** everything developer-facing in the repository — docs, comments,
  test names, identifiers, commit messages — is English. The product UI (the
  strings rendered to the end user) is intentionally Brazilian Portuguese and
  stays that way, and tests that assert on UI text keep those strings verbatim.

---

## 4. "This can't be tested" — it can, and the repository already shows how

Every time the answer is "it can't", the problem is the design, not the test.
The way out is always the same: **separate the decision from the effect** and
test the decision.

| The obstacle                          | What to do                                                                                         | Where it already exists                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Needs Tauri to emit an event          | Put the emission behind a trait and inject an in-memory collector                                  | `PtyEvents` + `emit::collect::CollectingEvents` |
| Needs `invoke()`                      | `vi.mock("./ipc")` with the functions created in `vi.hoisted()`                                    | `src/lib/lifecycle.test.ts`                     |
| Needs the Windows API                 | Extract the calculation (geometry, clipping, file name) into a pure function and test with numbers | `region_spec` in `portal.rs`                    |
| Needs the DOM                         | Extract the rule into a pure module; if a tiny piece is left, `vi.stubGlobal("window", { … })`     | `src/lib/lifecycle.test.ts`                     |
| Needs SQLite                          | `Connection::open_in_memory()`                                                                     | `pty/engine_tests.rs` (`Fixture::new`)          |
| Needs a real process                  | Spawn the real process, with isolated data, and wait for a condition with a deadline               | `pty/engine_tests.rs`                           |
| Needs the clock                       | Pass the instant as an argument                                                                    | `bridgeCore.test.ts`                            |
| Needs a git repository                | Create one in a temporary folder inside the test itself                                            | `git.rs` (`mod tests`)                          |

What genuinely has **no** unit test here: pixels, CSS, markup, icons,
documentation text. In those cases the rule changes shape, it does not
disappear — see §6.

---

## 5. Bug fixes: the regression test comes first

1. Reproduce the bug **as a test**, before understanding the cause. The test
   fails — that failure is the proof that you really reproduced it.
2. Only then investigate and fix.
3. Leave a short comment on the test saying which regression it locks down. The
   pattern here:

   ```rust
   /// The regression that motivated the fix: two distinct names wrote to the
   /// same file and the second `save` swallowed the first with no warning.
   #[test]
   fn distinct_names_do_not_collide_in_the_same_file() { … }
   ```

A bug fixed without a regression test comes back. It is the most expensive kind
of work there is: you pay twice for the same defect.

---

## 6. Changes that genuinely cannot be tested

CSS, layout, icons, colour, copy, documentation. Here you do **not** invent a
theatrical test (`expect(true).toBe(true)`, a CSS class snapshot, a test that
merely repeats the constant). Instead:

1. Run `npm run typecheck` and the suite — the change must not break anything.
2. Validate in the real application (`npm run app`) and say, in your reply,
   what you looked at and what you saw.
3. Write the honest sentence: **"no new test: visual-only change, validated in
   `npm run app`."**

If the visual change carries any rule — when to show, how to sort, what to
count, which label in which state — that rule leaves the JSX, becomes a pure
function and **has** a test. The visual part is what is left once the logic is
taken out.

---

## 7. Definition of done (checklist, no exceptions)

- [ ] There is a new (or changed) test describing the behaviour that changed
- [ ] That test **was seen red** before the implementation
- [ ] `npm test` green
- [ ] `npm run typecheck` clean
- [ ] `cargo test --lib` green (if you touched `src-tauri/`)
- [ ] No old test was deleted, commented out, `.skip`ped, `#[ignore]`d or
      loosened to fit the change
- [ ] If an old test changed, the reply explains which contract changed and why
- [ ] Docs updated when the contract is public (README, `docs/specs/`)

---

## 8. Forbidden

- Writing production code before the test — including "just this little file".
- Tweaking the test until it passes without understanding why it was failing.
- Deleting, `skip`ping or loosening a red test to "unblock".
- Testing internal detail (private field, call order, shape of the state)
  instead of behaviour.
- A decorative test just to tick the checklist.
- A fixed `sleep` waiting on a process; wait for a condition with a deadline.
- Bringing in a new test dependency (jsdom, testing-library, mockall…) without
  asking first: today vitest runs in a node environment, with no DOM, on
  purpose — that is what keeps the suite at 5 seconds.
- Committing with a red suite; committing or pushing without the user asking.
- Saying "done" with a test missing, skipped or failing. If something was left
  out, say exactly what.

---

## 9. Commands, quick reference

```powershell
npm test                                   # everything on the front end
npm run test:watch                         # live RED→GREEN cycle
npx vitest run src/lib/flow.test.ts        # one file
npx vitest run -t "part of the name"       # one test
npm run typecheck                          # tsc --noEmit

cd src-tauri
cargo test --lib                           # everything in Rust
cargo test --lib distinct_names            # one test by name
cargo test --lib pty::engine_tests         # one module
cargo test --lib -- --nocapture            # with println! visible
cargo clippy -- -D warnings                # before wrapping up
```

---

## 10. How to report the work

In your reply, show the cycle — it is what proves TDD happened:

1. the test you wrote (its name and what it locks down);
2. that it failed first (the failure line is enough);
3. the green suite at the end, with the numbers (`115 files, 1412 tests`).

If something was left without a test, say so plainly, with the reason. An
honest account of a gap is worth more than a green that means nothing.
