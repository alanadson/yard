//! Repository change reader — the "review" half of the
//! "Files" panel: what changed, what is new, and the diff of each file.
//!
//! All via a `git` subprocess (same decision as the §F5 blueprint: no libgit2).
//! Rules:
//! - `GIT_OPTIONAL_LOCKS=0` everywhere: `git status` stops rewriting the
//!   index, so we do not fight the lock with the git the agent itself
//!   runs inside the terminal.
//! - `--porcelain=v2 -z`: stable format, no path quoting — paths come out
//!   identical to the watcher's (`files.rs`), with `/`.
//! - A project without git is not an error: returns `isRepo: false` and the
//!   UI shows the session summary instead.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use parking_lot::Mutex;
use serde::Serialize;

#[derive(Clone, Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Old path when renamed.
    pub orig_path: Option<String>,
    /// `modified` | `added` | `deleted` | `renamed` | `untracked` | `conflicted`
    pub status: String,
    pub staged: bool,
    /// What the **index** holds for this path, on its own: the same vocabulary
    /// as `status`, plus `none` for "nothing prepared here".
    ///
    /// `staged` is a boolean and a path can be on both sides at once (`MM`:
    /// prepared, then edited again). Source Control lists the two groups
    /// separately, so it needs the two halves, not their `or`.
    #[serde(default)]
    pub index: String,
    /// What the **working tree** holds for this path, on its own. `untracked`
    /// only ever appears here — the index knows nothing about a new file.
    #[serde(default)]
    pub worktree: String,
    /// The raw unmerged pair (`UU`, `AA`, `DU`…) when the path is conflicted;
    /// `None` otherwise. It is what names the conflict: "both modified",
    /// "deleted by them" and "added by us" want different resolutions.
    pub conflict: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangesSummary {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub files: Vec<ChangedFile>,
    pub additions: u32,
    pub deletions: u32,
    /// New files past `MAX_UNTRACKED_COUNTED` whose lines were **not** counted.
    /// Above zero, `additions` is a floor, not the total — and the UI has to
    /// say so instead of presenting a partial number as final.
    pub uncounted: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub is_binary: bool,
    pub truncated: bool,
    /// The file is outside the repo being reviewed (the agent's own memory, a
    /// screenshot in `%TEMP%`…). `text` is then the current content, not a
    /// comparison — git has no other side to diff it against.
    pub external: bool,
    pub text: String,
}

/// Cap on the diff text returned to the UI.
const MAX_DIFF_BYTES: usize = 1024 * 1024;
/// Cap on the read when synthesizing a new-file diff.
const MAX_NEW_FILE_BYTES: usize = 512 * 1024;
/// How many new files get their lines counted in the summary.
const MAX_UNTRACKED_COUNTED: usize = 500;

pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output().map_err(|e| format!("falha ao rodar git: {e}"))
}

fn has_head(cwd: &Path) -> bool {
    run_git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Full summary: status + numstat + line counts of the new files.
pub fn changes(cwd: &Path) -> Result<ChangesSummary, String> {
    // Missing git or a folder outside a repo land in the same place: the UI
    // has its own fallback for `isRepo: false`.
    // `status` is the probe too. Running `rev-parse` first doubled the process
    // startup cost of the most frequent Git operation in the app.
    let Ok(out) = run_git(
        cwd,
        &["status", "--porcelain=v2", "--branch", "-z", "-uall"],
    ) else {
        return Ok(ChangesSummary::default());
    };
    if !out.status.success() {
        return Ok(ChangesSummary::default());
    }
    let (branch, mut files) = parse_status_v2(&out.stdout);

    // Changed lines per tracked file (staged + worktree in one go).
    if status_has_head(&out.stdout) {
        if let Ok(o) = run_git(cwd, &["diff", "--numstat", "-z", "-M", "HEAD"]) {
            let stats = parse_numstat(&o.stdout);
            for f in &mut files {
                if let Some((adds, dels)) = stats.get(&f.path) {
                    f.additions = *adds;
                    f.deletions = *dels;
                    f.binary = adds.is_none() && dels.is_none();
                }
            }
        }
    }

    // "What's new": count untracked lines so the summary stays honest
    // (without this a new file shows up as +0). Reading every new file of a
    // fresh `node_modules` would cost more than the number is worth, so the
    // cap stays — but how many were skipped travels to the UI, which was the
    // missing half: a truncated total used to be shown as if it were final.
    let untracked = files.iter().filter(|f| f.status == "untracked").count();
    let uncounted = untracked.saturating_sub(MAX_UNTRACKED_COUNTED) as u32;
    for f in files
        .iter_mut()
        .filter(|f| f.status == "untracked")
        .take(MAX_UNTRACKED_COUNTED)
    {
        if let Some((lines, binary)) = count_lines(&cwd.join(&f.path)) {
            f.binary = binary;
            if !binary {
                f.additions = Some(lines);
                f.deletions = Some(0);
            }
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    let additions = files.iter().filter_map(|f| f.additions).sum();
    let deletions = files.iter().filter_map(|f| f.deletions).sum();

    Ok(ChangesSummary {
        is_repo: true,
        branch,
        files,
        additions,
        deletions,
        uncounted,
    })
}

fn status_has_head(bytes: &[u8]) -> bool {
    bytes.split(|b| *b == 0).any(|token| {
        token
            .strip_prefix(b"# branch.oid ")
            .is_some_and(|oid| oid != b"(initial)")
    })
}

/// Where a path handed to the viewer actually lives.
enum Target {
    /// Something git can talk about: path relative to `cwd`.
    Inside(String),
    /// Rooted path outside the worktree — git refuses to diff it.
    Outside,
    /// The path tries to leave the worktree by climbing (`../../…`). Unlike
    /// `Outside` there is nothing legitimate here: the panel sends paths
    /// relative to the root and the overlay sends absolute ones, so a
    /// relative path with `..` is either a bug or the session log of an agent
    /// asking for a file it was not given.
    Escapes,
}

/// Rooted in the shape any of the platforms writes it: `/x`, `C:/x`,
/// `//server/share`. Deliberately not `Path::is_absolute`, which answers for
/// the build target: these paths come from an agent's log, not from this
/// process, and on Windows `is_absolute` already says "no" to `/x`.
fn is_rooted(path: &str) -> bool {
    let b = path.as_bytes();
    b.first() == Some(&b'/') || matches!(b, [d, b':', ..] if d.is_ascii_alphabetic())
}

/// Places a path against the repo root. The panel always sends paths relative
/// to it (git's own convention), but the live overlay sends whatever the agent
/// wrote in its log — usually absolute.
fn locate(cwd: &Path, path: &str) -> Target {
    let norm = path.replace('\\', "/");
    if !is_rooted(&norm) {
        // `cwd.join(rel)` with a `..` in it lands outside the worktree, and
        // this function had none of the fence `explorer::resolve` applies to
        // every other path crossing the IPC. A `:` is the NTFS alternate-stream
        // separator, blocked there for the same reason.
        if norm.split('/').any(|p| p == "..") || norm.contains(':') {
            return Target::Escapes;
        }
        return Target::Inside(norm);
    }
    let root = cwd.to_string_lossy().replace('\\', "/");
    let root = root.trim_end_matches('/');
    // Case-insensitive, same as the session tail: on Windows the agent writes
    // `C:\Users\…` and the root can arrive as `c:/users/…`.
    // The `/` test comes first — it is what makes the byte slice below land on
    // a char boundary.
    if !root.is_empty()
        && norm.len() > root.len() + 1
        && norm.as_bytes()[root.len()] == b'/'
        && norm[..root.len()].eq_ignore_ascii_case(root)
    {
        return Target::Inside(norm[root.len() + 1..].to_string());
    }
    Target::Outside
}

/// Unified diff of a file. For untracked (or a repo with no commit yet)
/// there is no "left side" — we synthesize an all-additions diff, so the
/// front renderer has a single path.
///
/// `orig_path` (rename): without the old path in the pathspec, `-M` has no
/// other side to compare and the rename would become a 100% new file.
///
/// `context`: context lines per hunk (`-U<n>`). `None` = git's default
/// (3). The large viewer uses a huge value for "whole file" mode — the
/// diff becomes the complete file with the changes marked.
pub fn file_diff(
    cwd: &Path,
    path: &str,
    untracked: bool,
    orig_path: Option<&str>,
    context: Option<u32>,
) -> Result<FileDiff, String> {
    // The live overlay lists everything the agent touched, and part of that is
    // never in the project: its own memory, a screenshot in `%TEMP%`. Giving
    // such a path to `git diff` answers `fatal: … is outside repository`, and
    // that fatal was what the viewer printed. Show the file itself instead —
    // the content is what the click was asking for.
    // The worktree under review counts as a root the app opened, whether or
    // not the file tree ever listed it.
    crate::explorer::remember(cwd);

    let rel = match locate(cwd, path) {
        Target::Inside(rel) => rel,
        Target::Escapes => {
            return Err(format!("caminho fora da pasta do projeto: {path}"));
        }
        Target::Outside => {
            // Outside the repo is allowed, "anywhere on disk" is not: the path
            // arrives from an agent's own session log. Only somewhere the app
            // has actually opened, or the temp folder where the screenshots
            // and scratch files this feature exists for are written.
            let target = Path::new(path);
            if !crate::explorer::path_allowed(target) {
                return Err(format!(
                    "{path} está fora de qualquer projeto aberto — o Yard não lê arquivos \
                     arbitrários do disco a partir do log de um agente"
                ));
            }
            return synth_diff(target, path, Synth::Content);
        }
    };

    if untracked || !has_head(cwd) {
        return synth_diff(&cwd.join(&rel), path, Synth::NewFile);
    }

    let ctx_arg = context.map(|n| format!("-U{n}"));
    let mut args = vec!["diff", "--no-color", "-M"];
    if let Some(c) = ctx_arg.as_deref() {
        args.push(c);
    }
    args.extend(["HEAD", "--", rel.as_str()]);
    if let Some(orig) = orig_path {
        args.push(orig);
    }
    let out = run_git(cwd, &args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let truncated = text.len() > MAX_DIFF_BYTES;
    if truncated {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    let is_binary = text.lines().any(|l| l.starts_with("Binary files "));

    Ok(FileDiff {
        path: path.to_string(),
        is_binary,
        truncated,
        external: false,
        text,
    })
}

/// Read cap for `head_text` — the same the editor applies to the disk side.
const MAX_HEAD_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// The file's content at HEAD, normalized the way the editor reads the disk
/// (`\n`, no BOM) — the left side of the editor's git gutter.
///
/// `Ok(None)` is an answer, not an error: untracked file, repo without a
/// commit, binary blob, folder outside a repo, git missing — in all of them
/// there is no HEAD text and the gutter simply has nothing to compare against.
pub fn head_text(cwd: &Path, rel: &str) -> Result<Option<String>, String> {
    // The same fence every editor path crosses. `rel` comes from an open
    // document, but nothing here should trust that.
    crate::explorer::resolve(cwd, rel)?;
    if !has_head(cwd) {
        return Ok(None);
    }
    // `./` makes the spec relative to `cwd` — right in a worktree whose root
    // is not the repository's.
    let spec = format!("HEAD:./{}", rel.replace('\\', "/"));
    let Ok(out) = run_git(cwd, &["show", spec.as_str()]) else {
        return Ok(None);
    };
    if !out.status.success() || out.stdout.len() > MAX_HEAD_TEXT_BYTES {
        return Ok(None);
    }
    // git's binary heuristic, the same the editor uses on disk.
    if out.stdout.iter().take(8 * 1024).any(|b| *b == 0) {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&out.stdout).into_owned();
    let raw = raw
        .strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(raw);
    Ok(Some(if raw.contains("\r\n") {
        raw.replace("\r\n", "\n")
    } else {
        raw
    }))
}

/// Which side of a synthesized diff the file's content stands on.
enum Synth {
    /// No left side at all (untracked, or a repo with no commit): every line
    /// is an addition, which is what the file being new means.
    NewFile,
    /// Nothing to compare against (file outside the repo): every line is
    /// context, so the viewer draws the file exactly as it is on disk.
    Content,
}

/// A diff built here instead of by git, from the bytes on disk. `full` is the
/// file to read; `path` is how the UI names it.
fn synth_diff(full: &Path, path: &str, side: Synth) -> Result<FileDiff, String> {
    let external = matches!(side, Synth::Content);
    let file = std::fs::File::open(full).map_err(|e| format!("nao consegui ler {path}: {e}"))?;

    let mut buf = Vec::new();
    file.take((MAX_NEW_FILE_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let truncated = buf.len() > MAX_NEW_FILE_BYTES;
    if truncated {
        buf.truncate(MAX_NEW_FILE_BYTES);
    }

    if buf.iter().take(8192).any(|b| *b == 0) {
        return Ok(FileDiff {
            path: path.to_string(),
            is_binary: true,
            truncated,
            external,
            text: String::new(),
        });
    }

    let content = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = content.lines().collect();
    let n = lines.len();
    let mut text = match side {
        Synth::NewFile => format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{n} @@\n"),
        // An empty file has no hunk to open: `@@ -1,0 +1,0 @@` would draw a
        // header over nothing. The viewer says "empty file" for a text-less diff.
        Synth::Content if n == 0 => String::new(),
        Synth::Content => format!("--- a/{path}\n+++ b/{path}\n@@ -1,{n} +1,{n} @@\n"),
    };
    let sign = match side {
        Synth::NewFile => '+',
        Synth::Content => ' ',
    };
    for line in &lines {
        text.push(sign);
        text.push_str(line);
        text.push('\n');
    }

    Ok(FileDiff {
        path: path.to_string(),
        is_binary: false,
        truncated,
        external,
        text,
    })
}

const LINE_COUNT_CACHE_CAP: usize = 2048;

#[derive(Clone, Copy, PartialEq, Eq)]
struct LineStamp {
    len: u64,
    modified: SystemTime,
}

#[derive(Clone, Copy)]
struct CachedLineCount {
    stamp: LineStamp,
    value: (u32, bool),
    used: u64,
}

#[derive(Default)]
struct LineCountCache {
    clock: u64,
    entries: HashMap<PathBuf, CachedLineCount>,
}

impl LineCountCache {
    fn get(&mut self, path: &Path, stamp: LineStamp) -> Option<(u32, bool)> {
        let cached = self.entries.get(path).copied()?;
        if cached.stamp != stamp {
            self.entries.remove(path);
            return None;
        }
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.entries.get_mut(path) {
            entry.used = self.clock;
        }
        Some(cached.value)
    }

    fn insert(&mut self, path: PathBuf, stamp: LineStamp, value: (u32, bool)) {
        if !self.entries.contains_key(&path) && self.entries.len() >= LINE_COUNT_CACHE_CAP {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(path, _)| path.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.clock = self.clock.wrapping_add(1);
        self.entries.insert(
            path,
            CachedLineCount {
                stamp,
                value,
                used: self.clock,
            },
        );
    }
}

fn line_count_cache() -> &'static Mutex<LineCountCache> {
    static CACHE: OnceLock<Mutex<LineCountCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LineCountCache::default()))
}

/// Counts lines of a small file; `None` = could not read. Results are reused
/// across the frequent `git status` refreshes until size or mtime changes.
/// The returned bool indicates binary (found NUL at the start).
fn count_lines(full: &Path) -> Option<(u32, bool)> {
    let meta = std::fs::metadata(full).ok()?;
    if meta.len() > MAX_NEW_FILE_BYTES as u64 {
        return None;
    }
    let stamp = LineStamp {
        len: meta.len(),
        modified: meta.modified().ok()?,
    };
    if let Some(value) = line_count_cache().lock().get(full, stamp) {
        return Some(value);
    }
    let bytes = std::fs::read(full).ok()?;
    let value = if bytes.iter().take(8192).any(|b| *b == 0) {
        (0, true)
    } else {
        let mut lines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
        if bytes.last().is_some_and(|b| *b != b'\n') {
            lines += 1;
        }
        (lines, false)
    };
    line_count_cache()
        .lock()
        .insert(full.to_path_buf(), stamp, value);
    Some(value)
}

// ---------------------------------------------------------------------------
// floors (git worktree)
// ---------------------------------------------------------------------------

/// Result of provisioning a floor. `kind`:
/// - `isolated`: a real git worktree, with its own branch;
/// - `plain`: project without git (or `--no-git`) — the floor shares the
///   ground's cwd and the response must tell the caller so.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProvision {
    pub path: String,
    pub branch: Option<String>,
    pub kind: String,
    /// Where the new worktree's HEAD landed — what the rollback compares
    /// against before it dares delete the branch it just created.
    pub head_oid: Option<String>,
    /// The commit the branch grew from, when this call created the branch.
    pub base_oid: Option<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub bare: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookResult {
    pub code: i32,
    pub output: String,
}

/// Cap on the captured output of a floor hook.
const MAX_HOOK_OUTPUT: usize = 32 * 1024;

/// Floor slug: it becomes a folder and branch name, so only `[a-z0-9-]`
/// survives. Common pt-BR accents are transliterated instead of
/// dropped ("Correção" -> "correcao", not "correo").
pub fn floor_slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        let mapped: Option<char> = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => Some('a'),
            'é' | 'è' | 'ê' | 'ë' => Some('e'),
            'í' | 'ì' | 'î' | 'ï' => Some('i'),
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => Some('o'),
            'ú' | 'ù' | 'û' | 'ü' => Some('u'),
            'ç' => Some('c'),
            'ñ' => Some('n'),
            c if c.is_ascii_alphanumeric() => Some(c),
            _ => None,
        };
        match mapped {
            Some(m) => out.push(m),
            None => {
                if !out.is_empty() && !out.ends_with('-') {
                    out.push('-');
                }
            }
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        "frente".into()
    } else {
        slug
    }
}

/// Is this a branch name git will accept — and that git will read as a *name*?
///
/// The second half is the one that was missing: the name travels as a
/// positional argument to `git worktree add`, so `--help` or `-f` became an
/// option and the error that came back said nothing about branch names. The
/// rest mirrors `git check-ref-format` for the cases a person actually types.
pub(crate) fn check_branch_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("o nome da branch está vazio".into());
    }
    if n.starts_with('-') {
        return Err(format!(
            "\"{n}\" começa com \"-\" e o git leria isso como uma opção, não como um nome de branch"
        ));
    }
    let forbidden = |c: char| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c);
    if n.chars().any(forbidden)
        || n.contains("..")
        || n.contains("@{")
        || n.starts_with('/')
        || n.ends_with('/')
        || n.ends_with('.')
        || n.ends_with(".lock")
        || n.contains("//")
    {
        return Err(format!(
            "\"{n}\" não é um nome de branch válido para o git (sem espaços, \"..\", \"~\", \"^\", \":\" ou barra no fim)"
        ));
    }
    Ok(())
}

