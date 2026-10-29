//! Task-scoped snapshots of working files, stored outside the repository.
//!
//! A capture is streamed file by file: once to compute its content digest and,
//! only when that digest differs from the newest checkpoint of the same
//! folder, once more into a new archive. An unchanged tree therefore costs a
//! manifest that points at the archive it already has, not another zip.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

type Files = BTreeMap<String, Vec<u8>>;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_DIFF_BYTES: usize = 512 * 1024;

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
        return Err("Um arquivo excede o limite de 32 MiB por checkpoint.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Um arquivo excede o limite de 32 MiB por checkpoint.".into());
    }
    Ok(Some(bytes))
}

fn check_budget(count: usize, bytes: usize) -> Result<(), String> {
    if count > MAX_FILES || bytes > MAX_TOTAL_BYTES {
        return Err("O checkpoint excede o limite de 20.000 arquivos ou 256 MiB.".into());
    }
    Ok(())
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Identificador de checkpoint inválido.".into());
    }
    Ok(())
}

fn check_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || path.split('/').any(|part| {
            let clean = part.trim_end_matches(['.', ' ']);
            let device = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
            let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ((device.starts_with("COM") || device.starts_with("LPT"))
                    && device.len() == 4
                    && matches!(device.as_bytes()[3], b'1'..=b'9'));
            clean.is_empty() || clean != part || clean.eq_ignore_ascii_case(".git") || reserved
        })
    {
        return Err("Caminho inválido para checkpoint.".into());
    }
    Ok(())
}

fn safe_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    check_path(name)?;
    let mut path = root.to_path_buf();
    for component in name.split('/') {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                let mut linked = metadata.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    linked |= metadata.file_attributes() & 0x400 != 0;
                }
                if linked {
                    return Err(format!(
                        "Links e junções não são aceitos em checkpoints: {name}"
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{name}: {e}")),
        }
    }
    Ok(path)
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub root: String,
    pub task_id: String,
    pub task_label: String,
    pub label: String,
    pub created_at: i64,
    pub file_count: usize,
    pub bytes: usize,
    pub git_state: String,
    /// SHA-256 over the sorted paths and bytes of the captured files.
    /// Absent on checkpoints written before deduplication existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// The checkpoint whose archive holds these files, when it is not this
    /// one: a capture identical to the newest one reuses its archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
}

impl Checkpoint {
    /// The id of the `.zip` that holds this checkpoint's files.
    fn archive_id(&self) -> &str {
        self.archive.as_deref().unwrap_or(&self.id)
    }
}

/// The content digest of a capture: every path and its bytes, length-prefixed
/// so no two different trees can feed the same stream, in path order.
#[derive(Default)]
struct ContentDigest(Sha256);

impl ContentDigest {
    fn add(&mut self, name: &str, bytes: &[u8]) {
        self.0.update((name.len() as u64).to_le_bytes());
        self.0.update(name.as_bytes());
        self.0.update((bytes.len() as u64).to_le_bytes());
        self.0.update(bytes);
    }

    fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

/// What a capture held: how many files, how many bytes, and their digest.
struct Summary {
    count: usize,
    bytes: usize,
    digest: String,
}

/// A new archive being written, entry by entry.
struct Archive {
    zip: zip::ZipWriter<File>,
    digest: ContentDigest,
    count: usize,
    bytes: usize,
}

impl Archive {
    fn create(path: &Path) -> Result<Self, String> {
        let file = File::create_new(path).map_err(|e| e.to_string())?;
        Ok(Self {
            zip: zip::ZipWriter::new(file),
            digest: ContentDigest::default(),
            count: 0,
            bytes: 0,
        })
    }

    fn add(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.zip
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|e| e.to_string())?;
        self.zip.write_all(bytes).map_err(|e| e.to_string())?;
        self.digest.add(name, bytes);
        self.count += 1;
        self.bytes += bytes.len();
        Ok(())
    }

    fn finish(self) -> Result<Summary, String> {
        self.zip
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        Ok(Summary {
            count: self.count,
            bytes: self.bytes,
            digest: self.digest.finish(),
        })
    }
}

fn repository_state(root: &Path) -> String {
    let head = git(root, &["rev-parse", "--verify", "HEAD"])
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_else(|_| "unborn".into());
    let branch = git(root, &["symbolic-ref", "--quiet", "HEAD"])
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    format!("{head}\n{branch}")
}

fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(output)
}

