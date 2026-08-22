//! The project's file explorer — the disk side of the "Files" tab (the tree in
//! the right-hand panel) and of the code editor.
//!
//! Decisions:
//! - **Every path crossing the IPC is relative to the root, with `/`** — the
//!   same convention the watcher (`files.rs`) and git already use, so the
//!   tree, the feed and `git status` talk about the same file without anyone
//!   normalizing anything. The root comes from the front end (the active
//!   floor's worktree, when there is one).
//! - **Nothing outside the root.** Each command resolves the relative path
//!   against the root and refuses `..`, an absolute anchor and any link that
//!   escapes — including after following symlinks/junctions, by comparing the
//!   canonical path.
//! - **Reading is cheap, writing is dangerous.** The write compares the mtime
//!   the editor saw with the one on disk: an agent that touched the file while
//!   it was open becomes an explicit conflict, never a silent overwrite.
//! - Line endings are preserved: we always read as `\n` (that is all the
//!   editor understands) and write back as CRLF if that is how the file was —
//!   otherwise the first save in a Windows repo would become a whole-file diff.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use parking_lot::Mutex;
use serde::Serialize;

/// Read cap for a file in the editor. Past it the file opens truncated and
/// read-only — saving would cut off the rest.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// How many bytes from the start decide whether the file is binary.
const SNIFF_BYTES: usize = 8 * 1024;
/// Cap on entries in a folder. Past it the rest is not listed (a folder with
/// 50 thousand files freezes the tree and helps nobody).
const MAX_ENTRIES: usize = 4000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    /// Relative to the root, with `/`.
    pub path: String,
    pub dir: bool,
    pub size: u64,
    /// Epoch ms; `0` when the filesystem does not report it.
    pub modified_at: i64,
    pub symlink: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntryInfo>,
    /// Entries past the cap — counted only.
    pub dropped: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub text: String,
    /// No text to show (image, executable, .pdf…).
    pub binary: bool,
    /// Past the read cap: the editor opens read-only.
    pub truncated: bool,
    /// The bytes are **not** valid UTF-8 (a legacy cp1252/latin-1 file, say),
    /// so `text` went through `from_utf8_lossy` and every byte we could not
    /// decode is now U+FFFD. Writing that back would destroy the original
    /// content — the editor opens read-only, like `truncated`.
    pub lossy: bool,
    pub size: u64,
    pub modified_at: i64,
    /// The file on disk uses CRLF — saving writes it back the way it was.
    pub crlf: bool,
    /// The file on disk starts with a UTF-8 BOM. Same contract as `crlf`: the
    /// buffer never carries it (no editor shows the BOM as a character at the
    /// start of the first line) and the save puts it back. Without this field
    /// the save *deleted* it, which on Windows changes how PowerShell decodes
    /// the script.
    pub bom: bool,
    /// MIME type, when the webview knows how to draw the file (`image/png`,
    /// `video/mp4`, `application/pdf`…). It is what makes the editor show the
    /// image instead of announcing there is no text; `None` = no face of its own.
    pub media: Option<&'static str>,
}

// ---------------------------------------------------------------------------
// path resolution (the fence)
// ---------------------------------------------------------------------------
//
// Besides `resolve` (which pins a path inside a root), this section keeps track
// of **which roots exist**. The IPC commands get the root from the front end on
// every call and that is enough for them: the caller is already our own code.
// The `yardfile` protocol (media.rs) has no such guarantee — a URL lives inside
// an `<img>`, and markdown written by an agent is third-party text. Hence the
// list: only a root the app actually opened this session is ever served.

/// Roots the app has read (project, floor). Short by nature — a dozen projects
/// opened in the same day is a lot — and capped anyway.
static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
const MAX_ROOTS: usize = 64;

/// Registers a root the app is working in, for callers outside this module
/// (`git::file_diff` reviews a worktree the file tree may never have listed).
pub fn remember(root: &Path) {
    remember_root(root);
}

/// Notes that this root is the app's. Called by whoever reads disk for the front end.
fn remember_root(root: &Path) {
    let Ok(real) = root.canonicalize() else {
        return;
    };
    let mut roots = ROOTS.lock();
    if roots.contains(&real) {
        return;
    }
    if roots.len() >= MAX_ROOTS {
        roots.remove(0);
    }
    roots.push(real);
}

/// Is this root one the app opened? (the question the protocol asks)
pub fn root_allowed(root: &Path) -> bool {
    let Ok(real) = root.canonicalize() else {
        return false;
    };
    ROOTS.lock().contains(&real)
}

