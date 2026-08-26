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

## Launcher and environment variables

`npm run app` opens Yard freshly rebuilt from the code currently in the
repository. The launcher ([`scripts/yard.ps1`](../scripts/yard.ps1)) stamps a
hash of the sources into `src-tauri/target`: if nothing changed, it just starts
the executable; if something did, it runs the front-end build and recompiles the
binary before opening.

```powershell
npm run app                # rebuilds if needed and opens
npm run app:shortcut       # creates the shortcuts on the Desktop and in the Start Menu
npm run app:installer      # NSIS installer (full release build)
npm run app:release        # same as app, with the full release profile (LTO)
```

The build uses the `release-fast` profile (release without LTO): the binary is a
few MB larger and rebuilds drop from minutes to seconds. While the app is open,
Windows keeps the `.exe` locked — in that case the launcher doesn't rebuild; it
just brings the existing window to the front.

| Variable        | What for |
| --------------- | -------- |
| `YARD_DATA_DIR` | Redirects the data directory (default `%APPDATA%\Yard`). Also **turns off the single-instance lock** — two builds with their own directories don't corrupt each other. |
| `YARD_LOG`      | `tracing` filter, e.g. `yard_lib=debug,ui=debug,warn`. |

The main window's capabilities (`src-tauri/capabilities/default.json`) grant
the front end `global-shortcut:allow-register`/`allow-unregister` (the summon
hotkey) and `core:window:allow-hide` (close to the tray); the tray icon itself
is built in Rust and needs no JS permission.

Inside every terminal Yard opens, the app injects `YARD=1`, `YARD_PTY_ID`,
`YARD_PIPE`, `YARD_CLI` and — in agent terminals — `YARD_BRIDGE_HELP` (the
path to the bridge manual).

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
