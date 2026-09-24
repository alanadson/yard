//! Scheduled backups with retention (§F3, "Dados e backup").
//!
//! The manual `.zip` export already existed; what was missing was the copy
//! nobody has to remember to make. `run` writes `yard-auto-<stamp>.zip` into
//! the backups folder and then prunes the oldest automatic copies beyond the
//! number the user chose. Manual exports (`yard-backup-*.zip`, or anything
//! else living in that folder) are never touched: the retention rule only
//! ever deletes what this module itself wrote.
//!
//! Same `_in(app_dir)` twin as `backup.rs`, for the same reason: cargo runs
//! tests in parallel and `YARD_DATA_DIR` is process-global.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Prefix of the automatic copies — the retention rule matches on it, so a
/// manual export saved into the same folder is invisible to the pruning.
pub const AUTO_PREFIX: &str = "yard-auto-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupReport {
    /// The zip just written.
    pub path: String,
    pub bytes: u64,
    /// Older automatic copies deleted to honour the retention.
    pub pruned: Vec<String>,
}

/// `yard-auto-YYYY-MM-DD-HHMM.zip` — lexical order *is* chronological order,
/// which is what lets `to_prune` sort names instead of stat-ing files.
pub fn file_name(now: DateTime<Local>) -> String {
    format!("{AUTO_PREFIX}{}.zip", now.format("%Y-%m-%d-%H%M"))
}

/// Which automatic copies go beyond `keep`, oldest first. Only names carrying
/// `AUTO_PREFIX` count; `keep` is never less than one — the copy just written
/// must survive its own retention pass.
pub fn to_prune(names: &[String], keep: usize) -> Vec<String> {
    let keep = keep.max(1);
    let mut autos: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with(AUTO_PREFIX) && n.ends_with(".zip"))
        .collect();
    autos.sort();
    let extra = autos.len().saturating_sub(keep);
    autos.into_iter().take(extra).cloned().collect()
}

/// Writes one automatic copy and prunes the extra ones. `dir = None` means
/// the `backups` folder of the data directory.
pub fn run(
    db: &Mutex<Connection>,
    dir: Option<&Path>,
    keep: usize,
    now: DateTime<Local>,
) -> anyhow::Result<AutoBackupReport> {
    run_in(&crate::paths::app_dir(), db, dir, keep, now)
}

fn run_in(
    app_dir: &Path,
    db: &Mutex<Connection>,
    dir: Option<&Path>,
    keep: usize,
    now: DateTime<Local>,
) -> anyhow::Result<AutoBackupReport> {
    // The whole run in one turn, as it was when the database lock covered it:
    // a second run in the same minute waits, then overwrites a finished zip,
    // and its pruning never races this one's.
    let _turn = super::backup::TURN.lock();
    let dir: PathBuf = match dir {
        Some(d) => d.to_path_buf(),
        None => app_dir.join("backups"),
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("nao consegui criar a pasta de backups {}: {e}", dir.display()))?;
    let dest = dir.join(file_name(now));
    super::backup::export_in(app_dir, db, &dest)?;
    let bytes = std::fs::metadata(&dest)?.len();

    // Retention: only names this module wrote, sorted by their own stamp.
    let names: Vec<String> = std::fs::read_dir(&dir)?
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let mut pruned = Vec::new();
    for name in to_prune(&names, keep) {
        let path = dir.join(&name);
        match std::fs::remove_file(&path) {
            Ok(()) => pruned.push(path.to_string_lossy().into_owned()),
            // A copy that will not go away is not worth failing the backup
            // that was just written; it is caught on the next pass.
            Err(e) => tracing::warn!(path = %path.display(), error = %e, "nao consegui apagar backup antigo"),
        }
    }
    tracing::info!(dest = %dest.display(), bytes, pruned = pruned.len(), "backup automatico gravado");
    Ok(AutoBackupReport {
        path: dest.to_string_lossy().into_owned(),
        bytes,
        pruned,
    })
}