fn is_repo(cwd: &Path) -> bool {
    run_git(cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

fn git_err(out: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() {
        format!("git saiu com codigo {:?}", out.status.code())
    } else {
        err
    }
}

/// Ensures `.yard/` is in the project's `.gitignore` — the floor clones live
/// in `<project>/.yard/floors/` and must not show up as untracked files on
/// the ground.
fn ensure_yard_ignored(project: &Path) -> std::io::Result<()> {
    let path = project.join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let already_there = current
        .lines()
        .map(str::trim)
        .any(|l| l == ".yard/" || l == ".yard" || l == "/.yard/" || l == "/.yard");
    if already_there {
        return Ok(());
    }
    let mut updated = current;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(".yard/\n");
    std::fs::write(&path, updated)
}

/// Everything the creation needs, already decided.
///
/// The fields nobody filled are derived here; the fields the plan filled are
/// used **verbatim**. That is the whole contract with the preflight: the
/// folder and the branch printed on the screen are the folder and the branch
/// that get created. They used to be derived twice, once in each language,
/// and a slug already taken made the plan promise one path and the disk get
/// another.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionInput {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub existing_branch: bool,
    #[serde(default)]
    pub no_git: bool,
    /// The commit the new branch grows from — the one the plan froze.
    #[serde(default)]
    pub base: Option<String>,
    /// The folder under `.yard/floors/`, when the plan already chose it.
    #[serde(default)]
    pub worktree_name: Option<String>,
}

/// How long `git worktree add` gets before the app stops waiting for it.
///
/// Generous for an ordinary large checkout, short enough that a folder backed
/// by a cloud sync (where reading a placeholder file can block for as long
/// as the service likes) fails instead of hanging the whole creation. What
/// makes a deadline safe here is the rollback: the journal knows what this
/// run wrote and undoes exactly that.
pub(crate) const WORKTREE_ADD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// The ceiling for `YARD_WORKTREE_ADD_TIMEOUT_MS`.
pub(crate) const WORKTREE_ADD_TIMEOUT_MAX: std::time::Duration =
    std::time::Duration::from_secs(30 * 60);

/// The deadline, with the escape hatch a genuinely slow repository needs.
///
/// The clamp only goes up. `=300` reads as seconds to almost everyone who
/// types it, and obeying that would turn every create on a big repository
/// into a failure three hundred milliseconds in.
pub(crate) fn worktree_add_timeout(raw: Option<&str>) -> std::time::Duration {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u64>().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or(WORKTREE_ADD_TIMEOUT)
        .clamp(WORKTREE_ADD_TIMEOUT, WORKTREE_ADD_TIMEOUT_MAX)
}

/// Runs an already configured command and kills it at the deadline.
///
/// The command arrives whole because its stdio belongs to the caller; this
/// owns only the waiting. A poll loop rather than a thread: there is one of
/// these in flight at a time, and a blocked reader would be one more thing to
/// join on the failure path.
pub(crate) fn run_bounded(
    mut cmd: std::process::Command,
    limit: std::time::Duration,
) -> Result<std::process::Output, String> {
    let mut child = cmd.spawn().map_err(|e| format!("falha ao rodar git: {e}"))?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "o git passou de {}s sem responder e foi encerrado",
                        limit.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(format!("falha ao esperar o git: {e}")),
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("falha ao ler a saida do git: {e}"))
}

/// `run_git`, with a deadline. Same environment, same hidden console window.
fn run_git_bounded(
    cwd: &Path,
    args: &[String],
    limit: std::time::Duration,
) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    run_bounded(cmd, limit)
}

/// `run_git`, with something written to the command's stdin.
///
/// The caller is expected to keep the input small: everything is written
/// before anything is read, which is only safe while the write fits in the
/// pipe's buffer.
fn run_git_stdin(cwd: &Path, args: &[&str], input: &[u8]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("falha ao rodar git: {e}"))?;
    if let Some(mut pipe) = child.stdin.take() {
        use std::io::Write;
        let _ = pipe.write_all(input);
        // Dropping the handle closes it: without that git waits for an end
        // that never comes.
    }
    child
        .wait_with_output()
        .map_err(|e| format!("falha ao ler a saida do git: {e}"))
}

/// The whole command line for creating a front's worktree.
///
/// `core.longpaths=true` rides at **command** scope, never `--global`, never
/// written to anybody's config. A front lives at `.yard/floors/<slug>/…`, two
/// folders below a ground that already fits, and on Windows that is exactly
/// where a deep repository crosses MAX_PATH and `worktree add` gives up with
/// "Filename too long".
///
/// `--no-track`: a front is a place to work, not a mirror of the base. Left
/// tracking, the first `git push` of every front would aim at the branch it
/// grew from. An existing branch takes no base, because naming one would ask
/// git to move a branch somebody else is using.
pub(crate) fn worktree_add_args(
    long_paths: bool,
    existing_branch: bool,
    branch: &str,
    rel: &str,
    base: &str,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if long_paths {
        args.push("-c".into());
        args.push("core.longpaths=true".into());
    }
    args.push("worktree".into());
    args.push("add".into());
    if existing_branch {
        args.push(rel.into());
        args.push(branch.into());
    } else {
        args.push("--no-track".into());
        args.push("-b".into());
        args.push(branch.into());
        args.push(rel.into());
        args.push(base.into());
    }
    args
}

/// Lets a plain `git push` from a new front create its own remote branch.
///
/// The branch was made with `--no-track`, so it has no upstream, and without
/// this the first push an agent runs inside the front dies with "The current
/// branch has no upstream branch". `--get` with no scope on purpose: a value
/// sitting in the global config is the person's answer and is left alone.
/// `--local` from a linked worktree writes the repository's shared config,
/// which is the intent: it is the whole repository's default from then on.
fn ensure_push_auto_setup_remote(worktree: &Path) {
    let Ok(read) = run_git(worktree, &["config", "--get", "push.autoSetupRemote"]) else {
        return;
    };
    // Exit 1 is the one code that means "unset everywhere". Anything else is
    // a read that failed, and a value we could not read is not ours to write.
    if read.status.success() || read.status.code() != Some(1) {
        return;
    }
    if let Ok(out) = run_git(
        worktree,
        &["config", "--local", "push.autoSetupRemote", "true"],
    ) {
        if !out.status.success() {
            tracing::warn!(
                worktree = %worktree.display(),
                "nao consegui definir push.autoSetupRemote: {}",
                git_err(&out)
            );
        }
    }
}

/// Repository-level list of ignored paths every new worktree needs. The name
/// is the convention other worktree tools already read, so a repository that
/// keeps one gets this without being told about the Yard.
const WORKTREE_INCLUDE_FILE: &str = ".worktreeinclude";
const WORKTREE_INCLUDE_MAX_BYTES: u64 = 256 * 1024;
const WORKTREE_INCLUDE_MAX_ENTRIES: usize = 1000;

