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
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agents::resolver::{probe_each, SharedDetection};
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
///
/// Linear in the bytes fed, however the pipe cuts them: what a push learned
/// is kept for the next one (where the header's blank line was searched up
/// to, where the body starts and how long it is), so a four-megabyte answer
/// arriving in 64 KiB reads is not searched again from its first byte on
/// every read. It used to be, and the search for a bare `\n\n` (which
/// compact JSON never has) ran to the end of the buffer each time: about a
/// gigabyte of comparisons for one such message in 8 KiB reads.
#[derive(Default)]
pub struct Framer {
    /// Unconsumed bytes. While a header is pending it starts at `buf[0]`.
    buf: Vec<u8>,
    state: FrameState,
}

/// Where the decoder is in the message that starts at `Framer::buf[0]`.
#[derive(Clone, Copy, Default)]
enum FrameState {
    /// Looking for a `Content-Length:` (the bytes before it are noise).
    #[default]
    Seeking,
    /// A header starts at `buf[0]` and its blank line has not been seen:
    /// no position before `scanned` can start one.
    Header { scanned: usize },
    /// The header is read: `len` body bytes start at `body_start`.
    Body { body_start: usize, len: usize },
}

impl Framer {
    /// Feeds bytes and returns every complete message they finished.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        // Bytes of `buf` already consumed in this push. They are drained once
        // at the end, not after each message: a read holding a thousand
        // small notifications would otherwise move its tail a thousand times.
        let mut at = 0;
        loop {
            let rest = &self.buf[at..];
            match self.state {
                FrameState::Seeking => {
                    let Some(start) = find_ci(rest, b"content-length:") else {
                        // Nothing that looks like a header yet: keep only a
                        // tail long enough to complete a header that
                        // straddles chunks.
                        let keep = rest.len().min(b"content-length:".len() - 1);
                        at = self.buf.len() - keep;
                        break;
                    };
                    // Garbage before the header (a server that printed to
                    // stdout before speaking the protocol): thrown away.
                    at += start;
                    self.state = FrameState::Header { scanned: 0 };
                }
                FrameState::Header { scanned } => {
                    let Some((header_end, sep_len)) = header_terminator(rest, scanned) else {
                        // The last three positions can still become the
                        // start of a `\r\n\r\n` when more bytes arrive.
                        self.state = FrameState::Header {
                            scanned: rest.len().saturating_sub(3),
                        };
                        break;
                    };
                    let header = String::from_utf8_lossy(&rest[..header_end]);
                    self.state = match content_length(&header) {
                        Some(len) => FrameState::Body {
                            body_start: header_end + sep_len,
                            len,
                        },
                        None => {
                            // A header block with no usable length: skip it
                            // and look for the next one instead of wedging
                            // the stream forever.
                            at += header_end + sep_len;
                            FrameState::Seeking
                        }
                    };
                }
                FrameState::Body { body_start, len } => {
                    if rest.len() < body_start + len {
                        break;
                    }
                    let body = String::from_utf8_lossy(&rest[body_start..body_start + len]);
                    out.push(body.into_owned());
                    at += body_start + len;
                    self.state = FrameState::Seeking;
                }
            }
        }
        if at > 0 {
            self.buf.drain(..at);
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

/// End of the header block: the offset of the first blank line at or after
/// `from` and the length of the separator that made it (`\r\n\r\n` per the
/// spec; `\n\n` tolerated). One forward pass that stops at the first match,
/// so it reads the header and never the body behind it. (The two patterns
/// cannot start at the same offset: one starts with `\r`, the other `\n`.)
fn header_terminator(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    (from..buf.len()).find_map(|p| {
        let tail = &buf[p..];
        if tail.starts_with(b"\r\n\r\n") {
            Some((p, 4))
        } else if tail.starts_with(b"\n\n") {
            Some((p, 2))
        } else {
            None
        }
    })
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
    /// Shared so `send` can write with the registry lock already released.
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
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
                stdin: Arc::new(Mutex::new(Box::new(stdin))),
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
        // A read returns whatever the pipe holds, up to this, so a bigger
        // buffer adds no wait: it only takes a multi-megabyte answer in
        // fewer trips. On the heap, not in the thread's stack.
        let mut chunk = vec![0u8; 64 * 1024];
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
    ///
    /// The stdin handle is cloned out and the registry lock released before
    /// the write: a server that stops draining its stdin blocks here, and
    /// with the registry locked `stop`/`stop_all` (the app's exit) would
    /// wait behind it.
    pub fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let stdin = self
            .map
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.stdin.clone())
            .ok_or_else(|| format!("servidor de linguagem {id} não está rodando"))?;
        let mut stdin = stdin.lock().unwrap();
        stdin
            .write_all(&frame(message))
            .and_then(|_| stdin.flush())
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
    // kill below is for the others. (A `send` stalled on this same stdin
    // still holds a clone; the kill covers that case too.)
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
/// user installs something (`refresh` is the button for that). Two callers
/// at once share one detection (`SharedDetection`).
pub fn detect(refresh: bool) -> Vec<LspServerInfo> {
    static CACHE: SharedDetection<Vec<LspServerInfo>> = SharedDetection::new();
    CACHE.get(refresh, || {
        detect_with(|program, version_args| {
            crate::agents::resolver::find_binary(program)
                .map(|_| crate::agents::resolver::probe_version(program, version_args))
        })
    })
}

/// The catalog resolved through `probe`: `None` when the program is not on
/// this machine, `Some(version)` when it is (the version itself may be
/// unknown, some servers answer nothing to `--version`). Every server is
/// probed at once (`probe_each`), and the list keeps the catalog's order.
fn detect_with(
    probe: impl Fn(&str, &[&str]) -> Option<Option<String>> + Sync,
) -> Vec<LspServerInfo> {
    let probed = probe_each(CATALOG, |entry| probe(entry.program, entry.version_args));
    CATALOG
        .iter()
        .zip(probed)
        .map(|(entry, probed)| {
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

// `lsp_start`, `lsp_send` and `lsp_stop` are plain `fn`s on purpose: each
// runs on its server's own lane (`lanes.rs`), off the UI thread and in the
// order the editor sent them. On the blocking pool, as they used to be, two
// messages the editor fired back to back could reach the server swapped (a
// `didChange` for version 5 written before the one for version 4).

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    let sink = emit_sink(app, id.clone());
    global().start(&id, &program, &args, &cwd, sink)
}

#[tauri::command]
pub fn lsp_send(id: String, message: String) -> Result<(), String> {
    global().send(&id, &message)
}

#[tauri::command]
pub fn lsp_stop(id: String) -> Result<(), String> {
    global().stop(&id)
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

    // --- framing: the same messages whatever the pipe's chunking ----------
    //
    // The pipe decides where a read ends, not the protocol, so the decoder
    // must yield the same messages, in the same order, however the stream is
    // cut. These lock that down across every shape the decoder tolerates
    // (bare LF, `\r\n\n`, garbage, a header with no usable length, bodies
    // that look like headers, invalid UTF-8) and across the sizes a real
    // server sends (a multi-megabyte `textDocument/semanticTokens` answer,
    // thousands of small notifications in one read).

    /// Every shape the decoder accepts or tolerates, back to back, with the
    /// messages it has to yield.
    fn mixed_stream() -> (Vec<u8>, Vec<String>) {
        let mut bytes: Vec<u8> = Vec::new();
        let mut want: Vec<String> = Vec::new();
        // A banner printed before the protocol, blank line included.
        bytes.extend(b"starting up...\nready\n\n");
        // The spec's framing.
        bytes.extend(msg(r#"{"n":1}"#));
        want.push(r#"{"n":1}"#.into());
        // Bare LF, lower-case name, no space after the colon.
        bytes.extend(b"content-length:7\n\n{\"n\":2}");
        want.push(r#"{"n":2}"#.into());
        // A Content-Type before the length, the name in upper case.
        bytes.extend(
            b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: 7\r\n\r\n{\"n\":3}",
        );
        want.push(r#"{"n":3}"#.into());
        // A header with no usable length: skipped, and what follows it up to
        // the next header is noise.
        bytes.extend(b"Content-Length: many\r\n\r\n{\"lost\":1}");
        // The length counts bytes, not characters.
        bytes.extend(msg(r#"{"t":"ação"}"#));
        want.push(r#"{"t":"ação"}"#.into());
        // A body holding a header-looking line and blank lines of both
        // kinds: the body is taken by its length, never searched.
        let tricky = "{\"s\":\"Content-Length: 99\"}\r\n\r\n\n\n";
        bytes.extend(msg(tricky));
        want.push(tricky.into());
        // CRLF followed by a bare LF: the blank line is the LF LF.
        bytes.extend(b"Content-Length: 7\r\n\n{\"n\":4}");
        want.push(r#"{"n":4}"#.into());
        // Noise between two messages.
        bytes.extend(b"oops\n");
        // Invalid UTF-8, decoded lossily.
        bytes.extend(b"Content-Length: 2\r\n\r\n\xff\xfe");
        want.push("\u{FFFD}\u{FFFD}".into());
        // An empty body.
        bytes.extend(b"Content-Length: 0\r\n\r\n");
        want.push(String::new());
        // Two lengths: the first one wins. A header after the length.
        bytes.extend(b"Content-Length: 7\r\nContent-Length: 99\r\nX-Extra: 1\r\n\r\n{\"n\":5}");
        want.push(r#"{"n":5}"#.into());
        (bytes, want)
    }

    fn feed(f: &mut Framer, chunks: impl IntoIterator<Item = impl AsRef<[u8]>>) -> Vec<String> {
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(f.push(chunk.as_ref()));
        }
        out
    }

    #[test]
    fn a_mixed_stream_in_one_chunk_yields_every_message_in_order() {
        let (bytes, want) = mixed_stream();
        assert_eq!(feed(&mut Framer::default(), [&bytes]), want);
    }

    #[test]
    fn a_mixed_stream_cut_at_any_single_point_yields_the_same_messages() {
        let (bytes, want) = mixed_stream();
        for cut in 0..=bytes.len() {
            let (a, b) = bytes.split_at(cut);
            assert_eq!(feed(&mut Framer::default(), [a, b]), want, "cut at {cut}");
        }
    }

    #[test]
    fn a_mixed_stream_fed_one_byte_at_a_time_yields_the_same_messages() {
        let (bytes, want) = mixed_stream();
        assert_eq!(feed(&mut Framer::default(), bytes.chunks(1)), want);
    }

    /// Chunk sizes from a fixed-seed generator: every cut position mixed with
    /// every other, deterministic from run to run.
    #[test]
    fn a_mixed_stream_in_chunks_of_varying_sizes_yields_the_same_messages() {
        let (bytes, want) = mixed_stream();
        let mut seed: u64 = 0x5eed;
        for run in 0..300 {
            let mut chunks = Vec::new();
            let mut at = 0;
            while at < bytes.len() {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let size = 1 + (seed >> 33) as usize % 40;
                let end = (at + size).min(bytes.len());
                chunks.push(&bytes[at..end]);
                at = end;
            }
            assert_eq!(feed(&mut Framer::default(), chunks), want, "run {run}");
        }
    }

    /// A body of `size` bytes of compact JSON (no blank line anywhere, the
    /// case that made a scan for one run to the end of the buffer), with
    /// multibyte characters so the reads cut them in half.
    fn big_body(size: usize) -> String {
        let mut body = String::from(r#"{"jsonrpc":"2.0","id":7,"result":{"data":""#);
        while body.len() < size {
            body.push_str("ação,");
        }
        body.push_str(r#""}}"#);
        body
    }

    #[test]
    fn a_four_megabyte_message_fed_in_8_kib_reads_comes_out_once_and_whole() {
        let body = big_body(4 * 1024 * 1024);
        let bytes = msg(&body);
        let mut f = Framer::default();
        let chunks: Vec<&[u8]> = bytes.chunks(8 * 1024).collect();
        let (last, rest) = chunks.split_last().unwrap();
        for (i, chunk) in rest.iter().enumerate() {
            assert!(f.push(chunk).is_empty(), "read {i} finished nothing");
        }
        assert_eq!(f.push(last), vec![body]);
    }

    /// A big answer with small notifications on both sides, in the reads a
    /// pipe hands over (8 KiB and 64 KiB): the order survives.
    #[test]
    fn a_big_message_between_small_ones_keeps_the_order_at_any_read_size() {
        let body = big_body(300 * 1024);
        let mut bytes = msg(r#"{"before":1}"#);
        bytes.extend(msg(&body));
        bytes.extend(b"Content-Length: 11\n\n{\"after\":1}");
        let want = vec![r#"{"before":1}"#.to_string(), body, r#"{"after":1}"#.to_string()];
        for read in [8 * 1024, 64 * 1024] {
            assert_eq!(feed(&mut Framer::default(), bytes.chunks(read)), want, "read {read}");
        }
    }

    /// A server that floods notifications (diagnostics, progress) puts
    /// hundreds of messages in one read, and cuts one in half at its end.
    #[test]
    fn thousands_of_small_messages_come_out_in_order_at_any_read_size() {
        let mut bytes = Vec::new();
        let mut want = Vec::new();
        for n in 0..3000 {
            let body = format!(r#"{{"jsonrpc":"2.0","method":"$/progress","params":{{"n":{n}}}}}"#);
            if n % 3 == 0 {
                bytes.extend(format!("Content-Length: {}\n\n{body}", body.len()).into_bytes());
            } else {
                bytes.extend(msg(&body));
            }
            want.push(body);
        }
        for read in [8 * 1024, 64 * 1024, bytes.len()] {
            assert_eq!(feed(&mut Framer::default(), bytes.chunks(read)), want, "read {read}");
        }
    }

    /// The reader thread, off a stream bigger than any single read: every
    /// message goes to the sink in order, then the exit (no code: nobody
    /// registered the server, so there is no process to reap).
    #[test]
    fn the_reader_delivers_a_stream_bigger_than_one_read_in_order_then_the_exit() {
        let body = big_body(200 * 1024);
        let mut bytes = Vec::new();
        let mut want = Vec::new();
        for n in 0..50 {
            let small = format!(r#"{{"n":{n}}}"#);
            bytes.extend(msg(&small));
            want.push(LspEvent::Message(small));
        }
        bytes.extend(msg(&body));
        want.push(LspEvent::Message(body));
        want.push(LspEvent::Exit(None));
        let servers = Servers::new();
        let (sink, rx) = channel_sink();
        servers.read_loop("t-reader", 0, std::io::Cursor::new(bytes), sink);
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), want);
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

    /// Seven `--version` runs one after the other (most of them Node) held
    /// the settings list for their sum. They run side by side, and the list
    /// still comes out in the catalog's order.
    #[test]
    fn detection_probes_every_server_at_the_same_time_and_keeps_the_catalog_order() {
        let gauge = crate::agents::resolver::tests::Gauge::default();
        let deadline = Instant::now() + Duration::from_secs(3);
        let list = detect_with(|program, _| {
            gauge.probe(CATALOG.len(), deadline);
            Some(Some(format!("{program} 1.0")))
        });
        assert_eq!(gauge.max(), CATALOG.len(), "probes running at once");
        let programs: Vec<&str> = list.iter().map(|s| s.program.as_str()).collect();
        let catalog: Vec<&str> = CATALOG.iter().map(|e| e.program).collect();
        assert_eq!(programs, catalog);
        for server in &list {
            assert_eq!(server.version, Some(format!("{} 1.0", server.program)));
        }
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

    /// A server that stops draining its stdin used to block `send` with the
    /// registry locked, and `stop`, `stop_all` (the app's exit) and every
    /// other client waited behind it. The registry lock is released before
    /// the bytes go out.
    #[cfg(windows)]
    #[test]
    fn a_stalled_send_does_not_hold_the_registry_lock() {
        struct Stalled {
            entered: mpsc::Sender<()>,
            gate: mpsc::Receiver<()>,
        }
        impl Write for Stalled {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let _ = self.entered.send(());
                let _ = self.gate.recv();
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let servers = Servers::new();
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let (entered_tx, entered) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        servers.map.lock().unwrap().insert(
            "x".into(),
            Server {
                child,
                stdin: Arc::new(Mutex::new(Box::new(Stalled {
                    entered: entered_tx,
                    gate,
                }))),
                pid,
                job: None,
            },
        );

        let sender = {
            let servers = servers.clone();
            std::thread::spawn(move || servers.send("x", "{}"))
        };
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("the write never started");
        let (probe_tx, probe) = mpsc::channel();
        {
            let servers = servers.clone();
            std::thread::spawn(move || {
                let _ = probe_tx.send(servers.is_running("x"));
            });
        }
        assert_eq!(
            probe.recv_timeout(Duration::from_secs(2)),
            Ok(true),
            "the registry is locked while the write is stalled"
        );
        release.send(()).unwrap();
        assert!(sender.join().unwrap().is_ok());
    }
}
