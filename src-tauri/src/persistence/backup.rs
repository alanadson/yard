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
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, ReentrantMutex};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

const OWNED_FOLDERS: &[(&str, &[&str])] = &[
    ("scrollback-archives", &["bin"]),
    ("partituras", &["json"]),
    ("checkpoints", &["json", "zip"]),
    ("attachments", &["png", "jpg", "gif", "bmp", "webp"]),
];

/// What a backup carries besides `app.db` (which every backup has).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Scope {
    /// A manual export: every owned folder, terminal output included.
    Full,
    /// The automatic copy, kept several times over: the database (preferences
    /// included), scores and attachments. Terminal output, archived sessions
    /// and code checkpoints are large, rebuildable or local recovery data, and
    /// were multiplied by the retention count.
    Light,
}

impl Scope {
    /// Whether this scope carries the owned `folder` (`scrollback` or one of
    /// `OWNED_FOLDERS`).
    pub(super) fn includes(self, folder: &str) -> bool {
        match self {
            Scope::Full => true,
            Scope::Light => matches!(folder, "partituras" | "attachments"),
        }
    }
}

/// Entries that are already compressed (archives, images) are stored as they
/// are: deflating them again costs CPU and saves nothing.
fn compression_for(path: &str) -> zip::CompressionMethod {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase());
    match extension.as_deref() {
        Some("zip" | "png" | "jpg" | "jpeg" | "webp" | "gif") => zip::CompressionMethod::Stored,
        _ => zip::CompressionMethod::Deflated,
    }
}

/// Whether restoring replaces the live `folder`. An inventory that lists the
/// folders its backup covers replaces exactly those; an inventory written
/// before that list existed covered every owned folder; a backup without an
/// inventory replaces only the folders it carries.
fn replaces_folder(folder: &str, covered: Option<&[String]>, complete_inventory: bool, carried: bool) -> bool {
    match covered {
        Some(covered) => covered.iter().any(|name| name == folder),
        None => complete_inventory || carried,
    }
}

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
    export_scoped_in(app_dir, db, dest, Scope::Full)
}

/// `export_in` for a chosen `Scope` (the automatic backup is `Light`).
pub(super) fn export_scoped_in(
    app_dir: &Path,
    db: &Mutex<Connection>,
    dest: &Path,
    scope: Scope,
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
    zip_scoped_in(app_dir, copy, dest, scope)
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

/// `zip_scoped_in` of a manual (full) backup, for the tests that hold the
/// copy and the zip apart.
#[cfg(test)]
fn zip_in(app_dir: &Path, copy: DbCopy, dest: &Path) -> anyhow::Result<PathBuf> {
    zip_scoped_in(app_dir, copy, dest, Scope::Full)
}

/// Phase two, **without the lock**: the zip, from the copy and the owned
/// files the `scope` carries.
fn zip_scoped_in(app_dir: &Path, copy: DbCopy, dest: &Path, scope: Scope) -> anyhow::Result<PathBuf> {
    let file = File::create(dest)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut files = Vec::new();

    // Streamed, not slurped: the database and every scrollback used to be read
    // into a `Vec` in full before going into the zip, and this app's whole
    // point is keeping the CLIs' history — a few dozen terminals at 4 MB each
    // is a peak of memory nobody asked for.
    if let DbCopy(Some(mut db)) = copy {
        files.push(write_inventory_entry(&mut zip, &mut db, "app.db", opts)?);
    }

    let sb_dir = app_dir.join("scrollback");
    let entries = if scope.includes("scrollback") { std::fs::read_dir(&sb_dir).ok() } else { None };
    if let Some(entries) = entries {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("bin") {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            let archive_path = format!("scrollback/{name}");
            files.push(write_inventory_entry(&mut zip, &mut File::open(&path)?, &archive_path, opts)?);
        }
    }

    for (folder, extensions) in OWNED_FOLDERS {
        let directory = app_dir.join(folder);
        if !scope.includes(folder) || !directory.exists() {
            continue;
        }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            if !path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extensions.contains(&extension)) {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| anyhow::anyhow!("backup file name is not valid UTF-8"))?;
            let archive_path = format!("{folder}/{name}");
            let options = opts.compression_method(compression_for(&archive_path));
            files.push(write_inventory_entry(&mut zip, &mut File::open(path)?, &archive_path, options)?);
        }
    }

    // The owned folders this backup speaks for: restoring it replaces those
    // and leaves the others as they are (`replaces_folder`).
    let folders: Vec<&str> = std::iter::once("scrollback")
        .chain(OWNED_FOLDERS.iter().map(|(folder, _)| *folder))
        .filter(|folder| scope.includes(folder))
        .collect();
    zip.start_file("manifest.json", opts)?;
    // A light backup is version 2: builds from before `folders` read any
    // inventory as covering every owned folder, and refusing it is what keeps
    // them from emptying the folders it leaves out.
    let version = if scope == Scope::Full { 1 } else { 2 };
    serde_json::to_writer(&mut zip, &serde_json::json!({ "format": "yard-backup", "version": version, "sourceRoot": app_dir.to_string_lossy(), "folders": folders, "files": files }))?;
    zip.finish()?;
    tracing::info!(dest = %dest.display(), "backup exportado");
    Ok(dest.to_path_buf())
}

