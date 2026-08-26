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

use std::fs::File;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

/// Builds a `.zip` with the database and every scrollback `.bin`.
/// Returns the path written.
///
/// Takes the **live connection** because of the WAL: see `export_in`. The
/// caller holds the database lock for the whole export, which is also what
/// keeps a write from landing between the checkpoint and the copy.
pub fn export(conn: &Connection, dest: &Path) -> anyhow::Result<PathBuf> {
    export_in(&crate::paths::app_dir(), conn, dest)
}

/// `pub(super)`: the automatic backup (`autobackup.rs`) writes through the
/// same path, so a WAL checkpoint is never skipped by the scheduled copy.
pub(super) fn export_in(app_dir: &Path, conn: &Connection, dest: &Path) -> anyhow::Result<PathBuf> {
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

    let file = File::create(dest)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Streamed, not slurped: the database and every scrollback used to be read
    // into a `Vec` in full before going into the zip, and this app's whole
    // point is keeping the CLIs' history — a few dozen terminals at 4 MB each
    // is a peak of memory nobody asked for.
    let db = app_dir.join("app.db");
    if db.exists() {
        zip.start_file("app.db", opts)?;
        std::io::copy(&mut File::open(&db)?, &mut zip)?;
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
    /// exactly the state the app is in when someone asks for a backup.
    fn live_db(dir: &Path, value: &str) -> Connection {
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
        conn
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
