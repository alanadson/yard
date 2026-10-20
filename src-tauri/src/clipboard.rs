//! Pasted image → file on disk → path.
//!
//! A PTY carries text and nothing else: there is no escape sequence for "here
//! comes a PNG". What the agent CLIs (Claude Code, Codex, Gemini) do is
//! recognize the **path of an image file** inside a paste and attach the image
//! themselves — a path is the only shape that survives a terminal.
//!
//! This module is the bottom half of that path: it takes the bytes WebView2
//! handed over in the `paste` event, checks they really are an image and writes
//! them to the workspace's `attachments` directory. Pasting the path into the terminal is the
//! front end's job.
//!
//! Two decisions worth the comment:
//!
//! * **The extension comes from the file's signature**, not from the `type` the
//!   front end reported. The MIME comes from the source page and is a guess; the
//!   first bytes are the file itself. With no known signature nothing is written
//!   and nobody needs a `.png` that is something else.
//! * Attachments are workspace data. They remain available until removed,
//!   rather than disappearing while a saved prompt still refers to them.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Cap on what we accept writing. A 4K screenshot in PNG is ~10 MB; twice that
/// is headroom enough and still keeps the IPC trip short.
pub const MAX_BYTES: usize = 24 * 1024 * 1024;

/// Prefix of the files this module creates.
const PREFIX: &str = "yard-";

/// Breaks the tie between two `paste`s in the same second (repeated Ctrl+V is common).
static SEQ: AtomicU64 = AtomicU64::new(0);

/// Writes the bytes (as base64) and returns the file's absolute path.
pub fn save_image(data: &str) -> Result<String, String> {
    save_image_in(&crate::paths::app_dir(), data)
}

fn save_image_in(app_dir: &Path, data: &str) -> Result<String, String> {
    // Reject the giant before decoding: 4 base64 characters become 3 bytes, so
    // the final size is already known from the length of the text.
    if data.len() / 4 * 3 > MAX_BYTES {
        return Err("imagem grande demais".into());
    }
    let bytes = decode_base64(data)?;
    if bytes.is_empty() {
        return Err("imagem vazia".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("imagem grande demais".into());
    }
    let ext = sniff_ext(&bytes).ok_or("formato de imagem não reconhecido")?;

    let dir = app_dir.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("não consegui criar {dir:?}: {e}"))?;

    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let file = dir.join(format!("{PREFIX}{stamp}-{seq}.{ext}"));
    std::fs::write(&file, &bytes).map_err(|e| format!("não consegui gravar {file:?}: {e}"))?;
    Ok(file.to_string_lossy().into_owned())
}

/// The front end writes `yard ask` prompts too large to paste to
/// `attachments/yard-ask-<ms>-<id>.md`; the agent reads one right away.
const ASK_PROMPT_PREFIX: &str = "yard-ask-";
const ASK_PROMPT_MAX_AGE_MS: i64 = 7 * crate::retention::DAY_MS;

/// Deletes week-old large `yard ask` prompts, and nothing else of the
/// attachments folder: the images there are the user's. Run at startup.
pub fn prune_ask_prompts_in(app_dir: &Path, now: i64) -> Vec<String> {
    crate::retention::prune_dir(
        &app_dir.join("attachments"),
        |name| name.starts_with(ASK_PROMPT_PREFIX) && name.ends_with(".md"),
        now,
        ASK_PROMPT_MAX_AGE_MS,
        None,
    )
}

/// Extension deduced from the first bytes. `None` when it is not an image the
/// CLIs know how to attach (SVG, for one, is out: it is text, not raster).
fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.starts_with(PNG) {
        return Some("png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    // RIFF without "WEBP" at offset 8 is audio (WAV) or video — no good.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// Minimal base64 decoder — avoids a new crate for a single call.
/// It requires the padding (the front end's `btoa` always emits it) and refuses
/// any character outside the alphabet, so we never write garbage shaped like an image.
pub fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    const INVALID: &str = "base64 invalido";
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !bytes.len().is_multiple_of(4) {
        return Err(INVALID.into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let last = bytes.len().saturating_sub(4);
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let padded = chunk[2] == b'=' || chunk[3] == b'=';
        // `=` only exists in the last group: in the middle it is truncated text
        // that would decode "almost right" and write a corrupted file.
        if padded && i * 4 != last {
            return Err(INVALID.into());
        }
        let a = val(chunk[0]).ok_or(INVALID)?;
        let b = val(chunk[1]).ok_or(INVALID)?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            val(chunk[2]).ok_or(INVALID)?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            val(chunk[3]).ok_or(INVALID)?
        };
        // `chunk[2] == '=' && chunk[3] != '='` is impossible in valid base64.
        if chunk[2] == b'=' && chunk[3] != b'=' {
            return Err(INVALID.into());
        }
        out.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            out.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            out.push((c << 6) | d);
        }
    }
    Ok(out)
}