/// Does this **file** sit under a root the app opened, or in the temp folder?
///
/// The other question the same list can answer, and the one `git::file_diff`
/// needs. That command is allowed to show a file outside the repository on
/// purpose — the live overlay lists what an agent touched, and part of that
/// is a screenshot in `%TEMP%` or the agent's own memory. But the path it is
/// handed comes from the agent's session log, which is text the agent writes,
/// so "outside the repository" cannot mean "anywhere on the disk".
///
/// The question is *where* the path is, not whether it exists — a screenshot
/// the agent already deleted must still produce "não consegui ler", not
/// "fora de qualquer projeto". So, like `resolve`, this validates the nearest
/// existing ancestor. Fails closed when even that cannot be canonicalized.
pub fn path_allowed(path: &Path) -> bool {
    let mut anchor = path;
    while !anchor.exists() {
        match anchor.parent() {
            Some(p) => anchor = p,
            None => return false,
        }
    }
    let Ok(real) = anchor.canonicalize() else {
        return false;
    };
    if let Ok(tmp) = std::env::temp_dir().canonicalize() {
        if real.starts_with(&tmp) {
            return true;
        }
    }
    ROOTS.lock().iter().any(|r| real.starts_with(r))
}

/// Joins `rel` (relative, with `/` or `\`) to the root, refusing anything that
/// tries to escape it. `""` and `"."` mean the root itself.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("raiz do projeto inválida".into());
    }
    let mut out = root.to_path_buf();
    for part in rel.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("caminho fora da pasta do projeto".into());
        }
        // `C:`, `\\server`, `name:stream` (NTFS ADS) — none is an ordinary file
        // name, and all of them escape a naive `join`.
        if part.contains(':') {
            return Err("caminho fora da pasta do projeto".into());
        }
        out.push(part);
    }

    // The `join` above already blocks the textual path; disk is what is left: a
    // symlink (or a Windows junction) pointing outside only shows up in the
    // canonical form. When the target does not exist yet, we validate the
    // nearest existing ancestor. A canonicalization error fails closed.
    let root_real = root
        .canonicalize()
        .map_err(|e| format!("não consegui validar a raiz do projeto: {e}"))?;
    let mut anchor = out.as_path();
    while !anchor.exists() {
        anchor = anchor
            .parent()
            .ok_or_else(|| "caminho fora da pasta do projeto".to_string())?;
    }
    let anchor_real = anchor
        .canonicalize()
        .map_err(|e| format!("não consegui validar o caminho: {e}"))?;
    if !anchor_real.starts_with(&root_real) {
        return Err("caminho fora da pasta do projeto".into());
    }
    Ok(out)
}

/// Path relative to the root, with `/` — the shape the front end gets back.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/// One level of the tree: folders first, then files, each block in
/// case-insensitive alphabetical order (the order Explorer and VS Code use).
pub fn list_dir(root: &Path, rel: &str) -> Result<DirListing, String> {
    let dir = resolve(root, rel)?;
    let reader = std::fs::read_dir(&dir).map_err(|e| format!("não consegui ler a pasta: {e}"))?;
    remember_root(root);

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut dropped = 0usize;
    for item in reader {
        let Ok(item) = item else { continue };
        if entries.len() >= MAX_ENTRIES {
            dropped += 1;
            continue;
        }
        let path = item.path();
        // `symlink_metadata` does not follow the link: a broken link still shows
        // up in the tree instead of vanishing with no explanation.
        let Ok(link_meta) = item
            .metadata()
            .or_else(|_| std::fs::symlink_metadata(&path))
        else {
            continue;
        };
        let symlink = std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        entries.push(DirEntryInfo {
            name: item.file_name().to_string_lossy().into_owned(),
            path: relative(root, &path),
            dir: link_meta.is_dir(),
            size: if link_meta.is_dir() {
                0
            } else {
                link_meta.len()
            },
            modified_at: modified_ms(&link_meta),
            symlink,
        });
    }

    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(DirListing {
        path: rel.replace('\\', "/"),
        entries,
        dropped,
    })
}

