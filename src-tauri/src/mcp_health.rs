//! Explicit, bounded MCP connection probes without invoking server tools.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::mcp::McpServer;
use crate::pty::job::JobHandle;

pub fn probe_in(home: &Path, cli: &str, scope: crate::mcp::Scope, root: Option<&Path>, name: &str, timeout: Duration) -> Result<McpHealth, String> {
    let path = crate::mcp::config_path(cli, scope, home, root).ok_or("MCP_SCOPE_UNSUPPORTED")?;
    let root_string = root.map(|value| value.to_string_lossy().into_owned());
    let server = crate::mcp::read_servers(cli, &path, scope, root_string.as_deref())
        .map_err(|_| "MCP_CONFIG_UNREADABLE")?
        .into_iter().find(|server| server.name == name).ok_or("MCP_NOT_FOUND")?;
    match server.transport.as_str() {
        "stdio" => probe_stdio(&server, root, timeout),
        "http" => probe_http(&server, timeout),
        _ => Err("MCP_TRANSPORT_UNSUPPORTED".into()),
    }
}

#[tauri::command]
pub async fn mcp_probe(cli: String, scope: String, project_root: Option<String>, name: String) -> Result<McpHealth, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::paths::home_dir().ok_or("MCP_HOME_UNAVAILABLE")?;
        let scope = crate::mcp::Scope::parse(&scope).ok_or("MCP_SCOPE_UNSUPPORTED")?;
        probe_in(&home, &cli, scope, project_root.as_deref().map(Path::new), &name, Duration::from_secs(10))
    }).await.map_err(|_| "MCP_PROBE_INTERRUPTED".to_string())?
}

const MESSAGE_LIMIT: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub server_name: String,
    pub server_version: String,
    pub protocol_version: String,
    pub tools: Option<usize>,
}

struct ProbeProcess {
    child: Child,
    job: Option<JobHandle>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ProbeProcess {
    fn drop(&mut self) {
        self.child.stdin.take();
        if let Some(job) = &self.job { job.terminate(); }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
    }
}

fn response(messages: &Receiver<Result<Value, String>>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let message = messages.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "MCP_TIMEOUT".to_string())??;
        if message.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if message.get("error").is_some() { return Err("MCP_SERVER_ERROR".into()); }
        return message.get("result").cloned().ok_or_else(|| "MCP_INVALID_RESPONSE".into());
    }
}

fn send(child: &mut Child, message: Value) -> Result<(), String> {
    let stdin = child.stdin.as_mut().ok_or("MCP_CLOSED")?;
    serde_json::to_writer(&mut *stdin, &message).map_err(|_| "MCP_WRITE_FAILED")?;
    stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|_| "MCP_WRITE_FAILED".into())
}

pub fn probe_stdio(server: &McpServer, root: Option<&Path>, timeout: Duration) -> Result<McpHealth, String> {
    if !server.enabled { return Err("MCP_DISABLED".into()); }
    let deadline = Instant::now() + timeout;
    let (program, args) = crate::agents::resolver::resolve_launch(server.command.as_deref().ok_or("MCP_MISSING_COMMAND")?, &server.args);
    let mut command = Command::new(program);
    command.args(args).envs(&server.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(root) = root { command.current_dir(root); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command.spawn().map_err(|_| "MCP_SPAWN_FAILED")?;
    let job = JobHandle::create_and_assign(child.id());
    let mut process = ProbeProcess { child, job, reader: None };
    #[cfg(windows)]
    if process.job.is_none() { return Err("MCP_PROCESS_ISOLATION_FAILED".into()); }
    let stdout = process.child.stdout.take().ok_or("MCP_CLOSED")?;
    let (sender, messages) = mpsc::sync_channel(8);
    process.reader = Some(std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut bytes = Vec::new();
            let result = (&mut reader).take((MESSAGE_LIMIT + 1) as u64).read_until(b'\n', &mut bytes);
            let message = match result {
                Ok(0) => Err("MCP_CLOSED".to_string()),
                Ok(_) if bytes.len() > MESSAGE_LIMIT => Err("MCP_MESSAGE_TOO_LARGE".to_string()),
                Ok(_) => serde_json::from_slice::<Value>(&bytes).map_err(|_| "MCP_INVALID_RESPONSE".to_string()),
                Err(_) => Err("MCP_READ_FAILED".to_string()),
            };
            let stop = message.is_err();
            if sender.send(message).is_err() || stop { break; }
        }
    }));
    let health = handshake(|message| {
        let id = message.get("id").and_then(Value::as_u64);
        send(&mut process.child, message)?;
        match id { Some(id) => response(&messages, id, deadline), None => Ok(Value::Null) }
    });
    drop(messages);
    health
}

