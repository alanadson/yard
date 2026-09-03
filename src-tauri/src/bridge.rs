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

    start_tcp(app.clone());

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

/// Secret every TCP request must carry, generated once per run.
///
/// The named pipe needs none: Windows already scopes it to this user's
/// session. The TCP listener exists precisely to be reached from *another*
/// machine (an agent running over SSH, through a reverse tunnel), and on that
/// machine the loopback is shared with every other process and user. So the
/// port alone proves nothing, and the token is the fence.
///
/// Random and per-run rather than derived from anything: it travels in a
/// remote process's environment, where it is readable by that user and by
/// root, and a token that outlived the session would keep working after the
/// tunnel is gone.
pub fn tcp_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        // 32 characters out of the nanoid alphabet the rest of the app uses.
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let mut out = String::with_capacity(32);
        let mut seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15)
            ^ (std::process::id() as u64) << 32
            ^ (&out as *const String as u64);
        for _ in 0..32 {
            // xorshift64*: no dependency, and this is a session secret behind
            // a loopback tunnel, not a key.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            out.push(ALPHABET[(seed % ALPHABET.len() as u64) as usize] as char);
        }
        out
    })
}

/// The loopback port the TCP twin is listening on, once it is up.
static TCP_PORT: OnceLock<u16> = OnceLock::new();

pub fn tcp_port() -> Option<u16> {
    TCP_PORT.get().copied()
}

/// Does this request carry the session token?
///
/// Compared in constant time over the bytes: the answer is a yes/no that an
/// attacker on the remote host can ask a million times.
fn token_ok(req: &serde_json::Value, expected: &str) -> bool {
    let Some(given) = req.get("token").and_then(|v| v.as_str()) else {
        return false;
    };
    if given.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in given.bytes().zip(expected.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// The loopback twin of the pipe, for agents that are not on this machine.
///
/// An agent launched over SSH runs on another computer: there is no named
/// pipe to reach, and until now that meant the whole `yard` CLI, asking
/// another agent, reading a note, driving a portal, simply did not exist for
/// it. A documented hole, and the reason "roda em: SSH" was half a feature.
///
/// The bridge therefore also listens on `127.0.0.1:0` (an ephemeral port the
/// OS picks; nothing is exposed to the network). `ssh -R` carries that port
/// to the remote host's own loopback, where the remote shim writes to it.
/// Every request through this door has to carry the session token.
///
/// A port that cannot be opened is not an error worth interrupting anyone
/// about: the local pipe keeps working and the SSH agents simply do not get
/// the bridge, which is where they were before.
fn start_tcp(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "bridge: sem porta local para a ponte remota");
                return;
            }
        };
        match listener.local_addr() {
            Ok(addr) => {
                let _ = TCP_PORT.set(addr.port());
                tracing::info!(port = addr.port(), "bridge: escutando no loopback");
            }
            Err(e) => {
                tracing::warn!(error = %e, "bridge: porta local desconhecida");
                return;
            }
        }
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(CONNECT_BACKOFF_MS)).await;
                continue;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(stream, app, true).await {
                    tracing::debug!(error = %e, "bridge: conexao TCP encerrada com erro");
                }
            });
        }
    });
}

async fn handle_conn(conn: NamedPipeServer, app: AppHandle) -> std::io::Result<()> {
    serve(conn, app, false).await
}