/// The scheduled (or "Fazer agora") backup. Same lock discipline as
/// `export_backup`: the connection is locked for the WAL checkpoint and the
/// copy of `app.db` only (see `backup::export_in`), so no write lands between
/// the two, and none waits for the zip.
#[tauri::command]
pub async fn backup_auto_run(
    app: AppHandle,
    dir: Option<String>,
    keep: u32,
) -> Result<AutoBackupReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Arc<AppState>>();
        run(
            &state.db,
            dir.as_deref().filter(|d| !d.trim().is_empty()).map(Path::new),
            keep as usize,
            Local::now(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::fs::File;
    use zip::ZipArchive;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yard-autobackup-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test folder");
        dir
    }

    /// A WAL database left open, as the app holds it when the timer fires:
    /// behind the mutex `AppState` keeps it in.
    fn live_db(dir: &Path) -> Mutex<Connection> {
        let conn = Connection::open(dir.join("app.db")).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
            .unwrap();
        conn.execute("INSERT INTO kv(key, value) VALUES ('workspace_rev', '7')", [])
            .unwrap();
        Mutex::new(conn)
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn touch(path: &Path) {
        std::fs::write(path, b"zip").unwrap();
    }

    #[test]
    fn file_name_carries_the_minute_stamp_so_names_sort_like_dates() {
        assert_eq!(file_name(at(2026, 8, 26, 4, 17)), "yard-auto-2026-08-26-0417.zip");
        assert!(file_name(at(2026, 8, 26, 4, 17)) < file_name(at(2026, 8, 26, 13, 5)));
    }

    #[test]
    fn keeps_the_newest_copies_and_names_the_oldest_for_deletion() {
        let all = names(&[
            "yard-auto-2026-08-26-0300.zip",
            "yard-auto-2026-08-24-0300.zip",
            "yard-auto-2026-08-25-0300.zip",
        ]);
        assert_eq!(to_prune(&all, 2), names(&["yard-auto-2026-08-24-0300.zip"]));
        assert_eq!(
            to_prune(&all, 1),
            names(&["yard-auto-2026-08-24-0300.zip", "yard-auto-2026-08-25-0300.zip"])
        );
    }

    /// The retention rule only ever deletes what this module wrote: a manual
    /// export saved into the same folder, or any other file, is not a copy
    /// to rotate.
    #[test]
    fn manual_exports_and_strangers_are_never_pruned() {
        let all = names(&[
            "yard-backup-2026-01-01.zip",
            "notes.txt",
            "yard-auto-2026-08-24-0300.zip",
            "yard-auto-2026-08-25-0300.zip",
            "yard-auto-2026-08-26-0300.zip",
            "yard-auto-2026-08-27-0300.txt",
        ]);
        assert_eq!(
            to_prune(&all, 1),
            names(&["yard-auto-2026-08-24-0300.zip", "yard-auto-2026-08-25-0300.zip"])
        );
    }

    #[test]
    fn keep_zero_still_keeps_the_copy_just_written() {
        let all = names(&["yard-auto-2026-08-25-0300.zip", "yard-auto-2026-08-26-0300.zip"]);
        assert_eq!(to_prune(&all, 0), names(&["yard-auto-2026-08-25-0300.zip"]));
    }

    #[test]
    fn fewer_copies_than_keep_prunes_nothing() {
        let all = names(&["yard-auto-2026-08-26-0300.zip"]);
        assert!(to_prune(&all, 7).is_empty());
        assert!(to_prune(&[], 1).is_empty());
    }

    #[test]
    fn run_writes_the_zip_and_prunes_the_extra_automatic_copies() {
        let app = temp_dir("run");
        let conn = live_db(&app);
        let dir = app.join("bk");
        std::fs::create_dir_all(&dir).unwrap();
        for old in [
            "yard-auto-2026-08-20-0300.zip",
            "yard-auto-2026-08-21-0300.zip",
            "yard-auto-2026-08-22-0300.zip",
            "yard-backup-2026-08-01.zip",
        ] {
            touch(&dir.join(old));
        }

        let now = at(2026, 8, 26, 4, 17);
        let report = run_in(&app, &conn, Some(&dir), 2, now).unwrap();

        let expected = dir.join("yard-auto-2026-08-26-0417.zip");
        assert_eq!(Path::new(&report.path), expected);
        assert!(report.bytes > 0);
        let mut archive = ZipArchive::new(File::open(&expected).unwrap()).unwrap();
        assert!(archive.by_name("app.db").is_ok(), "the copy carries the database");

        // keep = 2 → the copy just written plus the newest old one survive.
        assert_eq!(
            report.pruned,
            vec![
                dir.join("yard-auto-2026-08-20-0300.zip").to_string_lossy().into_owned(),
                dir.join("yard-auto-2026-08-21-0300.zip").to_string_lossy().into_owned(),
            ]
        );
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            names(&[
                "yard-auto-2026-08-22-0300.zip",
                "yard-auto-2026-08-26-0417.zip",
                "yard-backup-2026-08-01.zip",
            ])
        );
    }

    /// The regression this locks down: the run used to be one turn because
    /// the database lock covered all of it, export and pruning. With that lock
    /// down to the copy, the run holds the backup turn itself until it has
    /// measured its zip and pruned. A second backup (the timer's same-minute
    /// zip asked for twice after a webview reload reset the front end's guard)
    /// that got its turn as soon as the zip was written would rewrite and list
    /// the folder while this run was still deleting from it.
    #[test]
    fn another_backup_gets_its_turn_only_after_the_run_has_pruned() {
        use std::time::{Duration, Instant};
        let app = temp_dir("turno");
        let db = live_db(&app);
        let dir = app.join("bk");
        std::fs::create_dir_all(&dir).unwrap();
        // Enough old copies that the pruning takes a while: a turn handed over
        // when the zip is written finds them still there.
        let old: Vec<PathBuf> = (0..300u32)
            .map(|i| dir.join(file_name(at(2026, 7, 1 + i / 24, i % 24, 30))))
            .collect();
        for p in &old {
            touch(p);
        }
        let now = at(2026, 8, 26, 4, 17);
        let dest = dir.join(file_name(now));

        std::thread::scope(|s| {
            let (app, db, dir) = (&app, &db, &dir);
            let run = s.spawn(move || run_in(app, db, Some(dir), 1, now).unwrap());
            // Plays the second backup: it takes turns like any export, and the
            // first turn it gets once the zip exists must find the pruning done.
            let deadline = Instant::now() + Duration::from_secs(20);
            let left = loop {
                {
                    let _turn = super::super::backup::TURN.lock();
                    if dest.exists() {
                        break old.iter().filter(|p| p.exists()).count();
                    }
                }
                assert!(Instant::now() < deadline, "the run never wrote its zip");
                std::thread::yield_now();
            };
            assert_eq!(left, 0, "{left} old copies still there when the turn came");
            assert_eq!(run.join().unwrap().pruned.len(), old.len());
        });
        drop(db);
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn run_defaults_to_the_backups_folder_of_the_data_dir_and_creates_it() {
        let app = temp_dir("default");
        let conn = live_db(&app);
        let report = run_in(&app, &conn, None, 3, at(2026, 8, 26, 4, 17)).unwrap();
        assert_eq!(
            Path::new(&report.path),
            app.join("backups").join("yard-auto-2026-08-26-0417.zip")
        );
        assert!(Path::new(&report.path).is_file());
        assert!(report.pruned.is_empty());
    }
}
