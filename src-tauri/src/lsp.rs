//! Language servers for the file editor (LSP).
//!
//! The editor (CodeMirror) speaks the protocol through
//! `@codemirror/lsp-client`, whose transport carries **bare JSON** — no
//! headers. Everything that is a process is here: spawning the server with
//! piped stdio (npm shims resolved the way the agent CLIs are), decoding the
//! base-protocol framing (`Content-Length: N\r\n\r\n<body>`) on a reader
//! thread, and killing every server when the app leaves. A `rust-analyzer`
//! that outlives the window, eating two gigabytes with nobody to talk to, is
//! exactly the orphan this product exists to prevent — so the child is put in
//! a Job Object like a PTY, and `stop_all` runs on exit as a second net.
//!
//! The Rust side knows nothing about the messages: the client on the other
//! end owns initialization, capabilities and requests. This module is a pipe
//! with a frame decoder, which is what keeps it testable without Tauri: the
//! reader hands each decoded message to a sink closure, the command layer is
//! the only place that turns a sink into an `app.emit`, and the registry is a
//! value (`Servers`) so every test owns its own instead of sharing the app's.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::pty::job::JobHandle;

/// One decoded message from a server, addressed by the client id the
/// frontend chose when it started the server.
pub const TOPIC_MESSAGE: &str = "lsp://message";
/// The server's process ended (on its own or through `stop`).
pub const TOPIC_EXIT: &str = "lsp://exit";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspMessage {
    pub id: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspExit {
    pub id: String,
    pub code: Option<i32>,
}

/// What the reader thread reports, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LspEvent {
    Message(String),
    Exit(Option<i32>),
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

/// Decoder of the LSP base protocol: a header block ending in a blank line,
/// with a `Content-Length` header naming the size of the JSON body in bytes.
///
/// Incremental on purpose — a chunk from the pipe may hold half a header, or
/// two whole messages, or a body split at a UTF-8 boundary. Bytes are kept
/// until a whole message is there.
#[derive(Default)]
pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    /// Feeds bytes and returns every complete message they finished.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let Some(start) = find_ci(&self.buf, b"content-length:") else {
                // Nothing that looks like a header yet: keep only a tail
                // long enough to complete a header that straddles chunks.
                let keep = self.buf.len().min(b"content-length:".len() - 1);
                let drop = self.buf.len() - keep;
                if drop > 0 {
                    self.buf.drain(..drop);
                }
                break;
            };
            if start > 0 {
                // Garbage before the header (a server that printed to stdout
                // before speaking the protocol): throw it away.
                self.buf.drain(..start);
            }
            let Some((header_end, sep_len)) = header_terminator(&self.buf) else {
                break;
            };
            let header = String::from_utf8_lossy(&self.buf[..header_end]).into_owned();
            let Some(len) = content_length(&header) else {
                // A header block with no usable length: skip it and look for
                // the next one instead of wedging the stream forever.
                self.buf.drain(..header_end + sep_len);
                continue;
            };
            let body_start = header_end + sep_len;
            if self.buf.len() < body_start + len {
                break;
            }
            let body =
                String::from_utf8_lossy(&self.buf[body_start..body_start + len]).into_owned();
            self.buf.drain(..body_start + len);
            out.push(body);
        }
        out
    }
}

/// Position of the first case-insensitive occurrence of `needle`.
fn find_ci(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| {
        hay[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
    })
}

/// End of the header block: the offset of the blank line and the length of
/// the separator that made it (`\r\n\r\n` per the spec; `\n\n` tolerated).
fn header_terminator(buf: &[u8]) -> Option<(usize, usize)> {
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| (p, 4));
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|p| (p, 2));
    match (crlf, lf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// The `Content-Length` value of a header block, if it has a valid one.
fn content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("content-length") {
            return None;
        }
        value.trim().parse::<usize>().ok()
    })
}

/// A message with its framing, the way the server reads it.
pub fn frame(message: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    out.extend_from_slice(message.as_bytes());
    out
}