fn root_name(root: &Path) -> Result<String, String> {
    fs::canonicalize(root)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
fn capture(root: &Path) -> Result<Files, String> {
    capture_with(root, std::iter::empty())
}

/// The paths a capture covers: tracked and non-ignored files, plus `included`
/// (the paths of the checkpoint being compared against).
fn capture_names<'a>(
    root: &Path,
    included: impl Iterator<Item = &'a String>,
) -> Result<BTreeSet<String>, String> {
    let names = git(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    let mut paths = BTreeSet::new();
    for name in names.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        paths.insert(String::from_utf8(name.to_vec()).map_err(|e| e.to_string())?);
    }
    paths.extend(included.cloned());
    check_budget(paths.len(), 0)?;
    Ok(paths)
}

/// Reads `names` one file at a time, in path order, and hands each to `each`:
/// only one file is in memory at a time. The budget is enforced as it goes.
fn visit_files(
    root: &Path,
    names: &BTreeSet<String>,
    mut each: impl FnMut(&str, Vec<u8>) -> Result<(), String>,
) -> Result<(), String> {
    let (mut count, mut total) = (0, 0);
    for name in names {
        if let Some(bytes) = read_bytes(&safe_file(root, name)?)? {
            count += 1;
            total += bytes.len();
            check_budget(count, total)?;
            each(name, bytes)?;
        }
    }
    Ok(())
}

fn capture_with<'a>(
    root: &Path,
    included: impl Iterator<Item = &'a String>,
) -> Result<Files, String> {
    let names = capture_names(root, included)?;
    let mut files = Files::new();
    visit_files(root, &names, |name, bytes| {
        files.insert(name.to_string(), bytes);
        Ok(())
    })?;
    Ok(files)
}

pub fn create(
    store: &Path,
    root: &Path,
    task_id: &str,
    task_label: &str,
    label: &str,
    now: i64,
) -> Result<Checkpoint, String> {
    external_store(store, root)?;
    let names = capture_names(root, std::iter::empty())?;
    let mut digest = ContentDigest::default();
    let (mut count, mut bytes) = (0, 0);
    visit_files(root, &names, |name, data| {
        digest.add(name, &data);
        count += 1;
        bytes += data.len();
        Ok(())
    })?;
    let summary = Summary { count, bytes, digest: digest.finish() };
    let who = Identity { task_id, task_label, label, now };
    let saved = store_capture(store, root, who, summary, |archive| {
        visit_files(root, &names, |name, data| archive.add(name, &data))
    })?;
    // Retention is housekeeping: the capture just written stands even when an
    // old file refuses to go (the next capture tries again).
    if let Err(error) = prune(store, root, now) {
        tracing::warn!(%error, "checkpoint retention could not finish");
    }
    Ok(saved)
}

/// Applies `retention` to the checkpoints of `root`. Manifests go before
/// archives, so an interruption never leaves a manifest without its archive.
fn prune(store: &Path, root: &Path, now: i64) -> Result<(), String> {
    let plan = retention(&all_rows(store)?, &root_name(root)?, now);
    for id in &plan.manifests {
        check_id(id)?;
        fs::remove_file(store.join(format!("{id}.json"))).map_err(|e| format!("{id}: {e}"))?;
    }
    for id in &plan.archives {
        check_id(id)?;
        match fs::remove_file(store.join(format!("{id}.zip"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{id}: {e}")),
        }
    }
    Ok(())
}

/// Who a checkpoint belongs to and when it was taken.
struct Identity<'a> {
    task_id: &'a str,
    task_label: &'a str,
    label: &'a str,
    now: i64,
}

fn external_store(store: &Path, root: &Path) -> Result<(), String> {
    let real_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut ancestor = store;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Pasta de checkpoints inválida.")?;
    }
    if fs::canonicalize(ancestor)
        .map_err(|e| e.to_string())?
        .starts_with(real_root)
    {
        return Err("A pasta de checkpoints deve ficar fora da pasta de trabalho.".into());
    }
    Ok(())
}

/// A checkpoint of files already in memory (the recovery snapshot `restore`
/// takes of what it is about to replace).
fn save(
    store: &Path,
    root: &Path,
    task_id: &str,
    task_label: &str,
    label: &str,
    now: i64,
    files: &Files,
) -> Result<Checkpoint, String> {
    let mut digest = ContentDigest::default();
    for (name, bytes) in files {
        digest.add(name, bytes);
    }
    let summary = Summary {
        count: files.len(),
        bytes: files.values().map(Vec::len).sum(),
        digest: digest.finish(),
    };
    let who = Identity { task_id, task_label, label, now };
    store_capture(store, root, who, summary, |archive| {
        files.iter().try_for_each(|(name, bytes)| archive.add(name, bytes))
    })
}