fn handshake(mut exchange: impl FnMut(Value) -> Result<Value, String>) -> Result<McpHealth, String> {
    let initialization = exchange(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"yard-health","version":env!("CARGO_PKG_VERSION")}
    }}))?;
    let protocol_version = initialization["protocolVersion"].as_str().ok_or("MCP_INVALID_RESPONSE")?.to_string();
    if !matches!(protocol_version.as_str(), "2025-06-18" | "2025-03-26" | "2024-11-05") {
        return Err("MCP_PROTOCOL_UNSUPPORTED".into());
    }
    let server_name = initialization["serverInfo"]["name"].as_str().ok_or("MCP_INVALID_RESPONSE")?.to_string();
    let server_version = initialization["serverInfo"]["version"].as_str().ok_or("MCP_INVALID_RESPONSE")?.to_string();
    exchange(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
    let tools = if initialization["capabilities"].get("tools").is_some() {
        let mut count = 0;
        let mut cursor = None;
        let mut seen = std::collections::BTreeSet::new();
        for page in 0..32 {
            let id = page + 2;
            let mut message = json!({"jsonrpc":"2.0","id":id,"method":"tools/list"});
            if let Some(value) = &cursor { message["params"] = json!({"cursor":value}); }
            let result = exchange(message)?;
            count += result["tools"].as_array().ok_or("MCP_INVALID_RESPONSE")?.len();
            cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            let Some(next) = &cursor else { break; };
            if page == 31 || !seen.insert(next.clone()) { return Err("MCP_PAGINATION_LIMIT".into()); }
        }
        Some(count)
    } else { None };
    Ok(McpHealth { server_name, server_version, protocol_version, tools })
}

pub fn probe_http(server: &McpServer, timeout: Duration) -> Result<McpHealth, String> {
    if !server.enabled { return Err("MCP_DISABLED".into()); }
    let url = server.url.as_deref().ok_or("MCP_MISSING_URL")?;
    let deadline = Instant::now() + timeout;
    let agent = crate::http::client(timeout, None, false).map_err(|_| "MCP_CONNECTION_FAILED".to_string())?;
    let mut session: Option<String> = None;
    let mut protocol: Option<String> = None;
    let health = handshake(|message| {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err("MCP_TIMEOUT".into()); }
        let mut request = agent.post(url).timeout(remaining);
        for (name, value) in &server.headers { request = request.header(name.as_str(), value.as_str()); }
        request = request.header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream");
        if let Some(value) = &session { request = request.header("Mcp-Session-Id", value.as_str()); }
        if let Some(value) = &protocol { request = request.header("MCP-Protocol-Version", value.as_str()); }
        let response = request.body(message.to_string()).send().map_err(|_| "MCP_CONNECTION_FAILED".to_string())?;
        match crate::http::refused(&response) {
            Some(401 | 403) => return Err("MCP_AUTH_REQUIRED".into()),
            Some(_) => return Err("MCP_HTTP_ERROR".into()),
            None => {}
        }
        if let Some(value) = crate::http::header(&response, "Mcp-Session-Id") { session = Some(value.to_string()); }
        let Some(id) = message.get("id") else {
            return if response.status().as_u16() == 202 { Ok(Value::Null) } else { Err("MCP_INVALID_RESPONSE".into()) };
        };
        let content_type = crate::http::header(&response, "Content-Type").unwrap_or("").to_string();
        let result = read_http_response(response, &content_type, id)?;
        if message["method"] == "initialize" { protocol = result["protocolVersion"].as_str().map(str::to_string); }
        Ok(result)
    });
    if let Some(session) = session {
        let mut request = agent.delete(url).timeout(Duration::from_secs(1));
        for (name, value) in &server.headers { request = request.header(name.as_str(), value.as_str()); }
        request = request.header("Mcp-Session-Id", session.as_str());
        if let Some(protocol) = protocol { request = request.header("MCP-Protocol-Version", protocol.as_str()); }
        let _ = request.send();
    }
    health
}