// ---------------------------------------------------------------------------
// processes
// ---------------------------------------------------------------------------

/// Where the reader thread delivers what it decoded. The command layer turns
/// it into `app.emit`; the tests into a channel.
pub type Sink = Arc<dyn Fn(LspEvent) + Send + Sync>;

struct Server {
    child: Child,
    stdin: ChildStdin,
    pid: u32,
    /// Kill-on-close job, as for a PTY: the app dying takes the server along.
    #[allow(dead_code)]
    job: Option<JobHandle>,
}

/// The running servers, keyed by the client id the frontend chose.
///
/// A value, not a static: the app holds one in `global()`, and each test
/// holds its own — `stop_all` in one test must not take down the server
/// another test is talking to.
#[derive(Default)]
pub struct Servers {
    map: Mutex<HashMap<String, Server>>,
}

/// The app's registry.
pub fn global() -> Arc<Servers> {
    static SERVERS: OnceLock<Arc<Servers>> = OnceLock::new();
    SERVERS.get_or_init(|| Arc::new(Servers::default())).clone()
}

impl Servers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Spawns a language server and starts reading it. Returns the pid.
    ///
    /// A second `start` with the same id replaces the first (the old process
    /// is killed): the frontend's client is the only thing that knows
    /// whether it still wants that server.
    pub fn start(
        self: &Arc<Self>,
        id: &str,
        program: &str,
        args: &[String],
        cwd: &str,
        sink: Sink,
    ) -> Result<u32, String> {
        let (prog, argv) = crate::agents::resolver::resolve_launch(program, args);
        let mut cmd = Command::new(&prog);
        cmd.args(&argv)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("não consegui iniciar {program}: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("stdin do servidor não veio")?;
        let stdout = child.stdout.take().ok_or("stdout do servidor não veio")?;
        let stderr = child.stderr.take().ok_or("stderr do servidor não veio")?;
        let job = JobHandle::create_and_assign(pid);

        // Replacing an entry kills the previous process of that id.
        let previous = self.map.lock().unwrap().insert(
            id.to_string(),
            Server {
                child,
                stdin,
                pid,
                job,
            },
        );
        if let Some(old) = previous {
            kill_server(old);
        }
        tracing::info!(target: "lsp", id, pid, program, "servidor de linguagem iniciado");

        {
            let id = id.to_string();
            std::thread::Builder::new()
                .name(format!("lsp-stderr-{id}"))
                .spawn(move || {
                    use std::io::BufRead;
                    let reader = std::io::BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        tracing::debug!(target: "lsp", id, "{line}");
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        {
            let id = id.to_string();
            let registry = self.clone();
            std::thread::Builder::new()
                .name(format!("lsp-stdout-{id}"))
                .spawn(move || registry.read_loop(&id, pid, stdout, sink))
                .map_err(|e| e.to_string())?;
        }
        Ok(pid)
    }

    fn read_loop(&self, id: &str, pid: u32, mut stdout: impl Read, sink: Sink) {
        let mut framer = Framer::default();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for message in framer.push(&chunk[..n]) {
                        sink(LspEvent::Message(message));
                    }
                }
            }
        }
        // EOF: the process is going (or gone). If nobody stopped it on
        // purpose, its entry is still here — take it, reap it and report
        // the code.
        let code = {
            let mut map = self.map.lock().unwrap();
            match map.get(id) {
                Some(s) if s.pid == pid => {
                    let mut server = map.remove(id).expect("checked above");
                    server.child.wait().ok().and_then(|st| st.code())
                }
                _ => None,
            }
        };
        tracing::info!(target: "lsp", id, pid, ?code, "servidor de linguagem encerrou");
        sink(LspEvent::Exit(code));
    }

    /// Writes one framed message to the server's stdin.
    pub fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let server = map
            .get_mut(id)
            .ok_or_else(|| format!("servidor de linguagem {id} não está rodando"))?;
        server
            .stdin
            .write_all(&frame(message))
            .and_then(|_| server.stdin.flush())
            .map_err(|e| format!("falha ao escrever para o servidor {id}: {e}"))
    }

    /// Kills the server (and whatever it spawned) and forgets it.
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let server = self
            .map
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| format!("servidor de linguagem {id} não está rodando"))?;
        kill_server(server);
        Ok(())
    }

    /// Every server, on the way out of the app.
    pub fn stop_all(&self) {
        let all: Vec<Server> = self.map.lock().unwrap().drain().map(|(_, s)| s).collect();
        for server in all {
            kill_server(server);
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.map.lock().unwrap().contains_key(id)
    }
}

