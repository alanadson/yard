//! `.zip` backup export/import — `app.db` plus the scrollbacks (§F3).
//!
//! Importing is deliberately a **two-step** operation, split across a
//! restart. See `import` for why; the short version is that the connection
//! this process opened at boot is still holding `app.db`, so the only safe
//! moment to replace that file is before the next one exists.
//!
//! Every function has an `_in(app_dir)` twin: the real ones read
//! `crate::paths::app_dir()`, which honours the process-global
//! `YARD_DATA_DIR`, and cargo runs tests in parallel — so the tests drive
//! their own directory instead of fighting over an env var.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, ReentrantMutex};
use rusqlite::Connection;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

/// Builds a `.zip` with the database and every scrollback `.bin`.
/// Returns the path written.
///
/// Takes the **locked connection**, not a bare one, because the lock is only
/// needed for part of the job: see `export_in`.
pub fn export(db: &Mutex<Connection>, dest: &Path) -> anyhow::Result<PathBuf> {
    export_in(&crate::paths::app_dir(), db, dest)
}

/// `pub(super)`: the automatic backup (`autobackup.rs`) writes through the
/// same path, so a WAL checkpoint is never skipped by the scheduled copy.
///
/// The database lock is held for the checkpoint and a plain copy of `app.db`,
/// and released before anything is compressed. It used to cover the whole
/// zip, scrollbacks included (up to 8 MB each), and every autosave and
/// preference write queued behind it for seconds. The scrollbacks were never
/// protected by this lock anyway: the PTY engine writes them on its own.
pub(super) fn export_in(
    app_dir: &Path,
    db: &Mutex<Connection>,
    dest: &Path,
) -> anyhow::Result<PathBuf> {
    let _turn = TURN.lock();
    // Under the turn no export of ours is in flight, so any scratch copy found
    // here was orphaned by a power cut or an OS crash. Swept before the
    // database lock, so the locked window does not grow.
    sweep_orphan_copies(app_dir);
    let copy = {
        let conn = db.lock();
        copy_db_in(app_dir, &conn)?
    };
    zip_in(app_dir, copy, dest)
}

