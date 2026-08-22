//! Scores: a whole-group arrangement saved as a reusable template.
//!
//! A score is a JSON file in `<data>\partituras\<name>.json` with the terminals
//! (program/args/title/role — never an absolute `cwd`) and the canvas (positions,
//! notes, connections, drawings, routines). Applying creates the arrangement in
//! another project with new ids; `cwd` comes from the destination project.
//!
//! File instead of a database row on purpose: a score is meant to be copied,
//! versioned and sent to another machine. Rust here only does safe I/O — who
//! serializes and remaps ids is `src/lib/scores.ts`.

use std::path::PathBuf;

use serde::Serialize;

pub fn scores_dir() -> PathBuf {
    crate::paths::app_dir().join("partituras")
}

/// Longest score name we accept. Windows caps a path component at 255, and a
/// name near that is unreadable in the list anyway.
const MAX_NAME_CHARS: usize = 80;

/// Device names Windows still resolves even with an extension: `CON.json`
/// opens the console, not a file. They have to be refused by name.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Score name -> file name. The name comes from the UI (and from `yard score
/// save`), so it cannot escape the directory, land on a Windows device name,
/// or silently overwrite a different score.
///
/// Only the characters Windows actually rejects are replaced. Mapping
/// *everything* non-alphanumeric — as this used to — made `"v1.0"` and
/// `"v1_0"` the same file, and the second save overwrote the first with no
/// warning. A dot is a legal filename character; a colon is not.
fn file_for(name: &str) -> Result<PathBuf, String> {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| {
            // `< > : " / \ | ? *` plus the control range are the only ones
            // Win32 refuses outright; `/` and `\` are also the traversal we
            // must not let through.
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows strips trailing dots and spaces from a file name, so `"nome."`
    // and `"nome"` would resolve to the same file anyway — trim them here so
    // the collision check below sees the real name.
    let clean = clean.trim().trim_end_matches('.').trim().to_string();
    if clean.is_empty() {
        return Err("nome de partitura vazio".into());
    }
    // It used to be `.take(80)`, silently: two long names sharing a prefix
    // became the same file, and the second save ate the first with a toast
    // saying it had been saved. Refusing names the file system cannot hold is
    // the honest half of that.
    if clean.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "nome de partitura longo demais ({} caracteres; o máximo é {MAX_NAME_CHARS})",
            clean.chars().count()
        ));
    }
    let base = clean.split('.').next().unwrap_or(&clean);
    if RESERVED.iter().any(|r| base.eq_ignore_ascii_case(r)) {
        return Err(format!(
            "\"{clean}\" e um nome reservado do Windows — escolha outro"
        ));
    }
    Ok(scores_dir().join(format!("{clean}.json")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreMeta {
    pub name: String,
    pub path: String,
    pub updated_at: i64,
    pub size_bytes: u64,
}

/// Marker the front end matches on to offer "replace it?" instead of showing a
/// raw error. Same shape as the editor's `CONFLITO:`.
pub const EXISTS_PREFIX: &str = "JA_EXISTE:";

/// Writes a score, refusing to replace one that is already there unless the
/// caller says so. Returns the on-disk path.
///
/// `overwrite` exists because saving used to be a plain `fs::write`: a name
/// already in the list — right there on the same screen — was replaced with no
/// question and a toast that said "salva". A score is a whole arrangement
/// (CLIs, positions, roles, notes, routines); losing one to a repeated name is
/// exactly the kind of silent destruction the rest of the app asks about.
pub fn save(name: &str, json: &str, overwrite: bool) -> Result<String, String> {
    // Validate before writing: a crooked score on disk would break the whole
    // listing afterwards.
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| format!("partitura invalida: {e}"))?;
    let dir = scores_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("nao consegui criar {dir:?}: {e}"))?;
    let file = file_for(name)?;
    if !overwrite && file.exists() {
        return Err(format!(
            "{EXISTS_PREFIX} ja existe uma partitura chamada \"{name}\""
        ));
    }
    std::fs::write(&file, json).map_err(|e| format!("nao consegui gravar {file:?}: {e}"))?;
    Ok(file.to_string_lossy().into_owned())
}