fn kill_server(mut server: Server) {
    // Dropping stdin first: a well-behaved server exits on EOF, and the
    // kill below is for the others.
    drop(server.stdin);
    let killed = server.job.as_ref().map(|j| j.terminate()).unwrap_or(false);
    if !killed {
        let _ = server.child.kill();
    }
    let _ = server.child.wait();
}

/// Every server the app started, killed. Runs on exit.
pub fn stop_all() {
    global().stop_all();
}

// ---------------------------------------------------------------------------
// the catalog
// ---------------------------------------------------------------------------

/// A server the editor knows how to use, with how to find it and how to get
/// it when it is missing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    /// LSP language ids this server takes (`typescript`, `rust`, …).
    pub language_ids: Vec<String>,
    pub program: String,
    pub args: Vec<String>,
    pub version: Option<String>,
    pub install_hint: String,
    pub found: bool,
}

struct CatalogEntry {
    language_ids: &'static [&'static str],
    program: &'static str,
    args: &'static [&'static str],
    version_args: &'static [&'static str],
    install_hint: &'static str,
}

/// The servers offered. Order is the order of the settings list.
const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        language_ids: &["typescript", "typescriptreact", "javascript", "javascriptreact"],
        program: "typescript-language-server",
        args: &["--stdio"],
        version_args: &["--version"],
        install_hint: "npm i -g typescript-language-server typescript",
    },
    CatalogEntry {
        language_ids: &["rust"],
        program: "rust-analyzer",
        args: &[],
        version_args: &["--version"],
        install_hint: "rustup component add rust-analyzer",
    },
    CatalogEntry {
        language_ids: &["python"],
        program: "pyright-langserver",
        args: &["--stdio"],
        version_args: &["--version"],
        install_hint: "npm i -g pyright  (ou: pip install pyright)",
    },
    CatalogEntry {
        language_ids: &["go"],
        program: "gopls",
        args: &[],
        version_args: &["version"],
        install_hint: "go install golang.org/x/tools/gopls@latest",
    },
    CatalogEntry {
        language_ids: &["css", "scss", "less"],
        program: "vscode-css-language-server",
        args: &["--stdio"],
        version_args: &["--version"],
        install_hint: "npm i -g vscode-langservers-extracted",
    },
    CatalogEntry {
        language_ids: &["html"],
        program: "vscode-html-language-server",
        args: &["--stdio"],
        version_args: &["--version"],
        install_hint: "npm i -g vscode-langservers-extracted",
    },
    CatalogEntry {
        language_ids: &["json", "jsonc"],
        program: "vscode-json-language-server",
        args: &["--stdio"],
        version_args: &["--version"],
        install_hint: "npm i -g vscode-langservers-extracted",
    },
];

/// The catalog with what is installed on this machine. Cached: the version
/// probes are seven process launches, and the answer only changes when the
/// user installs something — `refresh` is the button for that.
pub fn detect(refresh: bool) -> Vec<LspServerInfo> {
    static CACHE: OnceLock<Mutex<Option<Vec<LspServerInfo>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if !refresh {
        if let Some(list) = cache.lock().unwrap().as_ref() {
            return list.clone();
        }
    }
    let list = detect_with(|program, version_args| {
        crate::agents::resolver::find_binary(program).map(|_| {
            crate::agents::resolver::probe_version(program, version_args)
        })
    });
    *cache.lock().unwrap() = Some(list.clone());
    list
}