/// Records a capture whose content is `summary`. When the newest checkpoint of
/// the same folder has the same digest (and its archive is still there), the
/// new manifest points at that archive; otherwise `write` fills a new one. A
/// write that fails leaves no partial archive behind.
fn store_capture(
    store: &Path,
    root: &Path,
    who: Identity,
    summary: Summary,
    write: impl FnOnce(&mut Archive) -> Result<(), String>,
) -> Result<Checkpoint, String> {
    external_store(store, root)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = format!(
        "{}-{}-{}",
        who.now,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let reused = list(store, root)?.into_iter().next().filter(|newest| {
        newest.digest.as_deref() == Some(summary.digest.as_str())
            && store.join(format!("{}.zip", newest.archive_id())).is_file()
    });
    let (summary, archive) = match reused {
        Some(newest) => (summary, Some(newest.archive_id().to_string())),
        None => {
            fs::create_dir_all(store).map_err(|e| e.to_string())?;
            let path = store.join(format!("{id}.zip"));
            let mut archive = Archive::create(&path)?;
            let written = write(&mut archive).and_then(|_| archive.finish());
            match written {
                Ok(written) => (written, None),
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            }
        }
    };
    let row = Checkpoint {
        id: id.clone(),
        root: root_name(root)?,
        task_id: who.task_id.into(),
        task_label: who.task_label.into(),
        label: who.label.into(),
        created_at: who.now,
        file_count: summary.count,
        bytes: summary.bytes,
        git_state: repository_state(root),
        digest: Some(summary.digest),
        archive,
    };
    let metadata = serde_json::to_vec(&row).map_err(|e| e.to_string())?;
    let pending = store.join(format!("{id}.pending"));
    let mut manifest = File::create_new(&pending).map_err(|e| e.to_string())?;
    manifest.write_all(&metadata).map_err(|e| e.to_string())?;
    manifest.sync_all().map_err(|e| e.to_string())?;
    drop(manifest);
    fs::rename(pending, store.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn list(store: &Path, root: &Path) -> Result<Vec<Checkpoint>, String> {
    let root = root_name(root)?;
    let mut rows: Vec<Checkpoint> = all_rows(store)?
        .into_iter()
        .filter(|row| row.root == root)
        .collect();
    rows.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(rows)
}

/// Every readable manifest in the store, whatever folder it belongs to.
fn all_rows(store: &Path) -> Result<Vec<Checkpoint>, String> {
    if !store.exists() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    for entry in fs::read_dir(store).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A manifest that will not read or parse is that one checkpoint's
        // problem, not the whole listing's.
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "checkpoint manifest unreadable");
                continue;
            }
        };
        let row: Checkpoint = match serde_json::from_slice(&bytes) {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "checkpoint manifest corrupt");
                continue;
            }
        };
        rows.push(row);
    }
    Ok(rows)
}

/// The files of checkpoint `id`, read from whichever archive holds them.
#[cfg(test)]
fn load_files(store: &Path, id: &str) -> Result<Files, String> {
    load_archive(store, metadata(store, id)?.archive_id())
}

fn load_archive(store: &Path, id: &str) -> Result<Files, String> {
    check_id(id)?;
    let file = File::open(store.join(format!("{id}.zip"))).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    check_budget(archive.len(), 0)?;
    let mut files = Files::new();
    let mut total = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        check_path(&name)?;
        let mut bytes = Vec::new();
        if entry.size() > MAX_FILE_BYTES {
            return Err("Um arquivo excede o limite de 32 MiB por checkpoint.".into());
        }
        entry
            .by_ref()
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("Um arquivo excede o limite de 32 MiB por checkpoint.".into());
        }
        total += bytes.len();
        check_budget(files.len() + 1, total)?;
        if files.insert(name, bytes).is_some() {
            return Err("Arquivo repetido no checkpoint.".into());
        }
    }
    Ok(files)
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "CheckpointChangedFile")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub before_bytes: usize,
    pub after_bytes: usize,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub files: Vec<ChangedFile>,
    pub token: String,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct Comparison {
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
}

fn fingerprint(root: &Path, files: &Files) -> Result<String, String> {
    // hash-object without -w computes a digest without writing Git objects.
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        let mut input = child.stdin.take().expect("piped stdin");
        for (name, bytes) in files {
            input.write_all(&(name.len() as u64).to_le_bytes())?;
            input.write_all(name.as_bytes())?;
            input.write_all(&(bytes.len() as u64).to_le_bytes())?;
            input.write_all(bytes)?;
        }
        Ok(())
    })();
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    result.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

fn changes(before: &Files, after: &Files) -> Vec<ChangedFile> {
    let names: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).collect();
    names
        .into_iter()
        .filter_map(|name| {
            let old = before.get(name);
            let new = after.get(name);
            if old == new {
                return None;
            }
            Some(ChangedFile {
                path: name.clone(),
                status: if old.is_none() {
                    "added"
                } else if new.is_none() {
                    "deleted"
                } else {
                    "modified"
                }
                .into(),
                before_bytes: old.map_or(0, Vec::len),
                after_bytes: new.map_or(0, Vec::len),
            })
        })
        .collect()
}