/// A file's contents as text, already normalized to `\n`.
pub fn read_text(root: &Path, rel: &str) -> Result<TextFile, String> {
    let path = resolve(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("não consegui abrir: {e}"))?;
    if meta.is_dir() {
        return Err("isso é uma pasta".into());
    }
    remember_root(root);

    let media = media_mime(&path);
    // An 800 MB `.mp4` does not need to be read to know it has no text: without
    // this shortcut, opening a video cost 2 MB of disk just to find a zero byte
    // and conclude the obvious. The viewer gets the bytes over the protocol
    // (media.rs), which serves chunks instead of the whole file.
    if known_binary(&path) {
        return Ok(TextFile {
            path: rel.replace('\\', "/"),
            text: String::new(),
            binary: true,
            truncated: false,
            lossy: false,
            size: meta.len(),
            modified_at: modified_ms(&meta),
            crlf: false,
            bom: false,
            media,
        });
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("não consegui abrir: {e}"))?;
    let mut buf = Vec::with_capacity((meta.len() as usize).min(MAX_TEXT_BYTES) + 1);
    file.by_ref()
        .take((MAX_TEXT_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("falha na leitura: {e}"))?;

    let truncated = buf.len() > MAX_TEXT_BYTES;
    if truncated {
        buf.truncate(MAX_TEXT_BYTES);
    }

    // A zero byte near the start = binary. It is git's own heuristic, and it
    // rarely misses: real text almost never contains NUL.
    let binary = buf.iter().take(SNIFF_BYTES).any(|b| *b == 0);
    if binary {
        return Ok(TextFile {
            path: rel.replace('\\', "/"),
            text: String::new(),
            binary: true,
            truncated,
            lossy: false,
            size: meta.len(),
            modified_at: modified_ms(&meta),
            crlf: false,
            bom: false,
            media,
        });
    }

    // Not valid UTF-8 and no zero byte: a legacy file in cp1252/latin-1, which
    // is text a person can read and the sniff above happily calls editable.
    // `from_utf8_lossy` turns every undecodable byte into U+FFFD, so saving the
    // buffer back would replace each accented character with `EF BF BD` —
    // silently, across the whole file, including the lines nobody touched.
    // Flagging it here is what makes the editor open it read-only.
    //
    // A truncated read is not evidence: the cut can land in the middle of a
    // perfectly valid multibyte character, and the last one is all it takes.
    let lossy = match std::str::from_utf8(&buf) {
        Ok(_) => false,
        Err(e) => !truncated || e.valid_up_to() + 4 < buf.len(),
    };

    let raw = String::from_utf8_lossy(&buf).into_owned();
    // The BOM is dropped on read and restored on write (`bom`, below) — no
    // editor shows the BOM as a character at the start of the first line.
    let bom = raw.starts_with('\u{feff}');
    let raw = raw
        .strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(raw);
    let crlf = raw.contains("\r\n");
    let text = if crlf { raw.replace("\r\n", "\n") } else { raw };

    Ok(TextFile {
        path: rel.replace('\\', "/"),
        text,
        binary: false,
        truncated,
        lossy,
        size: meta.len(),
        modified_at: modified_ms(&meta),
        crlf,
        bom,
        media,
    })
}

/// Extension in lowercase, without the dot.
fn ext_of(path: &Path) -> Option<String> {
    Some(path.extension()?.to_string_lossy().to_lowercase())
}

/// An image's MIME type from its extension. `None` = not an image the webview
/// knows how to draw, and the preview shows the path instead of trying.
fn image_mime(path: &Path) -> Option<&'static str> {
    Some(match ext_of(path)?.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// MIME type of what the webview draws on its own: image, video, audio and PDF.
///
/// This is the list that decides a file's face in the editor. Worth noting what
/// it does **not** promise: `video/x-matroska` and `video/quicktime` are here
/// because a `.mkv`/`.mov` is video and deserves to be treated as such, but the
/// codec inside may not play in WebView2 — the UI handles that, falling back to
/// the "open in default app" card when the element fails.
pub fn media_mime(path: &Path) -> Option<&'static str> {
    if let Some(mime) = image_mime(path) {
        return Some(mime);
    }
    Some(match ext_of(path)?.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// Files we already know have no text to edit, by extension.
///
/// It keeps us from reading 2 MB of a video for nothing (`read_text`) and lets
/// the editor open straight into the right face. `svg` is deliberately **out**:
/// it is image and text at once, and stays editable — the UI shows both sides.
fn known_binary(path: &Path) -> bool {
    let Some(ext) = ext_of(path) else {
        return false;
    };
    matches!(
        ext.as_str(),
        // image
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "tif" | "tiff"
            | "heic" | "psd" | "ai"
        // video and audio
            | "mp4" | "m4v" | "webm" | "ogv" | "mov" | "mkv" | "avi" | "wmv" | "flv"
            | "mp3" | "wav" | "m4a" | "aac" | "ogg" | "oga" | "opus" | "flac" | "wma"
        // document and archive
            | "pdf" | "zip" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "tar" | "jar"
            | "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" | "odt" | "ods"
        // program binary
            | "exe" | "dll" | "so" | "dylib" | "pdb" | "obj" | "lib" | "bin" | "class"
            | "wasm" | "node" | "msi" | "iso" | "dmg"
        // font, database, cache
            | "ttf" | "otf" | "woff" | "woff2" | "eot" | "db" | "sqlite" | "sqlite3"
            | "pack" | "idx"
    )
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/// What the editor saw on disk the last time it read (or wrote) the file.
/// Both halves matter — see `write_text`.
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub modified_at: i64,
    pub size: u64,
}

/// State of the file after a write — what the open document adopts so the
/// **next** save compares against the right thing.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub modified_at: i64,
    pub size: u64,
}

/// Writes the file and returns its new stamp.
///
/// `seen` is what the editor had when it opened the file: if disk moved,
/// someone (an agent, another editor) touched it in the meantime and the write
/// stops here.
///
/// Both the timestamp **and the size** are compared. The mtime alone carries a
/// one-second tolerance — FAT and network shares round it, and a false conflict
/// is worse than the remote chance of two writes inside the same second — but
/// in this app that window is not remote at all: the agents rewrite the same
/// files the user has open, all the time. The size closes it for any edit that
/// changes the file's length, which is nearly all of them, at the cost of the
/// `metadata` call we were already making.
pub fn write_text(
    root: &Path,
    rel: &str,
    text: &str,
    seen: Option<Seen>,
    crlf: bool,
    bom: bool,
) -> Result<WriteResult, String> {
    let path = resolve(root, rel)?;
    if path.is_dir() {
        return Err("isso é uma pasta".into());
    }

    if let Some(expected) = seen {
        if let Ok(meta) = std::fs::metadata(&path) {
            let current = modified_ms(&meta);
            let clock_moved = current != 0 && (current - expected.modified_at).abs() > 1000;
            let size_changed = meta.len() != expected.size;
            if clock_moved || size_changed {
                return Err("CONFLITO: o arquivo mudou no disco desde que você o abriu".into());
            }
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("não consegui criar a pasta: {e}"))?;
    }

    let mut payload = if crlf {
        // Normalize before expanding: text that already arrived with CRLF
        // (pasted from a browser, say) must not turn into `\r\r\n`.
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_owned()
    };
    // The BOM goes back exactly where the read took it from — and only when it
    // was there, so a file that never had one does not gain one.
    if bom && !payload.starts_with('\u{feff}') {
        payload.insert(0, '\u{feff}');
    }
    std::fs::write(&path, payload.as_bytes()).map_err(|e| format!("falha ao gravar: {e}"))?;

    let meta =
        std::fs::metadata(&path).map_err(|e| format!("gravou, mas não consegui reler: {e}"))?;
    Ok(WriteResult {
        modified_at: modified_ms(&meta),
        size: meta.len(),
    })
}

/// Creates an empty file or a folder. Intermediate folders come for free:
/// typing `src/lib/novo.ts` in the tree creates the whole path.
pub fn create_entry(root: &Path, rel: &str, dir: bool) -> Result<(), String> {
    let path = resolve(root, rel)?;
    if path.exists() {
        return Err("já existe um item com esse nome".into());
    }
    if dir {
        std::fs::create_dir_all(&path).map_err(|e| format!("não consegui criar a pasta: {e}"))
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("não consegui criar a pasta: {e}"))?;
        }
        std::fs::File::create(&path)
            .map(|_| ())
            .map_err(|e| format!("não consegui criar o arquivo: {e}"))
    }
}