/// The catalog resolved through `probe`: `None` when the program is not on
/// this machine, `Some(version)` when it is (the version itself may be
/// unknown — some servers answer nothing to `--version`).
fn detect_with(
    probe: impl Fn(&str, &[&str]) -> Option<Option<String>>,
) -> Vec<LspServerInfo> {
    CATALOG
        .iter()
        .map(|entry| {
            let probed = probe(entry.program, entry.version_args);
            LspServerInfo {
                language_ids: entry.language_ids.iter().map(|s| s.to_string()).collect(),
                program: entry.program.to_string(),
                args: entry.args.iter().map(|s| s.to_string()).collect(),
                version: probed.clone().flatten(),
                install_hint: entry.install_hint.to_string(),
                found: probed.is_some(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

fn emit_sink(app: AppHandle, id: String) -> Sink {
    Arc::new(move |event| match event {
        LspEvent::Message(message) => {
            let _ = app.emit(
                TOPIC_MESSAGE,
                LspMessage {
                    id: id.clone(),
                    message,
                },
            );
        }
        LspEvent::Exit(code) => {
            let _ = app.emit(
                TOPIC_EXIT,
                LspExit {
                    id: id.clone(),
                    code,
                },
            );
        }
    })
}

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    let sink = emit_sink(app, id.clone());
    tauri::async_runtime::spawn_blocking(move || {
        global().start(&id, &program, &args, &cwd, sink)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_send(id: String, message: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || global().send(&id, &message))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_stop(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || global().stop(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_detect(refresh: bool) -> Result<Vec<LspServerInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || detect(refresh))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn msg(body: &str) -> Vec<u8> {
        frame(body)
    }

    #[test]
    fn a_whole_message_in_one_chunk_comes_out_once() {
        let mut f = Framer::default();
        assert_eq!(f.push(&msg(r#"{"a":1}"#)), vec![r#"{"a":1}"#.to_string()]);
        assert!(f.push(b"").is_empty());
    }

    /// The pipe hands over what it has, not what the protocol means: a
    /// header can end in one chunk and start in the previous one.
    #[test]
    fn a_header_split_across_reads_is_stitched() {
        let mut f = Framer::default();
        let whole = msg(r#"{"id":1}"#);
        let (a, b) = whole.split_at(7);
        assert!(f.push(a).is_empty());
        assert_eq!(f.push(b), vec![r#"{"id":1}"#.to_string()]);
    }

    #[test]
    fn two_messages_in_one_chunk_come_out_in_order() {
        let mut f = Framer::default();
        let mut bytes = msg(r#"{"n":1}"#);
        bytes.extend(msg(r#"{"n":2}"#));
        assert_eq!(
            f.push(&bytes),
            vec![r#"{"n":1}"#.to_string(), r#"{"n":2}"#.to_string()]
        );
    }

    /// The length is in bytes, and a multibyte character can be cut in the
    /// middle: the body waits for its last byte instead of being decoded
    /// short.
    #[test]
    fn a_body_split_across_reads_waits_for_its_last_byte() {
        let mut f = Framer::default();
        let whole = msg(r#"{"t":"ação"}"#);
        let cut = whole.len() - 3;
        assert!(f.push(&whole[..cut]).is_empty());
        assert_eq!(f.push(&whole[cut..]), vec![r#"{"t":"ação"}"#.to_string()]);
    }

    /// The spec says CRLF; some servers (and every hand-written fake) send
    /// bare LF. Both are one blank line.
    #[test]
    fn a_bare_lf_separator_is_tolerated() {
        let mut f = Framer::default();
        let bytes = b"Content-Length: 7\n\n{\"a\":1}".to_vec();
        assert_eq!(f.push(&bytes), vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn a_content_type_header_before_the_length_is_fine() {
        let mut f = Framer::default();
        let bytes =
            b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 7\r\n\r\n{\"a\":1}"
                .to_vec();
        assert_eq!(f.push(&bytes), vec![r#"{"a":1}"#.to_string()]);
    }

    /// A server that prints a banner to stdout before it speaks the protocol
    /// must not poison the stream: the noise is dropped, the message survives.
    #[test]
    fn garbage_before_a_header_is_dropped() {
        let mut f = Framer::default();
        let mut bytes = b"starting up...\nready\n".to_vec();
        bytes.extend(msg(r#"{"ok":true}"#));
        assert_eq!(f.push(&bytes), vec![r#"{"ok":true}"#.to_string()]);
    }

    #[test]
    fn a_header_block_without_a_length_is_skipped_not_fatal() {
        let mut f = Framer::default();
        let mut bytes = b"X-Nothing: here\r\n\r\n".to_vec();
        bytes.extend(msg(r#"{"after":1}"#));
        assert_eq!(f.push(&bytes), vec![r#"{"after":1}"#.to_string()]);
    }

    // --- processes -------------------------------------------------------

    /// A language server in twenty lines of Node: reads framed JSON, answers
    /// `initialize`, logs a message, and can exit on its own when asked.
    const FAKE_SERVER: &str = r##"
let buf = Buffer.alloc(0);
const exitAfterInit = process.argv.includes('--exit-after-init');
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { completionProvider: {} } } });
    send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'olá' } });
    if (exitAfterInit) setTimeout(() => process.exit(3), 50);
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    process.exit(0);
  }
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, sep).toString());
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) break;
    const body = buf.slice(sep + 4, sep + 4 + len).toString();
    buf = buf.slice(sep + 4 + len);
    handle(JSON.parse(body));
  }
});
process.stderr.write('fake server up\n');
"##;

    fn fake_server() -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("yard-lsp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-server.js");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        (dir, script)
    }

    fn wait_until(timeout: Duration, label: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cond() {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        panic!("timed out waiting for: {label}");
    }

    fn channel_sink() -> (Sink, mpsc::Receiver<LspEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |ev| {
                let _ = tx.lock().unwrap().send(ev);
            }),
            rx,
        )
    }

    fn pid_alive(pid: u32) -> bool {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        sys.process(Pid::from_u32(pid)).is_some()
    }

    const INIT: &str =
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#;

    /// The whole round trip a real client makes first: start, send
    /// `initialize`, get the answer and the server's own notification back —
    /// each as bare JSON, the framing gone.
    #[test]
    fn start_initialize_and_read_the_answers_of_a_real_server_process() {
        let servers = Servers::new();
        let (dir, script) = fake_server();
        let (sink, rx) = channel_sink();
        let pid = servers
            .start(
                "t-init",
                "node",
                &[script.to_string_lossy().into_owned()],
                &dir.to_string_lossy(),
                sink,
            )
            .expect("start");
        assert!(servers.is_running("t-init"));
        servers.send("t-init", INIT).expect("send");

        let mut got: Vec<String> = Vec::new();
        wait_until(Duration::from_secs(20), "two messages", || {
            while let Ok(ev) = rx.try_recv() {
                if let LspEvent::Message(m) = ev {
                    got.push(m);
                }
            }
            got.len() >= 2
        });
        assert!(
            got[0].contains(r#""id":1"#) && got[0].contains("completionProvider"),
            "{}",
            got[0]
        );
        assert!(
            got[1].contains("window/logMessage") && got[1].contains("olá"),
            "{}",
            got[1]
        );

        servers.stop("t-init").expect("stop");
        assert!(!servers.is_running("t-init"));
        wait_until(Duration::from_secs(20), "process to die", || !pid_alive(pid));
        wait_until(Duration::from_secs(10), "exit event", || {
            matches!(rx.try_recv(), Ok(LspEvent::Exit(_)))
        });
        assert!(
            servers.send("t-init", INIT).is_err(),
            "a stopped server accepts nothing"
        );
    }

    #[test]
    fn stop_and_send_on_an_unknown_id_are_errors_not_panics() {
        let servers = Servers::new();
        assert!(servers.stop("t-nobody").unwrap_err().contains("t-nobody"));
        assert!(servers.send("t-nobody", "{}").unwrap_err().contains("t-nobody"));
    }

    /// A server that dies by itself (crash, `exit`) is reported once with
    /// its code and leaves the registry — the next `start` is a clean one.
    #[test]
    fn a_server_that_exits_on_its_own_reports_the_code_and_leaves_the_registry() {
        let servers = Servers::new();
        let (dir, script) = fake_server();
        let (sink, rx) = channel_sink();
        servers
            .start(
                "t-exit",
                "node",
                &[
                    script.to_string_lossy().into_owned(),
                    "--exit-after-init".into(),
                ],
                &dir.to_string_lossy(),
                sink,
            )
            .expect("start");
        servers.send("t-exit", INIT).expect("send");
        let mut exit = None;
        wait_until(Duration::from_secs(20), "exit event", || {
            while let Ok(ev) = rx.try_recv() {
                if let LspEvent::Exit(code) = ev {
                    exit = Some(code);
                }
            }
            exit.is_some()
        });
        assert_eq!(exit.unwrap(), Some(3));
        assert!(!servers.is_running("t-exit"));
    }

    #[test]
    fn stop_all_takes_every_server_down() {
        let servers = Servers::new();
        let (dir, script) = fake_server();
        let args = vec![script.to_string_lossy().into_owned()];
        let cwd = dir.to_string_lossy().into_owned();
        let (a, _ra) = channel_sink();
        let (b, _rb) = channel_sink();
        let p1 = servers.start("t-all-1", "node", &args, &cwd, a).expect("start 1");
        let p2 = servers.start("t-all-2", "node", &args, &cwd, b).expect("start 2");
        servers.stop_all();
        assert!(!servers.is_running("t-all-1") && !servers.is_running("t-all-2"));
        wait_until(Duration::from_secs(20), "both to die", || {
            !pid_alive(p1) && !pid_alive(p2)
        });
    }

    #[test]
    fn a_program_that_does_not_exist_is_an_error_with_its_name() {
        let servers = Servers::new();
        let (sink, _rx) = channel_sink();
        let err = servers
            .start("t-none", "yard-no-such-server-xyz", &[], ".", sink)
            .unwrap_err();
        assert!(err.contains("yard-no-such-server-xyz"), "{err}");
        assert!(!servers.is_running("t-none"));
    }

    // --- the catalog -----------------------------------------------------

    /// The list is the catalog in order, with `found` following the machine
    /// and the install line ready for the ones that are missing.
    #[test]
    fn detect_marks_what_the_machine_has_and_keeps_the_install_hint_for_the_rest() {
        let list = detect_with(|program, _| match program {
            "rust-analyzer" => Some(Some("rust-analyzer 1.80".into())),
            "gopls" => Some(None),
            _ => None,
        });
        assert_eq!(list.len(), CATALOG.len());
        let ra = list.iter().find(|s| s.program == "rust-analyzer").unwrap();
        assert!(ra.found && ra.version.as_deref() == Some("rust-analyzer 1.80"));
        assert_eq!(ra.language_ids, vec!["rust"]);
        let go = list.iter().find(|s| s.program == "gopls").unwrap();
        assert!(go.found && go.version.is_none(), "found without a version is still found");
        let ts = list.iter().find(|s| s.program == "typescript-language-server").unwrap();
        assert!(!ts.found && ts.install_hint.contains("npm i -g typescript-language-server"));
        assert_eq!(ts.args, vec!["--stdio"]);
    }

    #[test]
    fn every_language_id_has_exactly_one_server_in_the_catalog() {
        let mut seen = std::collections::HashMap::new();
        for entry in CATALOG {
            for id in entry.language_ids {
                *seen.entry(*id).or_insert(0) += 1;
            }
        }
        assert!(seen.values().all(|n| *n == 1), "{seen:?}");
    }
}
