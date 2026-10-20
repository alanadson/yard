# Development

## Environment setup (Windows)

Run in a PowerShell with winget available:

```powershell
# 1) Rust (MSVC toolchain) + Visual Studio Build Tools (required for linking)
winget install Rustlang.Rustup
rustup default stable-msvc
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2) Node LTS (for Vite/the frontend)
winget install OpenJS.NodeJS.LTS

# 3) WebView2 — already ships with Windows 11 and with an up-to-date 10.
#    (Tauri's NSIS installer embeds the bootstrapper for machines without it.)

# 4) Run
npm install
npm run tauri dev    # development, with HMR
npm run tauri build  # NSIS installer in src-tauri/target/release/bundle
```

Quick checks if something fails: `rustup show` should report
`stable-x86_64-pc-windows-msvc`; `cl.exe` needs to exist in a "Developer
PowerShell"; a `link.exe` error = Build Tools without the C++ workload.

> Running a development build next to an installed one? Set `YARD_DATA_DIR`
> for the dev build — without it the two share the same `app.db` and the same
> scrollback folder (see the table below).

## Tests

Isolated native runs should set both `YARD_DATA_DIR` and `YARD_HOME_DIR` to
temporary folders. The latter redirects agent configuration, session discovery
and credential lookups. Also set `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
`WEBVIEW2_USER_DATA_FOLDER` inside that temporary root, so a test neither changes
the real agent configuration nor shares a browser profile with a running app.
The smoke harness applies these overrides and refuses a logged WebView creation
failure even when SQLite and the bridge have started.

`npm run test:native-work` exercises a built native binary with a fresh workspace,
home directory and WebView profile. It first preserves a separately enqueued
native task while applying an older renderer's queue edit, then removes only the
selected prompt. It checks that failed queue persistence retains the composer draft, waits for a held
acknowledgement without duplicate submission and preserves a newer draft. After
reloading a persisted delivery reservation it cancels and confirms explicit retry,
verifies the fresh attempt identity and removes an interrupted prompt through the
real queue controls. It then creates a task through the real interface,
delivers it through ConPTY, reads and reports with the real `yard` CLI, refuses
approval of a failed validation, records a correction, approves explicitly and
checks the preserved report history after a WebView reload. It also starts a fresh
terminal session, verifies the previous output archive, exports its exact bytes,
cancels and confirms archive removal, preserves current output and verifies global
history after removing the terminal card. It terminates only the child process
it started. Failed runs retain their isolated data and a screen
capture when the WebView remains accessible; successful runs remove that data.

The check uses an existing Playwright module and never installs packages. Set
`YARD_PLAYWRIGHT_MODULE` to its module directory if it is not available through
normal module resolution. Pass an executable path after `--` to check another
built binary:

```powershell
$env:YARD_PLAYWRIGHT_MODULE = 'C:/path/to/existing/node_modules/playwright'
npm run test:native-work
npm run test:native-work -- C:/path/to/yard.exe
npm run test:native-chat
npm run test:native-diagnostics
npm run test:native-costs
npm run test:native-rendering
npm run test:native-terminal-memory
npm run test:native-flows
npm run test:native-flow-recovery
npm run test:native-task-evidence
```

This check requires Windows, WebView2 and an interactive desktop. It covers the
work-report contract; Android hardware, installer transitions and production
update services require separate validation.

`test:native-terminal-memory` restores twelve stopped tabs with real histories.
It verifies that only the selected history loads at boot, that no more than two
stopped views remain mounted per pane, and that an evicted history is readable
again when selected. A controlled background PowerShell also verifies attachment
and process identity while stopped views are evicted. It uses isolated data and
the same existing Playwright module as the other native checks; it does not run
an installed coding agent. Build the release binary with `npm run app -- -NoLaunch`
before running this check, or pass the path of another production binary.

`test:native-flows` unloads the actual WebView while two pipeline stages run
through native ConPTY input and the authenticated `yard flow stage` command.
It verifies carried evidence and the completed result after a renderer reload.
`test:native-flow-recovery` kills the executor during stage two, replaces its
process and exercises the real review dialog. Declining sends no stage;
confirming resumes only stage two with the original request and first-stage
evidence. Dismissing the final result remains effective after a reload.

`test:native-task-evidence` delivers managed work while the page is unloaded and
provokes a real snapshot size-limit failure. It verifies the warning after
reload, durable recovery history and opening a linked checkpoint from task review.

The existing `test:native-legacy-flow` command checks compatibility of the flow
CLI with the native executor. It holds an agent's work rather than a renderer's
output read, and verifies that its queued peer waits for the complete pipeline.

`test:native-chat` uses the same isolated process harness. It names a topic through
the canvas UI, sends a request, receives a final response through the authenticated
CLI, exports JSON and Markdown through the real disk-writing backend and verifies
reload persistence. It then kills its own fixture process and checks cancellation
and confirmation of pending-turn review, retained messages and draft recovery
without replay. Only the native save-file picker is substituted, because the
browser driver cannot operate that Windows dialog.

The chat check also associates an assigned task through the topic picker, excludes
an unassigned task, follows the work-panel conversation link and verifies that a
chat response retains its task reference without changing the task's state.

`test:native-diagnostics` reads the actual local agent catalog, verifies the six
integration rows in Settings and holds a controlled discovery failure at the IPC
boundary to verify progress, retained diagnostics and error recovery. A subsequent
real refresh clears that failure. It also restores a temporary SSH profile and
checks that local transcript, MCP configuration, hook and account-limit adapters
are not presented as connected to that remote runtime. This verifies profile
rendering and discovery behavior; it does not establish an SSH or WSL connection.

`test:native-costs` writes an isolated synthetic session with repeated message IDs
and reported five-minute and one-hour cache writes. It compares native session
and daily-history estimates, checks the displayed one-hour subtotal and estimate
in the real costs panel and repeats the checks after reload. No provider request
or paid generation is made. The fixture exercises reference-price arithmetic,
compares a native Opus 5.5 estimate with the public pricing snapshot, searches the
reference modal, checks inherited legacy provenance and verifies return navigation.
It also saves custom rates through native IPC and the real editor, reprices cached
usage, verifies stale-save rejection and retained editor drafts, and removes the
override to restore the reference estimate. A synthetic Codex rollout verifies
custom-model pricing and disjoint cached input in both session and history reads.
These checks use an isolated database.

Archived output export writes a temporary file beside its chosen destination and
syncs it before replacing that destination with
[`std::fs::rename`](https://doc.rust-lang.org/std/fs/fn.rename.html). The real-file
regression test includes a hard-linked destination, so saving plain text cannot
rewrite the archived source through another name for the same file.

**Here the test is written first.** The rule, the cycle and the definition of
done are in the root [`AGENTS.md`](../AGENTS.md); the recipe per layer, with the
test seams that already exist in the code, is in
[spec 06 — Testing discipline](./specs/06-tdd.md).

```powershell
npm test                   # vitest: bridge core, canvas, note markdown
npm run test:watch         # the RED→GREEN cycle, live
cd src-tauri
cargo test --lib           # PTY engine, agents, persistence, bridge shims
```

The tests in `pty::engine_tests` start a real PowerShell and verify F1's
acceptance criteria (see the [roadmap](./specs/05-roadmap.md)). Details of what
each suite covers are in [features.md](./features.md#tests).

`build.rs` also compiles the `yard` CLI client (`src/yard_cli.rs`) into a
console exe with the same `rustc` cargo uses, about a second, and only when
that file changes. It is std only on purpose: no crates, no crate-level
attributes, because it is built on its own and also included in the lib as
`bridge::cli` for its tests.

## Launcher and environment variables

`npm run app` opens Yard freshly rebuilt from the code currently in the
repository. The launcher ([`scripts/yard.ps1`](../scripts/yard.ps1)) stamps two
hashes into `src-tauri/target` — one for the front end, one for the binary — and
rebuilds only the half that moved. A change under `src-tauri/src` no longer pays
for `tsc + vite`, and a change under `src/` does not recompile Rust beyond the
relink cargo works out on its own.

```powershell
npm run app                # rebuilds what changed and opens
npm run app:shortcut       # creates the shortcuts on the Desktop and in the Start Menu
npm run app:installer      # NSIS installer
```

There is a single `release` profile, shared by the launcher and by the
installer. It used to be `lto = true` + `codegen-units = 1` + `opt-level = "s"`,
which spent **5m 07s** relinking after one changed line, with a second
`release-fast` profile next to it to escape that — and a second profile means
cargo compiles and keeps all ~600 dependencies twice (2.4 GB, plus a full
rebuild every time you move between the two). Measured on a 16-core machine,
rebuilding after one changed line with every dependency already compiled:

| `[profile.release]` | rebuild |
| --- | --- |
| `lto = true`, `codegen-units = 1`, `opt-level = "s"` | 5m 07s |
| `lto = "thin"`, `codegen-units = 16`, `opt-level = 2` | 2m 01s |
| `lto = false`, `codegen-units = 16`, `opt-level = 2`, `incremental` | **35 s** |

Nearly the whole bill was one step: LTO over the 611-crate graph, on every
link. It buys something in what ships and nothing on a machine that rebuilds
twenty times an hour, so `release.yml` puts it back with
`CARGO_PROFILE_RELEASE_LTO=thin` and the local profile leaves it off. The same
goes for codegen units: 16 let a local rebuild codegen in parallel, and
`release.yml` sets `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1` so the optimizer
sees each crate whole in the build that ships, at the cost of a slower tag
build only. `opt-level` is 2 in both. The local binary is ~27 MB, against
~22 MB for the old fat-LTO, size-optimized profile.

The `dev` profile behind `npm run tauri dev` went through the same treatment.
The slow part of that loop was never the dependencies, which are cached, but
the last two steps of every rebuild: compiling `yard_lib` itself and linking
`yard.exe`. Measured on the same machine, rebuilding after one changed line:

| `[lib]` / `[profile.dev]` | rebuild |
| --- | --- |
| `crate-type = ["staticlib", "cdylib", "rlib"]`, full debuginfo everywhere | 14 to 19 s |
| `crate-type = ["rlib"]`, `debug = "line-tables-only"`, dependencies `debug = false` | **7 to 8 s** |

`staticlib` and `cdylib` come from the Tauri template and exist for the mobile
targets this app does not have; here every rebuild archived the whole graph
into a 1.4 GB `yard_lib.lib` and linked a DLL nothing loads. The debuginfo
settings shrink the PDB from 276 MB to 70 MB, which is where the linker spent
its time. What is given up: variable inspection in a debugger (backtraces keep
file and line). Put `debug = 2` back under `[profile.dev]` when you need it.
Changing either debuginfo line recompiles every dependency once, about two
minutes.

Everything else the launcher does follows from the same idea — don't pay for
what didn't move. Nothing changed at all: **0.5 s**. Only `src-tauri/` changed:
**11 s**, `tsc + vite` skipped. Only `src/` changed: the front end is rebuilt
(**22 s**, down from 29 s — `build.reportCompressedSize` was costing seconds to
print a gzip figure a local app never pays) and cargo relinks by itself, because
the assets `generate_context!` embeds come back as `include_bytes!` of the 1780
real files in `dist/` and rustc records every one of them.

While the app is open, Windows keeps the `.exe` locked — in that case the
launcher doesn't rebuild; it just brings the existing window to the front.

If builds still feel slow, the usual culprit on Windows is Defender scanning
every artifact cargo writes. From an **administrator** PowerShell, with the
path of your own clone:

```powershell
Add-MpPreference -ExclusionPath "C:\path\to\yard\src-tauri\target"
```

| Variable        | What for |
| --------------- | -------- |
| `YARD_DATA_DIR` | Redirects the data directory (default `%APPDATA%\Yard`). Also **turns off the single-instance lock** — two builds with their own directories don't corrupt each other. |
| `YARD_LOG`      | `tracing` filter, e.g. `yard_lib=debug,ui=debug,warn`. |

The main window's capabilities (`src-tauri/capabilities/default.json`) grant
the front end `global-shortcut:allow-register`/`allow-unregister` (the summon
hotkey) and `core:window:allow-hide` (close to the tray); the tray icon itself
is built in Rust and needs no JS permission.

Inside every terminal Yard opens, the app injects `YARD=1`, `YARD_PTY_ID`,
`YARD_PIPE`, `YARD_CLI`, `YARD_TOKEN` and, in agent terminals, `YARD_BRIDGE_HELP` (the
path to the bridge manual).

`YARD_TOKEN` is a per-run transport credential generated from 32 bytes of OS
cryptographic randomness. The backend assigns it after launch-profile environment
overrides. Both local clients and the optional SSH bridge send it with requests;
the bridge removes it before forwarding the request to the interface.

## CI/CD

Two workflows live in `.github/workflows/`:

- **`ci.yml`** — on every push to `main` and every pull request, on
  `windows-latest`: `npm run typecheck`, `npm test`, `npm run build`, then
  `cargo clippy -- -D warnings` and `cargo test --lib`. The Rust job builds the
  front end first because `tauri::generate_context!` embeds `dist/` at compile
  time. `pty::engine_tests` spawn a real PowerShell — the runner has one.
- **`release.yml`** — on a `v*` tag, builds the NSIS installer with
  `tauri-apps/tauri-action`, signs the updater artifacts, writes `latest.json`
  and attaches everything to a **draft** GitHub release for review. Release
  flow: `git tag v0.1.0 && git push origin v0.1.0`, then publish the draft —
  **publishing is what ships the update**: the app reads
  `https://github.com/alanadson/yard/releases/latest/download/latest.json`,
  and a draft is not "latest".

