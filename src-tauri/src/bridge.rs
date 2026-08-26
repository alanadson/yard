//! Agent<->app bridge: the "`yard` CLI".
//!
//! Architecture: Rust is a dumb pipe. The `yard` CLI (shims in
//! `<data_dir>\bin`) writes ONE JSON line on a named pipe and waits for ONE
//! reply line. The server here only forwards the request to the
//! frontend (`bridge://request` event) and returns whatever the frontend
//! replies via the `bridge_respond` command. All intelligence — resolving
//! names, validating canvas connections, injecting prompts, waiting for the
//! agent to finish — lives in `src/lib/bridge.ts`, which holds workspace state.
//!
//! Also installs the bridge manual where agents find it on their own: the
//! `yard` skill in `~/.claude/skills/` (Claude Code) and
//! `<data>\bin\YARD-BRIDGE.md` pointed at by `YARD_BRIDGE_HELP` in the
//! environment (codex, opencode, gemini…).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

/// Maximum time a request may wait for the frontend. `ask` waits for the
/// other agent to finish, so the cap is generous; the CLI reports its own in
/// `timeoutMs` and this value is only the upper bound.
const MAX_WAIT_MS: u64 = 30 * 60 * 1000;
const DEFAULT_WAIT_MS: u64 = 3 * 60 * 1000;

/// Cap on one request line. A prompt — even a whole plan pasted through
/// `--file` — lives comfortably under this; anything larger is a mistake
/// (`yard note write "N" --file build.zip`) and used to be read into memory
/// whole, on both sides of the pipe.
const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

/// Pause after a failed `connect`, so a pipe that keeps refusing does not
/// become a hot loop for the rest of the session.
const CONNECT_BACKOFF_MS: u64 = 200;