/// Rename and move are the same operation — the new path is relative to the root.
pub fn rename_entry(root: &Path, rel: &str, new_rel: &str) -> Result<(), String> {
    let from = resolve(root, rel)?;
    let to = resolve(root, new_rel)?;
    if !from.exists() {
        return Err("o item não existe mais".into());
    }
    // On Windows `rename` overwrites an existing file without warning.
    if to.exists() && !same_path(&from, &to) {
        return Err("já existe um item com esse nome".into());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("não consegui criar a pasta: {e}"))?;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("não consegui renomear: {e}"))
}

/// A case-only change to the same name (`Foo.ts` → `foo.ts`): on Windows both
/// paths point at the same file, and refusing would be wrong.
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        p.components()
            .map(|c| match c {
                Component::Normal(s) => s.to_string_lossy().to_lowercase(),
                other => other.as_os_str().to_string_lossy().to_lowercase(),
            })
            .collect::<Vec<_>>()
    };
    norm(a) == norm(b)
}

pub fn delete_entry(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    // Deleting the project root through an empty `rel` would be catastrophic.
    if path == root {
        return Err("não dá para apagar a raiz do projeto".into());
    }
    let meta =
        std::fs::symlink_metadata(&path).map_err(|e| format!("o item não existe mais: {e}"))?;

    // A link is deleted as a link: we never follow through to the target
    // (deleting a symlink must not take the folder on the other side with it).
    // `symlink_metadata` reports `is_dir() == false` for any link, so without
    // this branch a folder link/junction fell into `remove_file` — which Windows
    // refuses, leaving the tree with an item impossible to delete.
    if meta.file_type().is_symlink() {
        #[cfg(windows)]
        {
            // On Windows the verb depends on what the link points at, and a
            // broken link gives no way to tell: try both.
            return std::fs::remove_file(&path)
                .or_else(|_| std::fs::remove_dir(&path))
                .map_err(|e| format!("não consegui apagar o link: {e}"));
        }
        #[cfg(not(windows))]
        {
            return std::fs::remove_file(&path)
                .map_err(|e| format!("não consegui apagar o link: {e}"));
        }
    }

    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("não consegui apagar a pasta: {e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("não consegui apagar: {e}"))
    }
}

// ---------------------------------------------------------------------------
// project-wide search and the quick-open index
// ---------------------------------------------------------------------------
//
// The tree above is lazy on purpose — it reads a folder when it opens. These
// two walk the whole project instead, because their questions are about the
// whole project: "where is this text" (Ctrl+Shift+F) and "open this file
// by name" (Ctrl+P). Both skip the folders no answer ever lives in
// (dependencies, build output, `.git`) and stop at caps, telling the front end
// when they did — a truncated result that says nothing reads as a complete one.

/// Folders no search answer lives in: dependencies and build output. A fixed
/// list rather than `.gitignore` — parsing ignore files across nested repos is
/// a project of its own, and this covers what actually burns the walk.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".turbo",
    ".gradle",
    ".idea",
    ".vs",
    "obj",
    "vendor",
    "Pods",
    ".dart_tool",
    "coverage",
];

