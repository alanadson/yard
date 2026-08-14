//! Central path resolution. No other module builds a path by hand.
//!
//! On-disk layout (docs/specs/02-architecture.md §5):
//! ```text
//! %APPDATA%\Yard\
//! ├── app.db
//! ├── scrollback\{ptyId}.bin
//! ├── logs\yard.log
//! └── backups\
//! ```

use std::path::{Path, PathBuf};

/// App data root: `%APPDATA%\Yard` on Windows.
///
/// `YARD_DATA_DIR` overrides the path. This exists for a concrete reason:
/// two builds of the same app (the installed one and the development one,
/// or two checkouts of the repo) would share `app.db` and the scrollback
/// folder, and one would stomp the other — including wiping the state of
/// the one that is running. Tests and dev builds should point at their own
/// directory.
pub fn app_dir() -> PathBuf {
    if let Some(custom) = std::env::var_os("YARD_DATA_DIR") {
        let p = PathBuf::from(custom);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Yard")
}

pub fn db_path() -> PathBuf {
    app_dir().join("app.db")
}

pub fn scrollback_dir() -> PathBuf {
    app_dir().join("scrollback")
}

/// Scrollback file of a PTY. The id comes from the frontend, so it is sanitized
/// to never escape the directory (`..`, separators, drive-colon).
pub fn scrollback_file(id: &str) -> PathBuf {
    scrollback_dir().join(format!("{}.bin", sanitize_id(id)))
}

pub fn logs_dir() -> PathBuf {
    app_dir().join("logs")
}

pub fn backups_dir() -> PathBuf {
    app_dir().join("backups")
}

/// User home directory (`%USERPROFILE%`), base for agent data.
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Creates the full app directory tree. Idempotent.
pub fn ensure_dirs() -> std::io::Result<()> {
    for d in [app_dir(), scrollback_dir(), logs_dir(), backups_dir()] {
        std::fs::create_dir_all(d)?;
    }
    Ok(())
}

/// Keeps only `[A-Za-z0-9_-]`; everything else becomes `_`. Empty ids become `_`.
pub fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "_".to_string()
    } else {
        cleaned
    }
}

/// Slug Claude Code uses to name a project folder under
/// `~/.claude/projects/`: the absolute path with every non-alphanumeric becoming `-`.
/// Ex.: `C:\Workspace\Code\yard` -> `C--Workspace-Code-yard`.
pub fn claude_project_slug(project_path: &Path) -> String {
    let s = project_path.to_string_lossy();
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_blocks_traversal() {
        assert_eq!(sanitize_id("../../evil"), "______evil");
        assert_eq!(sanitize_id("C:\\x"), "C__x");
        assert_eq!(sanitize_id(""), "_");
        assert_eq!(sanitize_id("ok-id_1"), "ok-id_1");
    }

    #[test]
    fn claude_slug_matches_cli_layout() {
        let p = Path::new(r"C:\Workspace\Code\yard");
        assert_eq!(claude_project_slug(p), "C--Workspace-Code-yard");
    }
}
