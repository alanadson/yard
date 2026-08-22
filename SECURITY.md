# Security policy

Yard runs real processes on your machine: it spawns agent CLIs and shells in
ConPTY sessions, reads and writes files in your projects, creates git
worktrees, opens embedded browser portals, and exposes a local bridge (the
`yard` CLI) that agents use to talk to the app. A vulnerability here can mean
arbitrary code execution with your user's privileges, so please take reports
seriously and report responsibly.

## Supported versions

Only the latest release on `main` receives fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting on this repository
("Security" → "Report a vulnerability"). Include:

- what the issue is and its impact;
- steps to reproduce (a minimal project or command sequence is ideal);
- the Yard version or commit, and your Windows version.

You will get an acknowledgement within a few days. Once a fix is ready it is
released and the report is credited (unless you prefer otherwise).

## Scope notes

- The usage-limit meter in the title bar reads the credentials the agent CLIs
  store locally and calls each provider's **undocumented** usage endpoint. The
  tokens never leave the Rust backend; the front end only receives percentages
  and reset times. Reports about this surface are welcome.
- The bridge only accepts connections from processes the app itself spawned
  (see `docs/specs/02-architecture.md`). Anything that lets an unrelated
  process drive the bridge is in scope.
- Browser portals are separate WebView2 webviews; anything that lets a portal
  page reach the app's main webview, the file system, or the bridge is in
  scope.