static PENDING: OnceLock<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>>> =
    OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Mutex<HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Short pipe name (without the `\\.\pipe\` prefix), unique per data
/// directory — two isolated instances do not fight over the same pipe.
pub fn pipe_name() -> String {
    pipe_name_for(&crate::paths::app_dir())
}

/// Pure over the path: the name goes in every PTY's environment, so two
/// computations with the same data directory must always yield the same name —
/// otherwise an already-open terminal starts talking to a pipe that does not exist.
fn pipe_name_for(dir: &std::path::Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    dir.to_string_lossy().to_lowercase().hash(&mut h);
    format!("yard-bridge-{:016x}", h.finish())
}

/// CLI shims folder, added to PATH of every spawned terminal.
pub fn bin_dir() -> PathBuf {
    crate::paths::app_dir().join("bin")
}

pub fn cli_path() -> PathBuf {
    bin_dir().join("yard.cmd")
}

/// Bridge manual as a file, for agents that do not read Claude Code skills.
/// Goes in the environment as `YARD_BRIDGE_HELP` in every agent terminal.
pub fn help_path() -> PathBuf {
    bin_dir().join("YARD-BRIDGE.md")
}

/// Frontend reply to a pending request.
pub fn respond(id: u64, body: serde_json::Value) -> bool {
    match pending().lock().remove(&id) {
        Some(tx) => tx.send(body).is_ok(),
        None => false,
    }
}

/// Starts the server and prepares shims + skill. Failures here do not take
/// the app down: without the bridge, Yard is still a normal terminal.
pub fn start(app: AppHandle) {
    if let Err(e) = write_shims() {
        tracing::warn!(error = %e, "nao consegui escrever os shims da CLI yard");
    }
    if let Err(e) = install_agent_docs() {
        tracing::warn!(error = %e, "nao consegui instalar a documentacao da ponte");
    }

    let name = pipe_name();
    let full = format!(r"\\.\pipe\{name}");
    tauri::async_runtime::spawn(async move {
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&full) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, pipe = %full, "bridge: pipe indisponivel");
                return;
            }
        };
        tracing::info!(pipe = %full, "bridge: escutando");
        loop {
            if let Err(e) = server.connect().await {
                tracing::warn!(error = %e, "bridge: connect falhou");
                tokio::time::sleep(std::time::Duration::from_millis(CONNECT_BACKOFF_MS)).await;
                continue;
            }
            let conn = server;
            server = match ServerOptions::new().create(&full) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "bridge: nao consegui recriar o pipe");
                    return;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle_conn(conn, app).await {
                    tracing::debug!(error = %e, "bridge: conexao encerrada com erro");
                }
            });
        }
    });
}

async fn handle_conn(conn: NamedPipeServer, app: AppHandle) -> std::io::Result<()> {
    let mut reader = BufReader::new(conn);
    let mut line = String::new();
    // Bounded read: `read_line` on its own would take whatever the client
    // sends, and the CLI happily reads a whole file into the request.
    let read_bytes = (&mut reader)
        .take(MAX_REQUEST_BYTES + 1)
        .read_line(&mut line)
        .await?;
    let mut conn = reader.into_inner();

    if read_bytes as u64 > MAX_REQUEST_BYTES {
        let out = serde_json::json!({
            "code": 2,
            "output": format!(
                "yard: requisicao grande demais (limite de {} MB por chamada)\n",
                MAX_REQUEST_BYTES / (1024 * 1024)
            ),
        });
        conn.write_all(format!("{out}\n").as_bytes()).await?;
        return Ok(());
    }

    let req: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(e) => {
            let out = serde_json::json!({
                "code": 2,
                "output": format!("yard: requisicao invalida: {e}\n"),
            });
            conn.write_all(format!("{out}\n").as_bytes()).await?;
            return Ok(());
        }
    };

    let wait_ms = req
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_WAIT_MS)
        .clamp(1_000, MAX_WAIT_MS);

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending().lock().insert(id, tx);

    if let Err(e) = app.emit(
        "bridge://request",
        serde_json::json!({ "id": id, "request": req }),
    ) {
        pending().lock().remove(&id);
        let out = serde_json::json!({
            "code": 1,
            "output": format!("yard: a interface nao esta escutando ({e})\n"),
        });
        conn.write_all(format!("{out}\n").as_bytes()).await?;
        return Ok(());
    }

    let body = match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => serde_json::json!({
            "code": 1,
            "output": "yard: a interface descartou a requisicao\n",
        }),
        Err(_) => {
            pending().lock().remove(&id);
            serde_json::json!({
                "code": 1,
                "output": format!(
                    "yard: tempo esgotado apos {}s aguardando a resposta; use `yard check` para ver o estado atual\n",
                    wait_ms / 1000
                ),
            })
        }
    };

    conn.write_all(format!("{body}\n").as_bytes()).await?;
    conn.flush().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// shims
// ---------------------------------------------------------------------------

/// `yard.cmd` + `yard.ps1` + `yard` (Git Bash). The `.ps1` does the
/// work; the other two only forward, so the CLI exists the same in cmd,
/// PowerShell and bash.
fn write_shims() -> std::io::Result<()> {
    write_shims_to(&bin_dir())
}

/// The directory comes in as a parameter so the test does not have to touch
/// `YARD_DATA_DIR` — env vars are process-global, and cargo tests run in
/// parallel.
fn write_shims_to(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;

    std::fs::write(
        dir.join("yard.cmd"),
        "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0yard.ps1\" %*\r\n",
    )?;

    std::fs::write(
        dir.join("yard"),
        "#!/bin/sh\nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$(dirname \"$0\")/yard.ps1\" \"$@\"\n",
    )?;

    std::fs::write(dir.join("yard.ps1"), YARD_PS1)?;
    std::fs::write(
        dir.join("YARD-BRIDGE.md"),
        format!("# Yard — agent bridge\n\n{BRIDGE_DOC}"),
    )?;
    Ok(())
}

/// The pipe client. Compatible with Windows PowerShell 5.1 (no `??`,
/// no chain operators, no ternary).
const YARD_PS1: &str = r#"# yard — Yard app bridge CLI. Generated by the app; do not edit.
$ErrorActionPreference = "Stop"
$pipeName = $env:YARD_PIPE
if (-not $pipeName) {
  [Console]::Error.WriteLine("yard: fora de um terminal do Yard (YARD_PIPE ausente)")
  exit 2
}

# `ask` waits for the other agent to finish; the server caps the timeout.
$timeoutMs = 180000
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq "--timeout" -and ($i + 1) -lt $args.Count) {
    $timeoutMs = [int]([double]$args[$i + 1] * 1000)
  }
}
if ($args.Count -gt 0 -and ($args[0] -eq "ask" -or $args[0] -eq "recruit" -or $args[0] -eq "wait")) {
  if ($timeoutMs -lt 600000) { $timeoutMs = 600000 }
}

# Multi-line prompt: cmd.exe's `%*` eats newlines, so long text
# comes in via a file (`--file`) or stdin (`--stdin`) and travels in its own
# request field. `--file` is rewritten to `--stdin` so the app only has to
# know one form.
$stdinText = $null
$argv = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq "--file" -and ($i + 1) -lt $args.Count) {
    $p = [string]$args[$i + 1]
    if (-not (Test-Path -LiteralPath $p)) {
      [Console]::Error.WriteLine("yard: arquivo nao encontrado: $p")
      exit 2
    }
    $stdinText = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $p))
    [void]$argv.Add("--stdin")
    $i++
  } elseif ($a -eq "--stdin") {
    if ($null -eq $stdinText) { $stdinText = [Console]::In.ReadToEnd() }
    [void]$argv.Add("--stdin")
  } else {
    [void]$argv.Add($a)
  }
}

$req = @{
  v = 1
  terminal = $env:YARD_PTY_ID
  cwd = (Get-Location).Path
  argv = @($argv | ForEach-Object { [string]$_ })
  stdin = $stdinText
  timeoutMs = $timeoutMs
} | ConvertTo-Json -Compress -Depth 5

try {
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  $pipe.Connect(4000)
} catch {
  [Console]::Error.WriteLine("yard: nao consegui falar com o app Yard ($($_.Exception.Message)); ele esta aberto?")
  exit 2
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$writer = New-Object System.IO.StreamWriter($pipe, $utf8)
$writer.AutoFlush = $true
$writer.WriteLine($req)
$reader = New-Object System.IO.StreamReader($pipe, $utf8)
$line = $reader.ReadLine()
$pipe.Dispose()

if (-not $line) {
  [Console]::Error.WriteLine("yard: resposta vazia do app")
  exit 1
}
$res = $line | ConvertFrom-Json
if ($res.output) { [Console]::Out.Write([string]$res.output) }
exit [int]$res.code
"#;

// ---------------------------------------------------------------------------
// discovery by agents
// ---------------------------------------------------------------------------

/// Leaves the bridge manual where agents find it:
///
/// - `~/.claude/skills/{yard,yard-portal,yard-flow}/SKILL.md` — Claude Code
///   discovers the CLI, the portals and the flow-stage contract on its own,
///   without anyone pasting instructions;
/// - `<data>\bin\YARD-BRIDGE.md` — for the other agents (codex, opencode,
///   gemini…), which get the path in `YARD_BRIDGE_HELP` in the environment.
///
/// Overwrites **only** these files. Agent config that belongs to the
/// user (`~/.codex/AGENTS.md`, for example) is never touched — the README
/// documents the line to add by hand.
fn install_agent_docs() -> std::io::Result<()> {
    // `YARD-BRIDGE.md` is written with the shims (same folder, same write).
    let Some(home) = crate::paths::home_dir() else {
        return Ok(());
    };
    let dir = home.join(".claude").join("skills").join("yard");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        dir.join("SKILL.md"),
        format!("{SKILL_FRONTMATTER}{BRIDGE_DOC}"),
    )?;
    let portal_dir = home.join(".claude").join("skills").join("yard-portal");
    std::fs::create_dir_all(&portal_dir)?;
    std::fs::write(
        portal_dir.join("SKILL.md"),
        format!("{PORTAL_SKILL_FRONTMATTER}{PORTAL_DOC}"),
    )?;
    let flow_dir = home.join(".claude").join("skills").join("yard-flow");
    std::fs::create_dir_all(&flow_dir)?;
    std::fs::write(
        flow_dir.join("SKILL.md"),
        format!("{FLOW_SKILL_FRONTMATTER}{FLOW_DOC}"),
    )?;
    Ok(())
}

const SKILL_FRONTMATTER: &str = r#"---
name: yard
description: Use when running inside the Yard app (YARD=1 in env) to collaborate with other agents and notes connected on the canvas - ask a connected agent to do something, check on an agent, read or write a connected note, recruit a teammate, schedule a routine, or notify the user.
---

"#;

/// The contract agents read. Changed a command in `src/lib/bridge.ts`?
/// Change this with it — this text is the only thing they see.
const BRIDGE_DOC: &str = r#"# Yard Inter-Agent Communication

You're running inside Yard, a Windows workspace that connects AI agents,
terminals and notes on a visual canvas. The `yard` CLI is on PATH (fallback:
`"$YARD_CLI"`). Connected agents can exchange prompts; connected notes can
be read and written.

## Commands

- `yard list` — list yourself, connected agents, notes and portals (exact names)
- `yard ask "Agent Name" "prompt"` — send a prompt to a connected agent and wait for its response
- `yard ask "Agent Name" --file plan.md` — send a long/multi-line prompt from a file
- `yard ask "Agent Name" --stdin` — same, reading the prompt from stdin
- `yard ask "Agent Name" --raw "2\n"` — send raw keystrokes (escapes: \n Enter, \t Tab, \e ESC, \xNN byte)
- `yard ask "Agent Name" --no-wait "prompt"` — fire and forget
- `yard ask ... --timeout 600` — seconds to wait (default 600 for ask)
- `yard check "Agent Name"` — read the agent's current terminal output without sending anything
- `yard wait "Agent Name"` — block until it stops, instead of polling `check` in a loop
- `yard wait --any` / `yard wait --all` — same, over every connected agent
- `yard wait ... --until stopped|done|blocked` — `stopped` (default) is either; `blocked` wakes you only when it needs a human
- `yard wait ... --fresh` — require new output first (use after `ask --no-wait`, whose target may still be marked from its previous turn)
- `yard wait ... --timeout 600` — seconds to wait (default 600)
- `yard note create ["content"] [--name "Name"]` — create a note on the canvas linked to this terminal; the response prints the assigned name
- `yard note read "Note Name" [start count]` — read with line numbers
- `yard note write "Note Name" "content"` / `--file notes.md` / `--stdin` — replace the note's content
- `yard note edit "Note Name" "old text" "new text"` — replace a substring
- `yard note delete "Note Name"` — remove the note. Destructive: only when the user explicitly asks.
- `yard connect "A" "B"` — wire two things together (agent, note or portal). One
  end must be you or something already connected to you; you cannot wire two
  strangers together to reach them.
- `yard portal create URL ["Name"] [--engine webview2|chrome|firefox|…] [--size WxH]` — new browser card, auto-connected
- `yard portal snapshot "Name"` — accessibility tree with `@eN` refs (run this before click/fill)
- `yard portal click|fill|type|key|hover|scroll|resize|ua|screenshot|evaluate|html|text|info "Name" …`
- `yard portal close "Name"` — remove the card. Destructive: only when the user explicitly asks.
- `yard recruit "Name" [--agent claude|codex|...] [--role "text or saved role"] [--dir PATH]` — spawn a new agent terminal on the canvas, auto-connected to you; `--role` is handed to the new CLI on start, so it begins already knowing its job
- `yard recruit "Name" --floor "Floor Name"` — spawn the agent on that floor's canvas instead, with the floor's worktree as cwd (no cable: connections never cross floors)
- `yard recruit "Name" --replace "Old Name" --agent codex` — swap the process behind an existing card, keeping its position, connections and role
- `yard floor list` — ground and floors of this project (floor = isolated git worktree with its own canvas)
- `yard floor create "Name" [--branch x] [--existing-branch] [--no-git] [--copy-ground]` — provision a new floor silently (the user's screen does not switch); `--copy-ground` clones the ground layout with stopped terminals
- `yard floor land "Name" [--close] [--keep-losers]` — merge the floor's branch onto the ground (refuses dirty trees and predicted conflicts). `--close` removes the floor afterwards; without `--keep-losers` the other floors of the same task go too
- `yard floor compare` — diffstat of every isolated floor against the ground
- `yard floor fanout "Name" --prompt "…" [--agents claude,codex] [--copy-ground]` — same prompt, one isolated floor per agent
- `yard dismiss "Name"` — stop and remove a recruit you are connected to (destructive; prefer asking the user)
- `yard role set "Agent Name" "text or saved role name"` — the instructions are delivered to that agent right away (and stay on its command line for later starts), so use the wording you want it to follow
- `yard role show ["Agent Name"]` — the role of an agent, or the text of a saved role
- `yard role create "Role" "text" [--scope global|current]` / `role list` / `role edit` / `role write` / `role delete`
- `yard routine list` — scheduled prompts of this group
- `yard routine create "Agent Name" "prompt" --every 30 [--once]` — run a prompt every N minutes (only when the target is idle)
- `yard routine pause|resume|delete <id>` — manage them
- `yard trigger list` — the group's triggers: "when X happens to a CLI, do Y"
- `yard trigger create --when finished|blocked|exited --on "Agent Name"|any --ask "Target" "prompt" | --notify "text" | --flow "Flow Name" "task" [--once] [--cooldown 60]` — arm an automation on an edge (a CLI finished a turn, stopped at a question, or exited); `{name}` and `{ask}` in the text become who fired and the question it stopped at. Same gate as `ask`: source and target must be you or someone wired to you
- `yard trigger pause|resume|delete <id>` — manage them
- `yard flow list` — the group's flows: cards on the canvas holding an ordered pipeline of prompts (e.g. QA -> TDD). A flow has no agents of its own; the CLI wired to its card is who runs it
- `yard flow run "Flow Name" --stdin` (or `"task"`) — run the pipeline IN YOUR OWN CLI: each stage arrives here as a one-line `[Yard · Fluxo ...]` stamp. On each stamp, run `yard flow stage` to receive the briefing (the stage's instructions, the task and the previous stage's summary), follow it, and end the turn with the `### RESUMO DA ETAPA` block it asks for. Gate: your terminal must be wired to the flow's card (`yard connect "You" "Flow Name"` works)
- `yard flow stage` — the current stage's briefing for the run executing in your CLI; rerun it anytime you need the briefing again mid-stage
- When the USER types a prompt in a wired CLI, Yard intercepts the Enter and runs the pipeline there by itself — you never forward anything, and connecting sends nothing. Just honor each `[Yard · Fluxo ...]` stamp (`yard flow stage`, follow, summarize); never pass a `[Yard ...]` message to `yard flow run`
- `yard flow status ["Flow Name"]` / `yard flow cancel "Flow Name"` — follow or stop a run; never poll a running flow in a loop
- `yard score save "Name"` / `score list` / `score apply "Name"` — save and reapply the whole group arrangement. Saving refuses a name already taken; add `--force` only when the user asked to replace that arrangement
- `yard notify "message"` — native notification to the user (only when the user asked to be notified)
- `yard debug` — diagnose bridge issues; run this FIRST if any command fails
- `yard help` — full usage

## Rules

- Always run `yard list` first to get exact names. Communication only works
  between things connected on the canvas. The user draws connections; you can
  only grow the graph outward from where you already are (`yard connect` with
  one end you already reach, `yard note create`, `yard recruit`). If what you
  need is not listed, ask the user for the cable instead of trying to route
  around the gate.
- `ask` returns when the other agent goes idle. Scale your Bash timeout to the
  task (1-10 min). If it times out, do NOT resend - `yard check` first.
- Ask-back pattern: tell the agent to reply with `yard ask "Your Name" "<result>"`
  when done (your name is under `You:` in `yard list`).
- Never poll `check` in a loop to find out when someone finished - that is what
  `wait` is for. It costs you nothing while it waits and it answers the moment
  the state changes. Fan-out pattern: `recruit` the team, `ask --no-wait` each
  one, then a single `yard wait --all --fresh`.
- An agent marked `travado` in `yard list` is stopped at a question and only a
  human can answer it. Do not send it another prompt - tell the user, with
  `yard notify` if they asked to be told.
- Notes: prefer `edit` over `write` when a note already has content. A note's
  name derives from its first line unless it was created with `--name`. Notes
  the user locked show `(locked)` in `yard list` and refuse writes - ask the
  user instead of trying to work around it.
- Multi-line prompts: `cmd.exe` eats newlines, so use `--file` or `--stdin`
  instead of embedding `\n` in a quoted argument.
- Routines fire only while the target is running and idle, so they never
  interrupt work in progress.
- Never interrupt an agent that is still working; don't edit files another
  agent is actively modifying.
- Portals: only drive portals listed under `Portais conectados`. Always
  `snapshot` again after the page changes — `@eN` refs go stale.
"#;

const PORTAL_SKILL_FRONTMATTER: &str = r#"---
name: yard-portal
description: Drive a browser portal on the Yard canvas - navigate, snapshot, click, fill, type, screenshot. Use when the user asks to browse a URL, test a web UI, or interact with a website from the canvas.
---

"#;

const PORTAL_DOC: &str = r#"# Yard Portal

You're running inside Yard. Portals are native browser cards on the canvas
(WebView2, or Chrome/Firefox/Edge/Brave if the user installed them). The
`yard` CLI is on PATH (fallback: `"$YARD_CLI"`).

Portal name is always required. Run `yard list` to see `Portais conectados:`.

## Create

`yard portal create URL ["Name"] [--engine webview2|chrome|msedge|brave|chromium|firefox|…] [--size WxH]`

Creates the card to the right of you and connects it. `--engine` only works
if that browser is installed; otherwise the command refuses. Default engine
is the native WebView2 host.

```
yard portal create http://localhost:5173
yard portal create https://example.com "Docs" --engine chrome
yard portal create http://localhost:3000 "Mobile" --size 390x844
```

## Drive

`yard portal snapshot "Portal"` is the important verb — it returns an
accessibility tree with refs (`@e1`, `@e2`…) for every other command:

```
viewport: 1280x800  url: https://example.com  title: Example
@e1 a "Home" [10,5 60x20]
@e2 input type=text "Search" [200,50 300x32] *focused*
```

Selectors: `@e3` (from snapshot), `#id` (CSS), `350,200` (coordinates).

- `yard portal navigate "P" URL`
- `yard portal info "P"`
- `yard portal click "P" @e3`
- `yard portal fill "P" @e2 "value"`
- `yard portal type "P" @e2 "hello"` / `yard portal type "P" "hello"`
- `yard portal key "P" Enter` / `ctrl+a`
- `yard portal hover|focus "P" @e3`
- `yard portal select "P" @e5 "Option"`
- `yard portal check|uncheck "P" @e6`
- `yard portal scroll "P" down 300` (optional `@e` or `x,y`)
- `yard portal scrollintoview "P" @e10`
- `yard portal resize "P" 390 844`
- `yard portal ua "P" ios` (presets: ios, android, firefox-android, edge-android, chrome, firefox, edge, desktop)
- `yard portal screenshot "P"` — writes a file and prints the path
- `yard portal evaluate "P" "document.title"`
- `yard portal html "P"` / `yard portal text "P" @e1`
- `yard portal logs-start "P"` then `yard portal logs "P"`
- `yard portal edit "P" --url URL`
- `yard portal edit "P" --live on|off` — auto-reload when the site changes
- `yard portal close "P"` — **only if the user asked**

## Limits

- Cross-origin iframes are invisible to snapshot.
- Firefox/Chrome engines only activate when that browser is installed.
  Native WebView2 is always available.
- Popups become a sibling portal named after the host, connected to the parent.
- Escape inside the portal returns keyboard focus to the canvas.
- A portal on a local address reloads itself when the server starts serving
  something else (a rebuild). It is on by default there and off for the
  internet; `--live off` stops it.

## Workflow

1. `yard portal snapshot "Portal"`
2. `fill` / `click` / `key` using the refs
3. `snapshot` again to verify
"#;

const FLOW_SKILL_FRONTMATTER: &str = r#"---
name: yard-flow
description: Execute a stage of a Yard flow (a pipeline of prompts on the canvas). Use whenever a message stamped "[Yard · Fluxo ...]" arrives in the conversation, or when the user asks to run a flow from this CLI.
---

"#;

/// The stage contract agents read. Changed the stamp or `yard flow stage`
/// in `src/lib/flow.ts` / `src/lib/bridge.ts`? Change this with it.
const FLOW_DOC: &str = r#"# Yard Flow (Modo Fluxo)

You're running inside Yard. A flow is a card on the canvas holding an
ordered pipeline of prompts — stages such as Planner -> Executor -> QA. The
flow has no agents of its own: the CLI wired to its card (you) executes
every stage, one turn per stage. The `yard` CLI is on PATH (fallback:
`"$YARD_CLI"`).

## When a stamp arrives

A stage turn opens with a one-line stamp:

    [Yard · Fluxo "Entrega" — etapa 2/3: Executor] Rode `yard flow stage` ...

On every stamp, in this order:

1. Run `yard flow stage`. It returns this stage's briefing: the stage's
   instructions, the user's task and the previous stage's summary. The
   briefing is the real prompt — the stamp is only the doorbell, kept to one
   line so the user's prompt box stays theirs.
2. Do what the briefing asks — ONLY this stage's work, nothing beyond it.
3. End your turn with a final block starting with the line
   `### RESUMO DA ETAPA`, summarizing what you did and what the next stage
   needs to know. That block is how the pipeline carries context forward;
   skip it and the next stage inherits raw scrollback instead.

When the user typed the task themselves it sits right above the stamp, in
the same message — the briefing applies to that request.

## Rules

- Never forward a `[Yard ...]` message anywhere (not to `yard ask`, not to
  `yard flow run`): those are Yard's own messages, never user tasks.
- `yard flow stage` can be rerun anytime mid-stage to re-read the briefing.
- Don't poll `yard flow status` in a loop while a flow runs.
- Other verbs: `yard flow list` (the group's flows), `yard flow run "Name"
  --stdin` (run a pipeline here; gate: being wired to its card),
  `yard flow cancel "Name"`.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// The pipe name goes in every PTY's environment. If it changes between
    /// two reads, already-open terminals start talking to a pipe that no longer
    /// exists — that is why it must be pure over the data directory.
    #[test]
    fn pipe_name_is_stable_and_valid() {
        let dir = std::path::Path::new(r"C:\Users\alguem\AppData\Roaming\Yard");
        let a = pipe_name_for(dir);
        assert_eq!(a, pipe_name_for(dir));
        assert!(a.starts_with("yard-bridge-"));
        // Goes inside `\\.\pipe\<name>`: a separator there would create a path.
        assert!(!a.contains('\\') && !a.contains('/'));
        // Windows does not distinguish case in a path; the pipe cannot either.
        assert_eq!(
            a,
            pipe_name_for(std::path::Path::new(&dir.to_string_lossy().to_uppercase()))
        );
        // Isolated instance (`YARD_DATA_DIR`) cannot fight over the same pipe.
        assert_ne!(
            a,
            pipe_name_for(std::path::Path::new(r"C:\scratch\yard-profile"))
        );
    }

    /// The three shims must exist together: the CLI needs to work the same in
    /// cmd, PowerShell and Git Bash. And the agent manual lands in the same folder.
    #[test]
    fn shims_come_out_in_all_three_flavors() {
        let dir = std::env::temp_dir().join(format!("yard-shims-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_shims_to(&dir).expect("shims");

        for f in ["yard.cmd", "yard.ps1", "yard", "YARD-BRIDGE.md"] {
            assert!(dir.join(f).is_file(), "missing {f}");
        }
        assert_eq!(help_path().file_name().unwrap(), "YARD-BRIDGE.md");

        let ps1 = std::fs::read_to_string(dir.join("yard.ps1")).unwrap();
        // Windows PowerShell 5.1 does not have these operators: if one of them
        // lands in the shim, the CLI breaks on every machine without PowerShell 7.
        assert!(!ps1.contains("??"), "shim uses a PowerShell 7 operator");
        assert!(!ps1.contains("&&"), "shim uses PowerShell 7 chaining");
        assert!(ps1.contains("--stdin"), "shim lost --stdin support");
        assert!(ps1.contains("--file"), "shim lost --file support");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