pub fn list() -> Result<Vec<ScoreMeta>, String> {
    let dir = scores_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new()); // folder does not exist yet: no scores
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let meta = entry.metadata().ok();
        let updated_at = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(ScoreMeta {
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            updated_at,
            size_bytes: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    Ok(out)
}

pub fn read(name: &str) -> Result<String, String> {
    let file = file_for(name)?;
    std::fs::read_to_string(&file).map_err(|e| format!("partitura \"{name}\" nao lida: {e}"))
}

pub fn delete(name: &str) -> Result<(), String> {
    let file = file_for(name)?;
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("nao consegui remover {file:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_of(name: &str) -> String {
        file_for(name)
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn name_cannot_escape_the_directory() {
        let f = file_for("../../evil").unwrap();
        // What blocks traversal is the absence of a separator: with no `/` or
        // `\`, a leftover `..` in the middle of the name is just text.
        assert_eq!(f.parent(), Some(scores_dir().as_path()));
        let file = name_of("../../evil");
        assert!(!file.contains('/') && !file.contains('\\'));
        assert_eq!(name_of("C:\\Windows\\System32"), "C__Windows_System32.json");
    }

    #[test]
    fn empty_name_is_refused() {
        assert!(file_for("   ").is_err());
        assert!(file_for(".").is_err());
        assert!(file_for("  ..  ").is_err());
    }

    #[test]
    fn ordinary_name_becomes_a_json_file() {
        assert_eq!(name_of("Time de revisao"), "Time de revisao.json");
    }

    /// The regression that motivated the fix: two distinct names wrote to the
    /// same file and the second `save` swallowed the first with no warning.
    #[test]
    fn distinct_names_do_not_collide_in_the_same_file() {
        assert_ne!(name_of("v1.0"), name_of("v1_0"));
        assert_eq!(name_of("v1.0"), "v1.0.json");
        assert_ne!(name_of("Revisão (nova)"), name_of("Revisão nova"));
    }

    /// `CON.json` is still the Windows console, not a file.
    #[test]
    fn windows_reserved_name_is_refused() {
        for reserved in ["CON", "con", "NUL", "com1", "LPT9", "aux.backup"] {
            assert!(
                file_for(reserved).is_err(),
                "{reserved} should be refused"
            );
        }
        // A name that merely starts with the same letters is still valid.
        assert!(file_for("console de revisao").is_ok());
    }

    /// Windows trims trailing dots and spaces; if we did not trim them here,
    /// two different names would point back at the same file.
    #[test]
    fn trailing_dot_and_space_are_normalized() {
        assert_eq!(name_of("Equipe."), name_of("Equipe"));
        assert_eq!(name_of("Equipe   "), name_of("Equipe"));
    }

    /// Truncating at 80 made two long names share one file, silently. Better
    /// to refuse the name than to eat somebody else's arrangement.
    #[test]
    fn overlong_name_is_refused_instead_of_truncated() {
        let base = "a".repeat(78);
        assert!(file_for(&base).is_ok());
        assert!(file_for(&format!("{base}bbbb")).is_err());
    }

    /// Saving over an existing score has to be asked for.
    #[test]
    fn does_not_overwrite_without_permission() {
        let dir = scores_dir();
        let _ = std::fs::create_dir_all(&dir);
        let name = format!("qa-sobrescreve-{}", std::process::id());
        let _ = std::fs::remove_file(file_for(&name).unwrap());

        save(&name, "{\"v\":1}", false).expect("first save");
        let err = save(&name, "{\"v\":2}", false).unwrap_err();
        assert!(err.starts_with(EXISTS_PREFIX), "error was: {err}");
        // The original content is still there.
        assert_eq!(read(&name).unwrap(), "{\"v\":1}");
        // With explicit permission, it writes.
        save(&name, "{\"v\":2}", true).expect("authorized overwrite");
        assert_eq!(read(&name).unwrap(), "{\"v\":2}");

        let _ = std::fs::remove_file(file_for(&name).unwrap());
    }
}
