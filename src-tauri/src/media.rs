//! The bytes of a project file, delivered to the webview.
//!
//! **Why not one more IPC command.** The previous path (`fs_read_data_url`, now
//! removed) turned the file into base64 and sent the whole thing to JavaScript.
//! It worked for the screenshot in a `![](docs/print.png)`, with a 12 MB cap,
//! and it is the worst possible way to play a video: a 300 MB `.mp4` would
//! become 400 MB of text in memory before the first frame, and with no `Range`
//! the progress bar goes nowhere.
//!
//! So the bytes leave over a protocol of their own — `yardfile://localhost/…`,
//! which on Windows WebView2 presents as `http://yardfile.localhost/…`. To
//! `<img>`, `<video>` and `<iframe>` it is an address like any other: Chromium
//! asks for the chunk it needs (`Range`), seeking works, and nothing goes
//! through JavaScript.
//!
//! **The fence has two turns**, because a URL is not like an IPC call: it lives
//! inside an `<img>`, and the markdown the page draws is written by agents as
//! much as by people.
//!
//! 1. `root` must be a root the app opened this session
//!    (`explorer::root_allowed`) — a made-up URL does not become a window into
//!    `C:\Users\…`;
//! 2. `path` goes through `explorer::resolve`, the same gate as the file
//!    commands: no `..`, no absolute path and no link pointing outside the root.
//!
//! What leaves here is always a file read from disk. Nothing is ever executed,
//! and the `Content-Type` comes from our own extension table (`explorer`), not
//! from a guess about the contents.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use crate::explorer;

/// The scheme name. Changing it here changes the front end's URL (`lib/media.ts`).
pub const SCHEME: &str = "yardfile";

/// Largest chunk returned at once. The player asks for the next one on its own;
/// the cap is what keeps a 4 GB movie from becoming 4 GB of RAM.
const MAX_CHUNK: u64 = 2 * 1024 * 1024;

/// Cap for a request **without** `Range` — the `<img>` case, which downloads
/// everything at once. Video and audio always arrive with `Range`, so they never
/// hit this.
const MAX_FULL: u64 = 128 * 1024 * 1024;

/// Serves a request from the webview. Reading leaves the UI thread: a video on a
/// slow disk must not freeze the window while the chunk is on its way.
pub fn serve<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let response = match file_response(&request) {
            Ok(response) => response,
            // A refusal here is invisible on screen — the `<img>` just fails and
            // the UI swaps in the "open in the default app" card. When that card
            // shows up for a file that plainly exists, the log is the only place
            // that says *why*, so this is a warning and not a debug line.
            Err((status, reason)) => {
                tracing::warn!(%status, reason, uri = %request.uri(), "yardfile recusado");
                plain(status, &reason)
            }
        };
        responder.respond(response);
    });
}

