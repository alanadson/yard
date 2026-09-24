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

/// The native `yard` client. `build.rs` compiles this same file on its own
/// into the console exe the shims run; the lib includes it so the bridge
/// shares its probe constants and the tests reach its pure functions. Its
/// `main` and I/O helpers belong to the exe, hence the `dead_code` allowance.
#[allow(dead_code)]
#[path = "yard_cli.rs"]
pub(crate) mod cli;

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
    let bin = bin_dir();
    if let Err(e) = write_support_files(&bin) {
        tracing::warn!(error = %e, "nao consegui escrever os shims da CLI yard");
    }
    // The skills under `~/.claude/skills` are written on that thread too.
    choose_launcher_in_background(bin);

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
            // The accepted client is served first, whatever happens to the
            // next instance: a client that already connected must not be
            // dropped unanswered because the listener could not be recreated.
            let conn = server;
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = handle_conn(conn, app).await {
                        tracing::debug!(error = %e, "bridge: conexao encerrada com erro");
                    }
                });
            }
            server = match ServerOptions::new().create(&full) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "bridge: nao consegui recriar o pipe");
                    return;
                }
            };
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

/// The native `yard` client (`yard_cli.rs`), compiled by `build.rs` into a
/// console exe. Empty on a build for another OS, which means "use PowerShell".
const CLI_EXE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/yard-cli.exe"));

