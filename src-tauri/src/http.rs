//! Blocking HTTP for the few places that talk to a server: the usage meters
//! (`usage.rs`), the MCP health probe (`mcp_health.rs`), the portal's
//! live-reload probe (`portal.rs`) and webhooks (`webhook.rs`).
//!
//! The client is reqwest's blocking one, on the rustls stack the updater
//! plugin already compiles. Each `Client` runs its own small runtime thread,
//! so a caller that polls keeps one client instead of building one per call.
//! Never use one from async code: the callers run on plain or blocking-pool
//! threads.

use std::time::Duration;

pub use reqwest::blocking::{Client, Response};

/// rustls needs a process-wide crypto provider. The updater installs the
/// same one (ring) when it builds its own client; whoever comes first wins,
/// and the other's attempt is a harmless no-op.
fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// A blocking client: `timeout` bounds each whole request, `connect` the
/// connection alone, and redirects are followed only when asked.
pub fn client(timeout: Duration, connect: Option<Duration>, follow_redirects: bool) -> Result<Client, String> {
    install_crypto_provider();
    let mut builder = Client::builder()
        .timeout(timeout)
        .user_agent(concat!("yard/", env!("CARGO_PKG_VERSION")));
    if let Some(connect) = connect {
        builder = builder.connect_timeout(connect);
    }
    if !follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    builder.build().map_err(|error| error.to_string())
}

/// The status of a refused request (400 and above), the line the old client
/// drew between an answer and an error.
pub fn refused(response: &Response) -> Option<u16> {
    let status = response.status().as_u16();
    (status >= 400).then_some(status)
}

/// A response header as text, when present and readable.
pub fn header<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
    response.headers().get(name).and_then(|value| value.to_str().ok())
}

/// A local server for the tests of the modules above: it answers one request
/// with a canned response and hands back what it received.
#[cfg(test)]
pub mod testing {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::time::{Duration, Instant};

    /// Serves one request on `127.0.0.1` with `status` (for example
    /// `"500 Internal Server Error"`), `headers` (whole lines, without CRLF)
    /// and `body`. Returns the base URL and the request as text.
    pub fn serve_once(status: &str, headers: &[&str], body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            headers.iter().map(|header| format!("{header}\r\n")).collect::<String>(),
            body.len()
        );
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let (stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                        std::thread::park_timeout(Duration::from_millis(10));
                    }
                    Err(error) => panic!("no request arrived: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            request.push_str(&String::from_utf8_lossy(&body));
            let mut stream = stream;
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            request
        });
        (format!("http://{address}"), server)
    }
}
