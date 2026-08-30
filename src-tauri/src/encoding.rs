//! Text encodings the editor can open a file in.
//!
//! Everything here reads and writes UTF-8 by default, and that is right for
//! this decade. What it could not do until now is open the file that is not:
//! a `.txt` some Windows tool wrote in UTF-16, a `.csv` exported as
//! Windows-1252 with an accented name in it. Those opened as a wall of
//! replacement characters, read-only, with no way to say "no, it is 1252".
//!
//! The list is deliberately four entries long and hand-decoded. A general
//! encoding crate is a large dependency for four tables, three of which are
//! trivial and the fourth of which is 32 characters wide.

#[cfg(test)]
mod tests;

/// The encodings a file can be opened in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// Latin-1 as Windows actually means it: with the C1 range filled in.
    Windows1252,
}

impl Encoding {
    /// The name the front end uses, and the one stored with the tab.
    pub fn name(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf-8",
            Encoding::Utf16Le => "utf-16le",
            Encoding::Utf16Be => "utf-16be",
            Encoding::Windows1252 => "windows-1252",
        }
    }

    /// Reads a name back. Anything unknown is UTF-8, which is the default
    /// everywhere else in this app and the safe answer to a stale record.
    pub fn parse(name: &str) -> Encoding {
        match name.to_ascii_lowercase().as_str() {
            "utf-16le" | "utf-16" => Encoding::Utf16Le,
            "utf-16be" => Encoding::Utf16Be,
            "windows-1252" | "cp1252" | "latin-1" | "iso-8859-1" => Encoding::Windows1252,
            _ => Encoding::Utf8,
        }
    }
}

/// The BOM at the start of the file, if there is one.
///
/// Only UTF-16 is ever guessed, and only from its BOM: those two bytes are
/// unambiguous, and reading such a file as UTF-8 gives a wall of NULs.
/// Windows-1252 is never guessed at all, because it decodes *any* byte
/// sequence and a heuristic reaching for it would happily succeed on a JPEG.
pub fn detect(bytes: &[u8]) -> Encoding {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Encoding::Utf16Le;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Encoding::Utf16Be;
    }
    Encoding::Utf8
}

/// `bytes` as text, or `None` when they are not that encoding.
///
/// Nothing here is lossy. The caller decides what to do about a file that
/// will not decode; guessing at this level writes characters the file never
/// had.
pub fn decode(bytes: &[u8], encoding: Encoding) -> Option<String> {
    match encoding {
        Encoding::Utf8 => {
            let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
            String::from_utf8(body.to_vec()).ok()
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let little = encoding == Encoding::Utf16Le;
            let bom: &[u8] = if little { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] };
            let body = bytes.strip_prefix(bom).unwrap_or(bytes);
            if !body.len().is_multiple_of(2) {
                return None;
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|p| {
                    if little {
                        u16::from_le_bytes([p[0], p[1]])
                    } else {
                        u16::from_be_bytes([p[0], p[1]])
                    }
                })
                .collect();
            // `from_utf16` refuses a lone surrogate, which is the answer we
            // want: half a pair is a broken file, not a character.
            String::from_utf16(&units).ok()
        }
        Encoding::Windows1252 => Some(bytes.iter().map(|b| cp1252_char(*b)).collect()),
    }
}

/// `text` as bytes. Characters the encoding cannot hold become `?`; use
/// [`encode_checked`] when that would be a silent loss.
pub fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    match encoding {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf16Le => text
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect(),
        Encoding::Utf16Be => text
            .encode_utf16()
            .flat_map(|u| u.to_be_bytes())
            .collect(),
        Encoding::Windows1252 => text.chars().map(|c| cp1252_byte(c).unwrap_or(b'?')).collect(),
    }
}

/// `text` as bytes, or `None` when the encoding cannot hold all of it.
///
/// This is what a save goes through: writing a `?` where the user typed an
/// emoji is a data loss nobody asked for and nobody would notice until later.
pub fn encode_checked(text: &str, encoding: Encoding) -> Option<Vec<u8>> {
    if encoding == Encoding::Windows1252 && text.chars().any(|c| cp1252_byte(c).is_none()) {
        return None;
    }
    Some(encode(text, encoding))
}

/// The 32 characters Windows-1252 puts where Latin-1 has C1 control codes.
/// Everything outside `0x80..=0x9F` is Latin-1, where the byte is the code
/// point. Two slots (0x81, 0x8D, 0x8F, 0x90, 0x9D) are unassigned; they map
/// to the code point of the byte, which is what every reader does with them.
const CP1252_C1: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
    '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}',
    '\u{017D}', '\u{008F}', '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
    '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
    '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

fn cp1252_char(byte: u8) -> char {
    if (0x80..=0x9F).contains(&byte) {
        CP1252_C1[(byte - 0x80) as usize]
    } else {
        byte as char
    }
}

fn cp1252_byte(c: char) -> Option<u8> {
    if let Some(at) = CP1252_C1.iter().position(|x| *x == c) {
        return Some(0x80 + at as u8);
    }
    let code = c as u32;
    // Latin-1 proper, minus the C1 range the table above owns.
    if code <= 0xFF && !(0x80..=0x9F).contains(&code) {
        return Some(code as u8);
    }
    None
}