/// Files bigger than this are skipped by the content search — a minified
/// bundle matches everything and answers nothing.
const MAX_SEARCH_FILE_BYTES: u64 = 1_500_000;
/// Total content-search caps: hits overall, hits in one file, files visited.
const MAX_SEARCH_HITS: usize = 800;
const MAX_HITS_PER_FILE: usize = 100;
const MAX_SEARCH_FILES: usize = 40_000;
/// The stored line is for the result row, not for reading the file there.
const MAX_HIT_LINE_CHARS: usize = 240;
/// Quick-open index cap. Past this Ctrl+P still works for everything indexed;
/// `truncated` tells the UI to say the list is not the whole repo.
const MAX_INDEX_FILES: usize = 30_000;
/// Deep enough for any real repo; a cycle of junctions is not one.
const MAX_WALK_DEPTH: usize = 32;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Relative to the root, with `/`.
    pub path: String,
    /// 1-based.
    pub line: u32,
    /// The line's text, trimmed to a sane width.
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    pub files_scanned: usize,
    pub files_hit: usize,
    /// Stopped at a cap — the project has more than what is here.
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndex {
    /// Every file under the root (skip list applied), relative, with `/`.
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Walks every file under the root, depth-first, folders in alphabetical
/// order — the same order the tree shows. `visit` returns `false` to stop the
/// whole walk (a cap was hit). Returns whether the walk ran to the end.
fn walk_files(root: &Path, visit: &mut dyn FnMut(&Path, u64) -> bool) -> bool {
    fn recurse(dir: &Path, depth: usize, visit: &mut dyn FnMut(&Path, u64) -> bool) -> bool {
        if depth > MAX_WALK_DEPTH {
            return true;
        }
        let Ok(reader) = std::fs::read_dir(dir) else {
            // A folder we cannot read is not a reason to stop the project walk.
            return true;
        };
        let mut files: Vec<(PathBuf, u64)> = Vec::new();
        let mut dirs: Vec<PathBuf> = Vec::new();
        for item in reader.flatten() {
            let path = item.path();
            // `symlink_metadata`: never follow links — a junction pointing at
            // the parent turns the walk into a loop, and one pointing outside
            // the root would leak files `resolve` was built to fence off.
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let name = item.file_name().to_string_lossy().to_lowercase();
                if SKIP_DIRS.iter().any(|s| *s == name) {
                    continue;
                }
                dirs.push(path);
            } else {
                files.push((path, meta.len()));
            }
        }
        let fold = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_lowercase());
        files.sort_by_key(|(p, _)| fold(p));
        dirs.sort_by_key(fold);
        for (path, size) in files {
            if !visit(&path, size) {
                return false;
            }
        }
        for sub in dirs {
            if !recurse(&sub, depth + 1, visit) {
                return false;
            }
        }
        true
    }
    recurse(root, 0, visit)
}

/// Is the byte before/after a match part of a word? (the whole-word test)
fn wordish(b: Option<u8>) -> bool {
    matches!(b, Some(c) if c.is_ascii_alphanumeric() || c == b'_')
}

/// Does `hay` contain `needle` (already case-folded together), respecting the
/// whole-word option?
fn line_matches(hay: &str, needle: &str, whole_word: bool) -> bool {
    let mut from = 0;
    while let Some(at) = hay[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        if !whole_word
            || (!wordish(
                hay.as_bytes()
                    .get(start.wrapping_sub(1))
                    .copied()
                    .filter(|_| start > 0),
            ) && !wordish(hay.as_bytes().get(end).copied()))
        {
            return true;
        }
        from = start + 1;
        if from >= hay.len() {
            break;
        }
    }
    false
}

/// The result row shows the line, not the file: cap it at a width a panel can
/// draw, on a char boundary.
fn hit_line(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.chars().count() <= MAX_HIT_LINE_CHARS {
        return trimmed.to_owned();
    }
    trimmed.chars().take(MAX_HIT_LINE_CHARS).collect::<String>() + "…"
}