fn rpc_result(message: Value, id: &Value) -> Result<Value, String> {
    if message.get("id") != Some(id) || message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { return Err("MCP_INVALID_RESPONSE".into()); }
    if message.get("error").is_some() { return Err("MCP_SERVER_ERROR".into()); }
    message.get("result").cloned().ok_or_else(|| "MCP_INVALID_RESPONSE".into())
}

fn read_http_response(reader: impl Read, content_type: &str, id: &Value) -> Result<Value, String> {
    if content_type.split(';').next().map(str::trim) == Some("application/json") {
        let mut bytes = Vec::new();
        reader.take((MESSAGE_LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(|_| "MCP_READ_FAILED")?;
        if bytes.len() > MESSAGE_LIMIT { return Err("MCP_MESSAGE_TOO_LARGE".into()); }
        return rpc_result(serde_json::from_slice(&bytes).map_err(|_| "MCP_INVALID_RESPONSE")?, id);
    }
    if content_type.split(';').next().map(str::trim) != Some("text/event-stream") { return Err("MCP_INVALID_RESPONSE".into()); }
    let mut reader = BufReader::new(reader);
    let mut data = Vec::new();
    let mut consumed = 0;
    loop {
        let mut line = Vec::new();
        let read = (&mut reader).take((MESSAGE_LIMIT + 1) as u64).read_until(b'\n', &mut line).map_err(|_| "MCP_READ_FAILED")?;
        consumed += read;
        if line.len() > MESSAGE_LIMIT || data.len() + line.len() > MESSAGE_LIMIT || consumed > MESSAGE_LIMIT * 32 { return Err("MCP_MESSAGE_TOO_LARGE".into()); }
        while matches!(line.last(), Some(b'\n' | b'\r')) { line.pop(); }
        if line.is_empty() || read == 0 {
            if !data.is_empty() {
                let message: Value = serde_json::from_slice(&data).map_err(|_| "MCP_INVALID_RESPONSE")?;
                data.clear();
                if message.get("id") == Some(id) { return rpc_result(message, id); }
            }
            if read == 0 { return Err("MCP_CLOSED".into()); }
        } else if let Some(value) = line.strip_prefix(b"data:") {
            let value = value.strip_prefix(b" ").unwrap_or(value);
            if !data.is_empty() { data.push(b'\n'); }
            data.extend_from_slice(value);
        }
    }
}

#[cfg(test)]
mod tests {
    // A configured command is healthy only after completing the MCP handshake.
    use super::*;
    use crate::mcp::McpServer;
    use std::collections::BTreeMap;
    use std::time::Duration;

    fn fixture_server(script: &str) -> McpServer {
        McpServer {
            name: "fixture".into(), transport: "stdio".into(),
            command: Some("powershell.exe".into()),
            args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script.into()],
            env: BTreeMap::new(), headers: BTreeMap::new(), url: None, enabled: true,
        }
    }

    #[test]
    fn an_unsupported_negotiated_protocol_is_not_reported_as_healthy() {
        let server = fixture_server(r#"
$null = [Console]::ReadLine()
[Console]::WriteLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2099-01-01","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}')
$null = [Console]::ReadLine()
"#);
        assert_eq!(probe_stdio(&server, None, Duration::from_secs(8)).unwrap_err(), "MCP_PROTOCOL_UNSUPPORTED");
    }

    #[test]
    fn a_disabled_server_is_not_started_by_a_connection_probe() {
        let mut server = fixture_server("exit 9");
        server.enabled = false;
        server.command = Some("yard-owned-missing-executable".into());
        assert_eq!(probe_stdio(&server, None, Duration::from_secs(1)).unwrap_err(), "MCP_DISABLED");
    }

    #[test]
    fn a_silent_stdio_server_reaches_the_deadline_and_its_process_is_reaped() {
        let server = fixture_server("$null = [Console]::ReadLine(); $null = [Console]::ReadLine()");
        let started = Instant::now();
        assert_eq!(probe_stdio(&server, None, Duration::from_millis(500)).unwrap_err(), "MCP_TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(3), "cleanup must not wait forever for a silent process");
    }

    #[test]
    fn the_tool_count_includes_every_advertised_page() {
        let server = fixture_server(r#"
while ($null -ne ($line = [Console]::ReadLine())) {
  $message = $line | ConvertFrom-Json
  if ($message.method -eq 'initialize') {
    [Console]::WriteLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}')
  } elseif ($message.method -eq 'tools/list') {
    $result = @{tools=@(@{name='read';inputSchema=@{type='object'}})}
    if ($message.params.cursor -ne 'second') { $result.nextCursor = 'second' }
    @{jsonrpc='2.0';id=$message.id;result=$result} | ConvertTo-Json -Compress -Depth 8 | % { [Console]::WriteLine($_) }
  }
}
"#);
        assert_eq!(probe_stdio(&server, None, Duration::from_secs(8)).unwrap().tools, Some(2));
    }

    #[test]
    fn probing_a_missing_configured_name_does_not_start_a_different_server() {
        let home = std::env::temp_dir().join(format!("yard-mcp-health-missing-{}", std::process::id()));
        assert_eq!(probe_in(&home, "codex", crate::mcp::Scope::User, None, "missing", Duration::from_secs(1)).unwrap_err(), "MCP_NOT_FOUND");
    }

    #[test]
    fn a_real_http_server_negotiates_a_session_and_lists_tools() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let fixture = std::thread::spawn(move || {
            for expected in ["initialize", "notifications/initialized", "tools/list", "DELETE"] {
                let deadline = Instant::now() + Duration::from_secs(3);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                            std::thread::park_timeout(Duration::from_millis(10));
                        }
                        Err(error) => panic!("missing expected {expected}: {error}"),
                    }
                };
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0;
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" { break; }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse::<usize>().unwrap(); }
                    headers.push_str(&line.to_ascii_lowercase());
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request: Value = if expected == "DELETE" { Value::Null } else { serde_json::from_slice(&body).unwrap() };
                if expected == "DELETE" { assert!(headers.starts_with("delete /mcp ")); }
                else {
                    assert_eq!(request["method"], expected);
                    assert!(headers.contains("accept: application/json, text/event-stream"));
                }
                if expected != "initialize" {
                    assert!(headers.contains("mcp-session-id: owned-session"));
                    assert!(headers.contains("mcp-protocol-version: 2025-06-18"));
                }
                let response = match expected {
                    "initialize" => json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"owned-http","version":"1"}}}).to_string(),
                    "tools/list" => json!({"jsonrpc":"2.0","id":request["id"],"result":{"tools":[]}}).to_string(),
                    _ => String::new(),
                };
                let status = if expected == "notifications/initialized" { "202 Accepted" } else if expected == "DELETE" { "204 No Content" } else { "200 OK" };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nMcp-Session-Id: owned-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            }
        });
        let mut server = fixture_server("exit 9");
        server.transport = "http".into();
        server.url = Some(format!("http://{address}/mcp"));
        let health = probe_http(&server, Duration::from_secs(8)).unwrap();
        assert_eq!(health.server_name, "owned-http");
        assert_eq!(health.tools, Some(0));
        fixture.join().unwrap();
    }

    /// Pinned when the client moved from ureq to reqwest: a refusal of the
    /// credentials is told apart from any other HTTP failure.
    #[test]
    fn an_http_server_that_refuses_the_credentials_reports_auth_required() {
        let (url, server) = crate::http::testing::serve_once("401 Unauthorized", &[], "");
        let mut refused = fixture_server("exit 9");
        refused.transport = "http".into();
        refused.url = Some(format!("{url}/mcp"));
        assert_eq!(probe_http(&refused, Duration::from_secs(5)).err().as_deref(), Some("MCP_AUTH_REQUIRED"));
        server.join().unwrap();
        let (url, server) = crate::http::testing::serve_once("500 Internal Server Error", &[], "");
        refused.url = Some(format!("{url}/mcp"));
        assert_eq!(probe_http(&refused, Duration::from_secs(5)).err().as_deref(), Some("MCP_HTTP_ERROR"));
        server.join().unwrap();
    }

    #[test]
    fn an_http_event_stream_ignores_notifications_and_reads_the_matching_response() {
        let text = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let result = read_http_response(std::io::Cursor::new(text), "text/event-stream; charset=utf-8", &json!(2)).unwrap();
        assert_eq!(result, json!({"tools":[]}));
    }

    #[test]
    fn a_configured_powershell_script_uses_the_existing_windows_launch_adapter() {
        let script = std::env::temp_dir().join(format!("yard-owned-mcp-shim-{}.ps1", std::process::id()));
        std::fs::write(&script, r#"
$null = [Console]::ReadLine()
[Console]::WriteLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"owned-script","version":"1"}}}')
$null = [Console]::ReadLine()
"#).unwrap();
        let mut server = fixture_server("exit 9");
        server.command = Some(script.to_string_lossy().into_owned());
        server.args.clear();
        let result = probe_stdio(&server, None, Duration::from_secs(8));
        std::fs::remove_file(&script).unwrap();
        assert_eq!(result.unwrap().server_name, "owned-script");
    }

    #[test]
    fn a_real_stdio_server_completes_initialization_before_listing_tools() {
        let script = r#"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$initialized = $false
while ($null -ne ($line = [Console]::ReadLine())) {
  $message = $line | ConvertFrom-Json
  if ($message.method -eq 'initialize') {
    @{jsonrpc='2.0';id=$message.id;result=@{protocolVersion='2025-06-18';capabilities=@{tools=@{}};serverInfo=@{name='owned-fixture';version='1.2.3'}}} | ConvertTo-Json -Compress -Depth 8 | % { [Console]::WriteLine($_) }
  } elseif ($message.method -eq 'notifications/initialized') {
    $initialized = $true
  } elseif ($message.method -eq 'tools/list' -and $initialized) {
    @{jsonrpc='2.0';id=$message.id;result=@{tools=@(@{name='read';inputSchema=@{type='object'}},@{name='inspect';inputSchema=@{type='object'}})}} | ConvertTo-Json -Compress -Depth 8 | % { [Console]::WriteLine($_) }
  } else { exit 9 }
}
"#;
        let server = fixture_server(script);
        let health = probe_stdio(&server, None, Duration::from_secs(8)).unwrap();
        assert_eq!(health.server_name, "owned-fixture");
        assert_eq!(health.server_version, "1.2.3");
        assert_eq!(health.protocol_version, "2025-06-18");
        assert_eq!(health.tools, Some(2));
    }
}
