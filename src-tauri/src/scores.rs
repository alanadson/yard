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

/// Score name -> file name. The name comes from the UI, so it cannot
/// escape the directory or collide with a Windows reserved name.
fn file_for(name: &str) -> Result<PathBuf, String> {
    let limpo: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let limpo = limpo.trim().to_string();
    if limpo.is_empty() {
        return Err("nome de partitura vazio".into());
    }
    Ok(scores_dir().join(format!("{limpo}.json")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreMeta {
    pub name: String,
    pub path: String,
    pub updated_at: i64,
    pub size_bytes: u64,
}

/// Writes (or overwrites) a score. Returns the on-disk path.
pub fn save(name: &str, json: &str) -> Result<String, String> {
    // Validate before writing: a crooked score on disk would break the whole
    // listing afterwards.
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| format!("partitura invalida: {e}"))?;
    let dir = scores_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("nao consegui criar {dir:?}: {e}"))?;
    let file = file_for(name)?;
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
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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

    #[test]
    fn nome_nao_escapa_do_diretorio() {
        let f = file_for("../../evil").unwrap();
        assert_eq!(f.parent(), Some(scores_dir().as_path()));
        assert!(!f.to_string_lossy().contains(".."));
    }

    #[test]
    fn nome_vazio_e_recusado() {
        assert!(file_for("   ").is_err());
    }

    #[test]
    fn nome_normal_vira_arquivo_json() {
        let f = file_for("Time de revisao").unwrap();
        assert_eq!(
            f.file_name().and_then(|s| s.to_str()),
            Some("Time de revisao.json")
        );
    }
}