/// `.worktreeinclude` into repo-relative literal paths.
///
/// Deliberately small: literal files and folders, anchored at the root.
/// A glob or a negation would have to be *interpreted*, and a pattern half
/// understood copies the wrong file; a `..`, a drive letter or a leading `/`
/// would read outside the repository altogether. Anything of that shape is
/// dropped rather than guessed at.
pub(crate) fn parse_worktree_include(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let slashes = line.replace('\\', "/");
        let entry = slashes
            .strip_prefix("./")
            .unwrap_or(&slashes)
            .trim_end_matches('/')
            .to_string();
        if entry.is_empty() || !seen.insert(entry.clone()) {
            continue;
        }
        if entry.starts_with('!') || entry.contains('*') || entry.contains('?') {
            continue;
        }
        if entry.starts_with('/') || entry.contains(':') {
            continue;
        }
        let segments: Vec<&str> = entry.split('/').collect();
        if segments.iter().any(|s| s.is_empty() || *s == "..") || segments[0] == ".git" {
            continue;
        }
        out.push(entry);
        if out.len() >= WORKTREE_INCLUDE_MAX_ENTRIES {
            break;
        }
    }
    out
}

/// Which of those paths git actually ignores.
///
/// Ignored is the whole contract. A tracked file is already in the checkout,
/// and carrying over an untracked one that git *would* show turns the front
/// dirty the second it is born: a change nobody made, on a branch nobody has
/// touched yet.
fn ignored_paths(project: &Path, paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    // Over stdin, in chunks: `-z` is what keeps a path with a space or an
    // accent whole, and git only accepts it that way. The chunk keeps the
    // write comfortably inside the pipe's buffer, so nothing deadlocks
    // waiting for a reader that is still writing.
    for chunk in paths.chunks(100) {
        let mut input = Vec::new();
        for path in chunk {
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        let Ok(res) = run_git_stdin(project, &["check-ignore", "-z", "--stdin"], &input) else {
            continue;
        };
        // Exit 1 means "none of these is ignored" and is not a failure;
        // anything above it is, and must not read as an answer.
        if !res.status.success() && res.status.code() != Some(1) {
            continue;
        }
        out.extend(
            res.stdout
                .split(|b| *b == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).into_owned()),
        );
    }
    out
}

/// The ignored paths a repository asks every new worktree to carry.
fn worktree_include_paths(project: &Path) -> Vec<String> {
    let file = project.join(WORKTREE_INCLUDE_FILE);
    let Ok(meta) = std::fs::metadata(&file) else {
        return Vec::new();
    };
    if !meta.is_file() || meta.len() > WORKTREE_INCLUDE_MAX_BYTES {
        return Vec::new();
    }
    let Ok(content) = std::fs::read_to_string(&file) else {
        return Vec::new();
    };
    // A listed path that is not on the ground has nothing to copy, and a
    // `node_modules` before the first install is the ordinary case.
    let existing: Vec<String> = parse_worktree_include(&content)
        .into_iter()
        .filter(|rel| project.join(rel).exists())
        .collect();
    if existing.is_empty() {
        return Vec::new();
    }
    ignored_paths(project, &existing)
}

/// Copies those paths into the front that was just created.
///
/// Best effort, always. A fresh worktree is a clean checkout: the `.env`, the
/// local config, everything the project ignores is missing from it, and the
/// CLI opened there starts in a project that cannot run. But a front that
/// fails to exist because one file was locked is worse than a front missing
/// it, so every failure here is a log line and the creation goes on.
fn copy_included_paths(project: &Path, worktree: &Path) {
    for rel in worktree_include_paths(project) {
        let to = worktree.join(&rel);
        // Whatever is already there was put there by the checkout or by a
        // hook, and it is not this function's to overwrite.
        if to.exists() {
            continue;
        }
        let outcome = to
            .parent()
            .map(std::fs::create_dir_all)
            .unwrap_or(Ok(()))
            .and_then(|()| copy_path(&project.join(&rel), &to));
        if let Err(e) = outcome {
            tracing::warn!(path = %rel, "nao consegui levar o arquivo para a frente: {e}");
        }
    }
}

/// Copies a file or a whole folder. A symlink is skipped: it points into the
/// ground's own folder, and following it would copy something nobody listed.
fn copy_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_path(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ())
}

/// Creates (or merely describes, without git) a floor's directory.
///
/// - new branch: `git worktree add --no-track -b <branch> <path> <base>`
/// - existing branch: `git worktree add <path> <branch>`
/// - no git / `no_git`: nothing runs; returns `kind: "plain"` with the
///   project's own cwd so the group is born in the same place as the ground.
///
/// The base is passed explicitly, always. Without it `worktree add -b` grows
/// the branch from whatever HEAD is at that instant: a plan read at 14:00 and
/// confirmed at 14:03, with a `git pull` in between, created the front
/// somewhere other than the screen had said, and nothing on screen ever
/// mentioned it.
pub fn worktree_provision(
    project_path: &Path,
    input: &ProvisionInput,
) -> Result<WorktreeProvision, String> {
    if input.no_git || !is_repo(project_path) {
        return Ok(WorktreeProvision {
            path: project_path.to_string_lossy().into_owned(),
            branch: None,
            kind: "plain".into(),
            head_oid: None,
            base_oid: None,
        });
    }
    if !has_head(project_path) {
        return Err(
            "o repositorio ainda nao tem nenhum commit — faca o primeiro commit antes de abrir uma frente"
                .into(),
        );
    }

    let floors = project_path.join(".yard").join("floors");
    let slug = match input
        .worktree_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Chosen by the plan: used as it is, and a folder already there is a
        // refusal, not a rename. The plan is what walks past what is taken.
        Some(chosen) => {
            if floors.join(chosen).exists() {
                return Err(format!("ja existe uma pasta em .yard/floors/{chosen}"));
            }
            chosen.to_string()
        }
        // Nobody chose: derive, and walk past what the disk already holds.
        // Two different names can collapse into the same slug — "Correção"
        // and "Correcao" both give `correcao` — and the old code stopped
        // there, naming a folder the user had never typed.
        None => {
            let base = floor_slug(&input.name);
            let mut slug = base.clone();
            let mut n = 2;
            while floors.join(&slug).exists() {
                if n > 99 {
                    return Err(format!(
                        "ja existem frentes demais com um nome parecido com \"{}\" \
                         (slug {base}) — escolha outro nome",
                        input.name
                    ));
                }
                slug = format!("{base}-{n}");
                n += 1;
            }
            slug
        }
    };

    let abs = floors.join(&slug);
    ensure_yard_ignored(project_path)
        .map_err(|e| format!("nao consegui atualizar o .gitignore: {e}"))?;

    // Relative path with `/`: git on Windows accepts it and the log stays readable.
    let rel = format!(".yard/floors/{slug}");
    let branch_name = if input.existing_branch {
        match input.branch.as_deref().map(str::trim) {
            Some(b) if !b.is_empty() => b.to_string(),
            _ => return Err("--existing-branch exige o nome da branch".into()),
        }
    } else {
        input
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("yard/{slug}"))
    };
    // Checked before it reaches the command line: the name is positional, so
    // one starting with `-` would be read as an option and the error would
    // talk about anything but the branch name.
    check_branch_name(&branch_name)?;

    // The base is resolved to a commit before this point, so what is recorded
    // is what was used, even when the caller passed a name.
    let base = if input.existing_branch {
        String::new()
    } else {
        let named = input
            .base
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .unwrap_or("HEAD");
        check_branch_name(named)?;
        named.to_string()
    };
    let out = run_git_bounded(
        project_path,
        &worktree_add_args(
            cfg!(windows),
            input.existing_branch,
            &branch_name,
            &rel,
            &base,
        ),
        worktree_add_timeout(std::env::var("YARD_WORKTREE_ADD_TIMEOUT_MS").ok().as_deref()),
    )?;
    if !out.status.success() {
        return Err(git_err(&out));
    }

    // Everything below here is about the front being *usable*, not about it
    // existing: a failure is logged and the front still comes back.
    if !input.existing_branch {
        ensure_push_auto_setup_remote(&abs);
    }
    copy_included_paths(project_path, &abs);

    // Read back, not assumed: this is the OID the rollback compares against
    // before it dares delete the branch it just made.
    let head_oid = resolve_commit(&abs, "HEAD");
    Ok(WorktreeProvision {
        path: abs.to_string_lossy().into_owned(),
        branch: Some(branch_name),
        kind: "isolated".into(),
        base_oid: if input.existing_branch {
            None
        } else {
            head_oid.clone()
        },
        head_oid,
    })
}

/// Deletes a branch **only** while it still points at `expected_oid`.
///
/// This is the whole safety of the rollback. A creation that failed halfway
/// wants its branch gone; a branch the agent has already committed to holds
/// work that exists nowhere else, and deleting that is the most expensive bug
/// this app could ship. `update-ref -d <ref> <old>` is git's own
/// compare-and-swap: it refuses when the ref moved, and there is no window
/// between the check and the delete for it to move in.
///
/// `Ok(true)` = gone (deleted, or already absent). `Ok(false)` = it moved and
/// was kept, and the caller owes the user a sentence saying so.
pub fn branch_delete_if_unchanged(
    project_path: &Path,
    branch: &str,
    expected_oid: &str,
) -> Result<bool, String> {
    check_branch_name(branch)?;
    let refname = format!("refs/heads/{branch}");
    let out = run_git(project_path, &["update-ref", "-d", &refname, expected_oid])?;
    if out.status.success() {
        return Ok(true);
    }
    match resolve_commit(project_path, &refname) {
        // Somebody else already removed it: nothing to preserve.
        None => Ok(true),
        // It moved: there is work on it now, and it stays.
        Some(now) if now != expected_oid => Ok(false),
        // It is exactly where we left it and git still refused — that is a
        // real failure (a lock, permissions) and must not read as success.
        Some(_) => Err(git_err(&out)),
    }
}

pub fn worktree_list(project_path: &Path) -> Result<Vec<WorktreeEntry>, String> {
    if !is_repo(project_path) {
        return Ok(Vec::new());
    }
    let out = run_git(project_path, &["worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    Ok(parse_worktree_list(&String::from_utf8_lossy(&out.stdout)))
}

/// Uncommitted work in the worktree? Closing a dirty floor is refused in
/// the UI — this is that test.
pub fn worktree_dirty(path: &Path) -> Result<bool, String> {
    let out = run_git(path, &["status", "--porcelain", "-unormal"])?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    Ok(!out.stdout.is_empty())
}

// ---------------------------------------------------------------------------
// landing a floor back on the ground
// ---------------------------------------------------------------------------

/// One file in a land preview: what the floor would bring onto the ground.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LandFile {
    pub path: String,
    pub orig_path: Option<String>,
    /// `added` | `modified` | `deleted` | `renamed` | `conflicted`
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Dry-run of `git merge <floor>` onto the ground: the diffstat, whether
/// it would conflict, and the two dirty flags that make landing unsafe.
/// Nothing on disk moves.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LandPreview {
    pub ground_branch: String,
    pub floor_branch: String,
    pub clean: bool,
    pub already_merged: bool,
    pub ground_dirty: bool,
    pub floor_dirty: bool,
    pub files: Vec<LandFile>,
    pub additions: u32,
    pub deletions: u32,
    pub conflict_paths: Vec<String>,
}

/// Outcome of a real merge on the ground. On conflict the merge is aborted
/// so the ground is left as it was — the preview is what the user acts on.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LandResult {
    pub ok: bool,
    pub already_merged: bool,
    pub conflicted: bool,
    pub message: String,
    pub conflict_paths: Vec<String>,
}

fn current_branch(cwd: &Path) -> Result<String, String> {
    let out = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        return Err("nao consegui ler a branch do chao".into());
    }
    Ok(name)
}

fn is_ancestor(cwd: &Path, ancestor: &str, tip: &str) -> Result<bool, String> {
    let out = run_git(cwd, &["merge-base", "--is-ancestor", ancestor, tip])?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_err(&out)),
    }
}

