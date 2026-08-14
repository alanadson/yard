//! `.zip` backup export/import — `app.db` plus the scrollbacks (§F3).

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

/// Builds a `.zip` with the database and every scrollback `.bin`.
/// Returns the path written.
pub fn export(dest: &Path) -> anyhow::Result<PathBuf> {
    let file = File::create(dest)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // The database is in WAL: a checkpoint guarantees the `.db` alone is
    // already consistent, without needing to pack `-wal`/`-shm` into the zip.
    let db = crate::paths::db_path();
    if db.exists() {
        zip.start_file("app.db", opts)?;
        let mut buf = Vec::new();
        File::open(&db)?.read_to_end(&mut buf)?;
        zip.write_all(&buf)?;
    }

    let sb_dir = crate::paths::scrollback_dir();
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
            let mut buf = Vec::new();
            File::open(&path)?.read_to_end(&mut buf)?;
            zip.write_all(&buf)?;
        }
    }

    zip.finish()?;
    tracing::info!(dest = %dest.display(), "backup exportado");
    Ok(dest.to_path_buf())
}

/// Restores a backup on top of the current state. The old database is kept
/// as `app.db.bak` — restoring by mistake must not be irreversible.
///
/// The app must be restarted afterwards: the open connection still points at
/// the old inode.
pub fn import(src: &Path) -> anyhow::Result<()> {
    let file = File::open(src)?;
    let mut archive = ZipArchive::new(file)?;

    let app_dir = crate::paths::app_dir();
    let db_path = crate::paths::db_path();
    if db_path.exists() {
        let _ = std::fs::copy(&db_path, db_path.with_extension("db.bak"));
    }

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(rel) = entry.enclosed_name() else {
            // `enclosed_name` is None on paths with `..` — zip-slip blocked.
            tracing::warn!(nome = entry.name(), "entrada de zip suspeita ignorada");
            continue;
        };
        let out = app_dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        std::fs::write(&out, buf)?;
    }

    // Leftover WAL files point at the old database and would corrupt the restored one.
    for ext in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(app_dir.join(format!("app.{ext}")));
    }

    tracing::info!(src = %src.display(), "backup importado");
    Ok(())
}