/// How long the probe may take. The first run of a freshly written unsigned
/// exe is when the antivirus looks at it: about 0.7 s on the machine this was
/// measured on, against 20 ms for every run after.
const PROBE_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Runs the client with the probe flag, hidden and bounded, and says whether
/// it printed the token: whether that exe can run on this machine at all. An
/// antivirus or Smart App Control blocking an unsigned program shows up here
/// instead of under every hook, and a failure is remembered beside the exe
/// (`choose_launcher`), so it shows up once per build and at most once a day,
/// not at every start.
fn probe_cli(exe: &std::path::Path) -> bool {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(cli::PROBE_FLAG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // The probe answers before it looks at the pipe; without the variable
        // even a client that got that wrong cannot send the app anything.
        .env_remove("YARD_PIPE");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match crate::git::run_bounded(cmd, PROBE_LIMIT) {
        Ok(out) => out.status.success() && out.stdout == cli::PROBE_TOKEN.as_bytes(),
        Err(e) => {
            tracing::info!(error = %e, exe = %exe.display(), "cliente yard nativo nao respondeu");
            false
        }
    }
}

/// What `yard.cmd` (cmd and PowerShell callers) and `yard` (Git Bash) hand
/// the call to. Both only forward, so the CLI exists the same in all three;
/// native shims whose exe has gone since the probe (an antivirus quarantining
/// it mid-session) forward to `yard.ps1` instead of failing every call.
#[derive(Debug, Clone, PartialEq)]
enum Launcher {
    /// The native client, by its file name beside the shims.
    Native(String),
    /// Windows PowerShell running `yard.ps1`: the shims as they always were,
    /// kept for machines where the native client cannot run.
    PowerShell,
}

const CMD_POWERSHELL: &str =
    "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0yard.ps1\" %*\r\n";
const SH_POWERSHELL: &str = "#!/bin/sh\nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$(dirname \"$0\")/yard.ps1\" \"$@\"\n";

/// How a native `yard.cmd` begins, up to the exe's name.
const CMD_NATIVE_HEAD: &str = "@echo off\r\nif exist \"%~dp0";

impl Launcher {
    /// `yard.cmd`. The arguments go on as `%*`, exactly as they went to
    /// powershell.exe. The exe's line is the file's last, so its exit code is
    /// the batch file's; the fallback line hands on powershell.exe's with
    /// `exit /b %errorlevel%` (a bare `exit /b` would make it 0).
    fn cmd(&self) -> String {
        match self {
            Launcher::Native(exe) => format!(
                "{CMD_NATIVE_HEAD}{exe}\" goto native\r\n\
                 powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0yard.ps1\" %*\r\n\
                 exit /b %errorlevel%\r\n:native\r\n\"%~dp0{exe}\" %*\r\n"
            ),
            Launcher::PowerShell => CMD_POWERSHELL.to_string(),
        }
    }

    /// `yard`, for Git Bash: `"$@"`, as before, with the same fallback.
    fn sh(&self) -> String {
        match self {
            Launcher::Native(exe) => format!(
                "#!/bin/sh\nd=$(dirname \"$0\")\n[ -f \"$d/{exe}\" ] && exec \"$d/{exe}\" \"$@\"\n\
                 exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$d/yard.ps1\" \"$@\"\n"
            ),
            Launcher::PowerShell => SH_POWERSHELL.to_string(),
        }
    }
}

const CLI_PREFIX: &str = "yard-cli-";
const CLI_SUFFIX: &str = ".exe";

/// `yard-cli-<FNV-1a 64 of the bytes>.exe`. Named after its content, a new
/// client never has to overwrite the file of an older one that may still be
/// running (a `yard ask` can wait ten minutes). FNV-1a because it cannot
/// change between Rust releases the way `DefaultHasher` may; fixed width, so
/// the next version's shims are as long as this one's.
fn cli_exe_name(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{CLI_PREFIX}{hash:016x}{CLI_SUFFIX}")
}

const REFUSED_SUFFIX: &str = ".blocked";

/// `yard-cli-<16 hex digits><suffix>`.
fn is_cli_name(name: &str, suffix: &str) -> bool {
    name.strip_prefix(CLI_PREFIX)
        .and_then(|rest| rest.strip_suffix(suffix))
        .is_some_and(|hash| hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_cli_exe_name(name: &str) -> bool {
    is_cli_name(name, CLI_SUFFIX)
}

/// `yard-cli-<hash>.blocked` beside `yard-cli-<hash>.exe`: that build failed
/// on this machine, at the Unix second the file holds.
fn refused_marker_name(exe_name: &str) -> String {
    format!("{}{REFUSED_SUFFIX}", exe_name.strip_suffix(CLI_SUFFIX).unwrap_or(exe_name))
}

/// How long a build that failed is left alone before it is tried again: a
/// policy can change, and a probe can run out of time while an antivirus
/// looks at a new file.
const RETRY_REFUSED_AFTER_SECS: u64 = 24 * 60 * 60;

/// Whether `marker` records a failure less than a day before `now_secs`. One
/// recorded after `now_secs` (the clock was set back) does not count.
fn refused_recently(marker: &std::path::Path, now_secs: u64) -> bool {
    std::fs::read_to_string(marker)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .and_then(|failed_at| now_secs.checked_sub(failed_at))
        .is_some_and(|age| age < RETRY_REFUSED_AFTER_SECS)
}

/// Puts this build's client beside the shims (unless the same bytes are
/// already there) and probes it: the native launcher if it runs, PowerShell
/// if anything fails on the way. Never an error, the fallback always exists.
/// A failure is remembered for this build, so a machine that refuses the
/// client is not asked again (and does not raise its block again) at every
/// start.
fn choose_launcher(
    dir: &std::path::Path,
    cli: &[u8],
    now_secs: u64,
    probe: impl FnOnce(&std::path::Path) -> bool,
) -> Launcher {
    if cli.is_empty() {
        return Launcher::PowerShell;
    }
    let name = cli_exe_name(cli);
    let exe = dir.join(&name);
    let refused = dir.join(refused_marker_name(&name));
    if refused_recently(&refused, now_secs) {
        tracing::info!(exe = %exe.display(), "o cliente yard nativo ja falhou nesta maquina; fica o PowerShell");
        return Launcher::PowerShell;
    }
    // Best effort: without the note the next start simply tries again.
    let remember_refusal = || {
        let _ = std::fs::write(&refused, now_secs.to_string());
        Launcher::PowerShell
    };
    let in_place = std::fs::read(&exe).is_ok_and(|bytes| bytes == cli);
    if !in_place {
        if let Err(e) = std::fs::write(&exe, cli) {
            tracing::warn!(error = %e, exe = %exe.display(), "nao consegui gravar o cliente yard nativo; fica o PowerShell");
            return remember_refusal();
        }
    }
    if probe(&exe) {
        let _ = std::fs::remove_file(&refused);
        Launcher::Native(name)
    } else {
        tracing::warn!(exe = %exe.display(), "o cliente yard nativo nao roda nesta maquina; fica o PowerShell");
        remember_refusal()
    }
}

/// The launcher both shims name, when they agree and it can run: PowerShell,
/// or a native client whose file is still there. `None` for missing,
/// mismatched or foreign shims.
fn launcher_on_disk(dir: &std::path::Path) -> Option<Launcher> {
    let cmd = std::fs::read_to_string(dir.join("yard.cmd")).ok()?;
    let sh = std::fs::read_to_string(dir.join("yard")).ok()?;
    if cmd == CMD_POWERSHELL && sh == SH_POWERSHELL {
        return Some(Launcher::PowerShell);
    }
    let (name, _) = cmd.strip_prefix(CMD_NATIVE_HEAD)?.split_once('"')?;
    let native = Launcher::Native(name.to_string());
    (is_cli_exe_name(name) && native.cmd() == cmd && native.sh() == sh && dir.join(name).is_file())
        .then_some(native)
}

fn write_if_changed(path: &std::path::Path, text: impl AsRef<str>) -> std::io::Result<()> {
    let text = text.as_ref();
    if std::fs::read(path).is_ok_and(|bytes| bytes == text.as_bytes()) {
        return Ok(());
    }
    std::fs::write(path, text)
}

/// The file name this build's client goes under, if the build has one.
fn current_cli_name(cli: &[u8]) -> Option<String> {
    (!cli.is_empty()).then(|| cli_exe_name(cli))
}

/// Points `yard.cmd` and `yard` at `launcher`, touching only what changed,
/// then removes every `yard-cli-*.exe` and failure note but this build's
/// (`current`, whose exe is kept even where it was refused, for its retry),
/// best effort: a client that is still running simply stays until the next
/// start.
fn write_launchers(
    dir: &std::path::Path,
    launcher: &Launcher,
    current: Option<&str>,
) -> std::io::Result<()> {
    write_if_changed(&dir.join("yard.cmd"), launcher.cmd())?;
    write_if_changed(&dir.join("yard"), launcher.sh())?;
    let current_refusal = current.map(refused_marker_name);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stale = (is_cli_exe_name(&name) && Some(name.as_ref()) != current)
                || (is_cli_name(&name, REFUSED_SUFFIX) && Some(name.as_ref()) != current_refusal.as_deref());
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// `write_shims_at` at one fixed instant, for the tests that do not care
/// when a refused client is tried again.
#[cfg(test)]
fn write_shims_with(
    dir: &std::path::Path,
    cli: &[u8],
    probe: impl FnOnce(&std::path::Path) -> bool,
) -> std::io::Result<()> {
    write_shims_at(dir, cli, 0, probe)
}

/// Everything at once, at the instant `now_secs` (Unix seconds), deciding
/// the launcher with `cli` and `probe` (the tests pass stand-ins). The app
/// runs the same steps in two halves, the second off the setup thread: see
/// `start`.
#[cfg(test)]
fn write_shims_at(
    dir: &std::path::Path,
    cli: &[u8],
    now_secs: u64,
    probe: impl FnOnce(&std::path::Path) -> bool,
) -> std::io::Result<()> {
    write_support_files(dir)?;
    let launcher = choose_launcher(dir, cli, now_secs, probe);
    write_launchers(dir, &launcher, current_cli_name(cli).as_deref())
}

/// The directory comes in as a parameter so the test does not have to touch
/// `YARD_DATA_DIR`: env vars are process-global, and cargo tests run in
/// parallel.
#[cfg(test)]
fn write_shims_to(dir: &std::path::Path) -> std::io::Result<()> {
    write_shims_with(dir, CLI_EXE, probe_cli)
}

/// The shims must not be rewritten once a terminal exists: cmd.exe reads a
/// batch file as it runs it, line by line, from where it left off, so
/// rewriting `yard.cmd` under a hook that is running it can run half of each
/// version. The launcher is chosen off the setup thread (the probe of a
/// freshly written exe takes most of a second while the antivirus looks at
/// it), and every spawn seals this gate without waiting for that choice. The
/// choice is normally made long before the window asks for a terminal; when a
/// terminal wins the race, that session keeps the shims `write_support_files`
/// checked (the earlier session's client, or PowerShell) and the next start,
/// whose exe is then in place and already scanned, adopts the new client.
struct LauncherGate {
    state: Mutex<GateState>,
}

struct GateState {
    /// A choice is being made in the background.
    pending: bool,
    /// A terminal went ahead: from now on the shims stay as they are.
    sealed: bool,
}

impl LauncherGate {
    const fn new() -> Self {
        LauncherGate {
            state: parking_lot::const_mutex(GateState { pending: false, sealed: false }),
        }
    }

    fn begin(&self) {
        self.state.lock().pending = true;
    }

    /// Ends the choice, running `write` only if no terminal went ahead first.
    fn settle(&self, write: impl FnOnce()) {
        let mut state = self.state.lock();
        if !state.sealed {
            write();
        }
        state.pending = false;
    }

    /// A terminal is about to exist: from now on the shims stay as they are.
    /// A choice still pending is given up on (its `settle` writes nothing) and
    /// this session keeps the shims `write_support_files` checked. Never
    /// waits for the choice; taking the lock only lets a `settle` that is
    /// already writing finish first.
    fn seal(&self) {
        let mut state = self.state.lock();
        if state.pending {
            tracing::info!("um terminal nasceu antes da escolha do cliente yard; ficam os shims atuais");
        }
        state.pending = false;
        state.sealed = true;
    }
}

static LAUNCHERS: LauncherGate = LauncherGate::new();

/// Called by every PTY spawn before the process exists, and never waits: see
/// `LauncherGate`.
pub fn seal_launchers() {
    LAUNCHERS.seal();
}

/// The second half of the shims, off the setup thread: write and probe the
/// native client, then point the shims at it (or keep PowerShell), unless a
/// terminal already went ahead. A thread that cannot even start leaves the
/// shims `write_support_files` checked.
fn choose_launcher_in_background(dir: PathBuf) {
    LAUNCHERS.begin();
    let spawned = std::thread::Builder::new()
        .name("yard-cli-shims".into())
        .spawn(move || {
            // First, and off the setup thread: the home folder can be a
            // roaming profile on a network share, and the window should not
            // wait on it to paint. Nothing before the first terminal needs
            // these (see `install_agent_docs`).
            install_agent_docs_logged();
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_secs());
            let launcher = choose_launcher(&dir, CLI_EXE, now_secs, probe_cli);
            tracing::info!(launcher = ?launcher, "shims da CLI yard");
            LAUNCHERS.settle(|| {
                if let Err(e) = write_launchers(&dir, &launcher, current_cli_name(CLI_EXE).as_deref()) {
                    tracing::warn!(error = %e, "nao consegui apontar os shims da CLI yard");
                }
            });
        });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "nao consegui escolher o cliente da CLI yard");
        install_agent_docs_logged();
        LAUNCHERS.settle(|| {});
    }
}

fn install_agent_docs_logged() {
    if let Err(e) = install_agent_docs() {
        tracing::warn!(error = %e, "nao consegui instalar a documentacao da ponte");
    }
}

/// The first half of the shims, on the setup thread before any terminal can
/// exist: the PowerShell client, the manual, the Claude hooks file, and
/// shims that work. Shims left by an earlier session are kept while what
/// they name is there (the background choice then only rewrites them if it
/// has to); missing, damaged or orphaned ones become the PowerShell pair, so
/// even a terminal born before the choice settles has a working `yard`.
///
/// Each file is written only when its text differs from what is on disk
/// (`write_if_changed`): this runs on every boot, and a file rewritten with the
/// same bytes still costs a flush, a new mtime and an antivirus scan.
fn write_support_files(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    write_if_changed(&dir.join("yard.ps1"), YARD_PS1)?;
    write_if_changed(
        &dir.join("YARD-BRIDGE.md"),
        format!("# Yard — agent bridge\n\n{BRIDGE_DOC}"),
    )?;
    write_if_changed(&dir.join(CLAUDE_HOOKS_FILE), CLAUDE_HOOKS_JSON)?;
    if launcher_on_disk(dir).is_none() {
        write_if_changed(&dir.join("yard.cmd"), CMD_POWERSHELL)?;
        write_if_changed(&dir.join("yard"), SH_POWERSHELL)?;
    }
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
/// documents the line to add by hand. Each is written only when its text
/// changed (`write_if_changed`).
///
/// Runs on the launcher thread, not in `setup`. Nothing waits for these files:
/// an agent session reads its skills when it starts, and the first terminal
/// spawns after the page has loaded, well after this thread wrote three small
/// files (or, nearly always, found them already up to date). At worst, a
/// session started in that window right after an update reads the previous
/// version's skill, which is what it would have read a second earlier.
fn install_agent_docs() -> std::io::Result<()> {
    // `YARD-BRIDGE.md` is written with the shims (same folder, same write).
    let Some(home) = crate::paths::home_dir() else {
        return Ok(());
    };
    install_agent_docs_in(&home)
}

/// `install_agent_docs` under `home`, which the tests point at a temporary
/// folder instead of the user's.
fn install_agent_docs_in(home: &std::path::Path) -> std::io::Result<()> {
    let dir = home.join(".claude").join("skills").join("yard");
    std::fs::create_dir_all(&dir)?;
    write_if_changed(
        &dir.join("SKILL.md"),
        format!("{SKILL_FRONTMATTER}{BRIDGE_DOC}"),
    )?;
    let portal_dir = home.join(".claude").join("skills").join("yard-portal");
    std::fs::create_dir_all(&portal_dir)?;
    write_if_changed(
        &portal_dir.join("SKILL.md"),
        format!("{PORTAL_SKILL_FRONTMATTER}{PORTAL_DOC}"),
    )?;
    let flow_dir = home.join(".claude").join("skills").join("yard-flow");
    std::fs::create_dir_all(&flow_dir)?;
    write_if_changed(
        &flow_dir.join("SKILL.md"),
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

Creates the card to the right of you and connects it. Every browser portal
runs in WebView2. Use `--ua` for user-agent presets; `--engine` is a legacy
alias for that setting and does not select another rendering engine.

```
yard portal create http://localhost:5173
yard portal create https://example.com "Docs" --engine chrome
yard portal create http://localhost:3000 "Mobile" --size 390x844
```

## Android devices

Install Android SDK Platform-Tools and expose `adb` through PATH,
ANDROID_HOME, ANDROID_SDK_ROOT, or the default Windows Android SDK folder.
Enable USB debugging and authorize the computer on the device. Connected
emulators use the same transport. Only devices in the `device` state can
be added; offline and unauthorized entries remain visible for diagnosis.

```
yard portal devices
yard portal create --device emulator-5554 "Android"
yard portal screenshot "Android"
yard portal snapshot "Android"
yard portal click "Android" 120,240
yard portal swipe "Android" 120,600 120,200 300
yard portal type "Android" "hello world"
yard portal key "Android" back
yard portal navigate "Android" https://example.com
yard portal launch "Android" com.example.app
yard portal stop "Android" com.example.app
```

Android snapshots contain UI Automator XML, not browser `@eN` references.
Clicks and swipes use native screen pixels. Text input accepts printable
ASCII without literal `%s`. Keys: back, home, recents, enter, delete,
power, volumeUp, volumeDown. Browser selectors, JavaScript evaluation,
user-agent changes and browser live reload do not apply to devices.
Device operations require a connected portal, just like browser operations.
Discovery lists devices attached to this computer. A screenshot returns a
local PNG path. The card refreshes screenshots; it is not a video stream.

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
- Browser cards use WebView2. User-agent presets do not emulate another engine.
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

    // -- files written at every boot ------------------------------------------
    //
    // `setup` wrote six files on every boot whether or not a byte had changed:
    // the PowerShell client, the manual and the Claude hooks beside the shims,
    // and the three skills under `~/.claude/skills`. Each write is a disk
    // flush, a new mtime for whatever watches those folders (Claude Code
    // watches its skills) and an antivirus scan, before the window can paint.

    /// An mtime no write made today: a file that still has it after a call was
    /// not written by that call.
    fn long_ago() -> std::time::SystemTime {
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000)
    }

    fn set_long_ago(path: &std::path::Path) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .and_then(|f| f.set_modified(long_ago()))
            .unwrap_or_else(|e| panic!("mtime of {}: {e}", path.display()));
    }

    fn mtime(path: &std::path::Path) -> std::time::SystemTime {
        std::fs::metadata(path).and_then(|m| m.modified()).expect("mtime")
    }

    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-boot-files-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    const SUPPORT_FILES: [&str; 3] = ["yard.ps1", "YARD-BRIDGE.md", CLAUDE_HOOKS_FILE];

    #[test]
    fn support_files_already_up_to_date_are_not_written_again() {
        let dir = fresh_dir("iguais");
        write_support_files(&dir).expect("first write");
        for name in SUPPORT_FILES {
            set_long_ago(&dir.join(name));
        }
        write_support_files(&dir).expect("second write");
        for name in SUPPORT_FILES {
            assert_eq!(mtime(&dir.join(name)), long_ago(), "{name} was written again");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Not writing must not mean not updating: a file left by another
    /// version (or edited by hand) gets this version's text.
    #[test]
    fn a_support_file_with_other_content_is_written() {
        let dir = fresh_dir("mudou");
        write_support_files(&dir).expect("first write");
        let expected: Vec<Vec<u8>> = SUPPORT_FILES
            .iter()
            .map(|name| std::fs::read(dir.join(name)).expect("written"))
            .collect();
        for name in SUPPORT_FILES {
            std::fs::write(dir.join(name), "de outra versao").unwrap();
        }
        write_support_files(&dir).expect("second write");
        for (name, want) in SUPPORT_FILES.iter().zip(expected) {
            assert_eq!(std::fs::read(dir.join(name)).unwrap(), want, "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn skill_files(home: &std::path::Path) -> Vec<std::path::PathBuf> {
        ["yard", "yard-portal", "yard-flow"]
            .iter()
            .map(|name| home.join(".claude").join("skills").join(name).join("SKILL.md"))
            .collect()
    }

    #[test]
    fn agent_skills_already_up_to_date_are_not_written_again() {
        let home = fresh_dir("skills-iguais");
        install_agent_docs_in(&home).expect("first install");
        for file in skill_files(&home) {
            set_long_ago(&file);
        }
        install_agent_docs_in(&home).expect("second install");
        for file in skill_files(&home) {
            assert_eq!(mtime(&file), long_ago(), "{} was written again", file.display());
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_agent_skill_with_other_content_is_written() {
        let home = fresh_dir("skills-mudou");
        install_agent_docs_in(&home).expect("first install");
        let expected: Vec<Vec<u8>> = skill_files(&home)
            .iter()
            .map(|file| std::fs::read(file).expect("written"))
            .collect();
        for file in skill_files(&home) {
            std::fs::write(&file, "de outra versao").unwrap();
        }
        install_agent_docs_in(&home).expect("second install");
        for (file, want) in skill_files(&home).iter().zip(expected) {
            assert_eq!(std::fs::read(file).unwrap(), want, "{}", file.display());
        }
        let _ = std::fs::remove_dir_all(&home);
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

    // -----------------------------------------------------------------------
    // the native client
    // -----------------------------------------------------------------------
    //
    // Every hook of every agent runs through the `yard` shims, so a client
    // that does not start, or answers differently from `yard.ps1`, breaks
    // every agent at once, and silently: the agent just sees a failed hook.
    // These run the real exe `build.rs` compiled.

    /// A fresh folder per test under the system temp dir, removed on drop.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir()
                .join(format!("yard-cli-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_embedded_client_answers_the_probe() {
        let scratch = Scratch::new("probe");
        let exe = scratch.path().join("yard-cli.exe");
        std::fs::write(&exe, CLI_EXE).expect("write client");
        assert!(probe_cli(&exe), "the client build.rs compiled does not run here");
    }

    #[test]
    fn a_file_that_is_not_a_program_fails_the_probe() {
        let scratch = Scratch::new("probe-junk");
        let exe = scratch.path().join("yard-cli.exe");
        std::fs::write(&exe, b"not a program").expect("write junk");
        assert!(!probe_cli(&exe));
        assert!(!probe_cli(&scratch.path().join("missing.exe")));
    }

    fn client_in(dir: &std::path::Path) -> std::path::PathBuf {
        let exe = dir.join("yard-cli.exe");
        std::fs::write(&exe, CLI_EXE).expect("write client");
        exe
    }

    /// A command for `program` run from `dir`, with the bridge variables of
    /// whatever terminal runs the suite removed: run inside Yard, a test
    /// would otherwise talk to the real app.
    fn isolated(program: impl AsRef<std::ffi::OsStr>, dir: &std::path::Path) -> std::process::Command {
        let mut cmd = std::process::Command::new(program);
        cmd.current_dir(dir).env_remove("YARD_PIPE").env_remove("YARD_PTY_ID");
        cmd
    }

    struct Ran {
        code: i32,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    }

    /// Runs `cmd` hidden with `stdin` on its input, and waits for it with a
    /// deadline rather than forever.
    fn run(mut cmd: std::process::Command, stdin: &[u8]) -> Ran {
        use std::io::Write as _;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("spawn");
        let mut input = child.stdin.take().expect("stdin");
        let _ = input.write_all(stdin);
        drop(input);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        let out = rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("the process finished within the deadline")
            .expect("wait");
        Ran {
            code: out.status.code().expect("exit code"),
            stdout: out.stdout,
            stderr: out.stderr,
        }
    }

    fn unique(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        format!("yard-test-{tag}-{}-{nanos}", std::process::id())
    }

    /// A stand-in for the app's end of the pipe: accepts one client per entry
    /// of `replies`, in turn, records its request line as it came, and answers
    /// with that entry (`None`: hangs up without a word).
    struct TestPipe {
        name: String,
        requests: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl TestPipe {
        fn serve(tag: &str, replies: Vec<Option<String>>) -> TestPipe {
            let name = unique(tag);
            let path = format!(r"\\.\pipe\{name}");
            let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("runtime");
                runtime.block_on(async move {
                    let mut server = ServerOptions::new()
                        .first_pipe_instance(true)
                        .create(&path)
                        .expect("test pipe");
                    let _ = ready_tx.send(());
                    for reply in replies {
                        if server.connect().await.is_err() {
                            return;
                        }
                        let conn = server;
                        server = ServerOptions::new().create(&path).expect("next instance");
                        let mut reader = BufReader::new(conn);
                        let mut line = String::new();
                        let _ = reader.read_line(&mut line).await;
                        seen.lock().push(line);
                        let mut conn = reader.into_inner();
                        if let Some(reply) = reply {
                            let _ = conn.write_all(format!("{reply}\n").as_bytes()).await;
                            let _ = conn.flush().await;
                        }
                    }
                });
            });
            ready_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("the test pipe is listening");
            TestPipe { name, requests }
        }

        fn raw(&self, i: usize) -> String {
            self.requests.lock()[i].clone()
        }

        fn request(&self, i: usize) -> serde_json::Value {
            serde_json::from_str(self.raw(i).trim()).expect("the request is JSON")
        }
    }

    #[test]
    fn outside_a_yard_terminal_the_client_says_so_and_exits_2() {
        let scratch = Scratch::new("no-pipe");
        let exe = client_in(scratch.path());
        let mut cmd = isolated(&exe, scratch.path());
        cmd.arg("list");
        let ran = run(cmd, b"");
        assert_eq!(ran.code, 2);
        assert_eq!(
            String::from_utf8_lossy(&ran.stderr),
            "yard: fora de um terminal do Yard (YARD_PIPE ausente)\r\n"
        );
        assert!(ran.stdout.is_empty());
    }

    /// `Connect(4000)`: an app that is still starting gets four seconds to
    /// open its pipe before the agent is told it is not there.
    #[test]
    fn an_app_that_is_not_there_is_waited_for_four_seconds_then_reported() {
        let scratch = Scratch::new("nobody");
        let exe = client_in(scratch.path());
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", unique("nobody")).arg("list");
        let started = std::time::Instant::now();
        let ran = run(cmd, b"");
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(3900),
            "gave up after {:?}",
            started.elapsed()
        );
        assert_eq!(ran.code, 2);
        let err = String::from_utf8_lossy(&ran.stderr);
        assert!(err.starts_with("yard: nao consegui falar com o app Yard ("), "{err}");
        assert!(err.ends_with("); ele esta aberto?\r\n"), "{err}");
        assert!(ran.stdout.is_empty());
    }

    /// The bug the native client fixes: `yard.ps1` wrote the reply in the
    /// console's OEM code page, so "não" reached the agent as `n\xC6o`,
    /// which is not UTF-8. Here the bytes are the reply's own UTF-8, and
    /// nothing is added after them.
    #[test]
    fn the_reply_reaches_stdout_as_utf8_with_nothing_added_and_its_code_is_the_exit_code() {
        let scratch = Scratch::new("reply");
        let exe = client_in(scratch.path());
        let pipe = TestPipe::serve("reply", vec![Some(r#"{"code":3,"output":"não ✓ pronto"}"#.to_string())]);
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", &pipe.name).args(["check", "Bob"]);
        let ran = run(cmd, b"");
        assert_eq!(ran.code, 3);
        assert_eq!(ran.stdout, "não ✓ pronto".as_bytes());
        assert!(ran.stderr.is_empty(), "{}", String::from_utf8_lossy(&ran.stderr));
    }

    /// The other half of the same bug: a hook payload is UTF-8, and one with an
    /// accent was read in the console's code page and reached the app as
    /// `a├º├úo`. Valid UTF-8 on standard input is read as UTF-8 now.
    #[test]
    fn the_request_carries_argv_the_terminal_the_folder_and_stdin_as_utf8() {
        let scratch = Scratch::new("request");
        let exe = client_in(scratch.path());
        let pipe = TestPipe::serve("request", vec![Some(r#"{"code":0,"output":""}"#.to_string())]);
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", &pipe.name)
            .env("YARD_PTY_ID", "t-42")
            .args(["hook", "prompt", "--stdin"]);
        let payload = r#"{"prompt":"ação €"}"#;
        let ran = run(cmd, payload.as_bytes());
        assert_eq!(ran.code, 0);
        assert!(ran.stdout.is_empty());
        assert_eq!(
            pipe.request(0),
            serde_json::json!({
                "v": 1,
                "terminal": "t-42",
                "cwd": scratch.path().to_string_lossy(),
                "argv": ["hook", "prompt", "--stdin"],
                "stdin": payload,
                "timeoutMs": 180000,
            })
        );
        // `StreamWriter.WriteLine` ended the line with CRLF.
        assert!(pipe.raw(0).ends_with("}\r\n"), "{:?}", pipe.raw(0));
    }

    /// The regression the native client fixes on the way: PowerShell's `-File`
    /// binder mangled these before `yard.ps1` saw them. `"-note: check this"`
    /// reached the app as `-note` and ` check this`, `-x:` and `--%` vanished,
    /// and a lone `-` killed the script with a PowerShell error (exit 1).
    #[test]
    fn arguments_powershell_used_to_mangle_arrive_as_typed() {
        use std::os::windows::process::CommandExt;
        let scratch = Scratch::new("mangled");
        let exe = client_in(scratch.path());
        let pipe = TestPipe::serve("mangled", vec![Some(r#"{"code":0}"#.to_string())]);
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", &pipe.name)
            .raw_arg(r#"ask Bob "-note: check this" -x: --% - -a:b"#);
        let ran = run(cmd, b"");
        assert_eq!(ran.code, 0, "{}", String::from_utf8_lossy(&ran.stderr));
        assert_eq!(
            pipe.request(0)["argv"],
            serde_json::json!(["ask", "Bob", "-note: check this", "-x:", "--%", "-", "-a:b"])
        );
    }

    #[test]
    fn a_file_is_sent_as_its_text_under_the_stdin_flag() {
        let scratch = Scratch::new("file");
        let exe = client_in(scratch.path());
        std::fs::write(scratch.path().join("plano.md"), "passo um\r\nação dois\r\n").unwrap();
        let pipe = TestPipe::serve("file", vec![Some(r#"{"code":0,"output":"ok\n"}"#.to_string())]);
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", &pipe.name)
            .args(["note", "write", "Plano", "--file", "plano.md"]);
        let ran = run(cmd, b"");
        assert_eq!((ran.code, ran.stdout.as_slice()), (0, b"ok\n".as_slice()));
        let request = pipe.request(0);
        assert_eq!(request["argv"], serde_json::json!(["note", "write", "Plano", "--stdin"]));
        assert_eq!(request["stdin"], "passo um\r\nação dois\r\n");
    }

    #[test]
    fn a_missing_file_is_refused_before_the_app_is_called() {
        let scratch = Scratch::new("no-file");
        let exe = client_in(scratch.path());
        let pipe = TestPipe::serve("no-file", vec![Some(r#"{"code":0}"#.to_string())]);
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", &pipe.name)
            .args(["note", "write", "N", "--file", "nope.md"]);
        let ran = run(cmd, b"");
        assert_eq!(ran.code, 2);
        assert_eq!(
            String::from_utf8_lossy(&ran.stderr),
            "yard: arquivo nao encontrado: nope.md\r\n"
        );
        assert!(pipe.requests.lock().is_empty(), "the app was called anyway");
    }

    #[test]
    fn an_app_that_hangs_up_without_answering_is_an_empty_reply() {
        let scratch = Scratch::new("silent");
        let exe = client_in(scratch.path());
        let pipe = TestPipe::serve("silent", vec![None]);
        let mut cmd = isolated(&exe, scratch.path());
        cmd.env("YARD_PIPE", &pipe.name).arg("list");
        let ran = run(cmd, b"");
        assert_eq!(ran.code, 1);
        assert_eq!(String::from_utf8_lossy(&ran.stderr), "yard: resposta vazia do app\r\n");
    }

    /// The native client takes over from `yard.ps1` under the same shims, and
    /// `yard.ps1` stays the fallback where the exe cannot run, so the two must
    /// send the same request for the same command line: same raw line, folder,
    /// environment and input, against the same stand-in app. ASCII only: on
    /// accented UTF-8 input PowerShell used the console's code page, the bug
    /// above (input in that code page is the next test).
    #[test]
    fn the_native_client_sends_what_the_powershell_client_sends() {
        use std::os::windows::process::CommandExt;
        let scratch = Scratch::new("parity");
        let exe = client_in(scratch.path());
        let ps1 = scratch.path().join("yard.ps1");
        std::fs::write(&ps1, YARD_PS1).unwrap();
        std::fs::write(scratch.path().join("plan.md"), "linha um\r\nlinha dois\r\n").unwrap();
        let cases: &[(&str, &str)] = &[
            (r#"ask Bob "duas palavras" --timeout 2.5"#, ""),
            ("hook tool --stdin", r#"{"tool_name":"Bash"}"#),
            ("note write Plano --file plan.md", ""),
            // Where Rust's own argv rules would have split this differently.
            (r#"x "a""b c" "d e""#, ""),
            (r#"ASK x --TIMEOUT 1,5 "" \"q\""#, ""),
            (r#"check a\\"b c" -x -1 $true"#, ""),
        ];
        let reply = r#"{"code":4,"output":"ok: feito\n"}"#.to_string();
        let pipe = TestPipe::serve("parity", vec![Some(reply); cases.len() * 2]);
        for (i, (tail, stdin)) in cases.iter().enumerate() {
            let mut powershell = isolated("powershell.exe", scratch.path());
            powershell.raw_arg(format!(
                "-NoProfile -ExecutionPolicy Bypass -File \"{}\" {tail}",
                ps1.display()
            ));
            let mut native = isolated(&exe, scratch.path());
            native.raw_arg(tail);
            for cmd in [&mut powershell, &mut native] {
                cmd.env("YARD_PIPE", &pipe.name).env("YARD_PTY_ID", "t-parity");
            }
            let from_powershell = run(powershell, stdin.as_bytes());
            let from_native = run(native, stdin.as_bytes());
            assert_eq!(
                String::from_utf8_lossy(&from_native.stderr),
                String::from_utf8_lossy(&from_powershell.stderr),
                "{tail}"
            );
            assert_eq!(from_native.code, from_powershell.code, "{tail}");
            assert_eq!(from_native.stdout, from_powershell.stdout, "{tail}");
            assert_eq!(pipe.request(2 * i + 1), pipe.request(2 * i), "{tail}");
        }
    }

    /// The regression: cmd.exe's `echo ação| yard note write N --stdin`
    /// writes the console's code page into the pipe (`61 87 C6 6F` under 850,
    /// a Brazilian Windows), which `[Console]::In` in `yard.ps1` read in that
    /// code page and the native client read as UTF-8, every accent becoming
    /// U+FFFD for good. Both clients run here under the same hidden console,
    /// so whatever its code page, they have to send the same text.
    #[test]
    fn text_in_the_console_code_page_on_stdin_arrives_as_the_powershell_client_read_it() {
        use std::os::windows::process::CommandExt;
        let scratch = Scratch::new("console-cp");
        let exe = client_in(scratch.path());
        let ps1 = scratch.path().join("yard.ps1");
        std::fs::write(&ps1, YARD_PS1).unwrap();
        let stdin: &[u8] = b"\x61\x87\xc6\x6f\r\n";
        let pipe = TestPipe::serve("console-cp", vec![Some(r#"{"code":0}"#.to_string()); 2]);
        let mut powershell = isolated("powershell.exe", scratch.path());
        powershell.raw_arg(format!(
            "-NoProfile -ExecutionPolicy Bypass -File \"{}\" note write N --stdin",
            ps1.display()
        ));
        let mut native = isolated(&exe, scratch.path());
        native.args(["note", "write", "N", "--stdin"]);
        for cmd in [&mut powershell, &mut native] {
            cmd.env("YARD_PIPE", &pipe.name);
        }
        let from_powershell = run(powershell, stdin);
        assert_eq!(from_powershell.code, 0, "{}", String::from_utf8_lossy(&from_powershell.stderr));
        let from_native = run(native, stdin);
        assert_eq!(from_native.code, 0, "{}", String::from_utf8_lossy(&from_native.stderr));
        assert_eq!(pipe.request(1)["stdin"], pipe.request(0)["stdin"]);
    }

    // -----------------------------------------------------------------------
    // which launcher the shims run
    // -----------------------------------------------------------------------

    /// The shims as they were before the native client, byte for byte: the
    /// fallback must be exactly what already worked everywhere.
    const LEGACY_CMD: &str =
        "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0yard.ps1\" %*\r\n";
    const LEGACY_SH: &str = "#!/bin/sh\nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$(dirname \"$0\")/yard.ps1\" \"$@\"\n";

    fn shims_in(dir: &std::path::Path) -> (String, String) {
        (
            std::fs::read_to_string(dir.join("yard.cmd")).expect("yard.cmd"),
            std::fs::read_to_string(dir.join("yard")).expect("yard"),
        )
    }

    /// The native line stays the batch file's last, so its exit code is the
    /// batch file's: a bare `exit /b` after it would turn every code into 0
    /// for `cmd /c` and PowerShell callers.
    fn native_shims(name: &str) -> (String, String) {
        (
            format!(
                "@echo off\r\nif exist \"%~dp0{name}\" goto native\r\n\
                 powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0yard.ps1\" %*\r\n\
                 exit /b %errorlevel%\r\n:native\r\n\"%~dp0{name}\" %*\r\n"
            ),
            format!(
                "#!/bin/sh\nd=$(dirname \"$0\")\n[ -f \"$d/{name}\" ] && exec \"$d/{name}\" \"$@\"\n\
                 exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$d/yard.ps1\" \"$@\"\n"
            ),
        )
    }

    const FAKE_CLIENT: &[u8] = b"client bytes";

    #[test]
    fn the_shims_run_the_native_client_when_its_probe_passes() {
        let scratch = Scratch::new("native");
        let mut probed = None;
        write_shims_with(scratch.path(), FAKE_CLIENT, |exe| {
            probed = Some(exe.to_path_buf());
            true
        })
        .expect("shims");
        let name = cli_exe_name(FAKE_CLIENT);
        assert_eq!(probed, Some(scratch.path().join(&name)));
        assert_eq!(std::fs::read(scratch.path().join(&name)).unwrap(), FAKE_CLIENT);
        assert_eq!(shims_in(scratch.path()), native_shims(&name));
        // The fallback stays on disk either way.
        assert!(scratch.path().join("yard.ps1").is_file());
    }

    #[test]
    fn the_shims_stay_on_powershell_when_the_probe_fails() {
        let scratch = Scratch::new("probe-fails");
        write_shims_with(scratch.path(), FAKE_CLIENT, |_| false).expect("shims");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
    }

    #[test]
    fn the_shims_stay_on_powershell_when_the_client_cannot_be_written() {
        let scratch = Scratch::new("unwritable");
        // A folder where the exe should go: the write fails.
        std::fs::create_dir(scratch.path().join(cli_exe_name(FAKE_CLIENT))).unwrap();
        let mut probed = false;
        write_shims_with(scratch.path(), FAKE_CLIENT, |_| {
            probed = true;
            true
        })
        .expect("shims");
        assert!(!probed, "probed a client that was never written");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
    }

    /// A build for another OS embeds an empty client.
    #[test]
    fn a_build_without_a_client_keeps_powershell_without_probing() {
        let scratch = Scratch::new("no-client");
        write_shims_with(scratch.path(), b"", |_| panic!("nothing to probe")).expect("shims");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
    }

    /// A `yard ask` holds its exe open for up to ten minutes, and a running
    /// exe cannot be opened for writing. The same bytes under the same name
    /// are simply reused (read-only stands in for "running" here).
    #[test]
    fn a_client_already_on_disk_with_the_same_bytes_is_reused_not_rewritten() {
        let scratch = Scratch::new("reuse");
        let name = cli_exe_name(FAKE_CLIENT);
        let exe = scratch.path().join(&name);
        std::fs::write(&exe, FAKE_CLIENT).unwrap();
        let set_readonly = |on: bool| {
            let mut perms = std::fs::metadata(&exe).unwrap().permissions();
            perms.set_readonly(on);
            std::fs::set_permissions(&exe, perms).unwrap();
        };
        set_readonly(true);
        let result = write_shims_with(scratch.path(), FAKE_CLIENT, |_| true);
        set_readonly(false);
        result.expect("shims");
        assert_eq!(shims_in(scratch.path()), native_shims(&name));
    }

    #[test]
    fn a_damaged_client_under_the_right_name_is_written_again() {
        let scratch = Scratch::new("damaged");
        let exe = scratch.path().join(cli_exe_name(FAKE_CLIENT));
        std::fs::write(&exe, &FAKE_CLIENT[..5]).unwrap();
        write_shims_with(scratch.path(), FAKE_CLIENT, |_| true).expect("shims");
        assert_eq!(std::fs::read(&exe).unwrap(), FAKE_CLIENT);
    }

    #[test]
    fn clients_of_earlier_versions_are_removed_and_nothing_else_is() {
        let scratch = Scratch::new("prune");
        let dir = scratch.path();
        let old = dir.join("yard-cli-0123456789abcdef.exe");
        let notes = dir.join("yard-cli-notes.txt");
        let other = dir.join("other.exe");
        for f in [&old, &notes, &other] {
            std::fs::write(f, b"x").unwrap();
        }
        write_shims_with(dir, FAKE_CLIENT, |_| true).expect("shims");
        assert!(!old.exists(), "the old client is still there");
        assert!(notes.exists() && other.exists(), "removed a file that is not a client");
        assert!(dir.join(cli_exe_name(FAKE_CLIENT)).is_file());
    }

    /// Content-addressed with a hash that does not change between Rust
    /// releases (FNV-1a, unlike `DefaultHasher`), and fixed-width, so the shim
    /// of the next version is the same length as this one's.
    #[test]
    fn the_client_is_named_after_its_bytes() {
        assert_eq!(cli_exe_name(b"a"), "yard-cli-af63dc4c8601ec8c.exe");
        assert_eq!(cli_exe_name(FAKE_CLIENT), cli_exe_name(FAKE_CLIENT));
        assert_ne!(cli_exe_name(b"a"), cli_exe_name(b"b"));
        assert_eq!(cli_exe_name(b"").len(), cli_exe_name(CLI_EXE).len());
    }

    /// The real client behind the real `yard.cmd`: the batch line has to
    /// hand every argument and the exit code through.
    #[test]
    fn yard_cmd_runs_the_native_client_with_the_arguments_and_the_exit_code() {
        let scratch = Scratch::new("cmd");
        write_shims_with(scratch.path(), CLI_EXE, |_| true).expect("shims");
        // PowerShell would answer the same; this is about the native line.
        assert_eq!(shims_in(scratch.path()), native_shims(&cli_exe_name(CLI_EXE)));
        let pipe = TestPipe::serve("cmd", vec![Some(r#"{"code":5,"output":"pronto"}"#.to_string())]);
        let mut cmd = isolated("cmd.exe", scratch.path());
        cmd.arg("/c")
            .arg(scratch.path().join("yard.cmd"))
            .args(["hook", "tool", "--stdin"])
            .env("YARD_PIPE", &pipe.name);
        let ran = run(cmd, br#"{"tool_name":"Bash"}"#);
        assert_eq!(ran.code, 5, "{}", String::from_utf8_lossy(&ran.stderr));
        assert_eq!(ran.stdout, b"pronto");
        let request = pipe.request(0);
        assert_eq!(request["argv"], serde_json::json!(["hook", "tool", "--stdin"]));
        assert_eq!(request["stdin"], r#"{"tool_name":"Bash"}"#);
    }

    /// Git's own `sh.exe`, found through `git --exec-path` rather than PATH,
    /// where `bash.exe` may well be WSL's. It is the launcher in `<git>/bin`,
    /// the one Git Bash hosts (Claude Code included) start, which puts
    /// `usr/bin` and `mingw64/bin` on PATH itself. The raw `usr/bin/sh.exe`
    /// adds nothing, so the shim's `dirname` only resolved when the suite's
    /// own PATH already had Git's `usr/bin`: true from Git Bash, false from a
    /// PowerShell whose PATH has only `Git\cmd`, where the test failed with 127.
    fn git_sh() -> std::path::PathBuf {
        let out = std::process::Command::new("git")
            .arg("--exec-path")
            .output()
            .expect("git is needed by this suite anyway");
        let exec_path = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        // <git>/mingw64/libexec/git-core -> <git>/bin/sh.exe
        let root = exec_path.ancestors().nth(3).expect("git install root");
        root.join("bin").join("sh.exe")
    }

    /// Claude Code runs its hooks through Git Bash, so `yard hook ...` goes
    /// through the sh shim far more often than through `yard.cmd`.
    #[test]
    fn the_sh_shim_runs_the_native_client_with_the_arguments_and_the_exit_code() {
        let scratch = Scratch::new("sh");
        write_shims_with(scratch.path(), CLI_EXE, |_| true).expect("shims");
        assert_eq!(shims_in(scratch.path()), native_shims(&cli_exe_name(CLI_EXE)));
        let pipe = TestPipe::serve("sh", vec![Some(r#"{"code":6,"output":"feito"}"#.to_string())]);
        let mut cmd = isolated(git_sh(), scratch.path());
        // Bash finds the shim on a PATH it keeps in forward-slash form.
        let shim = scratch.path().join("yard").to_string_lossy().replace('\\', "/");
        cmd.arg(shim)
            .args(["hook", "stop", "--stdin", "duas palavras"])
            .env("YARD_PIPE", &pipe.name);
        let ran = run(cmd, br#"{"stop_hook_active":false}"#);
        assert_eq!(ran.code, 6, "{}", String::from_utf8_lossy(&ran.stderr));
        assert_eq!(ran.stdout, b"feito");
        let request = pipe.request(0);
        assert_eq!(request["argv"], serde_json::json!(["hook", "stop", "--stdin", "duas palavras"]));
        assert_eq!(request["stdin"], r#"{"stop_hook_active":false}"#);
    }

    /// The regression: the probe passes at startup, then an antivirus
    /// quarantines the unsigned client mid-session, and every `yard` call and
    /// hook failed ("is not recognized") until the next start. The shim finds
    /// the exe gone and answers through `yard.ps1`, which is always there.
    #[test]
    fn yard_cmd_answers_through_yard_ps1_when_its_client_is_removed() {
        let scratch = Scratch::new("cmd-gone");
        write_shims_with(scratch.path(), CLI_EXE, |_| true).expect("shims");
        std::fs::remove_file(scratch.path().join(cli_exe_name(CLI_EXE))).expect("remove the client");
        let pipe = TestPipe::serve("cmd-gone", vec![Some(r#"{"code":5,"output":"pronto"}"#.to_string())]);
        let mut cmd = isolated("cmd.exe", scratch.path());
        cmd.arg("/c")
            .arg(scratch.path().join("yard.cmd"))
            .args(["hook", "tool", "--stdin"])
            .env("YARD_PIPE", &pipe.name);
        let ran = run(cmd, br#"{"tool_name":"Bash"}"#);
        assert_eq!(ran.code, 5, "{}", String::from_utf8_lossy(&ran.stderr));
        assert_eq!(ran.stdout, b"pronto");
        let request = pipe.request(0);
        assert_eq!(request["argv"], serde_json::json!(["hook", "tool", "--stdin"]));
        assert_eq!(request["stdin"], r#"{"tool_name":"Bash"}"#);
    }

    /// The same for the sh shim, the one Claude Code's hooks go through (exit
    /// 127, "No such file or directory", on every hook until the next start).
    #[test]
    fn the_sh_shim_answers_through_yard_ps1_when_its_client_is_removed() {
        let scratch = Scratch::new("sh-gone");
        write_shims_with(scratch.path(), CLI_EXE, |_| true).expect("shims");
        std::fs::remove_file(scratch.path().join(cli_exe_name(CLI_EXE))).expect("remove the client");
        let pipe = TestPipe::serve("sh-gone", vec![Some(r#"{"code":6,"output":"feito"}"#.to_string())]);
        let mut cmd = isolated(git_sh(), scratch.path());
        let shim = scratch.path().join("yard").to_string_lossy().replace('\\', "/");
        cmd.arg(shim)
            .args(["hook", "stop", "--stdin", "duas palavras"])
            .env("YARD_PIPE", &pipe.name);
        let ran = run(cmd, br#"{"stop_hook_active":false}"#);
        assert_eq!(ran.code, 6, "{}", String::from_utf8_lossy(&ran.stderr));
        assert_eq!(ran.stdout, b"feito");
        let request = pipe.request(0);
        assert_eq!(request["argv"], serde_json::json!(["hook", "stop", "--stdin", "duas palavras"]));
        assert_eq!(request["stdin"], r#"{"stop_hook_active":false}"#);
    }

    // -----------------------------------------------------------------------
    // the shims before any terminal exists
    // -----------------------------------------------------------------------

    #[test]
    fn before_any_terminal_starts_a_first_run_already_has_working_shims() {
        let scratch = Scratch::new("first-run");
        write_support_files(scratch.path()).expect("support files");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
        for f in ["yard.ps1", "YARD-BRIDGE.md", CLAUDE_HOOKS_FILE] {
            assert!(scratch.path().join(f).is_file(), "missing {f}");
        }
    }

    #[test]
    fn native_shims_from_an_earlier_session_are_kept_while_their_client_is_there() {
        let scratch = Scratch::new("kept");
        write_shims_with(scratch.path(), b"older client", |_| true).expect("shims");
        let before = shims_in(scratch.path());
        write_support_files(scratch.path()).expect("support files");
        assert_eq!(shims_in(scratch.path()), before);
        assert_eq!(before, native_shims(&cli_exe_name(b"older client")));
    }

    #[test]
    fn native_shims_whose_client_is_gone_go_back_to_powershell() {
        let scratch = Scratch::new("gone");
        write_shims_with(scratch.path(), b"older client", |_| true).expect("shims");
        std::fs::remove_file(scratch.path().join(cli_exe_name(b"older client"))).unwrap();
        write_support_files(scratch.path()).expect("support files");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
    }

    // -----------------------------------------------------------------------
    // a client this machine refuses
    // -----------------------------------------------------------------------
    //
    // Where Smart App Control, an antivirus rule for new unsigned programs or
    // an AppLocker policy refuses the client, each attempt to run it is one
    // more block notification from Windows. The clock comes in as Unix seconds.

    const T0: u64 = 1_000_000;
    const HOUR: u64 = 60 * 60;

    /// The regression: every start wrote the client, probed it and deleted it
    /// again, so every start raised the block again. A failure is remembered.
    #[test]
    fn a_client_that_failed_its_probe_is_neither_written_nor_probed_on_the_next_start() {
        let scratch = Scratch::new("refused-next");
        let exe = scratch.path().join(cli_exe_name(FAKE_CLIENT));
        write_shims_at(scratch.path(), FAKE_CLIENT, T0, |_| false).expect("shims");
        // Where an antivirus quarantined it, the file is gone.
        let _ = std::fs::remove_file(&exe);
        write_shims_at(scratch.path(), FAKE_CLIENT, T0 + HOUR, |_| panic!("probed again")).expect("shims");
        assert!(!exe.exists(), "the refused client was written again");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
    }

    fn refusals_in(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .expect("dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".blocked"))
            .collect()
    }

    /// Not forever: a policy can change, and a probe that only ran out of
    /// time while the antivirus looked at the new file may pass later. A day
    /// on, the client is tried again, adopted if it runs, and the failure is
    /// forgotten.
    #[test]
    fn a_refused_client_is_tried_again_a_day_later_and_adopted_if_it_runs() {
        let scratch = Scratch::new("refused-retry");
        write_shims_at(scratch.path(), FAKE_CLIENT, T0, |_| false).expect("shims");
        write_shims_at(scratch.path(), FAKE_CLIENT, T0 + 24 * HOUR, |_| true).expect("shims");
        assert_eq!(shims_in(scratch.path()), native_shims(&cli_exe_name(FAKE_CLIENT)));
        assert_eq!(refusals_in(scratch.path()), Vec::<String>::new());
    }

    /// A clock set back after the failure (a dead CMOS battery, a dual boot)
    /// must not turn the day into as long as the clock is behind.
    #[test]
    fn a_failure_recorded_ahead_of_the_clock_does_not_hold_the_client_back() {
        let scratch = Scratch::new("refused-ahead");
        write_shims_at(scratch.path(), FAKE_CLIENT, T0, |_| false).expect("shims");
        let mut probed = false;
        write_shims_at(scratch.path(), FAKE_CLIENT, T0 - HOUR, |_| {
            probed = true;
            true
        })
        .expect("shims");
        assert!(probed, "a failure stamped in the future kept the client out");
    }

    /// Deleted, the client was written anew for the retry, and a new file is
    /// one more for the antivirus to look at (the probe that ran out of time).
    /// Kept, the retry runs the file it already looked at.
    #[test]
    fn a_refused_client_of_this_build_stays_on_disk_for_its_retry() {
        let scratch = Scratch::new("refused-kept");
        write_shims_at(scratch.path(), FAKE_CLIENT, T0, |_| false).expect("shims");
        let exe = scratch.path().join(cli_exe_name(FAKE_CLIENT));
        assert_eq!(std::fs::read(&exe).ok().as_deref(), Some(FAKE_CLIENT));
    }

    /// The memory is per build: an update is probed even where the client
    /// before it was refused, and what that one left behind goes.
    #[test]
    fn a_new_client_is_tried_even_where_an_older_one_was_refused() {
        let scratch = Scratch::new("refused-older");
        write_shims_at(scratch.path(), b"older client", T0, |_| false).expect("shims");
        let mut probed = false;
        write_shims_at(scratch.path(), FAKE_CLIENT, T0 + HOUR, |_| {
            probed = true;
            true
        })
        .expect("shims");
        assert!(probed, "the older client's failure kept the new one out");
        assert_eq!(shims_in(scratch.path()), native_shims(&cli_exe_name(FAKE_CLIENT)));
        assert!(!scratch.path().join(cli_exe_name(b"older client")).exists());
        assert_eq!(refusals_in(scratch.path()), Vec::<String>::new());
    }

    /// The refusal can come at the write: an antivirus that takes a new
    /// unsigned exe for a threat fails it (`ERROR_VIRUS_INFECTED`) and says so
    /// on screen. That is remembered too, not attempted at every start.
    #[test]
    fn a_client_that_could_not_be_written_is_not_written_again_on_the_next_start() {
        let scratch = Scratch::new("refused-write");
        let exe = scratch.path().join(cli_exe_name(FAKE_CLIENT));
        // A folder where the exe should go: the write fails.
        std::fs::create_dir(&exe).unwrap();
        write_shims_at(scratch.path(), FAKE_CLIENT, T0, |_| panic!("nothing was written")).expect("shims");
        std::fs::remove_dir(&exe).unwrap();
        write_shims_at(scratch.path(), FAKE_CLIENT, T0 + HOUR, |_| panic!("probed again")).expect("shims");
        assert!(!exe.exists(), "the refused client was written again");
        assert_eq!(shims_in(scratch.path()), (LEGACY_CMD.to_string(), LEGACY_SH.to_string()));
    }

    // -----------------------------------------------------------------------
    // the gate between the launcher decision and the first terminal
    // -----------------------------------------------------------------------

    /// The regression this locks down: every spawn waited for the probe of a
    /// freshly written client (about a second while the antivirus looks at
    /// it, up to the 10 s bound), so the terminals that auto-start after an
    /// update sat in "starting", where the PowerShell shims let them start at
    /// once. A terminal born mid-decision starts now and keeps the shims it found.
    #[test]
    fn a_terminal_born_while_the_decision_is_pending_starts_at_once() {
        let gate = std::sync::Arc::new(LauncherGate::new());
        gate.begin();
        let (born, started) = std::sync::mpsc::channel();
        {
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.seal();
                let _ = born.send(());
            });
        }
        started
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the terminal waited for the launcher decision");
    }

    /// The normal start: the choice is made long before the window asks for a
    /// terminal, so the first terminal already finds the shims pointed at it.
    #[test]
    fn a_decision_settled_before_any_terminal_writes_the_shims() {
        let gate = LauncherGate::new();
        gate.begin();
        let mut written = false;
        gate.settle(|| written = true);
        assert!(written, "the decision was dropped with no terminal around");
        let started = std::time::Instant::now();
        gate.seal();
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    }

    /// cmd.exe reads a batch file as it runs it, line by line, from where it
    /// left off; rewriting `yard.cmd` under a hook that is running it can run
    /// half of each version. Once a terminal exists, the shims stay as they are.
    #[test]
    fn a_decision_that_comes_after_a_terminal_was_born_changes_nothing() {
        let gate = LauncherGate::new();
        gate.begin();
        gate.seal();
        let mut written = false;
        gate.settle(|| written = true);
        assert!(!written, "the shims were rewritten with a terminal already running");
    }

    #[test]
    fn terminals_do_not_wait_when_no_decision_is_in_flight_or_it_was_given_up_on() {
        let fresh = LauncherGate::new();
        let started = std::time::Instant::now();
        fresh.seal();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));

        // A decision that never comes (a hung probe) costs no terminal a wait.
        let hung = LauncherGate::new();
        hung.begin();
        hung.seal();
        let started = std::time::Instant::now();
        hung.seal();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }
}