/// Literal text search across the project (Ctrl+Shift+F). Case-insensitive by
/// default, optional whole-word — the same defaults VS Code opens with.
pub fn search_text(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<SearchOutcome, String> {
    search_text_cancellable(root, query, case_sensitive, whole_word, || false)
}

/// Search variant used by the IPC command. The callback is cheap and checked
/// between files (and periodically inside a large file), so replacing a query
/// releases the blocking worker instead of merely ignoring its eventual UI result.
pub fn search_text_cancellable(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    mut cancelled: impl FnMut() -> bool,
) -> Result<SearchOutcome, String> {
    if !root.is_dir() {
        return Err("raiz do projeto inválida".into());
    }
    let needle_raw = query.trim_end_matches('\n');
    if needle_raw.is_empty() {
        return Err("nada para buscar".into());
    }
    remember_root(root);

    let needle = if case_sensitive {
        needle_raw.to_owned()
    } else {
        needle_raw.to_lowercase()
    };

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut files_scanned = 0usize;
    let mut files_hit = 0usize;
    let mut truncated = false;
    let mut stopped = false;

    let finished = walk_files(root, &mut |path, size| {
        if cancelled() {
            stopped = true;
            return false;
        }
        if files_scanned >= MAX_SEARCH_FILES || hits.len() >= MAX_SEARCH_HITS {
            truncated = true;
            return false;
        }
        if size > MAX_SEARCH_FILE_BYTES || known_binary(path) {
            return true;
        }
        files_scanned += 1;
        let Ok(bytes) = std::fs::read(path) else {
            return true;
        };
        // git's own binary heuristic: a NUL near the start means "not text".
        if bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
            return true;
        }
        let text = String::from_utf8_lossy(&bytes);
        let rel = relative(root, path);
        let mut in_file = 0usize;
        for (i, line) in text.lines().enumerate() {
            if i & 0xff == 0 && cancelled() {
                stopped = true;
                return false;
            }
            let matched = if case_sensitive {
                line_matches(line, &needle, whole_word)
            } else {
                line_matches(&line.to_lowercase(), &needle, whole_word)
            };
            if !matched {
                continue;
            }
            if in_file == 0 {
                files_hit += 1;
            }
            in_file += 1;
            hits.push(SearchHit {
                path: rel.clone(),
                line: (i + 1) as u32,
                text: hit_line(line),
            });
            if in_file >= MAX_HITS_PER_FILE || hits.len() >= MAX_SEARCH_HITS {
                truncated = true;
                break;
            }
        }
        hits.len() < MAX_SEARCH_HITS
    });

    if stopped || cancelled() {
        return Err("busca cancelada".into());
    }

    Ok(SearchOutcome {
        hits,
        files_scanned,
        files_hit,
        truncated: truncated || !finished,
    })
}