pub fn preview(store: &Path, root: &Path, id: &str) -> Result<Preview, String> {
    let row = scoped_metadata(store, root, id)?;
    let before = load_archive(store, row.archive_id())?;
    let after = capture_with(root, before.keys())?;
    Ok(Preview {
        files: changes(&before, &after),
        token: fingerprint(root, &after)?,
        blocked_reason: repository_block(&row, root),
    })
}

pub fn compare_file(store: &Path, root: &Path, id: &str, path: &str) -> Result<Comparison, String> {
    check_path(path)?;
    let row = scoped_metadata(store, root, id)?;
    let files = load_archive(store, row.archive_id())?;
    let after = read_bytes(&safe_file(root, path)?)?.unwrap_or_default();
    let before = files.get(path).cloned().unwrap_or_default();
    let text = |bytes: Vec<u8>| {
        if bytes.len() > MAX_DIFF_BYTES || bytes.contains(&0) {
            None
        } else {
            String::from_utf8(bytes).ok()
        }
    };
    let before = text(before);
    let after = text(after);
    let binary = before.is_none() || after.is_none();
    Ok(Comparison {
        before,
        after,
        binary,
    })
}

fn metadata(store: &Path, id: &str) -> Result<Checkpoint, String> {
    check_id(id)?;
    serde_json::from_slice(&fs::read(store.join(format!("{id}.json"))).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn scoped_metadata(store: &Path, root: &Path, id: &str) -> Result<Checkpoint, String> {
    let row = metadata(store, id)?;
    if row.root != root_name(root)? {
        return Err("Este checkpoint pertence a outra pasta.".into());
    }
    Ok(row)
}

pub fn restore(
    store: &Path,
    root: &Path,
    id: &str,
    expected_token: &str,
    now: i64,
) -> Result<Checkpoint, String> {
    let row = scoped_metadata(store, root, id)?;
    if let Some(reason) = repository_block(&row, root) {
        return Err(reason);
    }
    let wanted = load_archive(store, row.archive_id())?;
    for name in wanted.keys() {
        safe_file(root, name)?;
    }
    let current = capture_with(root, wanted.keys())?;
    if fingerprint(root, &current)? != expected_token {
        return Err(
            "Os arquivos mudaram depois da prévia. Compare novamente antes de restaurar.".into(),
        );
    }
    let recovery = save(
        store,
        root,
        &row.task_id,
        &row.task_label,
        RECOVERY_LABEL,
        now,
        &current,
    )?;
    let result = (|| -> Result<(), String> {
        for name in current.keys().filter(|name| !wanted.contains_key(*name)) {
            fs::remove_file(safe_file(root, name)?).map_err(|e| format!("{name}: {e}"))?;
        }
        for (name, bytes) in &wanted {
            if current.get(name) == Some(bytes) {
                continue;
            }
            let path = safe_file(root, name)?;
            fs::create_dir_all(path.parent().expect("file inside root"))
                .map_err(|e| e.to_string())?;
            fs::write(path, bytes).map_err(|e| format!("{name}: {e}"))?;
        }
        Ok(())
    })();
    result.map_err(|e| format!("{e} (checkpoint de recuperação: {})", recovery.id))?;
    Ok(recovery)
}

fn repository_block(row: &Checkpoint, root: &Path) -> Option<String> {
    (row.git_state != repository_state(root)).then(|| {
        "A branch ou o commit mudou desde este checkpoint. A comparação continua disponível.".into()
    })
}

/// How many checkpoints of one working folder the store keeps.
const KEEP_PER_ROOT: usize = 50;
/// The label `restore` gives the snapshot of what it replaces.
const RECOVERY_LABEL: &str = "Antes de restaurar";
/// A recovery snapshot younger than this survives retention: it is the undo
/// of a restore the user may not have looked at yet.
const RECOVERY_GRACE_MS: i64 = 24 * 60 * 60 * 1000;

/// What one retention pass removes, oldest first.
#[derive(Debug, Default, PartialEq)]
struct Retention {
    manifests: Vec<String>,
    archives: Vec<String>,
}

/// Retention for the checkpoints of `root`, given every manifest in the store:
/// the newest `KEEP_PER_ROOT` stay, recovery snapshots younger than a day stay
/// too, and an archive leaves only when no remaining manifest (of any folder)
/// reads it.
fn retention(rows: &[Checkpoint], root: &str, now: i64) -> Retention {
    let mut own: Vec<&Checkpoint> = rows.iter().filter(|row| row.root == root).collect();
    own.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    let mut removed: Vec<&Checkpoint> = own
        .into_iter()
        .skip(KEEP_PER_ROOT)
        .filter(|row| !(row.label == RECOVERY_LABEL && now - row.created_at < RECOVERY_GRACE_MS))
        .collect();
    removed.reverse();
    let gone = |row: &Checkpoint| removed.iter().any(|old| old.id == row.id);
    let read: BTreeSet<&str> = rows.iter().filter(|row| !gone(row)).map(Checkpoint::archive_id).collect();
    let mut archives: Vec<String> = Vec::new();
    for row in &removed {
        let archive = row.archive_id();
        if !read.contains(archive) && !archives.iter().any(|seen| seen == archive) {
            archives.push(archive.to_string());
        }
    }
    Retention {
        manifests: removed.iter().map(|row| row.id.clone()).collect(),
        archives,
    }
}

/// Removes one checkpoint. Its archive goes too unless another checkpoint
/// still reads it. The manifest goes first: an interruption can leave an
/// archive nobody points at, never a manifest without its archive.
pub fn delete(store: &Path, root: &Path, id: &str) -> Result<(), String> {
    let row = scoped_metadata(store, root, id)?;
    fs::remove_file(store.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    let archive = row.archive_id();
    if all_rows(store)?.iter().all(|other| other.archive_id() != archive) {
        check_id(archive)?;
        fs::remove_file(store.join(format!("{archive}.zip"))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Checkpoints must preserve unfinished code without changing the user's Git state.
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        store: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let base = std::env::temp_dir().join(format!(
                "yard-checkpoints-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let root = base.join("repo");
            let store = base.join("snapshots");
            std::fs::create_dir_all(&root).unwrap();
            let f = Self { base, root, store };
            f.git(&["init", "-b", "main"]);
            f.git(&["config", "user.email", "checkpoint@example.test"]);
            f.git(&["config", "user.name", "Checkpoint Test"]);
            f.write("code.txt", b"original\r\n");
            f.write(".gitignore", b"ignored/\n");
            f.git(&["add", "."]);
            f.git(&["commit", "-m", "initial"]);
            f
        }
        fn git(&self, args: &[&str]) -> Vec<u8> {
            let mut command = Command::new("git");
            command.current_dir(&self.root).args(args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let result = command.output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            result.stdout
        }
        fn write(&self, path: &str, bytes: &[u8]) {
            let path = self.root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn archives_in(store: &Path) -> usize {
        fs::read_dir(store)
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().path().extension().is_some_and(|e| e == "zip"))
            .count()
    }

    /// The regression that motivated deduplication: every prompt sent to an
    /// idle agent wrote another full archive of an unchanged tree.
    #[test]
    fn an_unchanged_tree_reuses_the_newest_archive_and_keeps_both_task_identities() {
        let f = Fixture::new();
        let first = create(&f.store, &f.root, "first", "First", "Before", 1000).unwrap();
        let second = create(&f.store, &f.root, "second", "Second", "Before", 2000).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(archives_in(&f.store), 1, "an identical capture must not write another archive");
        let rows = list(&f.store, &f.root).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.task_id.as_str()).collect::<Vec<_>>(),
            ["second", "first"]
        );
        f.write("code.txt", b"changed after both");
        let review = preview(&f.store, &f.root, &second.id).unwrap();
        assert_eq!(review.files.len(), 1);
        restore(&f.store, &f.root, &second.id, &review.token, 3000).unwrap();
        assert_eq!(fs::read(f.root.join("code.txt")).unwrap(), b"original\r\n");
    }

    const HOUR: i64 = 60 * 60 * 1000;

    fn row(created_at: i64, root: &str, label: &str, archive: Option<&str>) -> Checkpoint {
        Checkpoint {
            id: format!("{created_at}-1-0"),
            root: root.into(),
            task_id: "task".into(),
            task_label: "Task".into(),
            label: label.into(),
            created_at,
            file_count: 1,
            bytes: 1,
            git_state: String::new(),
            digest: None,
            archive: archive.map(str::to_string),
        }
    }

    /// The regression that motivated retention: every send, queue delivery
    /// and flow stage added an archive, and nothing ever removed one.
    #[test]
    fn retention_keeps_the_newest_fifty_of_a_folder_and_leaves_other_folders_alone() {
        let mut rows: Vec<Checkpoint> = (1..=52).map(|at| row(at * HOUR, "C:\\repo", "Before", None)).collect();
        rows.push(row(HOUR / 2, "C:\\other", "Before", None));
        let plan = retention(&rows, "C:\\repo", 100 * HOUR);
        let oldest = vec![format!("{}-1-0", HOUR), format!("{}-1-0", 2 * HOUR)];
        assert_eq!(plan.manifests, oldest);
        assert_eq!(plan.archives, oldest);
    }

    #[test]
    fn retention_spares_recent_recovery_checkpoints_and_archives_a_kept_checkpoint_reads() {
        let now = 1000 * HOUR;
        let shared = format!("{}-1-0", 3 * HOUR);
        let mut rows: Vec<Checkpoint> = (0..50)
            .map(|n| row(now - n * 60_000, "C:\\repo", "Before", None))
            .collect();
        // The newest checkpoint reuses the archive of one past the limit.
        rows[0].archive = Some(shared.clone());
        rows.push(row(3 * HOUR, "C:\\repo", "Before", None));
        rows.push(row(now - 23 * HOUR, "C:\\repo", RECOVERY_LABEL, None));
        rows.push(row(now - 25 * HOUR, "C:\\repo", RECOVERY_LABEL, None));
        let plan = retention(&rows, "C:\\repo", now);
        let stale_recovery = format!("{}-1-0", now - 25 * HOUR);
        assert_eq!(plan.manifests, vec![shared, stale_recovery.clone()]);
        assert_eq!(plan.archives, vec![stale_recovery]);
    }

    #[test]
    fn a_new_capture_retires_the_oldest_checkpoint_past_the_limit_with_its_archive() {
        let f = Fixture::new();
        fs::create_dir_all(&f.store).unwrap();
        let root = root_name(&f.root).unwrap();
        for at in 1..=50 {
            let old = row(at, &root, "Before", None);
            fs::write(f.store.join(format!("{}.json", old.id)), serde_json::to_vec(&old).unwrap()).unwrap();
            fs::write(f.store.join(format!("{}.zip", old.id)), b"old archive").unwrap();
        }
        create(&f.store, &f.root, "task", "Task", "Before", 1000 * HOUR).unwrap();
        let rows = list(&f.store, &f.root).unwrap();
        assert_eq!(rows.len(), 50);
        assert!(rows.iter().all(|row| row.id != "1-1-0"), "the oldest checkpoint must be retired");
        assert!(!f.store.join("1-1-0.zip").exists());
        assert!(f.store.join("2-1-0.zip").exists());
    }

    /// Streaming writes the archive while reading the tree, so a file that
    /// grows past the budget between the digest pass and the archive pass
    /// fails halfway through the zip; that half must not stay in the store.
    #[test]
    fn an_archive_that_fails_halfway_leaves_neither_a_manifest_nor_a_partial_zip() {
        let f = Fixture::new();
        let summary = Summary { count: 1, bytes: 1, digest: "new".into() };
        let who = Identity { task_id: "task", task_label: "Task", label: "Before", now: 1000 };
        let result = store_capture(&f.store, &f.root, who, summary, |archive| {
            archive.add("code.txt", b"half")?;
            Err("O checkpoint excede o limite de 20.000 arquivos ou 256 MiB.".into())
        });
        assert!(result.is_err());
        assert_eq!(archives_in(&f.store), 0);
        assert!(list(&f.store, &f.root).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_checkpoint_keeps_an_archive_another_checkpoint_still_reads() {
        let f = Fixture::new();
        let first = create(&f.store, &f.root, "first", "First", "Before", 1000).unwrap();
        let second = create(&f.store, &f.root, "second", "Second", "Before", 2000).unwrap();
        delete(&f.store, &f.root, &first.id).unwrap();
        assert_eq!(archives_in(&f.store), 1, "the second checkpoint still needs the shared archive");
        assert!(preview(&f.store, &f.root, &second.id).unwrap().files.is_empty());
        delete(&f.store, &f.root, &second.id).unwrap();
        assert_eq!(archives_in(&f.store), 0, "the last reader takes the archive with it");
    }

    #[test]
    fn windows_path_aliases_cannot_address_parent_folders_or_devices() {
        for name in [
            ".. /outside.txt",
            ".../outside.txt",
            "folder./code.txt",
            "AUX",
            "nul.txt",
            "COM1.txt",
        ] {
            assert!(check_path(name).is_err(), "accepted alias {name}");
        }
    }

    #[test]
    fn deleting_one_checkpoint_leaves_other_tasks_and_working_files_untouched() {
        let f = Fixture::new();
        let first = create(&f.store, &f.root, "first", "First", "Before", 1000).unwrap();
        // A different tree, so the second checkpoint has an archive of its
        // own (identical captures share one, see the deduplication test).
        f.write("code.txt", b"second task's work");
        let second = create(&f.store, &f.root, "second", "Second", "Before", 2000).unwrap();
        let before = capture(&f.root).unwrap();
        delete(&f.store, &f.root, &first.id).unwrap();
        let rows = list(&f.store, &f.root).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, second.id);
        assert!(!f.store.join(format!("{}.zip", first.id)).exists());
        assert_eq!(capture(&f.root).unwrap(), before);
    }

    /// One manifest that does not parse (a crash mid-write, a hand edit) used
    /// to fail the whole listing; it is skipped and the others still show.
    #[test]
    fn a_corrupt_manifest_is_skipped_instead_of_hiding_the_others() {
        let f = Fixture::new();
        let good = create(&f.store, &f.root, "task", "Task", "Fine", 1000).unwrap();
        std::fs::write(f.store.join("corrupt.json"), b"{not json").unwrap();
        let rows = list(&f.store, &f.root).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, good.id);
    }

    #[test]
    fn checkpoint_storage_inside_the_working_directory_is_refused() {
        let f = Fixture::new();
        let nested = f.root.join("checkpoints");
        assert!(create(&nested, &f.root, "task", "Task", "Recursive", 1000).is_err());
        assert!(!nested.exists());
    }

    #[test]
    fn an_oversized_file_refuses_the_entire_checkpoint_instead_of_silently_omitting_it() {
        let f = Fixture::new();
        File::create(f.root.join("large.bin"))
            .unwrap()
            .set_len(32 * 1024 * 1024 + 1)
            .unwrap();
        assert!(
            create(&f.store, &f.root, "task", "Task", "Too large", 1000).is_err(),
            "the snapshot budget must be enforced"
        );
        assert!(list(&f.store, &f.root).unwrap().is_empty());
    }

    #[test]
    fn undo_preserves_a_checkpoint_file_that_became_ignored_after_capture() {
        let f = Fixture::new();
        f.write("draft.txt", b"before");
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        f.write(".gitignore", b"ignored/\ndraft.txt\n");
        f.write("draft.txt", b"valuable ignored work");
        let review = preview(&f.store, &f.root, &saved.id).unwrap();
        let recovery = restore(&f.store, &f.root, &saved.id, &review.token, 2000).unwrap();
        let undo = preview(&f.store, &f.root, &recovery.id).unwrap();
        restore(&f.store, &f.root, &recovery.id, &undo.token, 3000).unwrap();
        assert_eq!(
            fs::read(f.root.join("draft.txt")).unwrap(),
            b"valuable ignored work"
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_junction_replacing_a_tracked_folder_is_never_followed_by_checkpoints() {
        use std::os::windows::process::CommandExt;
        let f = Fixture::new();
        f.write("source/code.txt", b"saved");
        f.git(&["add", "source/code.txt"]);
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        fs::remove_file(f.root.join("source/code.txt")).unwrap();
        fs::remove_dir(f.root.join("source")).unwrap();
        let outside = f.base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("code.txt"), b"outside").unwrap();
        let result = Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(f.root.join("source"))
            .arg(&outside)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "junction fixture: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            create(&f.store, &f.root, "task", "Task", "Linked", 2000).is_err(),
            "a junction must never be copied"
        );
        assert!(preview(&f.store, &f.root, &saved.id).is_err());
        assert!(compare_file(&f.store, &f.root, &saved.id, "source/code.txt").is_err());
        assert_eq!(fs::read(outside.join("code.txt")).unwrap(), b"outside");
    }

    #[test]
    fn a_new_commit_keeps_comparison_available_but_refuses_restoring_old_code() {
        let f = Fixture::new();
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        f.write("code.txt", b"committed later");
        f.git(&["add", "code.txt"]);
        f.git(&["commit", "-m", "later"]);
        let review = preview(&f.store, &f.root, &saved.id).unwrap();
        assert_eq!(review.files.len(), 1);
        assert!(
            restore(&f.store, &f.root, &saved.id, &review.token, 2000).is_err(),
            "a checkpoint must not roll back a newer commit's files"
        );
        assert_eq!(
            fs::read(f.root.join("code.txt")).unwrap(),
            b"committed later"
        );
    }

    #[test]
    fn checkpoint_addresses_never_read_outside_the_archive_or_into_git_metadata() {
        let f = Fixture::new();
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        fs::write(f.base.join("outside.txt"), b"private").unwrap();
        for path in ["../outside.txt", ".git/config", "code.txt:stream", ""] {
            assert!(
                compare_file(&f.store, &f.root, &saved.id, path).is_err(),
                "accepted {path}"
            );
        }
        assert!(preview(&f.store, &f.root, &format!("../snapshots/{}", saved.id)).is_err());
    }

    #[test]
    fn a_checkpoint_cannot_be_read_or_restored_in_another_working_directory() {
        let f = Fixture::new();
        let other = Fixture::new();
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        assert!(preview(&f.store, &other.root, &saved.id).is_err());
        assert!(compare_file(&f.store, &other.root, &saved.id, "code.txt").is_err());
        assert!(restore(&f.store, &other.root, &saved.id, "anything", 2000).is_err());
        assert!(list(&f.store, &other.root).unwrap().is_empty());
    }

    #[test]
    fn a_file_changed_after_the_preview_refuses_restore_without_touching_any_file() {
        let f = Fixture::new();
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        f.write("code.txt", b"first edit");
        let review = preview(&f.store, &f.root, &saved.id).unwrap();
        f.write("code.txt", b"another agent's edit");
        let result = restore(&f.store, &f.root, &saved.id, &review.token, 2000);
        assert!(
            result.is_err(),
            "a stale preview must not authorize new content"
        );
        assert_eq!(
            fs::read(f.root.join("code.txt")).unwrap(),
            b"another agent's edit"
        );
        assert_eq!(list(&f.store, &f.root).unwrap().len(), 1);
    }

    #[test]
    fn restoring_a_task_recovers_its_files_and_saves_the_replaced_work_for_undo() {
        let f = Fixture::new();
        f.write("deleted.txt", b"saved draft");
        let saved = create(&f.store, &f.root, "task", "Fix login", "Before", 1000).unwrap();
        f.write("code.txt", b"staged work");
        f.git(&["add", "code.txt"]);
        f.write("code.txt", b"new work");
        f.write("added.bin", &[0, 255]);
        f.write("ignored/cache", b"keep ignored");
        fs::remove_file(f.root.join("deleted.txt")).unwrap();
        let index = f.git(&["ls-files", "--stage"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        let review = preview(&f.store, &f.root, &saved.id).unwrap();
        let recovery = restore(&f.store, &f.root, &saved.id, &review.token, 2000).unwrap();
        assert_eq!(fs::read(f.root.join("code.txt")).unwrap(), b"original\r\n");
        assert_eq!(
            fs::read(f.root.join("deleted.txt")).unwrap(),
            b"saved draft"
        );
        assert!(!f.root.join("added.bin").exists());
        assert_eq!(
            fs::read(f.root.join("ignored/cache")).unwrap(),
            b"keep ignored"
        );
        assert_eq!(f.git(&["ls-files", "--stage"]), index);
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        let undo = preview(&f.store, &f.root, &recovery.id).unwrap();
        restore(&f.store, &f.root, &recovery.id, &undo.token, 3000).unwrap();
        assert_eq!(fs::read(f.root.join("code.txt")).unwrap(), b"new work");
        assert_eq!(fs::read(f.root.join("added.bin")).unwrap(), [0, 255]);
        assert!(!f.root.join("deleted.txt").exists());
    }

    #[test]
    fn preview_describes_added_modified_and_deleted_files_without_writing_them() {
        let f = Fixture::new();
        f.write("deleted.txt", b"keep me");
        let saved = create(&f.store, &f.root, "task", "Task", "Before", 1000).unwrap();
        f.write("code.txt", b"changed");
        f.write("added.bin", &[0, 255]);
        fs::remove_file(f.root.join("deleted.txt")).unwrap();
        let before = capture(&f.root).unwrap();
        let result = preview(&f.store, &f.root, &saved.id).unwrap();
        let changes: Vec<_> = result
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert_eq!(
            changes,
            vec![
                ("added.bin", "added"),
                ("code.txt", "modified"),
                ("deleted.txt", "deleted")
            ]
        );
        assert_eq!(capture(&f.root).unwrap(), before);
        assert!(!result.token.is_empty());
        let diff = compare_file(&f.store, &f.root, &saved.id, "code.txt").unwrap();
        assert_eq!(diff.before.as_deref(), Some("original\r\n"));
        assert_eq!(diff.after.as_deref(), Some("changed"));
        assert!(
            compare_file(&f.store, &f.root, &saved.id, "added.bin")
                .unwrap()
                .binary
        );
    }

    #[test]
    fn creating_a_task_checkpoint_keeps_uncommitted_bytes_and_leaves_git_untouched() {
        let f = Fixture::new();
        f.write("code.txt", b"staged\r\n");
        f.git(&["add", "code.txt"]);
        f.write("code.txt", b"unfinished\r\n");
        f.write("new.bin", &[0, 255, 1, 13, 10]);
        f.write("ignored/cache", b"not code");
        let index = f.git(&["ls-files", "--stage"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        let saved = create(
            &f.store,
            &f.root,
            "task-one",
            "Fix login",
            "Before changes",
            1000,
        )
        .unwrap();
        let rows = list(&f.store, &f.root).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, "task-one");
        let bytes = load_files(&f.store, &saved.id).unwrap();
        assert_eq!(bytes["code.txt"], b"unfinished\r\n");
        assert_eq!(bytes["new.bin"], [0, 255, 1, 13, 10]);
        assert!(!bytes.contains_key("ignored/cache"));
        assert_eq!(f.git(&["ls-files", "--stage"]), index);
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(f.git(&["branch", "--show-current"]), b"main\n");
    }
}