fn write_inventory_entry(zip: &mut ZipWriter<File>, source: &mut impl Read, path: &str, options: SimpleFileOptions) -> anyhow::Result<serde_json::Value> {
    zip.start_file(path, options)?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 { break; }
        zip.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    Ok(serde_json::json!({ "path": path, "size": size, "sha256": format!("{:x}", hash.finalize()) }))
}

#[derive(serde::Deserialize, specta::Type)]
struct BackupInventory {
    format: String,
    version: u32,
    files: Vec<BackupInventoryFile>,
    #[serde(default, rename = "sourceRoot")]
    source_root: Option<String>,
}

#[derive(serde::Deserialize, specta::Type)]
struct BackupInventoryFile {
    path: String,
    size: u64,
    sha256: String,
}

fn verify_inventory(archive: &mut ZipArchive<File>) -> anyhow::Result<Option<String>> {
    let inventory: BackupInventory = {
        let manifest = match archive.by_name("manifest.json") {
            Ok(entry) => Some(entry),
            Err(zip::result::ZipError::FileNotFound) => None,
            Err(error) => return Err(error.into()),
        };
        let Some(manifest) = manifest else { return Ok(None) };
        if manifest.size() > 16 * 1024 * 1024 { anyhow::bail!("backup integrity: inventory is too large"); }
        serde_json::from_reader(manifest)?
    };
    if inventory.format != "yard-backup" || !matches!(inventory.version, 1 | 2) { anyhow::bail!("backup integrity: unsupported inventory format"); }
    let mut names = std::collections::HashSet::new();
    for record in inventory.files {
        if !names.insert(record.path.clone()) { anyhow::bail!("backup integrity: duplicate inventory path"); }
        let mut entry = archive.by_name(&record.path)?;
        if entry.size() != record.size { anyhow::bail!("backup integrity: size mismatch for {}", record.path); }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = entry.read(&mut buffer)?;
            if count == 0 { break; }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != record.sha256 { anyhow::bail!("backup integrity: digest mismatch for {}", record.path); }
    }
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if entry.name() != "manifest.json" && !entry.is_dir() && !names.contains(entry.name()) { anyhow::bail!("backup integrity: unlisted file"); }
    }
    Ok(inventory.source_root)
}

fn is_owned_archive_path(name: &str, directory: bool) -> bool {
    let folders = OWNED_FOLDERS.iter().copied().chain(std::iter::once(("scrollback", &["bin"][..])));
    if directory {
        return folders.into_iter().any(|(folder, _)| name == format!("{folder}/"));
    }
    if matches!(name, "app.db" | "manifest.json") { return true; }
    let Some((folder, file)) = name.split_once('/') else { return false };
    if file.is_empty() || file.contains(['/', '\\', ':']) || file.ends_with(['.', ' ']) { return false; }
    folders.into_iter().any(|(owned, extensions)| folder == owned && file.rsplit_once('.').is_some_and(|(_, extension)| extensions.contains(&extension)))
}

fn validate_archive_paths(archive: &mut ZipArchive<File>) -> anyhow::Result<()> {
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    if archive.len() > 100_000 { anyhow::bail!("backup contains too many entries"); }
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if !is_owned_archive_path(entry.name(), entry.is_dir()) {
            anyhow::bail!("backup contains an unowned or invalid path: {}", entry.name());
        }
        if !names.insert(entry.name().trim_end_matches('/').to_uppercase()) {
            anyhow::bail!("backup contains paths that alias on Windows: {}", entry.name());
        }
        let limit = if entry.name().ends_with(".json") { 16 * 1024 * 1024 } else { 2 * 1024 * 1024 * 1024 };
        if entry.size() > limit { anyhow::bail!("backup entry exceeds its size limit: {}", entry.name()); }
        total = total.checked_add(entry.size()).ok_or_else(|| anyhow::anyhow!("backup size overflow"))?;
        if total > 4 * 1024 * 1024 * 1024 { anyhow::bail!("backup exceeds its expanded size limit"); }
    }
    Ok(())
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
    let _turn = TURN.lock();
    let file = File::open(src)?;
    let mut archive = ZipArchive::new(file)?;
    validate_archive_paths(&mut archive)?;
    let source_root = verify_inventory(&mut archive)?;

    let staging = app_dir.join("import-em-preparo");
    // An earlier, abandoned import must not blend into this one.
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let _cleanup = StagingCleanup(staging.clone());

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
    if let Some(source_root) = source_root { rebase_owned_image_references(&staging, &source_root, app_dir)?; }

    let pending = staging_in(app_dir);
    let previous = app_dir.join("import-anterior");
    if previous.exists() { std::fs::remove_dir_all(&previous)?; }
    let had_pending = pending.exists();
    if had_pending { std::fs::rename(&pending, &previous)?; }
    if let Err(error) = std::fs::rename(&staging, &pending) {
        if had_pending { std::fs::rename(&previous, &pending)?; }
        return Err(error.into());
    }
    if had_pending { std::fs::remove_dir_all(&previous)?; }
    tracing::info!(src = %src.display(), "backup preparado para o proximo boot");
    Ok(())
}

struct StagingCleanup(PathBuf);