/// Removes the scratch copies (`copy_db_in`) that outlived their handle.
/// `FILE_FLAG_DELETE_ON_CLOSE` lives in memory only: a power cut or a BSOD
/// during the zip leaves the file behind, under a pid and a counter no later
/// process reuses. Errors are ignored: a leftover that will not go must never
/// fail the backup, and the next export tries again. A copy another process
/// still holds open is only marked for deletion (it was opened with delete
/// sharing), so its handle keeps reading.
fn sweep_orphan_copies(app_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(app_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(is_scratch_name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Start of every scratch copy's name: `app.db.backup-<pid>-<seq>.tmp`.
const SCRATCH_PREFIX: &str = "app.db.backup-";

/// Is `name` exactly the shape `copy_db_in` writes? Only those are the sweep's
/// to delete, whatever else sits in the data folder.
fn is_scratch_name(name: &str) -> bool {
    let Some(stamp) = name
        .strip_prefix(SCRATCH_PREFIX)
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    let number = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    matches!(stamp.split_once('-'), Some((pid, seq)) if number(pid) && number(seq))
}

/// One backup at a time. The database lock used to give that for free, held
/// from the first byte of the zip to the last; now that it covers only the
/// copy, two exports aimed at the same file would write it side by side into
/// one corrupt zip. This lock keeps them in turn, and only them: database
/// commands never wait on it. Reentrant because the automatic backup holds
/// it across its export and its pruning (`autobackup::run_in`), the whole
/// run the database lock used to cover. The exit waits on it too
/// (`wait_for_exports`), as it used to wait on the database lock.
pub(super) static TURN: ReentrantMutex<()> = parking_lot::const_reentrant_mutex(());

/// Blocks until no export is in flight, manual or automatic, the automatic
/// run's pruning included. For the exit path: the process exit would kill a
/// zip halfway and leave it with no central directory, and the database lock,
/// which used to cover the whole export, is what made the exit wait before.
/// One uncontended lock when no backup is running.
pub(crate) fn wait_for_exports() {
    drop(TURN.lock());
}

/// `app.db` as it stood right after a WAL checkpoint, in a scratch file that
/// the operating system removes as soon as it is closed (see `scratch_file`).
/// `None` inside when there was no `app.db` to copy.
pub(super) struct DbCopy(Option<File>);

/// Phase one, **under the database lock**: checkpoint, then copy. The copy is
/// what makes releasing the lock safe: a write that lands afterwards goes to
/// the live database, never into the backup, so the zip still carries one
/// consistent moment, the same bytes the old single-phase export zipped.
pub(super) fn copy_db_in(app_dir: &Path, conn: &Connection) -> anyhow::Result<DbCopy> {
    // The database is in WAL, so a commit lives in `app.db-wal` until a
    // checkpoint moves it into `app.db` — and only `app.db` goes into the zip.
    // This line used to be a comment claiming a checkpoint had happened;
    // nothing ran it, and a backup taken mid-session silently missed
    // everything written since SQLite's last automatic checkpoint.
    //
    // TRUNCATE (not PASSIVE): it waits for the WAL to be fully applied instead
    // of giving up quietly, which is the difference between a complete backup
    // and one that only looks complete.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| anyhow::anyhow!("nao consegui esvaziar o WAL antes do backup: {e}"))?;

    let db = app_dir.join("app.db");
    if !db.exists() {
        return Ok(DbCopy(None));
    }
    // Same volume as the database, so the copy is a fast disk-to-disk move;
    // pid plus a counter, so two exports in flight never share a scratch file.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let scratch = app_dir.join(format!(
        "{SCRATCH_PREFIX}{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = scratch_file(&scratch)?;
    // A wide buffer: this runs with the lock held, and 8 KB reads would make
    // the copy, not the disk, the slow part.
    std::io::copy(&mut BufReader::with_capacity(1 << 20, File::open(&db)?), &mut file)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(DbCopy(Some(file)))
}

/// A read-write file that deletes itself when its handle closes, so a copy of
/// the whole database never lingers beside the real one: not after an error,
/// not after a crash halfway through the zip. A power cut or an OS crash does
/// leave it behind (the flag lives in memory); the next export sweeps it
/// (`sweep_orphan_copies`).
#[cfg(windows)]
fn scratch_file(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
    // `truncate`, not `create_new`: a scratch file can only outlive its
    // handle through a power cut, and Windows reuses pids, so a leftover with
    // this very name must be taken over instead of failing the backup.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .open(path)
}

/// Same promise elsewhere: an unlinked file lives exactly as long as its handle.
#[cfg(not(windows))]
fn scratch_file(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    std::fs::remove_file(path)?;
    Ok(file)
}

/// Phase two, **without the lock**: the zip, from the copy and the scrollbacks.
pub(super) fn zip_in(app_dir: &Path, copy: DbCopy, dest: &Path) -> anyhow::Result<PathBuf> {
    let file = File::create(dest)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Streamed, not slurped: the database and every scrollback used to be read
    // into a `Vec` in full before going into the zip, and this app's whole
    // point is keeping the CLIs' history — a few dozen terminals at 4 MB each
    // is a peak of memory nobody asked for.
    if let DbCopy(Some(mut db)) = copy {
        zip.start_file("app.db", opts)?;
        std::io::copy(&mut db, &mut zip)?;
    }

    let sb_dir = app_dir.join("scrollback");
    if let Ok(entries) = std::fs::read_dir(&sb_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("bin") {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            zip.start_file(format!("scrollback/{name}"), opts)?;
            std::io::copy(&mut File::open(&path)?, &mut zip)?;
        }
    }

    zip.finish()?;
    tracing::info!(dest = %dest.display(), "backup exportado");
    Ok(dest.to_path_buf())
}

/// Staging directory an import writes to. Nothing in here is live until
/// `adopt_pending` moves it into place, at the next boot.
fn staging_in(app_dir: &Path) -> PathBuf {
    app_dir.join("import-pendente")
}

/// Is there a restored backup waiting for the next boot?
pub fn has_pending() -> bool {
    staging_in(&crate::paths::app_dir())
        .join("app.db")
        .is_file()
}

/// Discards a staged import before it is adopted. Only the staging directory
/// goes away — the live database and the original zip are untouched, so a
/// cancelled restore can be re-imported.
pub fn cancel_pending() -> anyhow::Result<()> {
    let staging = staging_in(&crate::paths::app_dir());
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
        tracing::info!("importacao de backup cancelada");
    }
    Ok(())
}

/// Unpacks a backup into the staging area. **Nothing live is touched.**
///
/// The obvious implementation — writing straight over `app.db` — is a trap.
/// The SQLite connection this process opened at boot is still pointing at
/// that file, in WAL mode, with its own page cache: overwriting it and
/// deleting `-wal`/`-shm` underneath risks a corrupt database, and every
/// later write (the autosave on window close, a preference toggle) would go
/// on writing the *old* state into the *new* file — so the restored backup
/// would quietly lose to the session that restored it.
///
/// So the import only stages. The swap happens in `adopt_pending`, called by
/// `db::open` before any connection exists. Whatever the user does between
/// importing and restarting lands in the database that is about to be
/// discarded — which is the honest behaviour, and what the UI now says.
pub fn import(src: &Path) -> anyhow::Result<()> {
    import_in(&crate::paths::app_dir(), src)
}

fn import_in(app_dir: &Path, src: &Path) -> anyhow::Result<()> {
    let file = File::open(src)?;
    let mut archive = ZipArchive::new(file)?;

    let staging = staging_in(app_dir);
    // An earlier, abandoned import must not blend into this one.
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    let mut has_db = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(rel) = entry.enclosed_name() else {
            // `enclosed_name` is None on paths with `..` — zip-slip blocked.
            tracing::warn!(name = entry.name(), "entrada de zip suspeita ignorada");
            continue;
        };
        let out = staging.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Streamed on the way in too, for the same reason as `export`.
        std::io::copy(&mut entry, &mut File::create(&out)?)?;
        if rel == Path::new("app.db") {
            has_db = true;
        }
    }

    // Refusing here is what keeps a wrong pick (any other zip) from arming a
    // swap that would replace the workspace with nothing on the next boot.
    if !has_db {
        let _ = std::fs::remove_dir_all(&staging);
        anyhow::bail!("o arquivo nao parece um backup do Yard (nao tem app.db dentro)");
    }
    // ...and the name alone was not enough. A file *called* `app.db` that is
    // not our database armed the swap all the same, and the next boot came up
    // on the "nao consegui abrir o workspace" wall — pointing at a second
    // instance, which is the wrong cause — with the real workspace recoverable
    // only by hand from `app.db.bak`. Opening it here is cheap and moves the
    // refusal to the moment the user can still act on it.
    if let Err(e) = looks_like_yard_db(&staging.join("app.db")) {
        let _ = std::fs::remove_dir_all(&staging);
        anyhow::bail!("o arquivo nao parece um backup do Yard ({e})");
    }

    tracing::info!(src = %src.display(), "backup preparado para o proximo boot");
    Ok(())
}

/// Is this file a Yard database? Opens it and asks for the two tables every
/// schema this app ever wrote has (`kv` since v1, `projects` since v1) — a
/// version-tolerant test, so a backup from an older schema still restores and
/// `db::migrate` brings it forward.
fn looks_like_yard_db(path: &Path) -> anyhow::Result<()> {
    let conn = Connection::open(path)?;
    // The first real query is what tells a SQLite file from anything else:
    // `open` alone is lazy and succeeds on any path.
    let tables: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name IN ('kv', 'projects')",
        [],
        |r| r.get(0),
    )?;
    if tables < 2 {
        anyhow::bail!("o banco nao tem as tabelas do workspace");
    }
    Ok(())
}

