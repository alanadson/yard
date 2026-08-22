//! Installed fonts, described well enough to be *chosen*.
//!
//! The preferences panel used to hand the user a free-text field and hope the
//! CSS stack they typed existed. This module walks the system font folders,
//! opens each face and answers the three questions the picker actually asks:
//! what the family is called, whether it is monospaced (terminal and editor
//! candidates), and whether its GSUB table carries ligatures (`liga`/`calt`/
//! `dlig`) — which is what decides if the "ligaduras" checkbox appears at all.
//!
//! Reading every face means reading every font file once (`ttf-parser` borrows
//! from the whole buffer), so the result is cached for the life of the app;
//! installing a font mid-session is rare enough that a restart is an honest
//! answer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct FontFamilyInfo {
    pub family: String,
    /// From the `post` table — the terminal/editor pickers only offer these.
    pub mono: bool,
    /// The family has at least one face whose GSUB lists `liga`, `calt` or
    /// `dlig` — the substitutions coding fonts use for `=>`-style glyphs.
    pub ligatures: bool,
}

static CACHE: OnceLock<Vec<FontFamilyInfo>> = OnceLock::new();

/// Every family installed on the machine, sorted by name. Scans once per run.
pub fn list() -> Vec<FontFamilyInfo> {
    CACHE.get_or_init(scan).clone()
}

fn scan() -> Vec<FontFamilyInfo> {
    // Key lowercased so "Fira Code" installed per-user and per-machine merge;
    // the value keeps the display casing of the first face seen.
    let mut families: BTreeMap<String, FontFamilyInfo> = BTreeMap::new();

    for dir in font_dirs() {
        collect_dir(&dir, 0, &mut families);
    }

    families.into_values().collect()
}

/// System folders, in the order Windows itself resolves them.
fn font_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();
    #[cfg(windows)]
    {
        let windir =
            std::env::var("WINDIR").map_or_else(|_| PathBuf::from(r"C:\Windows"), PathBuf::from);
        dirs_out.push(windir.join("Fonts"));
        // Fonts installed "for me only" (the default of a double-click install
        // since Win10 1809) never touch C:\Windows.
        if let Some(local) = dirs::data_local_dir() {
            dirs_out.push(local.join("Microsoft").join("Windows").join("Fonts"));
        }
    }
    #[cfg(not(windows))]
    {
        for p in [
            "/usr/share/fonts",
            "/usr/local/share/fonts",
            "/System/Library/Fonts",
            "/Library/Fonts",
        ] {
            dirs_out.push(PathBuf::from(p));
        }
        if let Some(home) = dirs::home_dir() {
            dirs_out.push(home.join(".local/share/fonts"));
            dirs_out.push(home.join("Library/Fonts"));
        }
    }
    dirs_out
}

/// Depth-limited: the Windows folder is flat, Linux nests one or two levels.
fn collect_dir(dir: &Path, depth: u8, families: &mut BTreeMap<String, FontFamilyInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 2 {
                collect_dir(&path, depth + 1, families);
            }
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("ttf" | "otf" | "ttc" | "otc")) {
            continue;
        }
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        let faces = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        for index in 0..faces {
            let Ok(face) = ttf_parser::Face::parse(&data, index) else {
                continue;
            };
            let Some(family) = family_name(&face) else {
                continue;
            };
            let info = FontFamilyInfo {
                family: family.clone(),
                mono: face.is_monospaced(),
                ligatures: has_ligatures(&face),
            };
            families
                .entry(family.to_lowercase())
                .and_modify(|f| {
                    // A family is offered for the terminal if *any* face is
                    // monospaced (some ship a proportional display cut), and
                    // gets the checkbox if any face has the features.
                    f.mono |= info.mono;
                    f.ligatures |= info.ligatures;
                })
                .or_insert(info);
        }
    }
}

/// Typographic family (id 16) when present — it groups "Light"/"SemiBold"
/// faces under one name — otherwise the legacy family (id 1).
fn family_name(face: &ttf_parser::Face) -> Option<String> {
    let mut legacy: Option<String> = None;
    let mut typographic: Option<String> = None;
    for name in face.names() {
        if !name.is_unicode() {
            continue;
        }
        match name.name_id {
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY if typographic.is_none() => {
                typographic = name.to_string();
            }
            ttf_parser::name_id::FAMILY if legacy.is_none() => {
                legacy = name.to_string();
            }
            _ => {}
        }
    }
    typographic
        .or(legacy)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn has_ligatures(face: &ttf_parser::Face) -> bool {
    let Some(gsub) = face.tables().gsub else {
        return false;
    };
    [b"liga", b"calt", b"dlig"].iter().any(|tag| {
        gsub.features
            .find(ttf_parser::Tag::from_bytes(tag))
            .is_some()
    })
}

#[cfg(test)]
mod tests {
    /// Runs the real scan against this machine — the point is exercising the
    /// parser on actual font files, not a fixture.
    #[test]
    #[cfg_attr(not(windows), ignore = "asserts fonts that ship with Windows")]
    fn scan_reads_real_windows_fonts() {
        let fonts = super::list();
        assert!(!fonts.is_empty(), "the scan found no font at all");
        // Consolas ships with every Windows and is monospaced.
        assert!(
            fonts
                .iter()
                .any(|f| f.family.eq_ignore_ascii_case("consolas") && f.mono),
            "Consolas should exist and be monospaced"
        );
        // The interface picker only makes sense if proportional families came too.
        assert!(fonts.iter().any(|f| !f.mono));
    }
}