fn rebase_owned_image_references(staging: &Path, source_root: &str, target_root: &Path) -> anyhow::Result<()> {
    let attachments = staging.join("attachments");
    if !attachments.is_dir() { return Ok(()); }
    let target = target_root.to_string_lossy();
    let mut replacements = std::collections::BTreeMap::new();
    for entry in std::fs::read_dir(attachments)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        for (source, target) in [(source_root.to_string(), target.to_string()), (source_root.replace('\\', "/"), target.replace('\\', "/"))] {
            for directory_separator in ['/', '\\'] {
                for file_separator in ['/', '\\'] {
                    let suffix = format!("{directory_separator}attachments{file_separator}{name}");
                    replacements.insert(format!("{}{suffix}", source.trim_end_matches(['/', '\\'])), format!("{}{suffix}", target.trim_end_matches(['/', '\\'])));
                }
            }
        }
    }
    let rewrite_text = |text: &str| {
        let mut rewritten = text.to_string();
        for (source, target) in &replacements {
            let mut next = String::new();
            let mut copied = 0;
            for (start, _) in rewritten.match_indices(source) {
                let end = start + source.len();
                let boundary = |character: char| character.is_whitespace() || matches!(character, '@' | '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '<' | '>');
                if rewritten[..start].chars().next_back().is_some_and(|character| !boundary(character)) || rewritten[end..].chars().next().is_some_and(|character| !boundary(character)) { continue; }
                next.push_str(&rewritten[copied..start]); next.push_str(target); copied = end;
            }
            next.push_str(&rewritten[copied..]); rewritten = next;
        }
        rewritten
    };
    fn visit(value: &mut serde_json::Value, rewrite: &impl Fn(&str) -> String) {
        match value {
            serde_json::Value::String(text) => *text = rewrite(text),
            serde_json::Value::Array(values) => values.iter_mut().for_each(|value| visit(value, rewrite)),
            serde_json::Value::Object(fields) => fields.values_mut().for_each(|value| visit(value, rewrite)),
            _ => {}
        }
    }
    let rewrite = |text: &str| -> anyhow::Result<String> {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text) {
            let original = value.clone(); visit(&mut value, &rewrite_text);
            if original == value { return Ok(text.to_string()); }
            Ok(serde_json::to_string(&value)?)
        } else { Ok(rewrite_text(text)) }
    };
    let connection = Connection::open(staging.join("app.db"))?;
    let transaction = connection.unchecked_transaction()?;
    for (table, key, columns) in [
        ("kv", "key", &["value"][..]), ("notes", "id", &["body"][..]),
        ("groups", "id", &["layout_json"][..]), ("terminals", "id", &["args_json", "resume_json"][..]),
        ("work_tasks", "id", &["request", "criteria_json", "delivery_json"][..]),
        ("work_task_deliveries", "rowid", &["criteria_json", "delivery_json"][..]),
    ] {
        for column in columns {
            let mut statement = transaction.prepare(&format!("SELECT CAST({key} AS TEXT), {column} FROM {table} WHERE {column} IS NOT NULL"))?;
            let rows: Vec<(String, String)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<_, _>>()?;
            drop(statement);
            for (key_value, original) in rows {
                let updated = rewrite(&original)?;
                if updated != original { transaction.execute(&format!("UPDATE {table} SET {column} = ?1 WHERE {key} = ?2"), rusqlite::params![updated, key_value])?; }
            }
        }
    }
    transaction.commit()?;
    let scores = staging.join("partituras");
    if scores.is_dir() {
        for entry in std::fs::read_dir(scores)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() { continue; }
            let original = std::fs::read_to_string(entry.path())?;
            let updated = rewrite(&original)?;
            if updated != original { std::fs::write(entry.path(), updated)?; }
        }
    }
    Ok(())
}