/// Moves a staged import into place. Called by `db::open`, **before** the
/// connection exists — the only point where replacing `app.db` is safe.
///
/// The database being replaced is kept as `app.db.bak`: importing the wrong
/// file must not be a one-way door.
pub fn adopt_pending() -> anyhow::Result<bool> {
    adopt_pending_in(&crate::paths::app_dir())
}

fn adopt_pending_in(app_dir: &Path) -> anyhow::Result<bool> {
    let staging = staging_in(app_dir);
    let incoming_db = staging.join("app.db");
    if !incoming_db.is_file() {
        return Ok(false);
    }

    let db_path = app_dir.join("app.db");
    if db_path.exists() {
        let _ = std::fs::copy(&db_path, db_path.with_extension("db.bak"));
    }

    std::fs::copy(&incoming_db, &db_path)?;
    // Leftovers of the replaced database describe pages that no longer exist.
    for ext in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(app_dir.join(format!("app.{ext}")));
    }

    // Scrollbacks travel with the database: a terminal restored from the
    // backup should find its own history, not this machine's.
    let incoming_sb = staging.join("scrollback");
    if incoming_sb.is_dir() {
        let sb_dir = app_dir.join("scrollback");
        let _ = std::fs::remove_dir_all(&sb_dir);
        std::fs::create_dir_all(&sb_dir)?;
        if let Ok(entries) = std::fs::read_dir(&incoming_sb) {
            for entry in entries.flatten() {
                let from = entry.path();
                if from.extension().and_then(|e| e.to_str()) != Some("bin") {
                    continue;
                }
                if let Some(name) = from.file_name() {
                    let _ = std::fs::copy(&from, sb_dir.join(name));
                }
            }
        }
    }

    let _ = std::fs::remove_dir_all(&staging);
    tracing::info!("backup importado adotado no boot");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yard-backup-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test folder");
        dir
    }

    /// A zip with `app.db` and one scrollback, built by hand so the test does
    /// not depend on `export` (which reads the real data directory).
    fn make_backup(dest: &Path, db_body: &[u8], sb_body: &[u8]) {
        let mut zip = ZipWriter::new(File::create(dest).unwrap());
        let opts = SimpleFileOptions::default();
        zip.start_file("app.db", opts).unwrap();
        zip.write_all(db_body).unwrap();
        zip.start_file("scrollback/abc.bin", opts).unwrap();
        zip.write_all(sb_body).unwrap();
        zip.finish().unwrap();
    }

    /// Opens a WAL database in `dir` and writes one row **without closing it** —
    /// exactly the state the app is in when someone asks for a backup, down to
    /// the mutex `AppState` keeps it behind.
    fn live_db(dir: &Path, value: &str) -> Mutex<Connection> {
        let conn = Connection::open(dir.join("app.db")).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
            .unwrap();
        conn.execute(
            "INSERT INTO kv(key, value) VALUES ('workspace_rev', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [value],
        )
        .unwrap();
        Mutex::new(conn)
    }

    fn rev_in(conn: &Connection) -> String {
        conn.query_row("SELECT value FROM kv WHERE key = 'workspace_rev'", [], |r| r.get(0))
            .unwrap()
    }

    /// Everything in `dir`, by name, sorted.
    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The reason the lock got narrower: compressing every scrollback (up to
    /// 8 MB each) used to happen with the database locked, and every autosave
    /// and preference write queued behind it for seconds. Now the lock covers
    /// the checkpoint and the copy only, so a write can land while the zip is
    /// still being built. It must not have to wait for it, and it must not
    /// leak into it: the backup is the database as of the copy. The write is
    /// checkpointed into `app.db` itself, so a zip that read the live file
    /// instead of the copy would carry it.
    #[test]
    fn a_write_that_lands_while_the_zip_is_built_neither_waits_nor_leaks_into_it() {
        let app = temp_dir("fatia");
        let db = live_db(&app, "42");

        let copy = copy_db_in(&app, &db.lock()).unwrap();

        let live = db.try_lock().expect("the lock is free once the copy is taken");
        live.execute("UPDATE kv SET value = '43' WHERE key = 'workspace_rev'", [])
            .unwrap();
        live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        // Still held by "the autosave" while the zip is written: the zip does
        // not need the connection at all.
        let zip = app.join("backup.zip");
        zip_in(&app, copy, &zip).unwrap();
        assert_eq!(rev_in(&live), "43");
        drop(live);

        let restored = db_from_zip(&zip, &app);
        assert_eq!(rev_in(&restored), "42");

        drop(restored);
        drop(db);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// Exports used to be serialized by the database lock they held from start
    /// to finish. With the lock down to the copy, two of them aimed at the
    /// same file (the timer's `yard-auto-<minute>.zip` asked for twice within
    /// a minute, after a reload reset the front end's own guard) would write
    /// their bytes into it side by side. They take turns instead, so the file
    /// is always one whole zip.
    #[test]
    fn exports_aimed_at_the_same_file_take_turns_instead_of_interleaving() {
        let app = temp_dir("vez");
        let db = live_db(&app, "42");
        let sb = app.join("scrollback");
        std::fs::create_dir_all(&sb).unwrap();
        let mut seed: u64 = 7;
        for k in 0..2 {
            let bytes: Vec<u8> = (0..400_000)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    (seed >> 56) as u8
                })
                .collect();
            std::fs::write(sb.join(format!("t{k}.bin")), bytes).unwrap();
        }

        // Each run sees a different database (an autosave landed in between),
        // so two of them mixed in one file cannot pass for either.
        let zip = app.join("backup.zip");
        std::thread::scope(|s| {
            for run in 0..4 {
                let (app, db, zip) = (&app, &db, &zip);
                s.spawn(move || {
                    db.lock()
                        .execute(
                            "UPDATE kv SET value = ?1 WHERE key = 'workspace_rev'",
                            [format!("rodada {run} {}", "x".repeat(run * 500))],
                        )
                        .unwrap();
                    export_in(app, db, zip).unwrap();
                });
            }
        });

        let mut archive = ZipArchive::new(File::open(&zip).unwrap()).expect("one whole zip");
        let mut names = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            names.push(entry.name().to_string());
            // Reading to the end checks the CRC of every entry.
            std::io::copy(&mut entry, &mut std::io::sink()).expect("an entry intact");
        }
        names.sort();
        assert_eq!(
            names,
            vec![
                "app.db",
                "scrollback/t0.bin",
                "scrollback/t1.bin"
            ]
        );

        drop(archive);
        drop(db);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// The regression that motivated the fix: the database lock used to cover
    /// the whole zip, and every way out of the app had to take that lock, so
    /// Yard could not exit halfway through a backup. With the lock narrowed to
    /// the copy, nothing on the exit path waited for the zip, and closing Yard
    /// mid-backup cut it off before its central directory. The exit waits for
    /// the export's turn to end instead, as it used to wait for the lock.
    #[test]
    fn the_exit_waits_for_an_export_that_is_still_zipping() {
        use std::sync::mpsc::{self, RecvTimeoutError};
        use std::time::Duration;
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let export = std::thread::spawn(move || {
            let _turn = TURN.lock();
            held_tx.send(()).unwrap();
            // "Still zipping" until the test says otherwise.
            let _ = release_rx.recv();
        });
        held_rx.recv().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let exit = std::thread::spawn(move || {
            wait_for_exports();
            let _ = done_tx.send(());
        });
        // An absence check needs a bound. Its length can only make a wait that
        // does not wait easier to catch; it never makes the real one flaky,
        // since the export is not released before it runs out.
        assert!(
            matches!(
                done_rx.recv_timeout(Duration::from_millis(300)),
                Err(RecvTimeoutError::Timeout)
            ),
            "the exit went ahead while an export was still being written"
        );
        release_tx.send(()).unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the exit goes ahead once the export is done");
        export.join().unwrap();
        exit.join().unwrap();
    }

    /// The copy is a whole database file sitting beside the real one. It is
    /// scratch for the zip and nothing else, so it goes away with the export,
    /// whether the zip got written or not.
    #[test]
    fn the_database_copy_does_not_outlive_the_export() {
        let app = temp_dir("copia");
        let db = live_db(&app, "42");
        let before = listing(&app);

        let zip = app.join("backup.zip");
        export_in(&app, &db, &zip).unwrap();
        let mut expected = before.clone();
        expected.push("backup.zip".to_string());
        expected.sort();
        assert_eq!(listing(&app), expected);

        let copy = copy_db_in(&app, &db.lock()).unwrap();
        let nowhere = app.join("nao-existe").join("backup.zip");
        assert!(zip_in(&app, copy, &nowhere).is_err());
        assert_eq!(listing(&app), expected);

        drop(db);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// The regression that motivated the fix: the scratch copy of `app.db` is
    /// deleted only when its handle closes, so a power cut or a BSOD during
    /// the zip leaves it on disk, under a pid and a counter no later process
    /// reuses. Each such crash left another full copy of the database beside
    /// the real one for good. The next export sweeps them.
    #[test]
    fn a_scratch_copy_left_by_a_crash_is_swept_by_the_next_export() {
        let app = temp_dir("sobra");
        let db = live_db(&app, "42");
        let before = listing(&app);
        std::fs::write(app.join("app.db.backup-1-0.tmp"), vec![0u8; 4096]).unwrap();
        std::fs::write(app.join("app.db.backup-99999-7.tmp"), b"x").unwrap();

        let zip = app.join("backup.zip");
        export_in(&app, &db, &zip).unwrap();

        let mut expected = before.clone();
        expected.push("backup.zip".to_string());
        expected.sort();
        assert_eq!(listing(&app), expected);

        drop(db);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// The sweep runs in the folder where the user's real work lives, so it
    /// deletes only the names `copy_db_in` writes (a pid and a counter), the
    /// same rule the retention pass follows: a file someone parked there
    /// under a look-alike name is not ours to remove.
    #[test]
    fn the_sweep_leaves_look_alike_names_it_did_not_write() {
        let app = temp_dir("parecido");
        let db = live_db(&app, "42");
        let strangers = [
            "app.db.backup-antes-da-migracao.tmp",
            "app.db.backup-.tmp",
            "app.db.backup-12.tmp",
            "app.db.backup-1-2-3.tmp",
            "app.db.backup-1-x.tmp",
        ];
        for name in strangers {
            std::fs::write(app.join(name), b"not a scratch copy").unwrap();
        }

        export_in(&app, &db, &app.join("backup.zip")).unwrap();

        let left = listing(&app);
        for name in strangers {
            assert!(left.iter().any(|n| n == name), "{name} was swept: {left:?}");
        }

        drop(db);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// Reads `app.db` out of the zip into `dir` and opens it.
    fn db_from_zip(zip: &Path, dir: &Path) -> Connection {
        let mut archive = ZipArchive::new(File::open(zip).unwrap()).unwrap();
        let out = dir.join("restaurado.db");
        let mut entry = archive.by_name("app.db").unwrap();
        std::io::copy(&mut entry, &mut File::create(&out).unwrap()).unwrap();
        Connection::open(&out).unwrap()
    }

    /// The regression this locks: the zip carries `app.db` alone, and in WAL
    /// mode a commit lives in `app.db-wal` until a checkpoint moves it. Without
    /// one, exporting mid-session produced a backup missing everything written
    /// since the last automatic checkpoint (~1000 pages) — silently, with the
    /// UI reporting success.
    #[test]
    fn exported_backup_carries_what_was_just_written() {
        let app = temp_dir("wal");
        let conn = live_db(&app, "42");

        let zip = app.join("backup.zip");
        export_in(&app, &conn, &zip).unwrap();

        let restored = db_from_zip(&zip, &app);
        let rev: String = restored
            .query_row("SELECT value FROM kv WHERE key = 'workspace_rev'", [], |r| {
                r.get(0)
            })
            .expect("the backup must carry the write still in the WAL");
        assert_eq!(rev, "42");

        drop(restored);
        drop(conn);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// What a backup is made of, locked before the database lock was narrowed
    /// to the checkpoint and the copy: `app.db` first, byte for byte the file
    /// the checkpoint left on disk, then every `scrollback/*.bin` untouched,
    /// all deflated, and nothing else from the data directory.
    #[test]
    fn the_zip_holds_the_checkpointed_db_then_every_scrollback_and_nothing_else() {
        let app = temp_dir("conteudo");
        let conn = live_db(&app, "42");
        let sb = app.join("scrollback");
        std::fs::create_dir_all(&sb).unwrap();
        std::fs::write(sb.join("t1.bin"), b"historico um").unwrap();
        std::fs::write(sb.join("t2.bin"), vec![7u8; 64 * 1024]).unwrap();
        std::fs::write(sb.join("leiame.txt"), b"nao entra").unwrap();

        let zip = app.join("backup.zip");
        export_in(&app, &conn, &zip).unwrap();

        let mut archive = ZipArchive::new(File::open(&zip).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert_eq!(names.first().map(String::as_str), Some("app.db"));
        let mut rest = names[1..].to_vec();
        rest.sort();
        assert_eq!(rest, vec!["scrollback/t1.bin", "scrollback/t2.bin"]);

        let read = |archive: &mut ZipArchive<File>, name: &str| {
            let mut entry = archive.by_name(name).unwrap();
            assert_eq!(entry.compression(), zip::CompressionMethod::Deflated);
            let mut out = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut out).unwrap();
            out
        };
        // Nothing was written after the export, so the file on disk is still
        // exactly what the checkpoint produced.
        assert_eq!(read(&mut archive, "app.db"), std::fs::read(app.join("app.db")).unwrap());
        assert_eq!(read(&mut archive, "scrollback/t1.bin"), b"historico um");
        assert_eq!(read(&mut archive, "scrollback/t2.bin"), vec![7u8; 64 * 1024]);

        drop(archive);
        drop(conn);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// Bytes of a real (tiny) Yard database — what a backup actually carries,
    /// and what `import` now insists on seeing before it arms a swap.
    fn bytes_of_a_db(dir: &Path, marker: &str) -> Vec<u8> {
        let path = dir.join(format!("modelo-{marker}.db"));
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
            )
            .unwrap();
            c.execute("INSERT INTO kv(key, value) VALUES ('marca', ?1)", [marker])
                .unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        bytes
    }

    /// The whole point of the split: importing leaves the live database alone,
    /// and only the next boot adopts the restored one.
    #[test]
    fn import_leaves_the_live_db_alone_until_the_next_boot() {
        let app = temp_dir("ciclo");
        std::fs::create_dir_all(app.join("scrollback")).unwrap();
        let current = bytes_of_a_db(&app, "atual");
        let do_backup = bytes_of_a_db(&app, "backup");
        std::fs::write(app.join("app.db"), &current).unwrap();
        std::fs::write(app.join("app.db-wal"), b"wal antigo").unwrap();
        std::fs::write(app.join("scrollback").join("velho.bin"), b"historico atual").unwrap();

        let zip = app.join("backup.zip");
        make_backup(&zip, &do_backup, b"historico do backup");

        import_in(&app, &zip).unwrap();
        // Still untouched: whoever is running keeps their own database.
        assert_eq!(std::fs::read(app.join("app.db")).unwrap(), current);
        assert!(staging_in(&app).join("app.db").is_file());

        assert!(adopt_pending_in(&app).unwrap());
        assert_eq!(std::fs::read(app.join("app.db")).unwrap(), do_backup);
        // The replaced database is still recoverable.
        assert_eq!(std::fs::read(app.join("app.db.bak")).unwrap(), current);
        // An orphaned WAL described pages that no longer exist.
        assert!(!app.join("app.db-wal").exists());
        // The scrollback came along and the machine's own one is gone.
        assert_eq!(
            std::fs::read(app.join("scrollback").join("abc.bin")).unwrap(),
            b"historico do backup"
        );
        assert!(!app.join("scrollback").join("velho.bin").exists());
        // Adopted exactly once.
        assert!(!adopt_pending_in(&app).unwrap());

        let _ = std::fs::remove_dir_all(&app);
    }

    /// With no pending import, boot touches nothing.
    #[test]
    fn boot_without_a_pending_import_does_nothing() {
        let app = temp_dir("vazio");
        std::fs::write(app.join("app.db"), b"intacto").unwrap();
        assert!(!adopt_pending_in(&app).unwrap());
        assert_eq!(std::fs::read(app.join("app.db")).unwrap(), b"intacto");
        assert!(!app.join("app.db.bak").exists());
        let _ = std::fs::remove_dir_all(&app);
    }

    /// The other half of the same guard: the entry is *named* `app.db` but is
    /// not a Yard database. The check used to be the file name alone, so a zip
    /// like this armed a swap that the next boot adopted — and the app came up
    /// on the "não consegui abrir o workspace" wall, blaming a second instance,
    /// with the real workspace recoverable only by hand from `app.db.bak`.
    #[test]
    fn zip_with_a_fake_db_is_refused_before_arming_the_swap() {
        let app = temp_dir("banco-falso");
        let zip = app.join("falso.zip");
        make_backup(&zip, b"isto nao e um sqlite", b"historico");

        let err = import_in(&app, &zip).unwrap_err().to_string();
        assert!(
            err.contains("backup do Yard"),
            "the message must say what is wrong: {err}"
        );
        assert!(!staging_in(&app).exists());

        let _ = std::fs::remove_dir_all(&app);
    }

    /// And a real SQLite that simply is not ours (any other app's database).
    #[test]
    fn sqlite_db_from_another_app_is_refused_too() {
        let app = temp_dir("banco-alheio");
        let foreign = app.join("outro.db");
        {
            let c = Connection::open(&foreign).unwrap();
            c.execute_batch("CREATE TABLE receitas (id TEXT PRIMARY KEY)")
                .unwrap();
        }
        let zip = app.join("alheio.zip");
        make_backup(&zip, &std::fs::read(&foreign).unwrap(), b"historico");

        assert!(import_in(&app, &zip).is_err());
        assert!(!staging_in(&app).exists());

        let _ = std::fs::remove_dir_all(&app);
    }

    /// Just any zip must not be able to stage a swap that would erase the workspace.
    #[test]
    fn zip_without_a_db_is_refused_and_leaves_nothing_pending() {
        let app = temp_dir("errado");
        let zip = app.join("qualquer.zip");
        {
            let mut z = ZipWriter::new(File::create(&zip).unwrap());
            z.start_file("leiame.txt", SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"nao sou um backup").unwrap();
            z.finish().unwrap();
        }
        assert!(import_in(&app, &zip).is_err());
        assert!(!staging_in(&app).exists());
        let _ = std::fs::remove_dir_all(&app);
    }
}
