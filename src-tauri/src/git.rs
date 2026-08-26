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

/// Creates (or merely describes, without git) a floor's directory.
///
/// - new branch: `git worktree add -b <branch> .yard/floors/<slug>`
/// - existing branch: `git worktree add .yard/floors/<slug> <branch>`
/// - no git / `no_git`: nothing runs; returns `kind: "plain"` with the
///   project's own cwd so the group is born in the same place as the ground.
pub fn worktree_provision(
    project_path: &Path,
    name: &str,
    branch: Option<&str>,
    existing_branch: bool,
    no_git: bool,
) -> Result<WorktreeProvision, String> {
    if no_git || !is_repo(project_path) {
        return Ok(WorktreeProvision {
            path: project_path.to_string_lossy().into_owned(),
            branch: None,
            kind: "plain".into(),
        });
    }
    if !has_head(project_path) {
        return Err(
            "o repositorio ainda nao tem nenhum commit — faca o primeiro commit antes de abrir uma frente"
                .into(),
        );
    }

    // Two different names can collapse into the same slug — "Correção" and
    // "Correcao" both give `correcao`, and any name made only of punctuation
    // gives `frente`. The old code stopped there with "ja existe uma frente em
    // <caminho>", naming a folder the user had never typed and giving no way
    // forward except renaming by guesswork. A numeric suffix keeps distinct
    // floors distinct; the display name is unaffected.
    let base = floor_slug(name);
    let floors = project_path.join(".yard").join("floors");
    let mut slug = base.clone();
    let mut n = 2;
    while floors.join(&slug).exists() {
        if n > 99 {
            return Err(format!(
                "ja existem frentes demais com um nome parecido com \"{name}\" \
                 (slug {base}) — escolha outro nome"
            ));
        }
        slug = format!("{base}-{n}");
        n += 1;
    }
    let abs = floors.join(&slug);
    ensure_yard_ignored(project_path)
        .map_err(|e| format!("nao consegui atualizar o .gitignore: {e}"))?;

    // Relative path with `/`: git on Windows accepts it and the log stays readable.
    let rel = format!(".yard/floors/{slug}");
    let branch_name = if existing_branch {
        match branch {
            Some(b) if !b.trim().is_empty() => b.trim().to_string(),
            _ => return Err("--existing-branch exige o nome da branch".into()),
        }
    } else {
        branch
            .filter(|b| !b.trim().is_empty())
            .map(|b| b.trim().to_string())
            .unwrap_or_else(|| format!("yard/{slug}"))
    };
    // Checked before it reaches the command line: the name is positional, so
    // one starting with `-` would be read as an option and the error would
    // talk about anything but the branch name.
    check_branch_name(&branch_name)?;

    let out = if existing_branch {
        run_git(project_path, &["worktree", "add", &rel, &branch_name])?
    } else {
        run_git(project_path, &["worktree", "add", "-b", &branch_name, &rel])?
    };
    if !out.status.success() {
        return Err(git_err(&out));
    }

    Ok(WorktreeProvision {
        path: abs.to_string_lossy().into_owned(),
        branch: Some(branch_name),
        kind: "isolated".into(),
    })
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
pub fn worktree_remove(
    project_path: &Path,
    worktree_path: &Path,
    delete_branch: Option<&str>,
) -> Result<(), String> {
    let target = worktree_path.to_string_lossy();
    let out = run_git(project_path, &["worktree", "remove", &target])?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    if let Some(branch) = delete_branch {
        let out = run_git(project_path, &["branch", "-D", branch])?;
        if !out.status.success() {
            return Err(format!(
                "worktree removido, mas a branch ficou: {}",
                git_err(&out)
            ));
        }
    }
    Ok(())
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
        let a = worktree_provision(&root, "Correção", None, false, false).unwrap();
        let b = worktree_provision(&root, "Correcao", None, false, false).unwrap();
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

        let floor = worktree_provision(&root, "fix", None, false, false).unwrap();
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
}