impl Drop for StagingCleanup {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// Validate and migrate only the staged copy, before it can replace live data.
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
    let integrity: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" { anyhow::bail!("backup database integrity check failed: {integrity}"); }
    super::db::migrate(&conn)?;
    super::workspace::load(&conn)?;
    super::db::kv_all(&conn)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
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

pub(super) fn adopt_pending_in(app_dir: &Path) -> anyhow::Result<bool> {
    adopt_pending_using(app_dir, |from, to| std::fs::rename(from, to))
}

fn adopt_pending_using(app_dir: &Path, mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>) -> anyhow::Result<bool> {
    let _turn = TURN.lock();
    recover_interrupted_restore(app_dir)?;
    let staging = staging_in(app_dir);
    let incoming_db = staging.join("app.db");
    if !incoming_db.is_file() {
        return Ok(false);
    }

    for (folder, _) in OWNED_FOLDERS.iter().copied().chain(std::iter::once(("scrollback", &[][..]))) {
        let target = app_dir.join(folder);
        if target.exists() && !target.is_dir() { anyhow::bail!("restore directory is blocked: {folder}"); }
    }

    looks_like_yard_db(&incoming_db)?;
    let prepared = app_dir.join("restore-prepared");
    remove_owned_path(&prepared)?;
    std::fs::create_dir_all(&prepared)?;
    let _cleanup = StagingCleanup(prepared.clone());
    std::fs::copy(&incoming_db, prepared.join("app.db"))?;
    let complete_inventory = staging.join("manifest.json").is_file();
    let covered = covered_folders(&staging);
    let mut replacements = vec!["app.db".to_string()];
    for (folder, extensions) in OWNED_FOLDERS.iter().copied().chain(std::iter::once(("scrollback", &["bin"][..]))) {
        let incoming = staging.join(folder);
        if !replaces_folder(folder, covered.as_deref(), complete_inventory, incoming.is_dir()) { continue; }
        let destination = prepared.join(folder);
        std::fs::create_dir_all(&destination)?;
        if incoming.is_dir() {
            for entry in std::fs::read_dir(incoming)? {
                let entry = entry?;
                if !entry.file_type()?.is_file() { anyhow::bail!("restore contains a non-file artifact"); }
                if !entry.path().extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extensions.contains(&extension)) { continue; }
                std::fs::copy(entry.path(), destination.join(entry.file_name()))?;
            }
        }
        replacements.push(folder.to_string());
    }
    let previous = app_dir.join("restore-previous");
    remove_owned_path(&previous)?;
    std::fs::create_dir_all(&previous)?;
    let live_db = app_dir.join("app.db");
    if live_db.is_file() { std::fs::copy(&live_db, app_dir.join("app.db.bak"))?; }
    let names: Vec<String> = replacements.iter().cloned().chain(["app.db-wal".to_string(), "app.db-shm".to_string()]).collect();
    let mut journal = RestoreJournal {
        existed: names.iter().filter(|name| app_dir.join(name).exists()).cloned().collect(),
        replacements: names,
        committed: false,
    };
    write_restore_journal(app_dir, &journal)?;
    let outcome = (|| -> anyhow::Result<()> {
        for name in replacements.iter().map(String::as_str).chain(["app.db-wal", "app.db-shm"]) {
            let live = app_dir.join(name);
            if live.exists() {
                rename(&live, &previous.join(name))?;
            }
            if replacements.iter().any(|replacement| replacement == name) {
                rename(&prepared.join(name), &live)?;
            }
        }
        journal.committed = true;
        write_restore_journal(app_dir, &journal)
    })();
    if let Err(error) = outcome {
        recover_interrupted_restore(app_dir)?;
        return Err(error);
    }
    recover_interrupted_restore(app_dir)?;
    tracing::info!("backup importado adotado no boot");
    Ok(true)
}

/// The owned folders a staged backup's inventory says it covers, or `None`
/// for an inventory written before that list existed (or no inventory).
fn covered_folders(staging: &Path) -> Option<Vec<String>> {
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(staging.join("manifest.json")).ok()?).ok()?;
    manifest.get("folders")?.as_array()?.iter().map(|folder| folder.as_str().map(str::to_string)).collect()
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
struct RestoreJournal {
    replacements: Vec<String>,
    existed: Vec<String>,
    committed: bool,
}