### Updater signing (required for every release)

The in-app updater (`src-tauri/src/updater.rs`, `src/stores/updaterStore.ts`)
only installs what the updater key signed. The key pair was generated with
`npx tauri signer generate -w %USERPROFILE%\.tauri\yard-updater.key`; the
public half lives in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`)
and a Rust test (`updater::tests`) fails the build if it goes missing. The
private half never enters the repository. The release job reads it from two
secrets:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the **content** of `yard-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (empty when the key has none) |

Without them `bundle.createUpdaterArtifacts` makes the build fail on purpose
— an unsigned installer can never become an update. Losing the private key
means every installed copy stops seeing updates: regenerate, ship one last
manually-installed release with the new public key, then continue.

**Building the installer on your own machine.** `npm run app:installer` goes
through [`scripts/installer.mjs`](../scripts/installer.mjs), which decides
before starting the compiler instead of after:

| What it finds | What it does |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` in the environment | signs, exactly as CI does |
| `%YARD_UPDATER_KEY%`, `.tauri\yard-updater.key` in the repo (gitignored), or `%USERPROFILE%\.tauri\yard-updater.key` | reads the key and signs |
| nothing | builds **without** updater artifacts and says so |

The last row is the point. Running `tauri build` straight with no key spends
the whole build and then dies on the last line with *"A public key has been
found, but no private key"*, leaving no installer at all. The password is
always passed, empty if it has none — with the variable absent minisign asks
for one on stdin and a scripted build hangs there.

The app checks half a minute after boot and every six hours after that
(`autoCheckUpdates`, off in Configurações → Dados e backup), keeps the last
check in `kv` (`updater.lastCheckAt`) so a reload does not fetch again, and
remembers a version the user ignored (`updater.skipVersion`). The installer
runs in `passive` mode and the app relaunches by itself.

### Code signing (optional; wired, waiting for a certificate)

Windows code signing is separate from the updater key: it is what stops
SmartScreen from asking on first install. The release job already carries the
step — import a PFX from `WINDOWS_CERT_PFX` (base64 of the `.pfx`) with
`WINDOWS_CERT_PASSWORD`, read its thumbprint and pass it to the bundler
through `--config` (`bundle.windows.certificateThumbprint`, `sha256`,
`http://timestamp.digicert.com`). With the two secrets absent the step is a
no-op and the build is unsigned, exactly as before; until a certificate exists
the SmartScreen prompt is documented in the README
([Windows pitfalls, item 7](./specs/04-windows-pitfalls.md)).

