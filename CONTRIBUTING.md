# Contributing to Yard

Thanks for considering a contribution. Yard is a Windows desktop app (Tauri 2 +
Rust, React + TypeScript) that runs several coding agents side by side. Most of
what you need to know lives in one file: **[`AGENTS.md`](./AGENTS.md)** — the
working rules for every contributor, human or agent. Read it before your first
edit; the short version is below.

## The one rule

**No production code lands without a test that failed first.** TypeScript or
Rust, no exceptions. The cycle, where tests live, and the definition of done are
all in `AGENTS.md`; the detailed discipline with examples from the code is in
[`docs/specs/06-tdd.md`](./docs/specs/06-tdd.md).

## Setting up

Prerequisites: Windows 10/11, Rust stable (MSVC toolchain), Visual Studio Build
Tools with the C++ workload, Node 20+.

```powershell
npm install
npm run tauri dev        # development build with HMR
npm run app              # rebuild if needed and launch the app
```

Before you touch anything, confirm the baseline is green:

```powershell
npm test
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

More in [`docs/development.md`](./docs/development.md).

## Language

Everything developer-facing — code, comments, identifiers, test names, docs,
commit messages — is written in **English**. The product UI is intentionally in
**Brazilian Portuguese**; strings rendered to the end user stay that way, and
tests that assert on UI text keep those strings verbatim.

## Pull requests

1. Open an issue first for anything beyond a small fix, so the approach can be
   discussed before you spend time on it.
2. Branch from `main`. Keep the PR focused on one change.
3. Every behaviour change comes with the test that drove it (see `AGENTS.md`
   §7 for the checklist). CI runs `npm test`, `npm run typecheck`,
   `cargo test --lib` and `cargo clippy -D warnings`.
4. Update the docs when a public contract changes (the `yard` CLI, the bridge
   protocol, persisted formats, README, `docs/specs/`).
5. Write commit messages in the imperative, with a type prefix:
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Reporting bugs and proposing features

Use the issue templates. For security problems, **do not open a public issue** —
see [`SECURITY.md`](./SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE), the same license as the project.