/// Every file path under the root — what makes Ctrl+P able to open a file
/// nobody has browsed to yet.
pub fn index_files(root: &Path) -> Result<FileIndex, String> {
    if !root.is_dir() {
        return Err("raiz do projeto inválida".into());
    }
    remember_root(root);
    let mut paths: Vec<String> = Vec::new();
    let mut truncated = false;
    walk_files(root, &mut |path, _size| {
        if paths.len() >= MAX_INDEX_FILES {
            truncated = true;
            return false;
        }
        paths.push(relative(root, path));
        true
    });
    Ok(FileIndex { paths, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway folder for the tests — no tmp crate in the project.
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yard-explorer-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test folder");
        dir.canonicalize().expect("canonicalize")
    }

    #[test]
    fn refuses_to_leave_the_root() {
        let root = temp_root("cerca");
        assert!(resolve(&root, "../segredo.txt").is_err());
        assert!(resolve(&root, "src/../../fora.txt").is_err());
        assert!(resolve(&root, "C:/Windows/System32").is_err());
        assert!(resolve(&root, "arquivo.txt:fluxo").is_err());
        assert_eq!(resolve(&root, "").unwrap(), root);
        assert_eq!(
            resolve(&root, "./src/a.rs").unwrap(),
            root.join("src").join("a.rs")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_missing_target_below_an_external_link() {
        let root = temp_root("link-root");
        let outside = temp_root("link-outside");
        let link = root.join("atalho");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, &link);
        if linked.is_err() {
            // Windows without Developer Mode can deny symlinks to the test process.
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        assert!(resolve(&root, "atalho/nova/pasta/arquivo.txt").is_err());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn lists_folders_before_files() {
        let root = temp_root("lista");
        std::fs::create_dir_all(root.join("Zeta")).unwrap();
        std::fs::create_dir_all(root.join("alpha")).unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        std::fs::write(root.join("A.txt"), "a").unwrap();

        let listing = list_dir(&root, "").unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zeta", "A.txt", "b.txt"]);
        assert!(listing.entries[0].dir);
        assert!(!listing.entries[3].dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The regression this locks: the BOM was dropped on read (right — no
    /// editor shows it as a character) and never written back, so saving a
    /// `.ps1`/`.csproj`/`.bat` from the tree silently shortened the file by
    /// three bytes. On Windows that flips how PowerShell 5.1 decodes the
    /// script, and the editor's own git gutter also strips the BOM from HEAD —
    /// so nothing in the app showed the change.
    #[test]
    fn preserves_the_bom_across_a_read_write_cycle() {
        let root = temp_root("bom");
        let raw_original = "\u{feff}Write-Host 'olá'\r\n".as_bytes().to_vec();
        std::fs::write(root.join("script.ps1"), &raw_original).unwrap();

        let read = read_text(&root, "script.ps1").unwrap();
        // The buffer never carries the BOM — that part was already right.
        assert_eq!(read.text, "Write-Host 'olá'\n");
        assert!(read.bom, "the read has to report that the file had a BOM");

        write_text(
            &root,
            "script.ps1",
            &read.text,
            Some(seen(&read)),
            read.crlf,
            read.bom,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(root.join("script.ps1")).unwrap(),
            raw_original,
            "writing the same text back must not change a single byte of the file"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The other half: a file without a BOM must not gain one.
    #[test]
    fn a_file_without_a_bom_does_not_gain_one_on_write() {
        let root = temp_root("sem-bom");
        std::fs::write(root.join("a.txt"), b"puro\n").unwrap();

        let read = read_text(&root, "a.txt").unwrap();
        assert!(!read.bom);
        write_text(&root, "a.txt", "puro\n", Some(seen(&read)), read.crlf, read.bom).unwrap();

        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"puro\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn preserves_crlf_across_a_read_write_cycle() {
        let root = temp_root("crlf");
        std::fs::write(root.join("win.txt"), b"um\r\ndois\r\n").unwrap();

        let read = read_text(&root, "win.txt").unwrap();
        assert_eq!(read.text, "um\ndois\n");
        assert!(read.crlf);

        write_text(
            &root,
            "win.txt",
            "um\ndois\ntres\n",
            Some(seen(&read)),
            read.crlf,
            read.bom,
        )
        .unwrap();
        let raw = std::fs::read(root.join("win.txt")).unwrap();
        assert_eq!(raw, b"um\r\ndois\r\ntres\r\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What the editor is holding after a read — the pair every save compares.
    fn seen(f: &TextFile) -> Seen {
        Seen {
            modified_at: f.modified_at,
            size: f.size,
        }
    }

    #[test]
    fn the_write_stops_when_the_disk_changed() {
        let root = temp_root("conflito");
        std::fs::write(root.join("a.txt"), "original").unwrap();
        let read = read_text(&root, "a.txt").unwrap();

        // Someone (an agent) rewrites the file with a different timestamp.
        let err = write_text(
            &root,
            "a.txt",
            "meu texto",
            Some(Seen {
                modified_at: read.modified_at - 5000,
                size: read.size,
            }),
            false,
            false,
        )
        .unwrap_err();
        assert!(err.starts_with("CONFLITO"));
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "original"
        );

        // With the right stamp, it writes.
        write_text(&root, "a.txt", "meu texto", Some(seen(&read)), false, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "meu texto"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The tolerance the mtime carries (FAT and network shares round it) used
    /// to be the whole check, and in this app that second is not remote at
    /// all: the agents rewrite the very files the user has open. A different
    /// length is a conflict however close the clocks are.
    #[test]
    fn a_different_size_is_a_conflict_even_within_the_same_second() {
        let root = temp_root("conflito-tamanho");
        std::fs::write(root.join("a.txt"), "original").unwrap();
        let read = read_text(&root, "a.txt").unwrap();

        // The agent rewrites the file right now — same second, different size.
        std::fs::write(root.join("a.txt"), "o agente escreveu bem mais que isso").unwrap();
        let err = write_text(&root, "a.txt", "meu texto", Some(seen(&read)), false, false).unwrap_err();
        assert!(err.starts_with("CONFLITO"), "error was: {err}");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "o agente escreveu bem mais que isso"
        );

        // And `None` still means "write over it, the user decided".
        let written = write_text(&root, "a.txt", "meu texto", None, false, false).unwrap();
        assert_eq!(written.size, "meu texto".len() as u64);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A legacy cp1252 file has no zero byte, so the binary sniff lets it
    /// through as text — and `from_utf8_lossy` has already replaced every
    /// accented byte by then. Saving that buffer used to overwrite the file
    /// with `EF BF BD`; `lossy` is what stops the editor from offering to.
    #[test]
    fn text_outside_utf8_comes_flagged() {
        let root = temp_root("lossy");
        // "coração\nseção\n" in Windows-1252.
        std::fs::write(root.join("legado.txt"), b"cora\xe7\xe3o\nse\xe7\xe3o\n").unwrap();

        let read = read_text(&root, "legado.txt").unwrap();
        assert!(!read.binary, "with no zero byte it is still readable text");
        assert!(read.lossy, "the bytes did not survive decoding");
        assert!(read.text.contains('\u{fffd}'));

        // Real UTF-8, accents and all, is not flagged.
        std::fs::write(root.join("moderno.txt"), "coração\n".as_bytes()).unwrap();
        let ok = read_text(&root, "moderno.txt").unwrap();
        assert!(!ok.lossy);
        assert_eq!(ok.text, "coração\n");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn binary_comes_with_no_text() {
        let root = temp_root("bin");
        std::fs::write(root.join("img.png"), [0x89, 0x50, 0x00, 0x01, 0x02]).unwrap();
        let read = read_text(&root, "img.png").unwrap();
        assert!(read.binary);
        assert!(read.text.is_empty());
        assert_eq!(read.media, Some("image/png"));
        assert_eq!(read.size, 5);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A video has no text **even with no zero byte near the start**: the
    /// extension decides, and that is what saves reading 2 MB of disk to learn it.
    #[test]
    fn media_is_recognized_by_extension() {
        let root = temp_root("media");
        std::fs::write(root.join("clipe.mp4"), b"ftypisom sem byte zero").unwrap();
        let video = read_text(&root, "clipe.mp4").unwrap();
        assert!(video.binary);
        assert!(!video.truncated);
        assert_eq!(video.media, Some("video/mp4"));

        // SVG is image *and* text: it opens in the editor, with the image face too.
        std::fs::write(root.join("logo.svg"), "<svg/>\n").unwrap();
        let svg = read_text(&root, "logo.svg").unwrap();
        assert!(!svg.binary);
        assert_eq!(svg.text, "<svg/>\n");
        assert_eq!(svg.media, Some("image/svg+xml"));

        // And an ordinary file has no face at all.
        std::fs::write(root.join("a.rs"), "fn main() {}").unwrap();
        assert_eq!(read_text(&root, "a.rs").unwrap().media, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The root list is what the `yardfile` protocol consults: a folder the app
    /// never opened is not served to the webview.
    #[test]
    fn only_a_root_the_app_opened_is_served() {
        let root = temp_root("raizes");
        let other = temp_root("raizes-fora");
        std::fs::write(root.join("a.txt"), "oi").unwrap();

        assert!(!root_allowed(&other));
        read_text(&root, "a.txt").unwrap();
        assert!(root_allowed(&root));
        assert!(!root_allowed(&other));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// A folder link is deleted as a link — and the target on the other side stays.
    #[test]
    fn deletes_a_folder_link_without_touching_the_target() {
        let root = temp_root("link-del");
        let outside = temp_root("link-del-alvo");
        std::fs::write(outside.join("importante.txt"), "não me apague").unwrap();

        let link = root.join("atalho");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, &link);
        if linked.is_err() {
            // Windows without Developer Mode can deny symlinks to the test process.
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        delete_entry(&root, "atalho").unwrap();
        assert!(!link.exists(), "the link should be gone");
        assert!(
            outside.join("importante.txt").is_file(),
            "deleting the link must not take the target with it"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn create_rename_delete() {
        let root = temp_root("crud");
        create_entry(&root, "src/lib/novo.ts", false).unwrap();
        assert!(root.join("src").join("lib").join("novo.ts").is_file());
        assert!(create_entry(&root, "src/lib/novo.ts", false).is_err());

        rename_entry(&root, "src/lib/novo.ts", "src/lib/velho.ts").unwrap();
        assert!(root.join("src").join("lib").join("velho.ts").is_file());

        create_entry(&root, "src/lib/outro.ts", false).unwrap();
        assert!(rename_entry(&root, "src/lib/velho.ts", "src/lib/outro.ts").is_err());

        delete_entry(&root, "src/lib").unwrap();
        assert!(!root.join("src").join("lib").exists());
        assert!(delete_entry(&root, "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_finds_text_and_skips_dependencies() {
        let root = temp_root("busca");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("lib")).unwrap();
        std::fs::write(
            root.join("src").join("a.ts"),
            "const alvo = 1;\noutra linha\n",
        )
        .unwrap();
        std::fs::write(root.join("src").join("b.ts"), "sem nada aqui\n").unwrap();
        std::fs::write(
            root.join("node_modules").join("lib").join("c.ts"),
            "const alvo = 2;\n",
        )
        .unwrap();

        let out = search_text(&root, "ALVO", false, false).unwrap();
        assert_eq!(out.hits.len(), 1, "node_modules is left out of the search");
        assert_eq!(out.hits[0].path, "src/a.ts");
        assert_eq!(out.hits[0].line, 1);
        assert_eq!(out.files_hit, 1);
        assert!(!out.truncated);

        // Case-sensitive: "ALVO" is not in the file.
        let nothing = search_text(&root, "ALVO", true, false).unwrap();
        assert!(nothing.hits.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_interrupted_search_does_not_walk_the_rest() {
        let root = temp_root("busca-cancelada");
        for i in 0..20 {
            std::fs::write(root.join(format!("{i:02}.txt")), "agulha\n").unwrap();
        }
        let mut checks = 0usize;
        let result = search_text_cancellable(&root, "agulha", false, false, || {
            checks += 1;
            checks > 3
        });
        let error = result.err().expect("the search should have been cancelled");
        assert_eq!(error, "busca cancelada");
        assert!(checks < 20, "cancellation must stop before the end");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn whole_word_search_respects_the_boundaries() {
        let root = temp_root("palavra");
        std::fs::write(root.join("a.txt"), "portal porta aporta\n").unwrap();

        let loose = search_text(&root, "porta", false, false).unwrap();
        assert_eq!(loose.hits.len(), 1, "the line counts once");

        let whole = search_text(&root, "porta", false, true).unwrap();
        assert_eq!(whole.hits.len(), 1, "only the exact word matches");

        let absent = search_text(&root, "portas", false, true).unwrap();
        assert!(absent.hits.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_index_lists_everything_except_what_is_skipped() {
        let root = temp_root("indice");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src").join("a.ts"), "x").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();
        std::fs::write(root.join(".git").join("config"), "x").unwrap();

        let index = index_files(&root).unwrap();
        assert_eq!(
            index.paths,
            vec!["README.md".to_string(), "src/a.ts".to_string()]
        );
        assert!(!index.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }
}
