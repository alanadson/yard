//! Previous session output is discoverable independently of the active scrollback file.

use std::path::{Path, PathBuf};
use std::io::{Read, Write};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedOutput {
    pub terminal_id: String,
    pub name: String,
    pub at: i64,
    pub bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedPreview {
    pub text: String,
    pub bytes: u64,
    pub truncated: bool,
}

pub fn preview_in(directory: &Path, terminal: &str, name: &str, max: usize) -> std::io::Result<ArchivedPreview> {
    let path = owned_path(directory, terminal, name)?;
    let max = max.clamp(1, 64 * 1024);
    let (tail, bytes) = super::scrollback::read_tail(&path, max)?;
    let text = super::scrollback::into_text(crate::pty_export::strip_ansi(&tail));
    Ok(ArchivedPreview { text, bytes, truncated: bytes > max as u64 })
}

pub fn delete_in(directory: &Path, terminal: &str, name: &str) -> std::io::Result<bool> {
    let path = match owned_path(directory, terminal, name) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// How long the archived sessions of a removed terminal stay in the global
/// history, counted from when each session was archived (the time in its name).
pub const ORPHAN_MAX_AGE_MS: i64 = 30 * crate::retention::DAY_MS;

/// The archives to delete at startup, oldest first: those whose terminal is
/// not in `terminals` (folder names, as `paths::sanitize_id` makes them) and
/// older than `ORPHAN_MAX_AGE_MS`. A terminal that still exists keeps its
/// archives; `Scrollback::fresh` caps those at five.
pub fn orphans_to_prune(records: &[ArchivedOutput], terminals: &std::collections::HashSet<String>, now: i64) -> Vec<String> {
    let orphans: Vec<crate::retention::Entry> = records
        .iter()
        .filter(|record| !terminals.contains(&record.terminal_id))
        .map(|record| crate::retention::Entry { name: record.name.clone(), modified_ms: record.at })
        .collect();
    crate::retention::to_prune(&orphans, now, ORPHAN_MAX_AGE_MS, None)
}

/// The terminals the saved workspace still has, as archive owner names.
/// `None` when the list cannot be read: then no archive is known to be an
/// orphan.
pub fn saved_terminal_ids(conn: &rusqlite::Connection) -> Option<std::collections::HashSet<String>> {
    let mut statement = conn.prepare("SELECT id FROM terminals").ok()?;
    let ids = statement.query_map([], |row| row.get::<_, String>(0)).ok()?;
    ids.map(|id| id.map(|id| crate::paths::sanitize_id(&id))).collect::<Result<_, _>>().ok()
}

/// Startup cleanup of `directory`: deletes the month-old archives of
/// terminals that no longer exist (`orphans_to_prune`) and returns their
/// names. Without the terminal list, nothing is deleted.
pub fn prune_orphans_in(directory: &Path, terminals: Option<&std::collections::HashSet<String>>, now: i64) -> Vec<String> {
    let Some(terminals) = terminals else { return Vec::new() };
    let Ok(records) = list_all_in(directory) else { return Vec::new() };
    let mut removed = Vec::new();
    for name in orphans_to_prune(&records, terminals, now) {
        let Some(record) = records.iter().find(|record| record.name == name) else { continue };
        match delete_in(directory, &record.terminal_id, &name) {
            Ok(true) => removed.push(name),
            Ok(false) => {}
            Err(error) => tracing::warn!(%error, name, "archived session of a removed terminal could not be deleted"),
        }
    }
    removed
}

pub fn export_in(directory: &Path, terminal: &str, name: &str, dest: &Path, plain: bool) -> std::io::Result<u64> {
    let path = owned_path(directory, terminal, name)?;
    if dest.parent().is_some_and(|parent| parent.canonicalize().ok() == directory.canonicalize().ok()) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Export destination cannot replace a managed session archive"));
    }
    if !plain { return publish_export(dest, |output| std::io::copy(&mut std::fs::File::open(path)?, output)); }
    let mut file = std::fs::File::open(path)?.take(16 * 1024 * 1024 + 1);
    let mut bytes = vec![];
    file.read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Use ANSI export for archives larger than 16 MiB")); }
    let body = crate::pty_export::to_crlf(&crate::pty_export::strip_ansi(&bytes));
    publish_export(dest, |output| { output.write_all(&body)?; Ok(body.len() as u64) })
}

fn publish_export(dest: &Path, write: impl FnOnce(&mut std::fs::File) -> std::io::Result<u64>) -> std::io::Result<u64> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = dest.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let name = dest.file_name().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Export destination needs a file name"))?;
    let (temporary, mut file) = loop {
        let mut candidate = name.to_os_string();
        candidate.push(format!(".yard-export-{}-{}.tmp", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        let temporary = parent.join(candidate);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary) {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let result = write(&mut file).and_then(|bytes| {
        if bytes == 0 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Archive has no output to export")); }
        file.sync_all()?;
        Ok(bytes)
    });
    drop(file);
    let result = result.and_then(|bytes| std::fs::rename(&temporary, dest).map(|_| bytes));
    if result.is_err() { let _ = std::fs::remove_file(temporary); }
    result
}

fn owned_path(directory: &Path, terminal: &str, name: &str) -> std::io::Result<PathBuf> {
    if archive_identity(name, terminal).is_none() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Archive does not belong to the selected terminal")); }
    let path = directory.join(name);
    if !std::fs::symlink_metadata(&path)?.file_type().is_file() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Archive is not a regular file")); }
    Ok(path)
}

pub fn list_in(directory: &Path, terminal: &str) -> std::io::Result<Vec<ArchivedOutput>> {
    list_matching_in(directory, Some(terminal))
}

pub fn list_all_in(directory: &Path) -> std::io::Result<Vec<ArchivedOutput>> {
    list_matching_in(directory, None)
}

fn list_matching_in(directory: &Path, terminal: Option<&str>) -> std::io::Result<Vec<ArchivedOutput>> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let mut records = vec![];
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((owner, at, sequence)) = archive_parts(&name) else { continue; };
        if terminal.is_some_and(|terminal| terminal != owner) { continue; }
        records.push((ArchivedOutput { terminal_id: owner.into(), name, at, bytes: entry.metadata()?.len() }, sequence));
    }
    records.sort_by(|(left, left_sequence), (right, right_sequence)| right.at.cmp(&left.at).then(right_sequence.cmp(left_sequence)).then(left.terminal_id.cmp(&right.terminal_id)));
    Ok(records.into_iter().map(|(record, _)| record).collect())
}

fn archive_identity(name: &str, terminal: &str) -> Option<(i64, u64)> {
    let (owner, at, sequence) = archive_parts(name)?;
    (owner == terminal).then_some((at, sequence))
}

fn archive_parts(name: &str) -> Option<(&str, i64, u64)> {
    let suffix = name.strip_suffix(".bin")?;
    let (prefix, sequence) = suffix.rsplit_once("--")?;
    let (terminal, at) = prefix.rsplit_once("--")?;
    if terminal.is_empty() || crate::paths::sanitize_id(terminal) != terminal { return None; }
    let at = at.parse().ok()?;
    if at < 0 { return None; }
    Some((terminal, at, sequence.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Partial writes and another terminal's files must never appear as complete sessions.
    #[test]
    fn archived_sessions_are_listed_newest_first_without_partial_or_unrelated_output() {
        let root = std::env::temp_dir().join(format!("yard-output-history-list-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for (name, text) in [
            ("terminal--1000--0.bin", "Earlier output"),
            ("terminal--2000--0.bin", "Recent output"),
            ("terminal--2000--1.bin", "Latest output"),
            ("terminal--3000--0.tmp", "Partial output"),
            ("other-terminal--4000--0.bin", "Unrelated output"),
            ("terminal--invalid--0.bin", "Invalid archive identity"),
        ] { std::fs::write(root.join(name), text.as_bytes()).unwrap(); }
        let records = list_in(&root, "terminal").unwrap();
        assert_eq!(records.iter().map(|record| record.name.as_str()).collect::<Vec<_>>(), ["terminal--2000--1.bin", "terminal--2000--0.bin", "terminal--1000--0.bin"]);
        assert_eq!(records[0].at, 2000);
        assert_eq!(records[0].bytes, 13);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_workspace_history_keeps_archives_accessible_after_the_terminal_card_is_removed() {
        let root = std::env::temp_dir().join(format!("yard-output-history-all-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["first-terminal--1000--0.bin", "removed-terminal--2000--0.bin"] { std::fs::write(root.join(name), b"Saved output").unwrap(); }
        let records = list_all_in(&root).unwrap();
        assert_eq!(records.iter().map(|record| record.terminal_id.as_str()).collect::<Vec<_>>(), ["removed-terminal", "first-terminal"]);
        assert_eq!(records[0].name, "removed-terminal--2000--0.bin");
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_bounded_archive_preview_starts_on_a_complete_utf8_character() {
        let root = std::env::temp_dir().join(format!("yard-output-history-preview-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let name = "terminal--1000--0.bin";
        std::fs::write(root.join(name), "prefix😀done".as_bytes()).unwrap();
        let preview = preview_in(&root, "terminal", name, 6).unwrap();
        assert_eq!(preview.text, "done");
        assert_eq!(preview.bytes, 14);
        assert!(preview.truncated);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exporting_an_archived_session_preserves_all_original_bytes_and_keeps_the_source() {
        let root = std::env::temp_dir().join(format!("yard-output-history-export-{}", std::process::id()));
        let archives = root.join("archives");
        std::fs::create_dir_all(&archives).unwrap();
        let name = "terminal--1000--0.bin";
        let raw = b"\x1b[32mPrevious output\x1b[0m\r\n";
        std::fs::write(archives.join(name), raw).unwrap();
        let dest = root.join("saved-output.ansi");
        assert_eq!(export_in(&archives, "terminal", name, &dest, false).unwrap(), raw.len() as u64);
        assert_eq!(std::fs::read(dest).unwrap(), raw);
        assert_eq!(std::fs::read(archives.join(name)).unwrap(), raw);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plain_export_to_an_external_hardlink_does_not_rewrite_the_archived_source() {
        let root = std::env::temp_dir().join(format!("yard-output-history-hardlink-{}", std::process::id()));
        let archives = root.join("archives");
        std::fs::create_dir_all(&archives).unwrap();
        let name = "terminal--1000--0.bin";
        let raw = b"\x1b[32mPrevious output\x1b[0m\r\n";
        let source = archives.join(name);
        std::fs::write(&source, raw).unwrap();
        let dest = root.join("export.txt");
        std::fs::hard_link(&source, &dest).unwrap();
        export_in(&archives, "terminal", name, &dest, true).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), raw);
        assert_eq!(std::fs::read(dest).unwrap(), b"Previous output\r\n");
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_a_selected_archive_preserves_current_output_and_other_terminals_history() {
        let root = std::env::temp_dir().join(format!("yard-output-history-remove-{}", std::process::id()));
        let archives = root.join("archives");
        std::fs::create_dir_all(&archives).unwrap();
        let name = "terminal--1000--0.bin";
        std::fs::write(archives.join(name), b"Selected archive").unwrap();
        std::fs::write(archives.join("other--1000--0.bin"), b"Other history").unwrap();
        std::fs::write(root.join("current.bin"), b"Current session").unwrap();
        assert!(delete_in(&archives, "terminal", name).unwrap());
        assert!(!archives.join(name).exists());
        assert_eq!(std::fs::read(archives.join("other--1000--0.bin")).unwrap(), b"Other history");
        assert_eq!(std::fs::read(root.join("current.bin")).unwrap(), b"Current session");
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn record(terminal: &str, at: i64) -> ArchivedOutput {
        ArchivedOutput { terminal_id: terminal.into(), name: format!("{terminal}--{at}--0.bin"), at, bytes: 1 }
    }

    /// Archives of removed terminals stay listed in the global history, but
    /// not forever: a month after the session ended they go. A terminal that
    /// still exists keeps its archives (its five newest, see `fresh_at`).
    #[test]
    fn archives_of_removed_terminals_go_after_thirty_days_and_existing_terminals_keep_theirs() {
        let now = 100 * DAY;
        let records = [record("kept", now - 90 * DAY), record("gone", now - 31 * DAY), record("gone", now - 29 * DAY), record("gone", now - 60 * DAY)];
        let terminals: std::collections::HashSet<String> = ["kept".to_string()].into();
        assert_eq!(orphans_to_prune(&records, &terminals, now), [format!("gone--{}--0.bin", now - 60 * DAY), format!("gone--{}--0.bin", now - 31 * DAY)]);
    }

    #[test]
    fn startup_prunes_month_old_archives_of_terminals_the_workspace_no_longer_has() {
        let root = std::env::temp_dir().join(format!("yard-output-history-orphans-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let now = 100 * DAY;
        let old = now - 31 * DAY;
        for name in [format!("kept_1--{old}--0.bin"), format!("gone--{old}--0.bin"), format!("gone--{}--0.bin", now - DAY)] {
            std::fs::write(root.join(name), b"output").unwrap();
        }
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE terminals (id TEXT PRIMARY KEY); INSERT INTO terminals VALUES ('kept:1');").unwrap();
        let terminals = saved_terminal_ids(&conn);
        assert_eq!(prune_orphans_in(&root, terminals.as_ref(), now), [format!("gone--{old}--0.bin")]);
        let mut left = std::fs::read_dir(&root).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect::<Vec<_>>();
        left.sort();
        assert_eq!(left, [format!("gone--{}--0.bin", now - DAY), format!("kept_1--{old}--0.bin")]);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Without the terminal list every archive could look orphaned.
    #[test]
    fn an_unreadable_terminal_list_deletes_no_archive() {
        let root = std::env::temp_dir().join(format!("yard-output-history-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("gone--1000--0.bin"), b"output").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let terminals = saved_terminal_ids(&conn);
        assert!(terminals.is_none());
        assert!(prune_orphans_in(&root, terminals.as_ref(), 100 * DAY).is_empty());
        assert!(root.join("gone--1000--0.bin").exists());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_other_terminal_names_cannot_read_export_or_remove_a_session_archive() {
        let root = std::env::temp_dir().join(format!("yard-output-history-identity-{}", std::process::id()));
        let archives = root.join("archives");
        std::fs::create_dir_all(&archives).unwrap();
        std::fs::write(archives.join("other--1000--0.bin"), b"Other terminal output").unwrap();
        let dest = root.join("export.ansi");
        for name in ["other--1000--0.bin", "../other--1000--0.bin", "terminal--1000--0.tmp", "terminal--invalid--0.bin"] {
            assert!(preview_in(&archives, "terminal", name, 100).is_err());
            assert!(export_in(&archives, "terminal", name, &dest, false).is_err());
            assert!(delete_in(&archives, "terminal", name).is_err());
        }
        assert!(!dest.exists());
        assert_eq!(std::fs::read(archives.join("other--1000--0.bin")).unwrap(), b"Other terminal output");
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_preview_request_cannot_load_more_than_the_bounded_tail() {
        let root = std::env::temp_dir().join(format!("yard-output-history-bound-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let name = "terminal--1000--0.bin";
        std::fs::write(root.join(name), vec![b'x'; 128 * 1024]).unwrap();
        let preview = preview_in(&root, "terminal", name, usize::MAX).unwrap();
        assert_eq!(preview.text.len(), 64 * 1024);
        assert_eq!(preview.bytes, 128 * 1024);
        assert!(preview.truncated);
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