fn merge_in_progress(cwd: &Path) -> bool {
    run_git(cwd, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn abort_merge(cwd: &Path) {
    let _ = run_git(cwd, &["merge", "--abort"]);
}

/// `git merge-tree --write-tree` (Git 2.38+): conflicted paths without
/// touching the worktree. Unknown option = older git, treated as "we
/// cannot tell" (empty list, `clean` stays true) — landing still refuses
/// a dirty ground and will abort a real merge that hits a conflict.
fn conflict_paths(cwd: &Path, theirs: &str) -> Vec<String> {
    let out = match run_git(
        cwd,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "HEAD",
            theirs,
        ],
    ) {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if out.status.success() {
        return Vec::new();
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("unknown option") || err.contains("unknown switch") {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !is_git_oid(l))
        .map(|s| s.to_string())
        .collect()
}

fn is_git_oid(s: &str) -> bool {
    s.len() >= 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `git diff --name-status -z -M`: status, then path; rename/copy carry
/// the old path as the next record.
pub(crate) fn parse_name_status(bytes: &[u8]) -> Vec<(String, String, Option<String>)> {
    let toks: Vec<String> = bytes
        .split(|b| *b == 0)
        .map(|t| String::from_utf8_lossy(t).into_owned())
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let tok = toks[i].trim();
        if tok.is_empty() {
            i += 1;
            continue;
        }
        let letter = tok.chars().next().unwrap_or('M');
        let status = match letter {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "added",
            'U' => "conflicted",
            _ => "modified",
        };
        if letter == 'R' || letter == 'C' {
            let orig = toks.get(i + 1).cloned().filter(|s| !s.is_empty());
            let dest = toks.get(i + 2).cloned().unwrap_or_default();
            if !dest.is_empty() {
                out.push((status.into(), dest, orig));
            }
            i += 3;
            continue;
        }
        if let Some(path) = toks.get(i + 1).filter(|s| !s.is_empty()) {
            out.push((status.into(), path.clone(), None));
        }
        i += 2;
    }
    out
}

fn name_status_to_files(
    names: Vec<(String, String, Option<String>)>,
    stats: &HashMap<String, (Option<u32>, Option<u32>)>,
    conflicts: &[String],
) -> Vec<LandFile> {
    let conflicted: HashSet<&str> = conflicts.iter().map(|s| s.as_str()).collect();
    let mut files: Vec<LandFile> = names
        .into_iter()
        .map(|(status, path, orig_path)| {
            let (additions, deletions) = stats
                .get(&path)
                .copied()
                .unwrap_or((None, None));
            LandFile {
                status: if conflicted.contains(path.as_str()) {
                    "conflicted".into()
                } else {
                    status
                },
                path,
                orig_path,
                additions,
                deletions,
            }
        })
        .collect();
    for path in conflicts {
        if !files.iter().any(|f| &f.path == path) {
            files.push(LandFile {
                path: path.clone(),
                orig_path: None,
                status: "conflicted".into(),
                additions: None,
                deletions: None,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// What landing `floor_branch` onto the project's current HEAD would do.
/// `floor_path` is only used to report whether the floor itself is dirty.
pub fn worktree_preview(
    project_path: &Path,
    floor_branch: &str,
    floor_path: Option<&Path>,
) -> Result<LandPreview, String> {
    if !is_repo(project_path) {
        return Err("o chao nao e um repositorio git".into());
    }
    let branch = floor_branch.trim();
    if branch.is_empty() {
        return Err("a frente nao tem branch para aterrissar".into());
    }
    let ground_branch = current_branch(project_path)?;
    if ground_branch == branch {
        return Err(format!(
            "a branch da frente e a mesma do chao ({branch}) — nao ha o que aterrissar"
        ));
    }

    let ground_dirty = worktree_dirty(project_path)?;
    let floor_dirty = match floor_path {
        Some(p) => worktree_dirty(p)?,
        None => false,
    };

    let already_merged = is_ancestor(project_path, branch, "HEAD")?;

    let names_out = run_git(
        project_path,
        &["diff", "--name-status", "-z", "-M", &format!("HEAD...{branch}")],
    )?;
    if !names_out.status.success() {
        return Err(git_err(&names_out));
    }
    let names = parse_name_status(&names_out.stdout);

    let stats = run_git(
        project_path,
        &["diff", "--numstat", "-z", "-M", &format!("HEAD...{branch}")],
    )
    .ok()
    .filter(|o| o.status.success())
    .map(|o| parse_numstat(&o.stdout))
    .unwrap_or_default();

    let conflicts = if already_merged {
        Vec::new()
    } else {
        conflict_paths(project_path, branch)
    };
    let files = name_status_to_files(names, &stats, &conflicts);
    let additions = files.iter().filter_map(|f| f.additions).sum();
    let deletions = files.iter().filter_map(|f| f.deletions).sum();

    Ok(LandPreview {
        ground_branch,
        floor_branch: branch.into(),
        clean: conflicts.is_empty(),
        already_merged,
        ground_dirty,
        floor_dirty,
        files,
        additions,
        deletions,
        conflict_paths: conflicts,
    })
}

/// Merges `floor_branch` into the ground. Refuses a dirty tree on either
/// side and a preview that already knows about conflicts. A merge that
/// still conflicts (race) is aborted so the ground stays clean.
pub fn worktree_land(
    project_path: &Path,
    floor_branch: &str,
    floor_path: Option<&Path>,
) -> Result<LandResult, String> {
    let preview = worktree_preview(project_path, floor_branch, floor_path)?;
    if preview.ground_dirty {
        return Err(
            "o chao tem trabalho nao commitado — faca commit (ou descarte) antes de aterrissar. \
             (abrir a primeira frente acrescenta `.yard/` ao `.gitignore`)"
                .into(),
        );
    }
    if preview.floor_dirty {
        return Err(
            "a frente tem trabalho nao commitado — faca commit (ou descarte) antes de aterrissar"
                .into(),
        );
    }
    if preview.already_merged {
        return Ok(LandResult {
            ok: true,
            already_merged: true,
            conflicted: false,
            message: format!(
                "\"{}\" ja esta no chao ({})",
                preview.floor_branch, preview.ground_branch
            ),
            conflict_paths: Vec::new(),
        });
    }
    if !preview.clean {
        return Ok(LandResult {
            ok: false,
            already_merged: false,
            conflicted: true,
            message: format!(
                "aterrissar \"{}\" no chao geraria {} conflito(s)",
                preview.floor_branch,
                preview.conflict_paths.len()
            ),
            conflict_paths: preview.conflict_paths,
        });
    }

    let msg = format!("Aterrissar {} no chao", preview.floor_branch);
    let out = run_git(
        project_path,
        &[
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            &msg,
            &preview.floor_branch,
        ],
    )?;
    if out.status.success() {
        return Ok(LandResult {
            ok: true,
            already_merged: false,
            conflicted: false,
            message: format!(
                "\"{}\" aterrissou em {}",
                preview.floor_branch, preview.ground_branch
            ),
            conflict_paths: Vec::new(),
        });
    }

    let conflicts = if merge_in_progress(project_path) {
        abort_merge(project_path);
        // Re-read: the abort restored the tree; the preview's list is
        // still the honest set of files that blocked the merge.
        preview.conflict_paths
    } else {
        Vec::new()
    };
    if !conflicts.is_empty() {
        return Ok(LandResult {
            ok: false,
            already_merged: false,
            conflicted: true,
            message: format!(
                "o merge de \"{}\" conflitou — desfiz, o chao continua limpo",
                preview.floor_branch
            ),
            conflict_paths: conflicts,
        });
    }
    Err(git_err(&out))
}

/// Removes the worktree (no `--force`: dirty fails, on purpose) and,
/// optionally, the branch that went with it.
/// What a removal left standing.
#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoval {
    /// Why the branch was kept, when it was. `None` means nothing was kept.
    pub branch_kept: Option<String>,
}

/// Removes a worktree and, when asked, the branch that lived in it.
///
/// The delete is `git branch -d`, never `-D`. `-D` takes whatever is on the
/// branch, and on a front that was never landed that is the agent's whole
/// afternoon, held nowhere else. `-d` refuses exactly that case, and the
/// refusal comes back as `branch_kept` rather than as an error: the worktree
/// really was removed, and the caller owes the user a sentence, not a failure.
pub fn worktree_remove(
    project_path: &Path,
    worktree_path: &Path,
    delete_branch: Option<&str>,
) -> Result<WorktreeRemoval, String> {
    let target = worktree_path.to_string_lossy();
    let out = run_git(project_path, &["worktree", "remove", &target])?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    let Some(branch) = delete_branch else {
        return Ok(WorktreeRemoval::default());
    };
    check_branch_name(branch)?;
    let out = run_git(project_path, &["branch", "-d", branch])?;
    if out.status.success() {
        return Ok(WorktreeRemoval::default());
    }
    // Gone already, by another window or another hand: nothing was kept and
    // nothing failed.
    if !local_branches(project_path).iter().any(|b| b == branch) {
        return Ok(WorktreeRemoval::default());
    }
    Ok(WorktreeRemoval {
        branch_kept: Some(git_err(&out)),
    })
}

/// Runs a floor hook command (setup/run/teardown) via `cmd /C`, with the
/// `YARD_FLOOR_*` environment already assembled by the caller. Captured
/// output is returned whole (capped) — the UI is what shows it, in a toast.
pub fn run_floor_hook(
    cwd: &Path,
    command: &str,
    env: &[(String, String)],
) -> Result<HookResult, String> {
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.arg("/C").arg(command).current_dir(cwd);
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("falha ao rodar o hook: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err.trim_end());
    }
    if text.len() > MAX_HOOK_OUTPUT {
        let mut cut = MAX_HOOK_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n…(cortado)");
    }
    Ok(HookResult {
        code: out.status.code().unwrap_or(-1),
        output: text,
    })
}

/// `git worktree list --porcelain`: blocks separated by a blank line;
/// each block has `worktree <path>` and, when present, `branch refs/heads/<b>`,
/// `bare` or `detached`.
fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(e) = current.take() {
                out.push(e);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(e) = current.take() {
                out.push(e);
            }
            current = Some(WorktreeEntry {
                path: path.to_string(),
                branch: None,
                bare: false,
            });
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(e) = current.as_mut() {
                e.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        } else if line == "bare" {
            if let Some(e) = current.as_mut() {
                e.bare = true;
            }
        }
    }
    if let Some(e) = current.take() {
        out.push(e);
    }
    out
}

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

/// `git status --porcelain=v2 --branch -z`: records separated by NUL; on a
/// rename (`2 ...`), the old path comes as the next record.
fn parse_status_v2(bytes: &[u8]) -> (Option<String>, Vec<ChangedFile>) {
    let mut branch = None;
    let mut files = Vec::new();
    let mut it = bytes.split(|b| *b == 0);

    while let Some(tok) = it.next() {
        if tok.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(tok);

        if let Some(rest) = s.strip_prefix("# branch.head ") {
            branch = Some(rest.to_string());
            continue;
        }
        if s.starts_with('#') || s.starts_with("! ") {
            continue;
        }

        if let Some(path) = s.strip_prefix("? ") {
            files.push(ChangedFile {
                path: path.to_string(),
                status: "untracked".into(),
                index: "none".into(),
                worktree: "untracked".into(),
                ..Default::default()
            });
            continue;
        }

        if s.starts_with("1 ") {
            let parts: Vec<&str> = s.splitn(9, ' ').collect();
            if parts.len() == 9 {
                let (status, staged) = classify(parts[1].as_bytes());
                let (index, worktree) = sides(parts[1].as_bytes());
                files.push(ChangedFile {
                    path: parts[8].to_string(),
                    status: status.into(),
                    staged,
                    index: index.into(),
                    worktree: worktree.into(),
                    ..Default::default()
                });
            }
            continue;
        }

        if s.starts_with("2 ") {
            let parts: Vec<&str> = s.splitn(10, ' ').collect();
            // The next record is the origin path — always consume it,
            // even if the current record is malformed, so we do not desync.
            let orig = it.next().map(|t| String::from_utf8_lossy(t).into_owned());
            if parts.len() == 10 {
                let (_, staged) = classify(parts[1].as_bytes());
                let (index, worktree) = sides(parts[1].as_bytes());
                files.push(ChangedFile {
                    path: parts[9].to_string(),
                    orig_path: orig,
                    status: "renamed".into(),
                    staged,
                    index: index.into(),
                    worktree: worktree.into(),
                    ..Default::default()
                });
            }
            continue;
        }

        if s.starts_with("u ") {
            let parts: Vec<&str> = s.splitn(11, ' ').collect();
            if parts.len() == 11 {
                files.push(ChangedFile {
                    path: parts[10].to_string(),
                    status: "conflicted".into(),
                    index: "conflicted".into(),
                    worktree: "conflicted".into(),
                    conflict: Some(parts[1].to_string()),
                    ..Default::default()
                });
            }
        }
    }

    (branch, files)
}

/// Maps the porcelain XY pair to a single display status.
fn classify(xy: &[u8]) -> (&'static str, bool) {
    let x = xy.first().copied().unwrap_or(b'.');
    let y = xy.get(1).copied().unwrap_or(b'.');
    let staged = x != b'.';
    let status = if x == b'A' {
        // New in the index — stays "new" even if already edited afterwards.
        "added"
    } else if y == b'D' || x == b'D' {
        "deleted"
    } else {
        "modified"
    };
    (status, staged)
}

/// Splits the porcelain XY pair into the two independent sides Source Control
/// lists apart: what the index holds and what the working tree holds. `.` on
/// either side means "nothing here", which is `none` — not a missing field, so
/// the UI never has to decide what an absent value meant.
pub(crate) fn sides(xy: &[u8]) -> (&'static str, &'static str) {
    let letter = |c: u8| match c {
        b'M' => "modified",
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "added",
        b'T' => "modified",
        _ => "none",
    };
    let x = xy.first().copied().unwrap_or(b'.');
    let y = xy.get(1).copied().unwrap_or(b'.');
    (letter(x), letter(y))
}

/// `git diff --numstat -z`: `ADD\tDEL\tPATH` NUL; on rename the path comes
/// empty and the next two records are origin and destination. `-` = binary.
pub(crate) fn parse_numstat(bytes: &[u8]) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let toks: Vec<String> = bytes
        .split(|b| *b == 0)
        .map(|t| String::from_utf8_lossy(t).into_owned())
        .collect();

    let mut map = HashMap::new();
    let mut i = 0;
    while i < toks.len() {
        let tok = &toks[i];
        if tok.is_empty() {
            i += 1;
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            i += 1;
            continue;
        };
        let adds = a.parse::<u32>().ok();
        let dels = d.parse::<u32>().ok();
        if p.is_empty() {
            if let Some(dest) = toks.get(i + 2) {
                map.insert(dest.clone(), (adds, dels));
            }
            i += 3;
        } else {
            map.insert(p.to_string(), (adds, dels));
            i += 1;
        }
    }
    map
}

// ---------------------------------------------------------------------------
// preflight: the plan, before anything is written
// ---------------------------------------------------------------------------

/// One row of the dialog, as it stands right now.
///
/// `kind` is the shape the front will have, and it decides which of the other
/// fields mean anything:
///
/// - `new_branch`: a branch this call would create, in a worktree it creates;
/// - `existing_branch`: a branch that already exists, in a new worktree;
/// - `adopt`: a worktree git already lists, which the Yard only takes over;
/// - `ground`: the project's own root, on whatever branch is checked out.
///
/// Anything left empty is *derived*, and a derived value is allowed to be
/// changed to keep it free. Anything typed by hand comes back verbatim, even
/// when it is taken: silently renaming what somebody wrote creates a branch
/// nobody asked for, and they find out three commits later.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightItem {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_name: Option<String>,
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

/// What this row would do, and everything the dialog needs to refuse it.
///
/// Nothing here is a verdict: the row says the branch exists, and *the rules*
/// (`lib/provision/plan.ts`) decide whether that is fatal, a warning or the
/// whole point. The split is what lets one backend answer serve the dialog,
/// the palette and the CLI without any of them re-deriving git's opinion.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightItemResult {
    pub id: String,
    pub branch: Option<String>,
    pub branch_exists: bool,
    /// The worktree already holding that branch — git gives out only one.
    pub branch_checked_out_at: Option<String>,
    /// Why git would refuse the name, when it would.
    pub branch_error: Option<String>,
    pub path: String,
    pub path_exists: bool,
    pub base_ref: Option<String>,
    /// The base frozen as a commit: what the person approved in the plan.
    pub base_oid: Option<String>,
    /// `Some(reason)` when the worktree is locked; the reason may be empty.
    pub locked: Option<String>,
    /// Uncommitted work at the destination — only asked of one that exists.
    pub dirty: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub is_repo: bool,
    pub has_head: bool,
    pub ground_path: String,
    pub ground_branch: Option<String>,
    pub ground_dirty: bool,
    /// What a new branch grows from when nobody chose: the ground's branch.
    pub default_base: Option<String>,
    pub local_branches: Vec<String>,
    pub worktrees: Vec<WorktreeEntry>,
    pub items: Vec<PreflightItemResult>,
}

/// `locked` on the porcelain listing, per worktree path. The reason is
/// optional and often empty — the lock is what matters.
fn parse_worktree_locks(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(path.to_string());
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(path) = current.clone() {
                out.insert(path, line.strip_prefix("locked ").unwrap_or("").to_string());
            }
        }
    }
    out
}

/// Local branches, in the one format git promises not to translate.
fn local_branches(cwd: &Path) -> Vec<String> {
    let Ok(out) = run_git(
        cwd,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    ) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// A ref frozen into the commit it points at *now*.
fn resolve_commit(cwd: &Path, git_ref: &str) -> Option<String> {
    // `^{commit}` so a tag resolves to what it tags, and `--verify --quiet`
    // so a name that does not exist is an exit code and not a page of stderr.
    let spec = format!("{git_ref}^{{commit}}");
    let out = run_git(cwd, &["rev-parse", "--verify", "--quiet", &spec]).ok()?;
    if !out.status.success() {
        return None;
    }
    let oid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if oid.is_empty() {
        None
    } else {
        Some(oid)
    }
}

/// A base, frozen into the commit it names *now*.
///
/// The qualification is not decoration. `rev-parse` resolves a bare name
/// against `refs/tags/` **before** `refs/heads/`, so a repository carrying a
/// tag called `main` grew every new front from the tag instead of from the
/// branch, and nothing on screen said so. What the picker offers is branches
/// (the local ones, then the ones on a remote), so that is the order asked
/// for here, and a name matching neither is handed to git as written, which
/// is how a tag chosen on purpose still works.
fn resolve_base_commit(cwd: &Path, base: &str) -> Option<String> {
    if base.starts_with("refs/") {
        return resolve_commit(cwd, base);
    }
    for candidate in [format!("refs/heads/{base}"), format!("refs/remotes/{base}")] {
        if let Some(oid) = resolve_commit(cwd, &candidate) {
            return Some(oid);
        }
    }
    resolve_commit(cwd, base)
}

/// git's own opinion on a branch name, which is the only one that counts.
///
/// The local guard runs first and is not redundant: a name starting with `-`
/// would be read by `check-ref-format` itself as an option, and the answer
/// would be about the command line instead of about the name.
fn check_ref_format(cwd: &Path, name: &str) -> Option<String> {
    if let Err(e) = check_branch_name(name) {
        return Some(e);
    }
    let out = run_git(cwd, &["check-ref-format", "--branch", name]).ok()?;
    if out.status.success() {
        None
    } else {
        Some(format!(
            "\"{name}\" nao e um nome de branch que o git aceite"
        ))
    }
}

/// Reads the repository and answers, for every row, what it would do.
///
/// Nothing here writes: no folder, no ref, no `.gitignore`. That is the whole
/// contract — the dialog can call this on every keystroke, and the person can
/// read the plan and walk away.
pub fn worktree_preflight(
    project_path: &Path,
    items: &[PreflightItem],
) -> Result<Preflight, String> {
    let repo = is_repo(project_path);
    let head = repo && has_head(project_path);

    let (worktrees, locks) = if repo {
        let out = run_git(project_path, &["worktree", "list", "--porcelain"])?;
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            (parse_worktree_list(&text), parse_worktree_locks(&text))
        } else {
            (Vec::new(), HashMap::new())
        }
    } else {
        (Vec::new(), HashMap::new())
    };

    let same = |a: &str, b: &Path| -> bool {
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
        norm(a) == norm(&b.to_string_lossy())
    };
    let ground_branch = worktrees
        .iter()
        .find(|w| same(&w.path, project_path))
        .and_then(|w| w.branch.clone());
    let ground_dirty = repo && worktree_dirty(project_path).unwrap_or(false);

    // Where each branch already lives — git hands out one worktree per branch
    // and the refusal, when it comes, has to name the holder.
    let mut checked_out: HashMap<String, String> = HashMap::new();
    for w in &worktrees {
        if let Some(b) = &w.branch {
            checked_out.entry(b.clone()).or_insert_with(|| w.path.clone());
        }
    }
    let branches = local_branches(project_path);
    let known: HashSet<&str> = branches.iter().map(String::as_str).collect();

    let floors = project_path.join(".yard").join("floors");
    // What earlier rows of *this same call* already spoke for. Without it two
    // rows taking the default name are both told "livre", and the second
    // `worktree add` is where the batch finds out.
    let mut spoken_paths: HashSet<String> = HashSet::new();
    let mut spoken_branches: HashSet<String> = HashSet::new();

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let typed_folder = item
            .worktree_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let typed_branch = item
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        // The derived slug walks past everything taken — on the disk, in the
        // refs, and in the rows already resolved above. A typed name does not
        // walk anywhere: it comes back exactly as written.
        let base_slug = floor_slug(&item.name);
        let mut slug = base_slug.clone();
        if typed_folder.is_none() && typed_branch.is_none() {
            let mut n = 2;
            while n < 100
                && (floors.join(&slug).exists()
                    || spoken_paths.contains(&slug.to_lowercase())
                    || known.contains(format!("yard/{slug}").as_str())
                    || spoken_branches.contains(&format!("yard/{slug}")))
            {
                slug = format!("{base_slug}-{n}");
                n += 1;
            }
        }

        let folder = typed_folder.unwrap_or(&slug);
        let path = match item.kind.as_str() {
            // Without git nothing is isolated, so every row runs in the
            // project's own folder — and the plan has to print *that*. A path
            // under `.yard/floors/` here would promise an isolation the row
            // will never get, and would send a setup hook to a folder that
            // does not exist.
            _ if !repo => project_path.to_string_lossy().into_owned(),
            "ground" => project_path.to_string_lossy().into_owned(),
            "adopt" => item.worktree_path.clone().unwrap_or_default(),
            _ => floors.join(folder).to_string_lossy().into_owned(),
        };

        let branch = match item.kind.as_str() {
            // Same reason as the path above: no git, no branch to name.
            _ if !repo => None,
            "ground" => ground_branch.clone(),
            "adopt" => worktrees
                .iter()
                .find(|w| same(&w.path, Path::new(&path)))
                .and_then(|w| w.branch.clone()),
            "existing_branch" => typed_branch.map(str::to_string),
            _ => Some(typed_branch.map(str::to_string).unwrap_or(format!("yard/{slug}"))),
        };

        // Only a branch this call would *create* is checked for shape: an
        // existing one is already a valid ref by definition, and saying
        // otherwise about a branch somebody else made is noise.
        let branch_error = match (item.kind.as_str(), branch.as_deref()) {
            ("new_branch", Some(b)) => check_ref_format(project_path, b),
            _ => None,
        };

        let dirty = match item.kind.as_str() {
            "ground" => Some(ground_dirty),
            "adopt" if Path::new(&path).exists() => worktree_dirty(Path::new(&path)).ok(),
            _ => None,
        };

        let base_ref = if item.kind == "new_branch" {
            item.base_ref
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| ground_branch.clone())
                .or(if head { Some("HEAD".into()) } else { None })
        } else {
            None
        };

        out.push(PreflightItemResult {
            id: item.id.clone(),
            branch_exists: branch.as_deref().is_some_and(|b| known.contains(b)),
            branch_checked_out_at: branch.as_deref().and_then(|b| checked_out.get(b).cloned()),
            branch_error,
            path_exists: !path.is_empty() && Path::new(&path).exists(),
            base_oid: base_ref
                .as_deref()
                .and_then(|r| resolve_base_commit(project_path, r)),
            base_ref,
            locked: locks
                .iter()
                .find(|(p, _)| same(p, Path::new(&path)))
                .map(|(_, reason)| reason.clone()),
            dirty,
            branch,
            path,
        });

        if let Some(last) = out.last() {
            spoken_paths.insert(
                Path::new(&last.path)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_lowercase())
                    .unwrap_or_default(),
            );
            if let Some(b) = &last.branch {
                spoken_branches.insert(b.clone());
            }
        }
    }

    Ok(Preflight {
        is_repo: repo,
        has_head: head,
        ground_path: project_path.to_string_lossy().into_owned(),
        ground_branch: ground_branch.clone(),
        ground_dirty,
        default_base: ground_branch.or(if head { Some("HEAD".into()) } else { None }),
        local_branches: branches,
        worktrees,
        items: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_cache_is_invalidated_when_the_file_changes() {
        let dir = std::env::temp_dir().join(format!(
            "yard-line-cache-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("novo.txt");
        std::fs::write(&file, "uma\nduas\n").unwrap();
        assert_eq!(count_lines(&file), Some((2, false)));
        assert_eq!(
            count_lines(&file),
            Some((2, false)),
            "the second read uses the cache"
        );

        std::fs::write(&file, "uma\nduas\ntres\nquatro\n").unwrap();
        assert_eq!(count_lines(&file), Some((4, false)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn z(parts: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in parts {
            out.extend_from_slice(p.as_bytes());
            out.push(0);
        }
        out
    }

    #[test]
    fn status_v2_basics() {
        let bytes = z(&[
            "# branch.oid abc123",
            "# branch.head main",
            "1 .M N... 100644 100644 100644 abc def src/App.tsx",
            "1 A. N... 000000 100644 100644 000 abc novo staged.ts",
            "1 D. N... 100644 000000 000000 abc 000 apagado.rs",
            "? nao rastreado.md",
        ]);
        let (branch, files) = parse_status_v2(&bytes);
        assert!(status_has_head(&bytes));
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "src/App.tsx");
        assert_eq!(files[0].status, "modified");
        assert!(!files[0].staged);
        // Path with a space survives the splitn.
        assert_eq!(files[1].path, "novo staged.ts");
        assert_eq!(files[1].status, "added");
        assert!(files[1].staged);
        assert_eq!(files[2].status, "deleted");
        assert_eq!(files[3].path, "nao rastreado.md");
        assert_eq!(files[3].status, "untracked");
    }

    /// The regression this locks: `staged` is one boolean, so a file edited
    /// *and* then edited again after `git add` (porcelain `MM`) could only be
    /// on one side of the Source Control list. The two sides are independent —
    /// the same path belongs under "Preparado" **and** under "Alterações" —
    /// and collapsing them hid half the work from the person about to commit.
    #[test]
    fn status_v2_separates_what_is_staged_from_what_is_on_disk() {
        let bytes = z(&[
            "# branch.head main",
            "1 MM N... 100644 100644 100644 abc def dois-lados.ts",
            "1 M. N... 100644 100644 100644 abc def so-preparado.ts",
            "1 .M N... 100644 100644 100644 abc def so-no-disco.ts",
            "1 AD N... 000000 100644 000000 000 abc criado-e-apagado.ts",
            "? novo.md",
        ]);
        let (_, files) = parse_status_v2(&bytes);
        assert_eq!(files[0].index, "modified");
        assert_eq!(files[0].worktree, "modified");
        assert_eq!(files[1].index, "modified");
        assert_eq!(files[1].worktree, "none");
        assert_eq!(files[2].index, "none");
        assert_eq!(files[2].worktree, "modified");
        // Added to the index, then deleted on disk: two different verbs.
        assert_eq!(files[3].index, "added");
        assert_eq!(files[3].worktree, "deleted");
        // Untracked has nothing in the index — it lives only on the disk side.
        assert_eq!(files[4].index, "none");
        assert_eq!(files[4].worktree, "untracked");
    }

    /// A conflict is neither staged nor unstaged: it is a third group, and the
    /// unmerged pair (`UU`, `AA`, `DU`…) is what says *which* conflict it is.
    #[test]
    fn status_v2_marks_both_sides_of_a_conflict() {
        let bytes = z(&[
            "# branch.head main",
            "u UU N... 100644 100644 100644 100644 a b c briga.ts",
        ]);
        let (_, files) = parse_status_v2(&bytes);
        assert_eq!(files[0].status, "conflicted");
        assert_eq!(files[0].index, "conflicted");
        assert_eq!(files[0].worktree, "conflicted");
        assert_eq!(files[0].conflict.as_deref(), Some("UU"));
    }

    #[test]
    fn status_v2_rename_consumes_the_origin() {
        let bytes = z(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 abc def R100 novo/lugar.ts",
            "antigo/lugar.ts",
            "1 .M N... 100644 100644 100644 abc def outro.ts",
        ]);
        let (_, files) = parse_status_v2(&bytes);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[0].path, "novo/lugar.ts");
        assert_eq!(files[0].orig_path.as_deref(), Some("antigo/lugar.ts"));
        assert_eq!(files[1].path, "outro.ts");
    }

    #[test]
    fn status_without_a_commit_does_not_try_a_head_diff() {
        let bytes = z(&["# branch.oid (initial)", "# branch.head main", "? novo.txt"]);
        assert!(!status_has_head(&bytes));
    }

    #[test]
    fn floor_slug_becomes_a_valid_folder_and_branch() {
        assert_eq!(floor_slug("fix-login"), "fix-login");
        assert_eq!(floor_slug("Correção de Login"), "correcao-de-login");
        assert_eq!(floor_slug("  auth / refresh  "), "auth-refresh");
        // Nothing usable: falls back to the generic name, never an empty folder.
        assert_eq!(floor_slug("???"), "frente");
        assert_eq!(floor_slug(""), "frente");
    }

    #[test]
    fn gitignore_gains_yard_exactly_once() {
        let dir = std::env::temp_dir().join(format!("yard-ign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No .gitignore: creates it with the line.
        ensure_yard_ignored(&dir).unwrap();
        let first = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(first.matches(".yard/").count(), 1);

        // Already there: no duplicate.
        ensure_yard_ignored(&dir).unwrap();
        let second = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(first, second);

        // File without a trailing newline: the new line must not stick to the last one.
        std::fs::write(dir.join(".gitignore"), "node_modules").unwrap();
        ensure_yard_ignored(&dir).unwrap();
        let third = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(third.lines().any(|l| l == "node_modules"));
        assert!(third.lines().any(|l| l == ".yard/"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worktree_list_porcelain() {
        let text = "worktree C:/proj\nHEAD abc\nbranch refs/heads/main\n\n\
worktree C:/proj/.yard/floors/fix-login\nHEAD def\nbranch refs/heads/yard/fix-login\n\n\
worktree C:/bare\nbare\n\n\
worktree C:/solto\nHEAD 123\ndetached\n";
        let list = parse_worktree_list(text);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, "C:/proj/.yard/floors/fix-login");
        assert_eq!(list[1].branch.as_deref(), Some("yard/fix-login"));
        assert!(list[2].bare);
        assert_eq!(list[3].branch, None);
    }

    fn inside(cwd: &str, path: &str) -> Option<String> {
        match locate(Path::new(cwd), path) {
            Target::Inside(rel) => Some(rel),
            Target::Outside | Target::Escapes => None,
        }
    }

    #[test]
    fn locate_relativizes_an_absolute_path_in_the_project() {
        // The live overlay sends the path exactly as the agent wrote it in the log.
        assert_eq!(
            inside(
                "C:/Workspace/Code/yard",
                "C:\\Workspace\\Code\\yard\\src\\App.tsx"
            )
            .as_deref(),
            Some("src/App.tsx"),
        );
        // Drive-letter case must not turn the file into an outsider.
        assert_eq!(
            inside(
                "c:/workspace/code/yard",
                "C:/Workspace/Code/yard/src/App.tsx"
            )
            .as_deref(),
            Some("src/App.tsx"),
        );
        // Already relative: just swap the separator.
        assert_eq!(inside("C:/proj", "src\\a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(
            inside("/home/alan/proj", "/home/alan/proj/src/a.ts").as_deref(),
            Some("src/a.ts")
        );
    }

    #[test]
    fn locate_flags_what_is_outside_the_repo() {
        // Agent memory and screenshots in %TEMP%: `git diff` would answer
        // `fatal: … is outside repository`.
        assert_eq!(
            inside(
                "C:/Workspace/Code/yard",
                "C:/Users/alan/.claude/memory/x.md"
            ),
            None
        );
        // A similar prefix is not the same directory.
        assert_eq!(inside("C:/proj", "C:/projeto/src/a.ts"), None);
        // The root itself is not a file.
        assert_eq!(inside("C:/proj", "C:/proj"), None);
    }

    #[test]
    fn a_file_outside_the_repo_becomes_content_instead_of_an_error() {
        let dir = std::env::temp_dir().join(format!("yard-fora-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let outside = dir.join("nota.md");
        std::fs::write(&outside, "linha 1\nlinha 2\n").unwrap();

        // `cwd` does not even have to be a repo: the path is resolved before git.
        let d = file_diff(
            Path::new("C:/proj"),
            &outside.to_string_lossy(),
            false,
            None,
            None,
        )
        .unwrap();
        assert!(d.external);
        assert!(!d.is_binary);
        // Every line as context: this is the file, not a comparison.
        assert!(
            d.text.contains("@@ -1,2 +1,2 @@\n linha 1\n linha 2\n"),
            "{}",
            d.text
        );

        // An empty file does not open a hollow hunk.
        let empty = dir.join("empty.md");
        std::fs::write(&empty, "").unwrap();
        let d = file_diff(
            Path::new("C:/proj"),
            &empty.to_string_lossy(),
            false,
            None,
            None,
        )
        .unwrap();
        assert!(d.external);
        assert_eq!(d.text, "");

        // Gone: a readable error, not a `fatal:` from git.
        let missing = file_diff(
            Path::new("C:/proj"),
            &dir.join("missing.md").to_string_lossy(),
            false,
            None,
            None,
        );
        match missing {
            Err(e) => assert!(e.starts_with("nao consegui ler "), "{e}"),
            Ok(_) => panic!("a missing file should fail"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fence `explorer::resolve` applies everywhere else. The paths that
    /// reach `file_diff` from the live overlay come out of an agent's own
    /// session log, so "outside the repository" cannot mean "anywhere".
    #[test]
    fn a_path_that_escapes_or_was_never_opened_is_refused() {
        // Relative with `..`: `cwd.join` would have climbed out of the worktree.
        let escaped = file_diff(Path::new("C:/proj"), "../../etc/passwd", true, None, None);
        match escaped {
            Err(e) => assert!(e.starts_with("caminho fora da pasta do projeto"), "{e}"),
            Ok(_) => panic!("`..` should be refused"),
        }
        // NTFS alternate stream, same reason it is blocked in the explorer.
        assert!(file_diff(Path::new("C:/proj"), "a.txt:oculto", true, None, None).is_err());

        // Rooted, real, readable — and under no project the app ever opened.
        let outside = if cfg!(windows) {
            "C:/Windows/System32/drivers/etc/hosts"
        } else {
            "/etc/hosts"
        };
        if Path::new(outside).exists() {
            match file_diff(Path::new("C:/proj"), outside, false, None, None) {
                Err(e) => assert!(e.contains("fora de qualquer projeto aberto"), "{e}"),
                Ok(_) => panic!("a file outside every opened root should be refused"),
            }
        }
    }

    /// The regression this locks: the branch name went to `git worktree add`
    /// as a positional argument, so one starting with `-` was read by git as
    /// an option — and the error that came back talked about anything but the
    /// branch name. Not shell injection (arguments travel as argv), but
    /// argument injection, and free to close.
    #[test]
    fn a_branch_name_git_would_read_as_an_option_is_refused() {
        assert!(check_branch_name("--help").is_err());
        assert!(check_branch_name("-f").is_err());
        assert!(check_branch_name("").is_err());
        assert!(check_branch_name("   ").is_err());
        // git's own rules, the ones `check-ref-format` enforces.
        assert!(check_branch_name("com espaco").is_err());
        assert!(check_branch_name("a..b").is_err());
        assert!(check_branch_name("fim/").is_err());
        assert!(check_branch_name("solto.lock").is_err());
        assert!(check_branch_name("til~1").is_err());

        assert!(check_branch_name("yard/correcao").is_ok());
        assert!(check_branch_name("feature/ABC-123_v2").is_ok());
        assert!(check_branch_name("main").is_ok());
    }

    /// Distinct names that collapse to the same slug get distinct folders,
    /// instead of the second one dying on "ja existe uma frente em <caminho>"
    /// naming a path the user never typed.
    #[test]
    fn names_with_the_same_slug_get_different_folders() {
        let root = std::env::temp_dir().join(format!(
            "yard-slug-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let git_ok = run_git(&root, &["init"])
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !git_ok {
            let _ = std::fs::remove_dir_all(&root);
            return; // no git on this machine: nothing to assert
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        let _ = run_git(&root, &["add", "-A"]);
        let commit = run_git(
            &root,
            &[
                "-c",
                "user.email=t@yard.test",
                "-c",
                "user.name=Yard Test",
                "commit",
                "-m",
                "inicial",
            ],
        );
        if !commit.map(|o| o.status.success()).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        assert_eq!(floor_slug("Correção"), floor_slug("Correcao"));
        let mk = |name: &str| {
            worktree_provision(
                &root,
                &ProvisionInput { name: name.into(), ..Default::default() },
            )
            .unwrap()
        };
        let a = mk("Correção");
        let b = mk("Correcao");
        assert_ne!(a.path, b.path, "two floors cannot land in the same folder");
        assert!(b.path.ends_with("correcao-2"), "{}", b.path);
        assert_ne!(a.branch, b.branch);

        let _ = run_git(&root, &["worktree", "remove", "--force", &a.path]);
        let _ = run_git(&root, &["worktree", "remove", "--force", &b.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn name_status_m_a_d_e_rename() {
        let mut bytes = b"M\0src/a.ts\0A\0novo.ts\0D\0velho.ts\0".to_vec();
        bytes.extend_from_slice(b"R100\0antes.ts\0depois.ts\0");
        let got = parse_name_status(&bytes);
        assert_eq!(
            got,
            vec![
                ("modified".into(), "src/a.ts".into(), None),
                ("added".into(), "novo.ts".into(), None),
                ("deleted".into(), "velho.ts".into(), None),
                (
                    "renamed".into(),
                    "depois.ts".into(),
                    Some("antes.ts".into())
                ),
            ]
        );
    }

    /// The regression this locks down: closing a front with "apagar a branch"
    /// ticked ran `git branch -D`, which deletes whatever is on it. On a front
    /// that had not been landed that was the agent's whole afternoon, gone
    /// with no way back. Now the delete is `-d`, git refuses an unmerged
    /// branch, and the branch is kept and reported.
    #[test]
    fn removing_a_front_never_deletes_a_branch_the_ground_does_not_have() {
        let root = std::env::temp_dir().join(format!(
            "yard-keep-branch-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "um").unwrap();
        let _ = run_git(&root, &["add", "-A"]);
        if !run_git(&root, &["commit", "-m", "inicial"])
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let made = worktree_provision(
            &root,
            &ProvisionInput { name: "login".into(), ..Default::default() },
        )
        .unwrap();
        let floor = std::path::Path::new(&made.path);
        let branch = made.branch.clone().unwrap();

        // The work the agent did, on the front's own branch and nowhere else.
        std::fs::write(floor.join("b.txt"), "trabalho").unwrap();
        let _ = run_git(floor, &["add", "-A"]);
        let _ = run_git(floor, &["commit", "-m", "trabalho do agente"]);

        let removal = worktree_remove(&root, floor, Some(&branch)).unwrap();
        assert!(
            removal.branch_kept.is_some(),
            "an unmerged branch must be kept, and the caller told why"
        );
        assert!(
            local_branches(&root).contains(&branch),
            "the commit exists nowhere else: the branch has to still be there"
        );
        assert!(!floor.exists(), "the worktree itself is removed either way");

        // And the merged case: nothing is lost, so nothing is kept.
        let made2 = worktree_provision(
            &root,
            &ProvisionInput { name: "vazia".into(), ..Default::default() },
        )
        .unwrap();
        let branch2 = made2.branch.clone().unwrap();
        let removal2 =
            worktree_remove(&root, std::path::Path::new(&made2.path), Some(&branch2)).unwrap();
        assert!(removal2.branch_kept.is_none());
        assert!(!local_branches(&root).contains(&branch2));

        let _ = std::fs::remove_dir_all(&root);
    }

    fn init_repo(root: &std::path::Path) -> bool {
        let git_ok = run_git(root, &["init", "-b", "main"])
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !git_ok {
            // Older git has no `-b`. Fall back and rename the default branch.
            if !run_git(root, &["init"])
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return false;
            }
            let _ = run_git(root, &["checkout", "-b", "main"]);
        }
        let _ = run_git(root, &["config", "user.email", "t@yard.test"]);
        let _ = run_git(root, &["config", "user.name", "Yard Test"]);
        // merge --no-ff otherwise fast-forwards and the land commit disappears.
        let _ = run_git(root, &["config", "commit.gpgsign", "false"]);
        true
    }

    fn commit_all(root: &std::path::Path, msg: &str) -> bool {
        let _ = run_git(root, &["add", "-A"]);
        run_git(
            root,
            &[
                "-c",
                "user.email=t@yard.test",
                "-c",
                "user.name=Yard Test",
                "commit",
                "-m",
                msg,
            ],
        )
        .map(|o| o.status.success())
        .unwrap_or(false)
    }

    #[test]
    fn preview_and_land_of_a_clean_floor() {
        let root = std::env::temp_dir().join(format!(
            "yard-land-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("base.txt"), "chao\n").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let floor = worktree_provision(
            &root,
            &ProvisionInput { name: "fix".into(), ..Default::default() },
        )
        .unwrap();
        assert_eq!(floor.kind, "isolated");
        // Provisioning appends `.yard/` to `.gitignore` on the ground —
        // that's a real dirty tree, and landing must refuse it. Commit it
        // so the rest of the test is about the floor's own commit.
        if !commit_all(&root, "ignorar .yard") {
            let _ = run_git(&root, &["worktree", "remove", "--force", &floor.path]);
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let floor_path = std::path::PathBuf::from(&floor.path);
        std::fs::write(floor_path.join("base.txt"), "chao\nfrente\n").unwrap();
        if !commit_all(&floor_path, "na frente") {
            let _ = run_git(&root, &["worktree", "remove", "--force", &floor.path]);
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let branch = floor.branch.clone().unwrap();
        let preview = worktree_preview(&root, &branch, Some(&floor_path)).unwrap();
        assert!(!preview.already_merged);
        assert!(preview.clean, "{:?}", preview.conflict_paths);
        assert!(!preview.ground_dirty);
        assert!(!preview.floor_dirty);
        assert!(
            preview.files.iter().any(|f| f.path == "base.txt"),
            "{:?}",
            preview.files
        );

        let land = worktree_land(&root, &branch, Some(&floor_path)).unwrap();
        assert!(land.ok, "{}", land.message);
        assert!(!land.conflicted);
        let text = std::fs::read_to_string(root.join("base.txt")).unwrap();
        assert!(text.contains("frente"), "{text}");

        // Second land is a no-op.
        let again = worktree_land(&root, &branch, Some(&floor_path)).unwrap();
        assert!(again.ok);
        assert!(again.already_merged);

        let _ = run_git(&root, &["worktree", "remove", "--force", &floor.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn numstat_normal_binary_and_rename() {
        let mut bytes = z(&["10\t2\tsrc/a.ts", "-\t-\timg.png"]);
        // rename: empty path + origin + destination
        bytes.extend_from_slice(b"3\t1\t\0old.ts\0new.ts\0");
        let map = parse_numstat(&bytes);
        assert_eq!(map.get("src/a.ts"), Some(&(Some(10), Some(2))));
        assert_eq!(map.get("img.png"), Some(&(None, None)));
        assert_eq!(map.get("new.ts"), Some(&(Some(3), Some(1))));
    }

    // -- preflight (a plan, before anything is written) ----------------------

    /// The whole point of the preflight: the dialog can show what it is about
    /// to do — the base commit, the branch, the folder — and refuse *before*
    /// touching the disk. Every one of these used to be discovered by running
    /// `git worktree add` and reading the failure.
    #[test]
    fn preflight_resolves_the_base_the_branch_and_the_folder_without_writing() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let plan = worktree_preflight(
            &root,
            &[PreflightItem {
                id: "row-1".into(),
                kind: "new_branch".into(),
                name: "Correcao do Login".into(),
                branch: None,
                worktree_name: None,
                base_ref: None,
                worktree_path: None,
            }],
        )
        .unwrap();

        assert!(plan.is_repo && plan.has_head);
        assert_eq!(plan.ground_branch.as_deref(), Some("main"));
        let it = &plan.items[0];
        assert_eq!(it.branch.as_deref(), Some("yard/correcao-do-login"));
        assert!(!it.branch_exists);
        assert_eq!(it.branch_error, None);
        assert!(it.path.ends_with("correcao-do-login"), "{}", it.path);
        assert!(!it.path_exists, "the preflight writes nothing");
        // The base is frozen as an OID here, so that the branch is created
        // from the commit the person approved and not from whatever `main`
        // points at by the time they click.
        assert_eq!(it.base_ref.as_deref(), Some("main"));
        assert_eq!(it.base_oid.as_ref().map(|o| o.len()), Some(40));
        assert!(!root.join(".yard").exists(), "nothing was created");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two rows of the same batch, both taking the default name: the plan
    /// must already show two different folders. Letting them both read
    /// "livre" and finding out inside `worktree add` is how a batch of four
    /// lands as one front and three errors.
    #[test]
    fn two_rows_with_the_same_derived_name_get_different_folders_and_branches() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-dup-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let row = |id: &str| PreflightItem {
            id: id.into(),
            kind: "new_branch".into(),
            name: "login".into(),
            branch: None,
            worktree_name: None,
            base_ref: None,
            worktree_path: None,
        };
        let plan = worktree_preflight(&root, &[row("a"), row("b")]).unwrap();
        assert_ne!(plan.items[0].path, plan.items[1].path);
        assert_ne!(plan.items[0].branch, plan.items[1].branch);
        assert_eq!(plan.items[1].branch.as_deref(), Some("yard/login-2"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A name typed by hand is never quietly changed: two rows asking for the
    /// same branch come back saying so, and the dialog is what refuses. A
    /// backend that silently renamed the second one would create a branch
    /// nobody asked for.
    #[test]
    fn a_typed_branch_comes_back_verbatim_even_when_two_rows_share_it() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-typed-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let row = |id: &str| PreflightItem {
            id: id.into(),
            kind: "new_branch".into(),
            name: "seja o que for".into(),
            branch: Some("agent/login".into()),
            worktree_name: Some("login".into()),
            base_ref: None,
            worktree_path: None,
        };
        let plan = worktree_preflight(&root, &[row("a"), row("b")]).unwrap();
        assert_eq!(plan.items[0].branch.as_deref(), Some("agent/login"));
        assert_eq!(plan.items[1].branch.as_deref(), Some("agent/login"));
        assert_eq!(plan.items[0].path, plan.items[1].path);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `main` is checked out at the project's own root, and git gives one
    /// worktree per branch. The preflight names the path holding it so the
    /// dialog can say where, instead of forwarding git's own sentence.
    #[test]
    fn an_existing_branch_reports_where_it_is_already_checked_out() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-taken-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let plan = worktree_preflight(
            &root,
            &[
                PreflightItem {
                    id: "taken".into(),
                    kind: "existing_branch".into(),
                    name: "revisar".into(),
                    branch: Some("main".into()),
                    worktree_name: None,
                    base_ref: None,
                    worktree_path: None,
                },
                PreflightItem {
                    id: "gone".into(),
                    kind: "existing_branch".into(),
                    name: "revisar".into(),
                    branch: Some("nao-existe".into()),
                    worktree_name: None,
                    base_ref: None,
                    worktree_path: None,
                },
            ],
        )
        .unwrap();

        assert!(plan.items[0].branch_exists);
        assert!(plan.items[0].branch_checked_out_at.is_some());
        assert!(!plan.items[1].branch_exists);
        assert_eq!(plan.items[1].branch_checked_out_at, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The name goes to `git worktree add` as a positional argument, so one
    /// starting with `-` becomes an option and the error that comes back
    /// talks about anything but branch names. The refusal belongs in the
    /// plan, under the field, before the click.
    #[test]
    fn a_branch_name_git_would_refuse_comes_back_as_an_error_not_a_crash() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-bad-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let bad = |b: &str| PreflightItem {
            id: b.into(),
            kind: "new_branch".into(),
            name: "x".into(),
            branch: Some(b.into()),
            worktree_name: None,
            base_ref: None,
            worktree_path: None,
        };
        let plan =
            worktree_preflight(&root, &[bad("--force"), bad("a..b"), bad("com espaco")]).unwrap();
        for it in &plan.items {
            assert!(it.branch_error.is_some(), "{:?}", it.branch);
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A base that resolves to nothing is a refusal with a field to point at,
    /// not a `worktree add` that fails halfway with the folder already made.
    #[test]
    fn a_base_that_resolves_to_nothing_is_reported_before_anything_is_created() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-base-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let plan = worktree_preflight(
            &root,
            &[PreflightItem {
                id: "x".into(),
                kind: "new_branch".into(),
                name: "x".into(),
                branch: None,
                worktree_name: None,
                base_ref: Some("origin/nao-existe".into()),
                worktree_path: None,
            }],
        )
        .unwrap();
        assert_eq!(plan.items[0].base_oid, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Adopting: the folder is already there and the question is what state
    /// it is in. A worktree with uncommitted work is not refused — it is
    /// *announced*, because the agent is about to start on top of it.
    #[test]
    fn adopting_reports_the_worktrees_own_branch_and_whether_it_is_dirty() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-adopt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let made = worktree_provision(
            &root,
            &ProvisionInput { name: "solta".into(), ..Default::default() },
        )
        .unwrap();
        std::fs::write(std::path::Path::new(&made.path).join("sujo.txt"), "x").unwrap();

        let plan = worktree_preflight(
            &root,
            &[PreflightItem {
                id: "x".into(),
                kind: "adopt".into(),
                name: "x".into(),
                branch: None,
                worktree_name: None,
                base_ref: None,
                worktree_path: Some(made.path.clone()),
            }],
        )
        .unwrap();
        let it = &plan.items[0];
        assert_eq!(it.branch, made.branch);
        assert_eq!(it.dirty, Some(true));
        assert!(it.path_exists);

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A folder with no git at all, and a repo with no commit yet, are two
    /// different answers — and neither is an error. The dialog says which
    /// before the click; it used to find out from `worktree add`.
    #[test]
    fn a_folder_without_git_and_a_repo_without_a_commit_answer_plainly() {
        let root = std::env::temp_dir().join(format!(
            "yard-preflight-empty-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let row = PreflightItem {
            id: "x".into(),
            kind: "new_branch".into(),
            name: "seja o que for".into(),
            branch: None,
            worktree_name: None,
            base_ref: None,
            worktree_path: None,
        };
        let plain = worktree_preflight(&root, std::slice::from_ref(&row)).unwrap();
        assert!(!plain.is_repo && !plain.has_head);
        // Without git nothing is isolated: the front runs in the project's own
        // folder, and the plan has to print *that*. A path under
        // `.yard/floors/` here promises an isolation the row will never get,
        // and a setup hook would be sent to a folder that does not exist.
        assert_eq!(
            plain.items[0].path.replace('\\', "/"),
            root.to_string_lossy().replace('\\', "/")
        );
        assert_eq!(plain.items[0].branch, None);

        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let fresh = worktree_preflight(&root, &[]).unwrap();
        assert!(fresh.is_repo, "git init happened");
        assert!(!fresh.has_head, "but nothing was committed");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A locked worktree is one someone deliberately took off the table
    /// (`git worktree lock`, usually a removable drive or a long-running
    /// build). Adopting it, or removing it, has to be refused with the reason
    /// the person wrote — which travels on the same porcelain listing, on its
    /// own line, sometimes with a reason and sometimes bare.
    #[test]
    fn the_porcelain_listing_carries_the_lock_and_its_reason() {
        let text = "worktree C:/proj\nHEAD abc\nbranch refs/heads/main\n\
                    \n\
                    worktree C:/proj/.yard/floors/a\nHEAD def\nbranch refs/heads/yard/a\nlocked pen drive\n\
                    \n\
                    worktree C:/proj/.yard/floors/b\nHEAD 123\nbranch refs/heads/yard/b\nlocked\n";
        let locks = parse_worktree_locks(text);
        assert_eq!(locks.get("C:/proj/.yard/floors/a").map(String::as_str), Some("pen drive"));
        // Locked with no reason is still locked: the entry has to exist, and
        // an empty reason is what the UI turns into its own sentence.
        assert_eq!(locks.get("C:/proj/.yard/floors/b").map(String::as_str), Some(""));
        assert_eq!(locks.get("C:/proj"), None);
    }

    // -- creating from an approved base, and undoing it safely ---------------

    /// The plan freezes the base as a commit and the creation has to honour
    /// *that* commit. `worktree add -b <b> <path>` without a base grows the
    /// branch from whatever HEAD happens to be — so a plan read at 14:00 and
    /// confirmed at 14:03, with a pull in between, silently created the front
    /// somewhere else than the screen said.
    #[test]
    fn a_new_branch_grows_from_the_commit_the_plan_froze() {
        let root = std::env::temp_dir().join(format!(
            "yard-base-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "um").unwrap();
        if !commit_all(&root, "primeiro") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let first = resolve_commit(&root, "HEAD").unwrap();
        std::fs::write(root.join("a.txt"), "dois").unwrap();
        assert!(commit_all(&root, "segundo"));
        let second = resolve_commit(&root, "HEAD").unwrap();
        assert_ne!(first, second);

        let made = worktree_provision(
            &root,
            &ProvisionInput {
                name: "antiga".into(),
                base: Some(first.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(made.head_oid.as_deref(), Some(first.as_str()));
        assert_eq!(made.base_oid.as_deref(), Some(first.as_str()));
        // And the base branch stayed exactly where it was: creating a front
        // never moves the branch it grew from.
        assert_eq!(resolve_commit(&root, "main").as_deref(), Some(second.as_str()));

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The rollback of a failed creation deletes the branch it made — and
    /// only while that branch still points where it was left. The moment an
    /// agent commits, the branch holds work nobody else has, and a rollback
    /// that deleted it would be the most expensive bug in the app.
    #[test]
    fn the_created_branch_is_deleted_only_while_it_still_points_where_we_left_it() {
        let root = std::env::temp_dir().join(format!(
            "yard-cas-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "um").unwrap();
        if !commit_all(&root, "primeiro") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let made = worktree_provision(
            &root,
            &ProvisionInput {
                name: "descartavel".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let branch = made.branch.clone().unwrap();
        let born = made.head_oid.clone().unwrap();
        let work = std::path::Path::new(&made.path);

        // The agent committed. The branch moved, and the branch is now the
        // only place that work exists.
        std::fs::write(work.join("b.txt"), "trabalho").unwrap();
        assert!(commit_all(work, "o agente trabalhou"));

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        assert_eq!(
            branch_delete_if_unchanged(&root, &branch, &born),
            Ok(false),
            "the branch moved: it is kept, and the caller has to say so"
        );
        assert!(
            local_branches(&root).contains(&branch),
            "a branch with work on it survives the rollback"
        );

        // A second front, untouched, is deleted without ceremony.
        let clean = worktree_provision(
            &root,
            &ProvisionInput {
                name: "intocada".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let clean_branch = clean.branch.clone().unwrap();
        let clean_oid = clean.head_oid.clone().unwrap();
        let _ = run_git(&root, &["worktree", "remove", "--force", &clean.path]);
        assert_eq!(
            branch_delete_if_unchanged(&root, &clean_branch, &clean_oid),
            Ok(true)
        );
        assert!(!local_branches(&root).contains(&clean_branch));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The plan already chose the folder, and the creation must land in it —
    /// not in whatever the slug rule would derive again from the name. The
    /// two used to be computed twice, in two languages, and a name whose slug
    /// was already taken made the plan say one path and the disk get another.
    #[test]
    fn the_folder_the_plan_showed_is_the_folder_that_is_created() {
        let root = std::env::temp_dir().join(format!(
            "yard-folder-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "um").unwrap();
        if !commit_all(&root, "primeiro") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let plan = worktree_preflight(
            &root,
            &[PreflightItem {
                id: "x".into(),
                kind: "new_branch".into(),
                name: "Revisar o Checkout".into(),
                branch: None,
                worktree_name: None,
                base_ref: None,
                worktree_path: None,
            }],
        )
        .unwrap();
        let planned = plan.items[0].clone();

        let made = worktree_provision(
            &root,
            &ProvisionInput {
                name: "Revisar o Checkout".into(),
                branch: planned.branch.clone(),
                worktree_name: std::path::Path::new(&planned.path)
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned()),
                base: planned.base_oid.clone(),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            made.path.replace('\\', "/"),
            planned.path.replace('\\', "/"),
            "the plan promised a folder"
        );
        assert_eq!(made.branch, planned.branch);

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    // -- what a front is born with -------------------------------------------

    fn strings(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    /// The command line is built in one place because two of its pieces are
    /// invisible from here: the `-c core.longpaths=true` a Windows checkout
    /// needs to go past MAX_PATH (a front lives two folders deeper than the
    /// ground, so the ground fitting proves nothing), and the fact that an
    /// existing branch takes no base, because naming one would ask git to move it.
    #[test]
    fn a_windows_checkout_is_given_the_long_path_escape() {
        assert_eq!(
            worktree_add_args(true, false, "yard/fix", ".yard/floors/fix", "abc123"),
            strings(&[
                "-c",
                "core.longpaths=true",
                "worktree",
                "add",
                "--no-track",
                "-b",
                "yard/fix",
                ".yard/floors/fix",
                "abc123",
            ])
        );
        assert_eq!(
            worktree_add_args(false, false, "yard/fix", ".yard/floors/fix", "abc123"),
            strings(&[
                "worktree",
                "add",
                "--no-track",
                "-b",
                "yard/fix",
                ".yard/floors/fix",
                "abc123",
            ])
        );
        assert_eq!(
            worktree_add_args(true, true, "feature/x", ".yard/floors/x", "abc123"),
            strings(&[
                "-c",
                "core.longpaths=true",
                "worktree",
                "add",
                ".yard/floors/x",
                "feature/x",
            ])
        );
    }

    fn config_get(cwd: &std::path::Path, key: &str) -> Option<String> {
        let out = run_git(cwd, &["config", "--get", key]).ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// The regression this locks down: a front's branch is created with
    /// `--no-track`, so it has no upstream, and the first `git push` an agent
    /// ran inside the front died with "The current branch has no upstream
    /// branch". Pushing from the front is not an advanced case: the front is
    /// where the work happens.
    #[test]
    fn the_first_push_from_a_front_needs_no_upstream_spelled_out() {
        let root = std::env::temp_dir().join(format!(
            "yard-push-default-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        // Whatever this machine already says counts as the person's answer,
        // so the expectation is read before anything is written.
        let ambient = config_get(&root, "push.autoSetupRemote");

        let made = worktree_provision(
            &root,
            &ProvisionInput { name: "envio".into(), ..Default::default() },
        )
        .unwrap();
        let front = std::path::PathBuf::from(&made.path);
        let after = config_get(&front, "push.autoSetupRemote");
        match ambient {
            None => assert_eq!(
                after.as_deref(),
                Some("true"),
                "a front with no upstream needs `git push` to be able to create one"
            ),
            Some(chosen) => assert_eq!(after.as_deref(), Some(chosen.as_str())),
        }

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// And the other half: a value the person already chose is theirs. The
    /// read is `--get` with no scope on purpose: a `false` sitting in the
    /// global config is an answer, not an absence.
    #[test]
    fn a_push_default_the_person_already_chose_is_kept() {
        let root = std::env::temp_dir().join(format!(
            "yard-push-chosen-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let _ = run_git(
            &root,
            &["config", "--local", "push.autoSetupRemote", "false"],
        );

        let made = worktree_provision(
            &root,
            &ProvisionInput { name: "envio".into(), ..Default::default() },
        )
        .unwrap();
        assert_eq!(
            config_get(std::path::Path::new(&made.path), "push.autoSetupRemote").as_deref(),
            Some("false"),
            "the app does not get to overrule a setting the person wrote"
        );

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The list is deliberately small: literal files and folders, anchored at
    /// the root. A glob or a negation would have to be *interpreted*, and a
    /// half-understood pattern copies the wrong file; a `..` or an absolute
    /// path would read outside the repository entirely.
    #[test]
    fn the_include_list_takes_only_literal_paths_that_cannot_leave_the_repository() {
        let entries = parse_worktree_include(
            "# o que toda frente precisa\n\
             \n\
             .env\n\
             ./config\\local.json\n\
             assets/\n\
             assets\n\
             *.key\n\
             !.env.prod\n\
             ../fora\n\
             /etc/passwd\n\
             .git/hooks\n",
        );
        assert_eq!(entries, strings(&[".env", "config/local.json", "assets"]));
    }

    /// A new worktree is a clean checkout, so everything the project ignores
    /// (the `.env`, the local config) is missing from it, and the CLI put
    /// there starts in a project that cannot run. The repository names those
    /// paths in `.worktreeinclude`, and only ignored ones travel: copying an
    /// untracked file that git *would* show turns the front dirty on birth.
    #[test]
    fn the_ignored_files_the_repository_lists_travel_to_the_new_front() {
        let root = std::env::temp_dir().join(format!(
            "yard-include-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "oi").unwrap();
        std::fs::write(root.join(".gitignore"), ".env\nlocal/\n").unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            ".env\nlocal\nrascunho.txt\n",
        )
        .unwrap();
        if !commit_all(&root, "inicial") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join(".env"), "TOKEN=1\n").unwrap();
        std::fs::create_dir_all(root.join("local")).unwrap();
        std::fs::write(root.join("local").join("config.json"), "{}\n").unwrap();
        // Untracked and *not* ignored: listed, but it must stay behind.
        std::fs::write(root.join("rascunho.txt"), "nao vai\n").unwrap();

        let made = worktree_provision(
            &root,
            &ProvisionInput { name: "com env".into(), ..Default::default() },
        )
        .unwrap();
        let front = std::path::PathBuf::from(&made.path);

        assert_eq!(
            std::fs::read_to_string(front.join(".env")).ok().as_deref(),
            Some("TOKEN=1\n"),
            "the front was born without the file the project needs to run"
        );
        assert!(
            front.join("local").join("config.json").exists(),
            "a listed folder travels whole"
        );
        assert!(
            !front.join("rascunho.txt").exists(),
            "a file git does not ignore would show up as a change nobody made"
        );

        let _ = run_git(&root, &["worktree", "remove", "--force", &made.path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The regression: `rev-parse main^{commit}` answers with the **tag**
    /// named `main` before the branch, which is git's own disambiguation
    /// order, so a repository carrying a tag with a branch's name grew every
    /// new front from the wrong commit, and nothing on screen said so.
    #[test]
    fn a_base_is_read_as_a_branch_even_when_a_tag_shares_its_name() {
        let root = std::env::temp_dir().join(format!(
            "yard-base-tag-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if !init_repo(&root) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "primeiro").unwrap();
        if !commit_all(&root, "primeiro") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let _ = run_git(&root, &["tag", "main"]);
        std::fs::write(root.join("a.txt"), "segundo").unwrap();
        if !commit_all(&root, "segundo") {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let head = resolve_commit(&root, "refs/heads/main").unwrap();

        let plan = worktree_preflight(
            &root,
            &[PreflightItem {
                id: "row-1".into(),
                kind: "new_branch".into(),
                name: "depois da tag".into(),
                branch: None,
                worktree_name: None,
                base_ref: None,
                worktree_path: None,
            }],
        )
        .unwrap();
        assert_eq!(
            plan.items[0].base_oid.as_deref(),
            Some(head.as_str()),
            "the base is the branch the person is looking at, not a tag that shares its name"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `git` that never answers used to hang the whole creation: there was
    /// no deadline anywhere, and a folder backed by a cloud sync can stall a
    /// checkout for as long as it likes. The bound is the difference between
    /// a front that fails and an app that waits forever.
    #[test]
    fn a_git_that_never_answers_is_killed_at_the_deadline() {
        // Reads stdin to the end; the pipe is ours and we never close it.
        let mut cmd = std::process::Command::new("git");
        cmd.args(["hash-object", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let started = std::time::Instant::now();
        let out = run_bounded(cmd, std::time::Duration::from_millis(300));
        assert!(out.is_err(), "a command with no end must not come back Ok");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the deadline is what makes this a bound and not a wish"
        );
    }

    /// The escape hatch, and its floor: a repository that genuinely takes
    /// longer can be given more room, but nobody gets to make a create fail
    /// *sooner* by typing seconds where milliseconds go.
    #[test]
    fn the_creation_deadline_stretches_but_never_shrinks() {
        assert_eq!(worktree_add_timeout(None), WORKTREE_ADD_TIMEOUT);
        assert_eq!(worktree_add_timeout(Some("   ")), WORKTREE_ADD_TIMEOUT);
        assert_eq!(worktree_add_timeout(Some("depois")), WORKTREE_ADD_TIMEOUT);
        assert_eq!(worktree_add_timeout(Some("300")), WORKTREE_ADD_TIMEOUT);
        assert_eq!(
            worktree_add_timeout(Some("600000")),
            std::time::Duration::from_millis(600_000)
        );
        assert_eq!(
            worktree_add_timeout(Some("999999999")),
            WORKTREE_ADD_TIMEOUT_MAX
        );
    }
}