fn write_restore_journal(app_dir: &Path, journal: &RestoreJournal) -> anyhow::Result<()> {
    let temporary = app_dir.join("restore-journal.tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, journal)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temporary, app_dir.join("restore-journal.json"))?;
    Ok(())
}

fn recover_interrupted_restore(app_dir: &Path) -> anyhow::Result<()> {
    let path = app_dir.join("restore-journal.json");
    if !path.exists() { return Ok(()); }
    let journal: RestoreJournal = serde_json::from_reader(File::open(&path)?)?;
    let owned = |name: &str| matches!(name, "app.db" | "app.db-wal" | "app.db-shm" | "scrollback") || OWNED_FOLDERS.iter().any(|(folder, _)| *folder == name);
    if journal.replacements.iter().chain(&journal.existed).any(|name| !owned(name)) { anyhow::bail!("restore journal contains an unowned path"); }
    if journal.committed {
        remove_owned_path(&staging_in(app_dir))?;
    } else {
        for name in journal.replacements.iter().rev() {
            let previous = app_dir.join("restore-previous").join(name);
            let live = app_dir.join(name);
            if previous.exists() {
                remove_owned_path(&live)?;
                std::fs::rename(previous, live)?;
            } else if !journal.existed.contains(name) {
                remove_owned_path(&live)?;
            }
        }
    }
    std::fs::remove_file(path)?;
    Ok(())
}

fn remove_owned_path(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Imported managed files must remain usable after moving the data directory.
    #[test]
    fn restoring_to_another_data_directory_rebases_owned_image_references() {
        let source = temp_dir("image-reference-source");
        let target = temp_dir("image-reference-target");
        let database = live_db(&source, "42");
        super::super::db::migrate(&database.lock()).unwrap();
        std::fs::create_dir_all(source.join("attachments")).unwrap();
        std::fs::create_dir_all(source.join("partituras")).unwrap();
        std::fs::write(source.join("attachments/capture.png"), b"managed image").unwrap();
        let original = source.join("attachments/capture.png").to_string_lossy().into_owned();
        let expected = target.join("attachments/capture.png").to_string_lossy().into_owned();
        let payload = serde_json::json!({ "text": format!("Inspect {original}"), "external": "C:/projects/attachments/external.png" });
        super::super::db::kv_set(&database.lock(), "draft", &payload.to_string()).unwrap();
        database.lock().execute("INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('image-note', 'Image', ?1, 1000, 1000)", [&original]).unwrap();
        let task = crate::work::create(&mut database.lock(), crate::work::NewTask {
            id: "image-task".into(), title: "Inspect image".into(), request: original.clone(), criteria: vec![], links: Default::default(),
        }, 1000).unwrap();
        let queued = crate::work::transition(&mut database.lock(), &task.id, task.revision, "queued", 2000).unwrap();
        let running = crate::work::transition(&mut database.lock(), &task.id, queued.revision, "running", 3000).unwrap();
        crate::work::submit(&mut database.lock(), &task.id, running.revision, crate::work::Submission {
            attempt_id: None,
            delivery: crate::work::Delivery { summary: "Image inspected".into(), artifacts: vec![original.clone()], checks: vec![] }, evidence: Default::default(),
        }, 4000).unwrap();
        std::fs::write(source.join("partituras/image.json"), payload.to_string()).unwrap();
        let archive = source.join("backup.zip");
        export_in(&source, &database, &archive).unwrap();
        import_in(&target, &archive).unwrap();
        adopt_pending_in(&target).unwrap();
        let restored = Connection::open(target.join("app.db")).unwrap();
        let draft: serde_json::Value = serde_json::from_str(&super::super::db::kv_get(&restored, "draft").unwrap()).unwrap();
        assert_eq!(draft["text"], format!("Inspect {expected}"));
        assert_eq!(draft["external"], payload["external"]);
        assert_eq!(crate::work::get(&restored, "image-task").unwrap().request, expected);
        assert_eq!(crate::work::deliveries(&restored, "image-task").unwrap()[0].delivery.artifacts, [expected.clone()]);
        assert_eq!(restored.query_row("SELECT body FROM notes WHERE id = 'image-note'", [], |row| row.get::<_, String>(0)).unwrap(), expected);
        let score: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(target.join("partituras/image.json")).unwrap()).unwrap();
        assert_eq!(score["text"], format!("Inspect {expected}"));
        drop(restored);
        drop(database);
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    /// Restore must not stage files outside the application's backup contract.
    #[test]
    fn an_archive_with_an_unowned_file_cannot_arm_a_restore() {
        let app = temp_dir("unowned-entry");
        let db_bytes = bytes_of_a_db(&app, "incoming");
        let path = app.join("unowned.zip");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        zip.start_file("app.db", SimpleFileOptions::default()).unwrap();
        zip.write_all(&db_bytes).unwrap();
        zip.start_file("startup.ps1", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"unowned content").unwrap();
        zip.finish().unwrap();
        assert!(import_in(&app, &path).is_err());
        assert!(!staging_in(&app).exists());
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn archive_paths_that_alias_on_windows_cannot_overwrite_each_other() {
        let app = temp_dir("case-alias-entry");
        let db_bytes = bytes_of_a_db(&app, "incoming");
        let path = app.join("aliases.zip");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        zip.start_file("app.db", SimpleFileOptions::default()).unwrap();
        zip.write_all(&db_bytes).unwrap();
        for name in ["attachments/photo.png", "attachments/PHOTO.png"] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(name.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        assert!(import_in(&app, &path).is_err());
        assert!(!staging_in(&app).exists());
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn oversized_compressed_metadata_is_rejected_before_restore_staging() {
        let app = temp_dir("oversized-entry");
        let db_bytes = bytes_of_a_db(&app, "incoming");
        let path = app.join("oversized.zip");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("app.db", options).unwrap();
        zip.write_all(&db_bytes).unwrap();
        zip.start_file("partituras/oversized.json", options).unwrap();
        std::io::copy(&mut std::io::repeat(0).take(16 * 1024 * 1024 + 1), &mut zip).unwrap();
        zip.finish().unwrap();
        assert!(import_in(&app, &path).is_err());
        assert!(!staging_in(&app).exists());
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn a_database_with_workspace_table_names_but_incompatible_columns_is_refused() {
        let app = temp_dir("incompatible-schema");
        let database = app.join("fake-workspace.db");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE kv (key TEXT, value TEXT); CREATE TABLE projects (unrelated TEXT); PRAGMA user_version = 9;").unwrap();
        drop(connection);
        let path = app.join("fake-workspace.zip");
        make_backup(&path, &std::fs::read(database).unwrap(), b"history");
        assert!(import_in(&app, &path).is_err());
        assert!(!staging_in(&app).exists());
        std::fs::remove_dir_all(app).unwrap();
    }

    /// Private provider files and callback output must never enter a workspace archive.
    #[test]
    fn account_credentials_and_login_output_are_excluded_from_workspace_backups() {
        let app = temp_dir("account-privacy");
        let db = live_db(&app, "42");
        {
            let connection = db.lock();
            super::super::db::migrate(&connection).unwrap();
            let account = crate::accounts::create_in(&connection, &app, "work", "codex", "Work").unwrap();
            let runtime = crate::accounts::runtime_dir(&app, &account).unwrap();
            std::fs::write(runtime.join("auth.json"), "OWNED_PRIVATE_CREDENTIAL_FIXTURE").unwrap();
            std::fs::write(runtime.join("login-terminal.bin"), "OWNED_PRIVATE_CALLBACK_FIXTURE").unwrap();
        }
        let dest = app.join("backup.zip");
        export_in(&app, &db, &dest).unwrap();
        let mut archive = ZipArchive::new(File::open(dest).unwrap()).unwrap();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            assert!(!entry.name().starts_with("accounts/"));
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
            assert!(!bytes.windows(b"OWNED_PRIVATE_".len()).any(|window| window == b"OWNED_PRIVATE_"));
        }
        drop(archive);
        drop(db);
        std::fs::remove_dir_all(app).unwrap();
    }

    /// New backups need a versioned inventory so restore can account for every owned file.
    #[test]
    fn exported_backup_carries_a_versioned_inventory_of_its_owned_files() {
        let app = temp_dir("inventory");
        let db = live_db(&app, "42");
        std::fs::create_dir_all(app.join("partituras")).unwrap();
        std::fs::write(app.join("partituras/review.json"), b"arrangement").unwrap();
        let zip = app.join("backup.zip");
        export_in(&app, &db, &zip).unwrap();
        let mut archive = ZipArchive::new(File::open(&zip).unwrap()).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("manifest.json").expect("backup inventory"), &mut text).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(manifest["format"], "yard-backup");
        assert_eq!(manifest["version"], 1);
        let files = manifest["files"].as_array().unwrap();
        assert!(files.iter().any(|file| file["path"] == "app.db"));
        assert!(files.iter().any(|file| file["path"] == "partituras/review.json" && file["size"] == 11));
        drop(archive);
        drop(db);
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn an_inventory_mismatch_refuses_restore_without_leaving_a_pending_database() {
        let app = temp_dir("integrity");
        let db = live_db(&app, "42");
        super::super::db::migrate(&db.lock()).unwrap();
        std::fs::create_dir_all(app.join("partituras")).unwrap();
        std::fs::write(app.join("partituras/review.json"), b"original").unwrap();
        let original = app.join("original.zip");
        export_in(&app, &db, &original).unwrap();
        import_in(&app, &original).expect("the unaltered backup restores");
        std::fs::remove_dir_all(staging_in(&app)).unwrap();
        let altered = app.join("altered.zip");
        let mut archive = ZipArchive::new(File::open(original).unwrap()).unwrap();
        let mut writer = ZipWriter::new(File::create(&altered).unwrap());
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            writer.start_file(entry.name(), SimpleFileOptions::default()).unwrap();
            if entry.name() == "partituras/review.json" {
                std::io::Write::write_all(&mut writer, b"tampered").unwrap();
            } else {
                std::io::copy(&mut entry, &mut writer).unwrap();
            }
        }
        writer.finish().unwrap();
        let error = import_in(&app, &altered).expect_err("an altered artifact cannot be restored");
        assert!(error.to_string().contains("integrity"), "{error}");
        assert!(!staging_in(&app).join("app.db").exists());
        drop(db);
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn a_failed_import_preserves_the_previously_validated_pending_restore() {
        let app = temp_dir("pending-recovery");
        let valid = app.join("valid.zip");
        let expected = bytes_of_a_db(&app, "pending");
        make_backup(&valid, &expected, b"history");
        import_in(&app, &valid).unwrap();
        let invalid = app.join("invalid.zip");
        make_backup(&invalid, b"not SQLite", b"broken");
        assert!(import_in(&app, &invalid).is_err());
        assert_eq!(std::fs::read(staging_in(&app).join("app.db")).expect("previous restore is retained"), expected);
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn backup_roundtrip_preserves_output_archived_before_a_fresh_terminal_session() {
        let source = temp_dir("scrollback-archive-source");
        let target = temp_dir("scrollback-archive-target");
        let db = live_db(&source, "42");
        super::super::db::migrate(&db.lock()).unwrap();
        std::fs::create_dir_all(source.join("scrollback-archives")).unwrap();
        std::fs::write(source.join("scrollback-archives/terminal--1000--0.bin"), b"Previous session output").unwrap();
        let archive = source.join("backup.zip");
        export_in(&source, &db, &archive).unwrap();
        import_in(&target, &archive).unwrap();
        adopt_pending_in(&target).unwrap();
        assert_eq!(std::fs::read(target.join("scrollback-archives/terminal--1000--0.bin")).expect("restored session archive"), b"Previous session output");
        drop(db);
        assert!(source.starts_with(std::env::temp_dir()) && target.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn backup_roundtrip_restores_managed_prompt_attachments() {
        let source = temp_dir("attachment-source");
        let target = temp_dir("attachment-target");
        let db = live_db(&source, "42");
        super::super::db::migrate(&db.lock()).unwrap();
        std::fs::create_dir_all(source.join("attachments")).unwrap();
        std::fs::write(source.join("attachments/yard-image.png"), b"image bytes").unwrap();
        let archive = source.join("backup.zip");
        export_in(&source, &db, &archive).unwrap();
        import_in(&target, &archive).unwrap();
        adopt_pending_in(&target).unwrap();
        assert_eq!(std::fs::read(target.join("attachments/yard-image.png")).expect("restored attachment"), b"image bytes");
        drop(db);
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_restore_failure_leaves_the_live_database_and_pending_backup_unchanged() {
        let source = temp_dir("restore-failure-source");
        let target = temp_dir("restore-failure-target");
        let db = live_db(&source, "42");
        super::super::db::migrate(&db.lock()).unwrap();
        std::fs::create_dir_all(source.join("checkpoints")).unwrap();
        std::fs::write(source.join("checkpoints/task.json"), b"checkpoint").unwrap();
        let original_db = bytes_of_a_db(&target, "original");
        std::fs::write(target.join("app.db"), &original_db).unwrap();
        std::fs::write(target.join("checkpoints"), b"a conflicting file").unwrap();
        let archive = source.join("backup.zip");
        export_in(&source, &db, &archive).unwrap();
        import_in(&target, &archive).unwrap();
        assert!(adopt_pending_in(&target).is_err());
        assert_eq!(std::fs::read(target.join("app.db")).unwrap(), original_db);
        assert!(staging_in(&target).join("app.db").is_file());
        drop(db);
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn a_failed_file_swap_rolls_back_the_database_and_its_owned_artifacts() {
        let source = temp_dir("swap-source");
        let target = temp_dir("swap-target");
        let incoming = bytes_of_a_db(&source, "incoming");
        let original = bytes_of_a_db(&target, "original");
        std::fs::write(target.join("app.db"), &original).unwrap();
        std::fs::create_dir_all(target.join("scrollback")).unwrap();
        std::fs::write(target.join("scrollback/old.bin"), b"old history").unwrap();
        let zip = source.join("backup.zip");
        make_backup(&zip, &incoming, b"new history");
        import_in(&target, &zip).unwrap();
        let outcome = adopt_pending_using(&target, |from, to| {
            if from.ends_with("scrollback") && from.starts_with(target.join("restore-prepared")) {
                return Err(std::io::Error::other("simulated disk failure"));
            }
            std::fs::rename(from, to)
        });
        assert!(outcome.is_err());
        assert!(std::fs::read(target.join("app.db")).unwrap() == original, "the original database remains live");
        assert_eq!(std::fs::read(target.join("scrollback/old.bin")).unwrap(), b"old history");
        assert!(staging_in(&target).join("app.db").is_file());
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn the_next_boot_rolls_back_a_restore_interrupted_during_file_swaps() {
        let app = temp_dir("restore-crash");
        let original = bytes_of_a_db(&app, "before");
        let replacement = bytes_of_a_db(&app, "after");
        std::fs::create_dir_all(app.join("restore-previous/scrollback")).unwrap();
        std::fs::write(app.join("restore-previous/app.db"), &original).unwrap();
        std::fs::write(app.join("restore-previous/scrollback/old.bin"), b"old history").unwrap();
        std::fs::write(app.join("app.db"), replacement).unwrap();
        std::fs::write(app.join("restore-journal.json"), r#"{"replacements":["app.db","scrollback"],"existed":["app.db","scrollback"],"committed":false}"#).unwrap();
        assert!(!adopt_pending_in(&app).unwrap());
        assert!(std::fs::read(app.join("app.db")).unwrap() == original, "interrupted restore recovers the previous database");
        assert_eq!(std::fs::read(app.join("scrollback/old.bin")).unwrap(), b"old history");
        assert!(!app.join("restore-journal.json").exists());
        std::fs::remove_dir_all(app).unwrap();
    }

    /// Backing up the workspace must also preserve its reusable arrangements and recovery archives.
    #[test]
    fn exported_backup_preserves_scores_and_code_checkpoints() {
        let app = temp_dir("owned-data");
        let db = live_db(&app, "42");
        for (name, body) in [
            ("partituras/review.json", b"arrangement".as_slice()),
            ("checkpoints/task.json", b"manifest".as_slice()),
            ("checkpoints/task.zip", b"archive".as_slice()),
        ] {
            let path = app.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let zip = app.join("backup.zip");
        export_in(&app, &db, &zip).unwrap();
        let mut archive = ZipArchive::new(File::open(&zip).unwrap()).unwrap();
        for (name, expected) in [("partituras/review.json", "arrangement"), ("checkpoints/task.json", "manifest"), ("checkpoints/task.zip", "archive")] {
            let mut body = String::new();
            std::io::Read::read_to_string(&mut archive.by_name(name).expect("owned data is in the backup"), &mut body).unwrap();
            assert_eq!(body, expected);
        }
        drop(archive);
        drop(db);
        std::fs::remove_dir_all(app).unwrap();
    }

    /// A restored workspace must recover the same arrangements and checkpoints as the export.
    #[test]
    fn importing_and_adopting_a_backup_restores_scores_and_code_checkpoints() {
        let source = temp_dir("owned-source");
        let target = temp_dir("owned-target");
        let db = live_db(&source, "42");
        super::super::db::migrate(&db.lock()).unwrap();
        for name in ["partituras/review.json", "checkpoints/task.json", "checkpoints/task.zip"] {
            let path = source.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, name).unwrap();
        }
        let zip = source.join("backup.zip");
        export_in(&source, &db, &zip).unwrap();
        import_in(&target, &zip).unwrap();
        assert!(adopt_pending_in(&target).unwrap());
        for name in ["partituras/review.json", "checkpoints/task.json", "checkpoints/task.zip"] {
            assert_eq!(std::fs::read_to_string(target.join(name)).expect("restored owned data"), name);
        }
        drop(db);
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    /// The regression that motivated the light scope: every automatic copy
    /// carried every terminal's output, every archived session and every code
    /// checkpoint, times the number of copies kept.
    #[test]
    fn automatic_backups_carry_scores_and_attachments_but_no_output_or_checkpoints() {
        for folder in ["partituras", "attachments"] {
            assert!(Scope::Light.includes(folder), "{folder}");
        }
        for folder in ["scrollback", "scrollback-archives", "checkpoints"] {
            assert!(!Scope::Light.includes(folder), "{folder}");
        }
        for folder in ["scrollback", "scrollback-archives", "checkpoints", "partituras", "attachments"] {
            assert!(Scope::Full.includes(folder), "{folder}");
        }
    }

    #[test]
    fn already_compressed_files_are_stored_instead_of_deflated_again() {
        for path in ["checkpoints/1-2-3.zip", "attachments/a.PNG", "attachments/b.jpg", "attachments/c.jpeg", "attachments/d.webp", "attachments/e.gif"] {
            assert_eq!(compression_for(path), zip::CompressionMethod::Stored, "{path}");
        }
        for path in ["app.db", "manifest.json", "scrollback/t.bin", "partituras/x.json", "attachments/f.bmp", "checkpoints/1-2-3.json"] {
            assert_eq!(compression_for(path), zip::CompressionMethod::Deflated, "{path}");
        }
    }

    #[test]
    fn a_light_export_leaves_out_terminal_output_and_checkpoints_and_stores_images_as_they_are() {
        let app = temp_dir("light");
        let db = live_db(&app, "42");
        for (name, body) in [
            ("scrollback/t1.bin", b"live output".as_slice()),
            ("scrollback-archives/t1--1000--0.bin", b"old output".as_slice()),
            ("checkpoints/1-1-0.json", b"{}".as_slice()),
            ("checkpoints/1-1-0.zip", b"archive".as_slice()),
            ("partituras/review.json", b"arrangement".as_slice()),
            ("attachments/capture.png", b"image".as_slice()),
        ] {
            let path = app.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let zip = app.join("light.zip");
        export_scoped_in(&app, &db, &zip, Scope::Light).unwrap();
        let mut archive = ZipArchive::new(File::open(&zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(names, ["app.db", "attachments/capture.png", "manifest.json", "partituras/review.json"]);
        assert_eq!(archive.by_name("attachments/capture.png").unwrap().compression(), zip::CompressionMethod::Stored);
        drop(archive);
        drop(db);
        std::fs::remove_dir_all(app).unwrap();
    }

    /// A backup's inventory used to mean "every owned folder": restoring one
    /// that leaves folders out would have emptied the live ones.
    #[test]
    fn restoring_a_light_backup_keeps_the_live_output_archives_and_checkpoints() {
        let source = temp_dir("light-source");
        let target = temp_dir("light-target");
        let db = live_db(&source, "42");
        super::super::db::migrate(&db.lock()).unwrap();
        std::fs::create_dir_all(source.join("attachments")).unwrap();
        std::fs::write(source.join("attachments/capture.png"), b"backed up image").unwrap();
        let live = ["scrollback/t1.bin", "scrollback-archives/t1--1000--0.bin", "checkpoints/1-1-0.json", "checkpoints/1-1-0.zip"];
        for name in live {
            let path = target.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, name).unwrap();
        }
        let zip = source.join("light.zip");
        export_scoped_in(&source, &db, &zip, Scope::Light).unwrap();
        import_in(&target, &zip).unwrap();
        assert!(adopt_pending_in(&target).unwrap());
        for name in live {
            assert_eq!(std::fs::read_to_string(target.join(name)).expect("live data kept"), name);
        }
        assert_eq!(std::fs::read(target.join("attachments/capture.png")).unwrap(), b"backed up image");
        drop(db);
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    /// A build from before the folder list reads any inventory as covering
    /// every owned folder; given a light backup it would empty the live
    /// output and checkpoints. Version 2 makes those builds refuse it instead,
    /// while full backups stay readable by them.
    #[test]
    fn a_light_inventory_is_version_two_and_a_full_one_stays_version_one() {
        let app = temp_dir("inventory-version");
        let db = live_db(&app, "42");
        let version = |scope: Scope| {
            let zip = app.join("versioned.zip");
            export_scoped_in(&app, &db, &zip, scope).unwrap();
            let mut archive = ZipArchive::new(File::open(&zip).unwrap()).unwrap();
            let manifest: serde_json::Value = serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
            (manifest["version"].as_u64().unwrap(), manifest["folders"].clone())
        };
        assert_eq!(version(Scope::Light), (2, serde_json::json!(["partituras", "attachments"])));
        assert_eq!(version(Scope::Full).0, 1);
        drop(db);
        std::fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn a_restore_replaces_exactly_the_folders_its_backup_covers() {
        let covered = ["attachments".to_string()];
        assert!(replaces_folder("attachments", Some(&covered), true, false));
        assert!(!replaces_folder("checkpoints", Some(&covered), true, true));
        // An inventory written before the list existed covered everything.
        assert!(replaces_folder("checkpoints", None, true, false));
        // No inventory at all: only what the zip carries.
        assert!(replaces_folder("scrollback", None, false, true));
        assert!(!replaces_folder("checkpoints", None, false, false));
    }

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
                "manifest.json",
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
    /// all deflated, plus the versioned inventory and no unowned files.
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
        assert_eq!(rest, vec!["manifest.json", "scrollback/t1.bin", "scrollback/t2.bin"]);

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
            super::super::db::migrate(&c).unwrap();
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