## Release validation

`npm run validate:release` runs TypeScript validation, frontend tests, dependency
auditing that rejects moderate-or-higher alerts, Rust lint with warnings
denied, and the Rust library tests, in order. It does not build the front end:
the installer step's `beforeBuildCommand` already runs `npm run build`. The first
failed child process stops all later checks and returns a failing exit status.
The tag release workflow runs this gate before importing a signing certificate
or starting the installer build. Pass a built binary after `--` to also verify
its isolated native boot. Interactive native work, chat, diagnostics, cost and rendering
checks remain available through the corresponding `test:native-*` scripts.

The release job also runs `test:packaged-install` on a disposable Windows runner.
It installs the previous published package when available, starts it with an
owned legacy SQLite fixture, replaces it with the current package and starts it
again. Both boots must migrate the database while preserving the original task
request, acceptance criteria and existing preference. Without a published
baseline, the result explicitly identifies a same-package reinstall. This
checks installation and replacement; it does not simulate the production
updater's network download or signature-verification service.

The installer check refuses workstations and self-hosted runners using the
[GitHub runner environment](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
It passes the install directory as the final unquoted `/D` argument, as required
by [NSIS](https://nsis.sourceforge.io/Docs/Chapter3.html). The smoke runner reuses
caller-owned temporary data without deleting it and rejects previous boot logs
as evidence for the replacement process.

The rendering check opens a real Markdown file through the palette, verifies
that disabled extensions retain ordinary code blocks, then enables Mermaid and
KaTeX and checks the diagram, formula and invalid-diagram fallback in WebView2.
It preserves a screenshot for visual inspection and uses the same isolated
workspace and child-process cleanup as the other native checks.

The optional Windows certificate step selects exactly one imported certificate
with a private key, code-signing extended usage, a valid 40-character thumbprint
and a validity period containing the current time. Invalid or ambiguous metadata
fails before the compiler starts. Tests read a real self-signed certificate created
in memory; they never import test keys into the user's Windows certificate store.

The dependency audit workflow also checks the locked npm tree weekly, on manifest
changes and on manual dispatch. It fails on moderate-or-higher advisories and keeps
the complete JSON result for 14 days, including lower-severity alerts. It uses
read-only repository permissions and never creates dependency branches or commits.

## Reporting a problem

**Configurações → Dados e backup → Relatar um problema** writes a support
bundle the user can attach to an issue. It contains, and only contains:

- `logs/yard.log.<date>` for today and yesterday (from `logs_dir()`);
- `about.json` — app version, OS, data directory, whether `YARD_DATA_DIR` is set;
- `agents.json` — the CLIs detected on the machine, with versions.

It never contains `app.db`, scrollback `.bin` files, the `kv` preferences,
notes, agent session files or anything from the user's projects — the test
`bundle_holds_recent_logs_and_the_two_jsons_and_nothing_else` in
`src-tauri/src/support.rs` pins that list. The "Copiar link do rastreador"
button copies the new-issue URL plus a skeleton to the clipboard; nothing in
production opens a browser.

## License

**Apache-2.0** (`LICENSE` file at the root; `license` fields in `package.json`
and in `Cargo.toml`). Chosen over MIT for the explicit patent grant, while
keeping the same openness for contributions and commercial use.

### Third-party work bundled into the app

Everything below ships inside the Yard and is switched on from
**Configurações**, one row per item on the page of the surface it changes.
Until 2026-08-27 the author and the licence of each were printed on its card in
a store shelf of its own; the shelf was retired, so the notice lives here — and
beside the code, in the `LICENSE` file vendored with each drop.

| What | Author | Version | Licence |
| --- | --- | --- | --- |
| Symbols icon theme (`FileGlyph/symbols/`) | Miguel Solorio | 0.0.25 | MIT |
| Material Icon Theme (`FileGlyph/material/`, `public/material-icons/`) | Philipp Kief | 5.37.0 | MIT |
| `@replit/codemirror-minimap` | Replit | 0.5.x | MIT |
| `@replit/codemirror-indentation-markers` | Replit | 6.5.x | MIT |
| `@replit/codemirror-css-color-picker` | Replit | 1.3.x | MIT |
| Prettier (format on save) | Prettier | 3.x | MIT |
| `@xterm/addon-image` (images in the terminal) | The xterm.js authors | 0.8.x | MIT |
| Mermaid | Knut Sveidqvist and contributors | 11.x | MIT |
| KaTeX | Khan Academy and contributors | 0.18.x (Mermaid's copy is overridden to the same one) | MIT |
| Bundled code fonts (via Fontsource) | JetBrains, Mozilla, GitHub, IBM and others | — | OFL 1.1 |

The colour palettes in `lib/colorSchemes.ts` are all MIT, and each is other
people's work: **Dracula** (Zeno Rocha and contributors), **Nord** (Sven Greb,
Nord Project), **Catppuccin Mocha** (Catppuccin Org), **Tokyo Night** (enkia),
**Rosé Pine** (Rosé Pine Org), **Solarized Dark** (Ethan Schoonover), **One
Dark** (Atom, GitHub), **Ayu Dark** (Ike Ku, dempfi), **GitHub Dark** (GitHub,
Primer) and **Min Dark** (Miguel Solorio). A palette added to that file belongs
in this paragraph on the same commit.