/// The way back: bytes become base64 to cross the IPC as text. It serves the
/// markdown preview, which embeds images from the project's own folder as
/// `data:` URLs — the app's CSP only accepts `self`, `data:` and `blob:` in
/// `img-src`, so a disk path does not load on its own.
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `yard ask` prompts over 32 KB go to `attachments/yard-ask-*.md` and
    /// nothing ever deleted them; the images beside them are user content.
    #[test]
    fn week_old_ask_prompts_are_deleted_and_every_other_attachment_is_kept() {
        use crate::retention::testing::{millis, write_aged};
        let root = std::env::temp_dir().join(format!("yard-ask-prompts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("attachments");
        std::fs::create_dir_all(&dir).unwrap();
        let now = std::time::SystemTime::now();
        for (name, age_days) in [
            ("yard-ask-1000-abc123.md", 8),
            ("yard-ask-2000-def456.md", 2),
            ("yard-image-20260101-000000-0.png", 90),
            ("notes.md", 90),
        ] {
            write_aged(&dir.join(name), now, age_days);
        }
        prune_ask_prompts_in(&root, millis(now));
        let mut left = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect::<Vec<_>>();
        left.sort();
        assert_eq!(left, ["notes.md", "yard-ask-2000-def456.md", "yard-image-20260101-000000-0.png"]);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    // Prompt attachments must survive restarts and travel with the workspace backup.
    #[test]
    fn pasted_images_are_owned_workspace_attachments_and_keep_existing_files() {
        let root = std::env::temp_dir().join(format!("yard-attachments-{}", std::process::id()));
        let assets = root.join("attachments");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("older.png"), b"previous attachment").unwrap();
        let path = save_image_in(&root, "iVBORw0KGgo=").unwrap();
        assert_eq!(Path::new(&path).parent(), Some(assets.as_path()));
        assert_eq!(std::fs::read(path).unwrap(), [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert!(assets.join("older.png").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn base64_round_trips() {
        for original in [
            "",
            "M",
            "Ma",
            "Man",
            "qualquer coisa \u{1f600} com bytes altos",
        ] {
            let text = encode_base64(original.as_bytes());
            assert_eq!(
                decode_base64(&text).unwrap(),
                original.as_bytes(),
                "{original}"
            );
        }
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
        assert_eq!(encode_base64(b"M"), "TQ==");
    }

    #[test]
    fn base64_roundtrip_covers_every_remainder() {
        // "M", "Ma", "Man" cover the three padding sizes.
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        // A line break in the middle (some encoders add one) does not invalidate it.
        assert_eq!(decode_base64("TWFu\nTWFu").unwrap(), b"ManMan");
    }

    #[test]
    fn base64_rejects_garbage() {
        assert!(decode_base64("TWF").is_err()); // length not a multiple of 4
        assert!(decode_base64("T*Fu").is_err()); // character outside the alphabet
        assert!(decode_base64("TQ==TWFu").is_err()); // padding in the middle
        assert!(decode_base64("T=Fu").is_err()); // padding in an impossible position
    }

    #[test]
    fn the_signature_decides_the_extension() {
        assert_eq!(
            sniff_ext(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]),
            Some("png")
        );
        assert_eq!(sniff_ext(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(sniff_ext(b"GIF89a...."), Some("gif"));
        assert_eq!(sniff_ext(b"BM\0\0\0\0"), Some("bmp"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        // RIFF that is not WEBP, SVG and loose text never become a file.
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_ext(b"<svg xmlns=\"...\">"), None);
        assert_eq!(sniff_ext(b""), None);
    }

    #[test]
    fn rejects_what_is_not_an_image() {
        // "ola" in base64 — it decodes, but has no image signature.
        assert!(save_image("b2xh").is_err());
        assert!(save_image("").is_err());
    }

    #[test]
    fn writes_the_png_and_returns_a_path_that_exists() {
        // Smallest valid PNG (1x1 transparent), just as the front end would send it.
        const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\
                               YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let root = std::env::temp_dir().join(format!("yard-clipboard-roundtrip-{}", std::process::id()));
        let path = save_image_in(&root, PNG_1X1).expect("should have written the file");
        let file = Path::new(&path);
        assert!(file.is_file(), "{path} does not exist");
        assert_eq!(file.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(
            std::fs::read(file).unwrap(),
            decode_base64(PNG_1X1).unwrap(),
            "the file has to be byte for byte what was pasted"
        );
        let _ = std::fs::remove_file(file);
        std::fs::remove_dir_all(root).unwrap();
    }
}
