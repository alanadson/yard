## What changes

<!-- One paragraph: the behaviour that changed, and why. -->

## The test that drove it

<!-- Name the test(s) you wrote first and the failure you saw before the
     implementation (the failing line is enough). See AGENTS.md §10. -->

## Checklist

- [ ] A new or changed test describes the behaviour that changed
- [ ] That test was seen red before the implementation
- [ ] `npm test` and `npm run typecheck` are green
- [ ] `cargo test --lib` and `cargo clippy -- -D warnings` are green (if `src-tauri/` changed)
- [ ] No old test was deleted, skipped or loosened to fit the change
- [ ] Docs updated where a public contract changed (README, `docs/specs/`)