fn file_response(request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, (StatusCode, String)> {
    let refuse = |status: StatusCode, reason: &str| (status, reason.to_string());

    let query = request.uri().query().unwrap_or("");
    let root = query_param(query, "root")
        .ok_or_else(|| refuse(StatusCode::BAD_REQUEST, "faltou a raiz do projeto"))?;
    let rel = query_param(query, "path")
        .ok_or_else(|| refuse(StatusCode::BAD_REQUEST, "faltou o caminho"))?;

    let root = Path::new(&root);
    if !explorer::root_allowed(root) {
        return Err(refuse(StatusCode::FORBIDDEN, "essa raiz não é do app"));
    }
    let path = explorer::resolve(root, &rel).map_err(|e| (StatusCode::FORBIDDEN, e))?;

    let mut file =
        std::fs::File::open(&path).map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let len = file
        .metadata()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .len();

    let mut res = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        // The file lives on disk and changes underneath us — an agent rewrites
        // the screenshot while it is open. Whoever asks again has to get the
        // current one, not the one from ten minutes ago.
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_TYPE,
            explorer::media_mime(&path).unwrap_or("application/octet-stream"),
        );

    if let Some(requested) = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
        let Some((start, end)) = parse_range(requested, len) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
        };
        let count = end - start + 1;
        let mut buf = Vec::with_capacity(count as usize);
        file.seek(SeekFrom::Start(start))
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        file.take(count)
            .read_to_end(&mut buf)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        res = res
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, buf.len());
        return res
            .body(buf)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }

    if len > MAX_FULL {
        return Err(refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "arquivo grande demais para mostrar aqui",
        ));
    }
    let mut buf = Vec::with_capacity(len as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    res.header(header::CONTENT_LENGTH, buf.len())
        .body(buf)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(text.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The value of `key=` in a query, already unescaped.
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|item| {
        let (k, v) = item.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// `%2F` → `/`. That is all: the front end builds the query with
/// `encodeURIComponent`, which never writes `+` for a space — decoding `+` here
/// would mangle the name of every file that has one.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// The chunk to return, given a `Range` header and the file size.
///
/// It understands the three forms that matter — `bytes=0-`, `bytes=100-199` and
/// `bytes=-500` (the last N) — and returns **inclusive** bounds, already clipped
/// to `MAX_CHUNK`. `None` = impossible request, which becomes a 416.
///
/// Of several ranges in one request only the first is served: no player uses
/// them, and a `multipart/byteranges` response is a lot of complexity for nobody.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = value.trim().strip_prefix("bytes=")?;
    let (from, to) = spec.split(',').next()?.trim().split_once('-')?;
    let (start, end) = if from.is_empty() {
        let last_n: u64 = to.trim().parse().ok()?;
        if last_n == 0 {
            return None;
        }
        (len.saturating_sub(last_n), len - 1)
    } else {
        let start: u64 = from.trim().parse().ok()?;
        let end = if to.trim().is_empty() {
            len - 1
        } else {
            to.trim().parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    if start >= len || end < start {
        return None;
    }
    Some((start, end.min(start + MAX_CHUNK - 1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_query() {
        let q = "root=C%3A%2FWorkspace%2Fc%C3%B3digo&path=public%2Fassets%2Fmama%C3%A3e%20e%2Bfilho.png&v=7";
        assert_eq!(query_param(q, "root").unwrap(), "C:/Workspace/código");
        assert_eq!(
            query_param(q, "path").unwrap(),
            "public/assets/mamaãe e+filho.png"
        );
        assert_eq!(query_param(q, "nada"), None);
        // A lone `%` is not an escape and survives as a character.
        assert_eq!(percent_decode("100%25 %zz"), "100% %zz");
    }

    #[test]
    fn cuts_the_range_into_chunks() {
        let len = 10 * 1024 * 1024;
        // A `<video>`'s first request: from zero to the end, clipped to the cap.
        assert_eq!(parse_range("bytes=0-", len), Some((0, MAX_CHUNK - 1)));
        // A closed range within the cap comes out whole.
        assert_eq!(parse_range("bytes=100-199", len), Some((100, 199)));
        // Suffix: the last bytes (this is how an .mp4's index is read).
        assert_eq!(parse_range("bytes=-500", len), Some((len - 500, len - 1)));
        // An end past the file is trimmed, not refused.
        assert_eq!(
            parse_range("bytes=0-99999999999", len),
            Some((0, MAX_CHUNK - 1))
        );
    }

    #[test]
    fn refuses_an_impossible_range() {
        assert_eq!(parse_range("bytes=500-", 100), None);
        assert_eq!(parse_range("bytes=80-20", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-", 100), None);
        assert_eq!(parse_range("bytes=abc-", 100), None);
    }

    /// Escapes anything that is not a letter or a digit — enough for a Windows
    /// path (`C:\proj`) to become a query the URI parser accepts. This is what
    /// the front end's `encodeURIComponent` does.
    fn escape(text: &str) -> String {
        text
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                    (b as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect()
    }

    fn req_for(root: &Path, rel: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let uri = format!(
            "yardfile://localhost/?root={}&path={}",
            escape(&root.to_string_lossy()),
            escape(rel)
        );
        let mut req = Request::builder().uri(uri);
        if let Some(r) = range {
            req = req.header(header::RANGE, r);
        }
        req.body(Vec::new()).unwrap()
    }

    /// The whole path: the fence, the right bytes and the right chunk.
    #[test]
    fn serves_the_file_in_chunks_and_only_from_a_known_root() {
        let root = std::env::temp_dir().join(format!(
            "yard-media-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let bytes: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        std::fs::write(root.join("clipe.mp4"), &bytes).unwrap();

        // Before the app opens that folder, it does not exist for the protocol.
        let err = file_response(&req_for(&root, "clipe.mp4", None)).unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);

        // Opening the file through the normal path is what registers the root.
        crate::explorer::read_text(&root, "clipe.mp4").unwrap();

        let whole = file_response(&req_for(&root, "clipe.mp4", None)).unwrap();
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(whole.body(), &bytes);

        let partial = file_response(&req_for(&root, "clipe.mp4", Some("bytes=1000-1099"))).unwrap();
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            partial.headers()[header::CONTENT_RANGE],
            "bytes 1000-1099/5000"
        );
        assert_eq!(partial.body(), &bytes[1000..=1099]);

        // The root fence still holds inside a known root.
        let fuga = file_response(&req_for(&root, "../fora.txt", None)).unwrap_err();
        assert_eq!(fuga.0, StatusCode::FORBIDDEN);

        let _ = std::fs::remove_dir_all(&root);
    }
}