/// One JSON line in, one JSON line out, the same conversation over the pipe
/// and over the loopback socket. `guarded` is what tells them apart: a TCP
/// request has to prove it is ours.
async fn serve<S>(conn: S, app: AppHandle, guarded: bool) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
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

    if guarded && !token_ok(&req, tcp_token()) {
        let out = serde_json::json!({
            "code": 2,
            "output": "yard: token invalido (YARD_TOKEN nao confere)
",
        });
        conn.write_all(format!("{out}
").as_bytes()).await?;
        return Ok(());
    }

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
    std::fs::write(dir.join(CLAUDE_HOOKS_FILE), CLAUDE_HOOKS_JSON)?;
    Ok(())
}

/// The settings file Claude Code is launched with (`--settings <file>`),
/// written beside the shims so nothing lands in the user's home. Every hook
/// is the `yard` shim told which event it carries; the frontend reads the
/// same JSON on stdin (`src/lib/hookEvents.ts`).
pub const CLAUDE_HOOKS_FILE: &str = "claude-hooks.json";

pub fn claude_hooks_file() -> PathBuf {
    bin_dir().join(CLAUDE_HOOKS_FILE)
}

const CLAUDE_HOOKS_JSON: &str = r#"{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "yard hook prompt --stdin" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "yard hook stop --stdin" }] }],
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "yard hook permission --stdin" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "yard hook tool --stdin" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "yard hook session --stdin" }] }]
  }
}
"#;

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
- `yard recruit "Name" --floor "Floor Name"` — spawn the agent as a tab of that floor instead, with the floor's worktree as cwd (no cable: connections never cross floors, and a floor has no canvas)
- `yard recruit "Name" --replace "Old Name" --agent codex` — swap the process behind an existing card, keeping its position, connections and role
- `yard floor list`: ground and floors of this project. The ground is the project root, on whatever branch is checked out there; a floor is an isolated git worktree with a branch and a canvas of its own. A project has no other kind of child: plain folder-groups are gone
- `yard floor create "Name" [--branch x] [--existing-branch] [--adopt PATH] [--no-git] [--copy-ground] [--base REF] [--worktree-name FOLDER] [--dry-run] [--json]`: provision a new floor silently (the user's screen does not switch); `--copy-ground` clones the ground layout with stopped terminals. `--adopt PATH` opens the floor on a worktree git already knows about instead of creating one: nothing is written to the disk, and closing that floor never deletes it. `--base REF` picks the commit the branch grows from (frozen as an OID before anything is written) and `--worktree-name FOLDER` picks the folder under `.yard/floors/`. `--dry-run` prints the plan and writes nothing; `--json` prints that same plan (or result) with stable error codes. Exit codes: 0 all done, 2 the plan was refused, 3 partial, 4 something this run made is still on disk, 5 cancelled
- `yard floor land "Name" [--close] [--keep-losers]` — merge the floor's branch onto the ground (refuses dirty trees and predicted conflicts). `--close` removes the floor afterwards; without `--keep-losers` the other floors of the same task go too
- `yard floor compare` — diffstat of every isolated floor against the ground
- `yard floor fanout "Name" --prompt "…" [--agents claude,codex] [--copy-ground]` — same prompt, one isolated floor per agent
- `yard worker create "Name" --task "…" [--agent claude|codex|…] [--copy-ground]`: one isolated front, one agent card inside it, the task typed in as its first prompt; the front keeps the name you gave. Without `--agent`, the worker is the same CLI as you. `--stdin` takes the task from stdin
- `yard worker list [--json]`: every worker of this project with its state: `starting`, `working`, `done`, `blocked` (asking something), `permission` (the CLI's own hook said it waits on a permission), `stopped`, `exited`
- `yard worker inspect "Name"`: agent, branch, worktree path, card id, the task. A name, a unique prefix of it, or the group id all address a worker
- `yard worker wait "Name" [--until stopped|done|blocked] [--timeout s]`: block until the worker's card gets there, like `yard wait` but without a cable (workers live on other fronts)
- `yard worker send "Name" "text" [--queue]`: type into the worker (or `--stdin`); `--queue` leaves it for its next idle
- `yard worker review "Name"`: its branch against the ground: files with counts, predicted conflicts, dirty trees; what `apply` will see
- `yard worker apply "Name" [--keep-front] [--close-siblings]`: merge the branch onto the ground and close the front (`--keep-front` leaves it open); `--close-siblings` also closes the other fronts of the same task
- `yard worker keep "Name"`: the front stays as an ordinary front (branch and worktree intact) and stops being a worker
- `yard worker discard "Name"`: close the front: worktree and branch go (an adopted worktree is left alone). Refused from inside that front
- `yard worker stop "Name"`: kill the worker's process; the front and its files stay
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
- `yard canvas list [--json]`: everything on the canvas with its position and size; `[conectado]` marks what you reach
- `yard canvas move "Name" X Y` / `move "Name" --by DX DY` / `resize "Name" W H`: lay out a card or item you reach (never a pinned one)
- `yard canvas arrange [--layout grid|row|column] ["Name"...]` / `align left|hcenter|right|top|vcenter|bottom "A" "B"`: tidy your corner of the board; with no names, you and everything wired to you
- `yard canvas frame "Group name" ["Member"...]`: a named frame around them; `pin|unpin "Name"` fixes or frees an element
- `yard canvas focus "Name"` / `zoom fit|N%`: move the user's camera (use sparingly: it is their screen)
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

    /// Why the token matters: the pipe is reachable only by this Windows user,
    /// but the TCP twin exists to be reached **from another machine** through
    /// an SSH reverse tunnel, which means anything running on that remote
    /// host can also reach it. The token is the whole of the fence.
    #[test]
    fn a_request_without_the_token_is_refused_over_tcp() {
        let req = serde_json::json!({ "argv": ["list"] });
        assert!(!token_ok(&req, "segredo"));
    }

    #[test]
    fn the_wrong_token_is_refused() {
        let req = serde_json::json!({ "argv": ["list"], "token": "outro" });
        assert!(!token_ok(&req, "segredo"));
    }

    #[test]
    fn the_right_token_passes() {
        let req = serde_json::json!({ "argv": ["list"], "token": "segredo" });
        assert!(token_ok(&req, "segredo"));
    }

    /// A token of the wrong *length* must not be distinguishable by timing
    /// from one of the right length with wrong content. Both are simply false.
    #[test]
    fn a_shorter_token_does_not_pass_as_a_prefix() {
        let req = serde_json::json!({ "argv": ["list"], "token": "seg" });
        assert!(!token_ok(&req, "segredo"));
    }

    /// The session token goes into a remote process's environment, so it is
    /// worth being long and random rather than derived from anything.
    #[test]
    fn the_session_token_is_long_and_stable_within_the_session() {
        let a = tcp_token();
        assert_eq!(a, tcp_token());
        assert!(a.len() >= 32, "token curto demais: {}", a.len());
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }

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

        for f in ["yard.cmd", "yard.ps1", "yard", "YARD-BRIDGE.md", CLAUDE_HOOKS_FILE] {
            assert!(dir.join(f).is_file(), "missing {f}");
        }
        assert_eq!(help_path().file_name().unwrap(), "YARD-BRIDGE.md");
        assert_eq!(claude_hooks_file().file_name().unwrap(), CLAUDE_HOOKS_FILE);

        // The hooks file has to be JSON Claude Code accepts, and every event
        // the frontend knows how to read has to be in it.
        let hooks: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(CLAUDE_HOOKS_FILE)).unwrap())
                .expect("hooks file is JSON");
        for event in ["UserPromptSubmit", "Stop", "Notification", "PostToolUse", "SessionStart"] {
            let cmd = hooks["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap_or_else(|| panic!("no command for {event}"));
            assert!(cmd.starts_with("yard hook "), "{event}: {cmd}");
            assert!(cmd.ends_with("--stdin"), "{event}: {cmd}");
        }

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
