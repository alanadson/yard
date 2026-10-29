# Local agent accounts

Delivery A adds isolated local Windows accounts for Codex, followed by Claude Code.
The existing system login remains available as **System default**. WSL and SSH
continue to authenticate in their destination environment.

## Account lifecycle

Settings > Agents > Codex or Claude Code contains the account list. Create a
label, open **Sign in**, finish the provider's native CLI flow, return to Settings
and choose **Check sign-in**. Selecting the default is a separate operation.
An open project or board supplies the login terminal's workspace.

| Operation | Codex | Claude Code |
| --- | --- | --- |
| Isolated home | `<data>/accounts/<id>/.codex` | `<data>/accounts/<id>/.claude` |
| Process environment | `CODEX_HOME` | `CLAUDE_CONFIG_DIR` |
| Interactive login | `codex login` | `claude auth login` |
| Verification | `codex login status` | `claude auth status` |
| User MCP file | `<home>/config.toml` | `<home>/.claude.json` |
| Session directory | `<home>/sessions` | `<home>/projects` |

Verification discards stdout and stderr, runs off the UI thread, and has a
12 second deadline with process tree cleanup. Failure never selects another
account. Provider credentials remain owned by the CLI. Yard neither imports
the system credential files nor implements a second OAuth token refresh loop.
Claude profiles receive Yard's three bridge skills, updated on launch.

## Terminal identity

Schema v10 adds `agent_accounts`, `account_defaults` and
`terminal_account_bindings`. The workspace snapshot does not own these bindings,
so autosave and full layout rewrites cannot change a terminal's account.
Migration binds existing Codex and Claude terminals to the system login.

A terminal binds on its first local provider launch. Selecting another default
only affects future unbound terminals. Restart and resume keep the original
binding. Session history also carries `accountId`; opening a transcript pins
the new terminal to that account before the process can start. Tabs and canvas
cards display their saved account label.

An unavailable account, missing home or incompatible transport aborts the
launch. Restart checks this before terminating the running process. There is
no fallback from a managed account to system credentials. Provider API keys,
OAuth token overrides and provider home overrides are removed from the child
environment before Yard applies the account home. Other terminal environment
settings keep their existing behavior.

An explicit login may recreate a registered account's missing home after a
backup restore. It marks the account as requiring verification. Normal launches
stay blocked until verification succeeds. Removing an account requires closing
both its running terminals and its saved resumable terminals. The confirmation
states that local login and history files will be deleted. Opaque terminal
bindings remain as retired references so an old ID cannot acquire the system
login after account removal. Removal covers the managed home directory;
external credential stores retain the provider CLI's own lifecycle.

## History, limits and configuration

The history command reads system sessions and registered account session roots.
The watcher observes the accounts parent directory recursively, including
accounts created after startup. Cost history includes those managed roots too.

Usage polling has one cache and backoff per provider/account pair. Snapshots
include every account reading and the selected provider readings for the status
bar. The frontend immediately reselects cached readings when the default changes
and ignores a late snapshot's obsolete selection. Automation also considers the
accounts of running pinned terminals. Selecting a different default does not
silently resume an already paused automation.

Some CLI authentication modes, including credentials kept in an OS keyring,
cannot supply the existing usage endpoints with a readable credential file.
In that case Yard reports unavailable limits and leaves authentication to the
CLI. The account manager does not treat a missing usage reading as a failed
native sign-in.

MCP listing captures the selected accounts. Editing, removing, reading secret
fields and probing a server carry that captured account identity through IPC,
so a later default change cannot redirect a pending operation. Profiles keep
their own MCP configuration; existing provider configuration is not copied into
a new profile. Project-scoped MCP files retain their existing project scope.

## Private data and exports

The database contains labels, provider IDs, status, defaults and terminal
bindings. Account snapshots do not read or serialize credential files. Native
login output is stored under the private account home, because an OAuth flow
can print callback codes or URLs. It is outside normal workspace scrollback.

The existing backup allowlist excludes the entire `accounts` directory,
including credentials, private login output and provider session files.
Backups retain the account metadata and bindings in SQLite. Restore therefore
requires signing in again on the destination machine. Support bundles retain
their existing log/build/agent-version allowlist and exclude account files.

## Validation

The rules have sibling Vitest tests in `src/lib/accounts.test.ts`,
`src/stores/accountsStore.test.ts`, `src/stores/usageStore.test.ts` and
`src/stores/mcpStore.test.ts`. Rust tests cover migration, isolated directories,
immutable bindings, failed authentication, restore recovery, managed session
discovery, MCP paths, independent usage backoff, bridge skills and backup privacy.
The PTY suite exercises real PowerShell children for account launch, restart and
private login output. Production behaviors were implemented after observing
their tests fail. Backup exclusion additionally has a characterization test of
the existing export allowlist.

`scripts/native-accounts.mjs` uses the packaged native WebView and isolated CLI
stand-ins for both providers. It exercises account creation, CLI login and
verification, default selection, restart, history, MCP writes and guarded removal.
It does not authenticate against a real provider or consume paid requests.

```powershell
npm test
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run app -- -NoLaunch
$env:YARD_PLAYWRIGHT_MODULE = '<existing Playwright module directory>'
node scripts/native-accounts.mjs src-tauri/target/release/yard.exe
```

Provider contracts: [Codex authentication](https://developers.openai.com/codex/auth/),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Claude configuration directory](https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds).
