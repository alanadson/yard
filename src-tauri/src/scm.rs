//! Source control — the **write** half of git.
//!
//! `git.rs` reads: what changed, the diff of a file, the worktrees that back
//! the floors. This module is what acts on the repository: prepare and
//! unprepare, discard, commit, branch, fetch/pull/push, stash, tag, and read
//! back the history. It is what the bench's "Controle" tab is made of.
//!
//! The rules it inherits from `git.rs`, because they are the same repository:
//! - every call is a `git` subprocess (no libgit2), with `GIT_OPTIONAL_LOCKS=0`
//!   so we never fight the index lock with the agent's own terminal;
//! - `-z` and porcelain formats wherever git offers one — paths come out
//!   byte-identical to the watcher's, with `/`;
//! - a folder without git is not an error.
//!
//! And two of its own, because writing is not reading:
//! - **every path is fenced before it reaches git** (`rel_paths`): the panel
//!   sends paths relative to the root, and anything else — rooted, climbing
//!   with `..`, carrying an NTFS `:` stream — is a bug or an attack, never a
//!   file the user clicked;
//! - **every user-typed name goes after `--`** or through `check_branch_name`,
//!   so a branch called `--upload-pack=…` is a name, not an option.

use std::collections::HashSet;
use std::path::Path;
use std::process::Output;

use serde::Serialize;

use crate::git::run_git;

/// What the panel's header is made of: where we are, how far from the remote,
/// and whether the repository is in the middle of something (a merge, a
/// rebase) that changes what every button means.
#[derive(Clone, Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScmInfo {
    pub is_repo: bool,
    /// Root of the worktree, as git resolves it — not the folder we were
    /// handed, which may be a subdirectory of it.
    pub root: Option<String>,
    /// `None` when `HEAD` is detached; `detached` then says why.
    pub branch: Option<String>,
    /// Short sha of `HEAD`. `None` in a repository with no commit yet.
    pub head: Option<String>,
    pub detached: bool,
    /// `origin/main` — the branch this one tracks, when it tracks one.
    pub upstream: Option<String>,
    /// Commits we have that the upstream does not, and vice-versa. Both zero
    /// when there is no upstream: the panel offers "publicar" instead.
    pub ahead: u32,
    pub behind: u32,
    pub remotes: Vec<RemoteInfo>,
    /// `clean` | `merging` | `rebasing` | `cherry-picking` | `reverting` |
    /// `bisecting`. Anything but `clean` means the tree is mid-gesture and the
    /// panel has to offer "continuar" and "abortar" before anything else.
    pub state: String,
    pub stashes: u32,
    /// There is at least one commit. Everything that needs a "before" side —
    /// unstage, amend, log, diff against `HEAD` — hangs off this.
    pub has_head: bool,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// Fetch URL. Shown so "push" names where it is about to write.
    pub url: String,
}

// ---------------------------------------------------------------------------
// the fence
// ---------------------------------------------------------------------------

/// Normalizes and **fences** the paths a command received.
///
/// Everything the panel sends came out of `git status`: relative to the root,
/// with `/`. A rooted path, one climbing with `..`, or one carrying the NTFS
/// stream separator is not something the user clicked — and `git restore`,
/// `git clean` and `git add` would all obey it without blinking.
///
/// The same reasoning (and the same three refusals) as `explorer::resolve`
/// and `git::locate`; it lives here too because this is the module that
/// *writes*, and a wrong path here destroys work instead of showing the wrong
/// diff.
pub(crate) fn rel_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("nenhum arquivo foi informado".into());
    }
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let norm = raw.replace('\\', "/");
        let norm = norm.trim();
        if norm.is_empty() {
            return Err("caminho vazio".into());
        }
        // Even after `--`, a path shaped like an option is never one git gave
        // us — and it is the cheapest thing in the world to refuse.
        if norm.starts_with('-') {
            return Err(format!("caminho inválido: {raw}"));
        }
        if norm.contains(':') || norm.split('/').any(|p| p == "..") || norm.starts_with('/') {
            return Err(format!("caminho fora do repositório: {raw}"));
        }
        out.push(norm.to_string());
    }
    Ok(out)
}

/// Runs git and turns a non-zero exit into an `Err` carrying what git said —
/// the panel shows that text verbatim, because git's own message ("Your local
/// changes would be overwritten by merge") is always better than ours.
pub(crate) fn git_out(cwd: &Path, args: &[&str]) -> Result<String, String> {
    check(run_git(cwd, args)?)
}

fn check(out: Output) -> Result<String, String> {
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = err.trim();
    if !msg.is_empty() {
        return Err(msg.to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("o git falhou sem dizer por quê".into())
}

/// Same as `git_out`, but the caller only wants to know whether it worked.
pub(crate) fn ok(cwd: &Path, args: &[&str]) -> Result<(), String> {
    git_out(cwd, args).map(|_| ())
}

/// `[fixed…, "--", paths…]`. The `--` is what keeps a path from becoming an
/// option; `rel_paths` already refused the shapes that would try.
fn with_paths<'a>(fixed: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args: Vec<&str> = fixed.to_vec();
    args.push("--");
    args.extend(paths.iter().map(|p| p.as_str()));
    args
}

/// How many characters of paths go into one command line.
///
/// Windows refuses a command line past ~32k characters, and the failure is
/// the worst kind: `CreateProcess` returns an error the panel shows as "o git
/// falhou", with no hint that the number of files is the problem. The margin
/// under 32k is for the fixed part (`git`, `add`, `--`) plus the quoting the
/// runtime adds around each argument.
const PATH_ARG_BUDGET: usize = 24_000;

/// Splits a path list into batches that each fit one command line.
///
/// A path bigger than the whole budget still goes out alone: refusing it
/// would silently skip the very file the user clicked, which is worse than
/// letting the OS say no.
fn path_batches(paths: &[String], budget: usize) -> Vec<&[String]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut cost = 0usize;
    for (i, p) in paths.iter().enumerate() {
        // `+ 3` = the space between arguments and the pair of quotes the
        // runtime puts around a path with a space in it.
        let weight = p.len() + 3;
        if i > start && cost + weight > budget {
            out.push(&paths[start..i]);
            start = i;
            cost = 0;
        }
        cost += weight;
    }
    if start < paths.len() {
        out.push(&paths[start..]);
    }
    out
}

/// `ok`, once per batch — the shape every path-taking git call needs so that
/// a group with thousands of files does not become one impossible command
/// line. Stops at the first batch git refused.
fn ok_batched(cwd: &Path, fixed: &[&str], paths: &[String]) -> Result<(), String> {
    for batch in path_batches(paths, PATH_ARG_BUDGET) {
        ok(cwd, &with_paths(fixed, batch))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// the staging area
// ---------------------------------------------------------------------------

/// Prepares the given paths. `add` (not `stage`) on purpose: it is the one
/// verb that covers new, modified **and** deleted in a single call.
pub fn stage(cwd: &Path, paths: &[String]) -> Result<(), String> {
    let paths = rel_paths(paths)?;
    ok_batched(cwd, &["add"], &paths)
}

/// Everything, including the untracked.
pub fn stage_all(cwd: &Path) -> Result<(), String> {
    ok(cwd, &["add", "-A", "--"])
}

/// Takes the paths out of the index without touching the disk.
///
/// `reset -q HEAD --` and not `restore --staged`: in a repository with no
/// commit yet there is no `HEAD` to restore from, and that empty repo is
/// exactly where the first "preparei sem querer" happens. The no-HEAD branch
/// below drops the entry from the index instead, which leaves the file on
/// disk as untracked — what the user meant by "desfazer o preparo".
pub fn unstage(cwd: &Path, paths: &[String]) -> Result<(), String> {
    let paths = rel_paths(paths)?;
    if has_head(cwd) {
        return ok_batched(cwd, &["reset", "-q", "HEAD"], &paths);
    }
    ok_batched(cwd, &["rm", "--cached", "-q", "-r"], &paths)
}

pub fn unstage_all(cwd: &Path) -> Result<(), String> {
    if has_head(cwd) {
        return ok(cwd, &["reset", "-q", "HEAD", "--"]);
    }
    ok(cwd, &["rm", "--cached", "-q", "-r", "--", "."])
}

/// Throws away the given paths' changes — the one irreversible button.
///
/// Two different gestures wear the same name, and both have to happen or the
/// promise is a lie: a tracked file goes back to what `HEAD` says (index
/// *and* disk, or a staged-then-edited file would keep half the mess), and an
/// untracked one is deleted.
pub fn discard(cwd: &Path, paths: &[String]) -> Result<(), String> {
    let paths = rel_paths(paths)?;
    let tracked = tracked_set(cwd, &paths)?;
    let (known, untracked): (Vec<String>, Vec<String>) =
        paths.into_iter().partition(|p| tracked.contains(p));

    if !known.is_empty() {
        if has_head(cwd) {
            ok_batched(cwd, &["checkout", "-q", "HEAD"], &known)?;
        } else {
            // No commit to go back to: the file exists only in the index.
            ok_batched(cwd, &["rm", "-f", "-q"], &known)?;
        }
    }
    if !untracked.is_empty() {
        ok_batched(cwd, &["clean", "-q", "-f", "-d"], &untracked)?;
    }
    Ok(())
}

/// Everything at once. `include_untracked` is a separate decision because a
/// new file is not "a change to undo": it is work with no other copy anywhere.
pub fn discard_all(cwd: &Path, include_untracked: bool) -> Result<(), String> {
    if has_head(cwd) {
        ok(cwd, &["checkout", "-q", "HEAD", "--", "."])?;
    } else {
        ok(cwd, &["rm", "-f", "-q", "-r", "--cached", "--", "."])?;
    }
    if include_untracked {
        ok(cwd, &["clean", "-q", "-f", "-d", "--"])?;
    }
    Ok(())
}

/// Which of these paths git already knows about — the split `discard` needs
/// between "restore" and "delete".
fn tracked_set(cwd: &Path, paths: &[String]) -> Result<HashSet<String>, String> {
    let out = run_git(cwd, &with_paths(&["ls-files", "-z"], paths))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

pub(crate) fn has_head(cwd: &Path) -> bool {
    run_git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// where we are
// ---------------------------------------------------------------------------

/// One `git status --branch --porcelain=v2` plus the cheap extras. A folder
/// with no git — or outside a repository — comes back `isRepo: false`, which
/// is the state the panel draws its "iniciar um repositório" face from.
pub fn info(cwd: &Path) -> Result<ScmInfo, String> {
    let Ok(out) = run_git(cwd, &["status", "--porcelain=v2", "--branch", "-z", "-uno"]) else {
        return Ok(ScmInfo::default());
    };
    if !out.status.success() {
        return Ok(ScmInfo::default());
    }
    let head = parse_branch_header(&out.stdout);

    // A single probe for the three path/HEAD questions. Every `git` costs
    // ~35 ms on Windows before it does anything, and `info` runs on every
    // write and on every beat of the watcher — that was three processes where
    // one will do.
    let probe = run_git(
        cwd,
        &[
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--short",
            "HEAD",
        ],
    )
    .map(|o| parse_head_probe(&String::from_utf8_lossy(&o.stdout)))
    .unwrap_or_default();
    let root = probe.root.clone();
    let short = probe.short.clone();
    let stashes = run_git(cwd, &["stash", "list"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
        .unwrap_or(0);

    Ok(ScmInfo {
        is_repo: true,
        state: repo_state(probe.git_dir.as_deref(), root.as_deref()),
        root,
        branch: head.branch,
        detached: head.detached,
        upstream: head.upstream,
        ahead: head.ahead,
        behind: head.behind,
        remotes: remotes(cwd),
        stashes,
        has_head: short.is_some(),
        head: short,
    })
}

/// stdout of a git call that answers with one line, `None` when it failed or
/// said nothing — which is how "no HEAD yet" arrives.
fn first_line(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = run_git(cwd, args).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[derive(Default)]
pub(crate) struct BranchHeader {
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// The `# branch.*` lines of `--porcelain=v2 --branch`, which is where every
/// number in the header comes from in a single process.
pub(crate) fn parse_branch_header(bytes: &[u8]) -> BranchHeader {
    let mut head = BranchHeader::default();
    for token in bytes.split(|b| *b == 0) {
        let s = String::from_utf8_lossy(token);
        if let Some(rest) = s.strip_prefix("# branch.head ") {
            // git writes the literal `(detached)` when there is no branch.
            if rest == "(detached)" {
                head.detached = true;
            } else {
                head.branch = Some(rest.to_string());
            }
        } else if let Some(rest) = s.strip_prefix("# branch.upstream ") {
            head.upstream = Some(rest.to_string());
        } else if let Some(rest) = s.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            head.ahead = parts
                .next()
                .and_then(|p| p.strip_prefix('+'))
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            head.behind = parts
                .next()
                .and_then(|p| p.strip_prefix('-'))
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        }
    }
    head
}

/// Mid-gesture states, read from the files git leaves in the git dir — the
/// same probe `git status`'s own long format uses, and far cheaper than
/// parsing it.
fn repo_state(git_dir: Option<&str>, root: Option<&str>) -> String {
    let Some(dir) = git_dir
        .map(std::path::PathBuf::from)
        .or_else(|| root.map(|r| Path::new(r).join(".git")))
    else {
        return "clean".into();
    };
    if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        return "rebasing".into();
    }
    if dir.join("CHERRY_PICK_HEAD").exists() {
        return "cherry-picking".into();
    }
    if dir.join("REVERT_HEAD").exists() {
        return "reverting".into();
    }
    if dir.join("MERGE_HEAD").exists() {
        return "merging".into();
    }
    if dir.join("BISECT_LOG").exists() {
        return "bisecting".into();
    }
    "clean".into()
}

/// `.git` is a folder in a normal clone and a *file* pointing elsewhere inside
/// a worktree — which every Yard floor is, so this cannot be `root/.git`.
/// What one `git rev-parse --show-toplevel --absolute-git-dir --short HEAD`
/// answered.
#[derive(Default)]
pub(crate) struct HeadProbe {
    pub root: Option<String>,
    pub git_dir: Option<String>,
    /// `None` in a repository with no commit yet — where the third question
    /// fails and git simply writes one line less.
    pub short: Option<String>,
}

/// Read in order, and tolerant of a short answer: with no commit, `--short
/// HEAD` is a `fatal:` on stderr and **nothing** on stdout, so the reply is
/// two lines instead of three. Read positionally without allowing for that,
/// the git dir would be taken for the short hash — and an empty repository
/// would start claiming it has a HEAD.
pub(crate) fn parse_head_probe(stdout: &str) -> HeadProbe {
    let mut lines = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| l.replace('\\', "/"));
    HeadProbe {
        root: lines.next(),
        git_dir: lines.next(),
        short: lines.next(),
    }
}

fn remotes(cwd: &Path) -> Vec<RemoteInfo> {
    let Ok(out) = run_git(cwd, &["remote", "-v"]) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_remotes(&String::from_utf8_lossy(&out.stdout))
}

/// `origin<TAB>url (fetch)` / `(push)` — one entry per remote, the fetch URL,
/// in the order git lists them.
pub(crate) fn parse_remotes(text: &str) -> Vec<RemoteInfo> {
    let mut out: Vec<RemoteInfo> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || !line.ends_with("(fetch)") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else {
            continue;
        };
        if out.iter().any(|r| r.name == name) {
            continue;
        }
        out.push(RemoteInfo {
            name: name.to_string(),
            url: url.to_string(),
        });
    }
    out
}


// ---------------------------------------------------------------------------
// committing
// ---------------------------------------------------------------------------

/// Everything the commit button can carry. Each flag is a separate decision
/// the UI makes explicit — none of them is ever inferred from the state.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOpts {
    /// Rewrite the last commit instead of adding one.
    pub amend: bool,
    /// Prepare everything first — the "commit tudo" shortcut.
    pub stage_all: bool,
    pub signoff: bool,
    /// Skips the repository's hooks. Off by default: a hook that runs the
    /// tests is the reason the repository has one.
    pub no_verify: bool,
    /// Records a commit with no change. Only reachable from the ⋯ menu.
    pub allow_empty: bool,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
}

/// Records the commit and reads back what it actually contains — the toast
/// says "3 arquivos, +40 −7", and that number has to come from the commit,
/// not from the list the panel was showing a moment earlier.
pub fn commit(cwd: &Path, message: &str, opts: CommitOpts) -> Result<CommitResult, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("escreva a mensagem do commit".into());
    }
    if opts.stage_all {
        stage_all(cwd)?;
    }
    let mut args: Vec<&str> = vec!["commit", "-m", msg];
    if opts.amend {
        args.push("--amend");
    }
    if opts.signoff {
        args.push("--signoff");
    }
    if opts.no_verify {
        args.push("--no-verify");
    }
    if opts.allow_empty {
        args.push("--allow-empty");
    }
    ok(cwd, &args)?;

    let hash = first_line(cwd, &["rev-parse", "HEAD"])
        .ok_or_else(|| "o commit foi gravado mas o git não disse qual".to_string())?;
    let detail = commit_detail(cwd, &hash)?;
    Ok(CommitResult {
        short: detail.commit.short.clone(),
        subject: detail.commit.subject.clone(),
        files: detail.files.len() as u32,
        additions: detail.additions,
        deletions: detail.deletions,
        hash,
    })
}

/// The full message of the last commit — subject **and** body. It is what the
/// amend button pre-fills the box with, and dropping the body there is how a
/// typo fix silently deletes four paragraphs of context.
pub fn last_message(cwd: &Path) -> Result<Option<String>, String> {
    if !has_head(cwd) {
        return Ok(None);
    }
    let out = git_out(cwd, &["log", "-1", "--format=%B"])?;
    let text = out.trim_end_matches(['\n', '\r']).to_string();
    Ok((!text.trim().is_empty()).then_some(text))
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/// Field separator inside a record, record separator between them: `%x1f`
/// (unit separator) and NUL. Neither can appear in a path, a name or a commit
/// message, which is the whole reason for choosing them over `|`.
const FS: char = '\u{1f}';

const LOG_FORMAT: &str = "--format=%H\u{1f}%h\u{1f}%an\u{1f}%ae\u{1f}%at\u{1f}%P\u{1f}%D\u{1f}%s\u{1f}%b";
const DEFAULT_LOG_LIMIT: u32 = 100;
/// Cap on the diff text of a commit's file, same reasoning as `git.rs`.
const MAX_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogQuery {
    /// `0` = the module's own page size. The panel pages by asking for more.
    pub limit: u32,
    pub skip: u32,
    /// Only commits that touched this path — the "histórico deste arquivo".
    pub path: Option<String>,
    /// Where to start walking: a branch, a tag, a hash. `None` = `HEAD`.
    pub rev: Option<String>,
    /// Every branch, not just the current one.
    pub all: bool,
    /// Text to look for in the message (`--grep`).
    pub search: Option<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /// Author date, epoch seconds.
    pub date: i64,
    pub parents: Vec<String>,
    /// `HEAD -> main`, `origin/main`, `tag: v1.0` — what points at it.
    pub refs: Vec<String>,
    pub subject: String,
    pub body: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: CommitInfo,
    pub files: Vec<crate::git::ChangedFile>,
    pub additions: u32,
    pub deletions: u32,
}

pub fn log(cwd: &Path, query: LogQuery) -> Result<Vec<CommitInfo>, String> {
    // A repository with no commit is not an error here: it is the state the
    // "primeiro commit" face of the panel is drawn from.
    if !has_head(cwd) {
        return Ok(Vec::new());
    }
    let limit = if query.limit == 0 {
        DEFAULT_LOG_LIMIT
    } else {
        query.limit
    };
    let max = format!("--max-count={limit}");
    let skip = format!("--skip={}", query.skip);
    let mut args: Vec<String> = vec![
        "log".into(),
        "-z".into(),
        LOG_FORMAT.into(),
        max,
        skip,
        "--no-color".into(),
    ];
    if query.all {
        args.push("--all".into());
    }
    if let Some(text) = query.search.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        // One argv element that already starts with `--grep=`: the text can
        // hold anything, including a leading dash, without becoming an option.
        args.push(format!("--grep={text}"));
        args.push("--regexp-ignore-case".into());
        args.push("--fixed-strings".into());
    }
    if let Some(rev) = query.rev.as_deref() {
        check_ref_name(rev)?;
        args.push(rev.to_string());
    }
    if let Some(path) = query.path.as_deref() {
        let fenced = rel_paths(&[path.to_string()])?;
        args.push("--".into());
        args.push(fenced[0].clone());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = run_git(cwd, &refs)?;
    if !out.status.success() {
        return Err(check(out).unwrap_err());
    }
    Ok(parse_log(&out.stdout))
}

/// `-z` makes git write one NUL-terminated record per commit; `%x1f` splits
/// the fields inside it. The body is last on purpose — it is the only field
/// that can hold newlines, so nothing after it can be thrown off by them.
pub(crate) fn parse_log(bytes: &[u8]) -> Vec<CommitInfo> {
    let mut out = Vec::new();
    for record in bytes.split(|b| *b == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim_start_matches(['\n', '\r']);
        if text.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = text.splitn(9, FS).collect();
        if f.len() < 9 {
            continue;
        }
        out.push(CommitInfo {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            author: f[2].to_string(),
            email: f[3].to_string(),
            date: f[4].parse().unwrap_or(0),
            parents: split_words(f[5]),
            refs: f[6]
                .split(", ")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect(),
            subject: f[7].to_string(),
            body: f[8].trim_end_matches(['\n', '\r']).to_string(),
        });
    }
    out
}

fn split_words(text: &str) -> Vec<String> {
    text.split_whitespace().map(|s| s.to_string()).collect()
}

/// A hash is a ref, and a ref reaching git unchecked is the same argument
/// injection a branch name is — `git show --output=…` writes files.
fn check_hash(hash: &str) -> Result<(), String> {
    let h = hash.trim();
    if h.len() < 4 || h.len() > 40 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("hash inválido: {hash}"));
    }
    Ok(())
}

pub fn commit_detail(cwd: &Path, hash: &str) -> Result<CommitDetail, String> {
    check_hash(hash)?;
    let head = git_out(cwd, &["show", "--no-patch", "-z", LOG_FORMAT, hash])?;
    let commit = parse_log(head.as_bytes())
        .into_iter()
        .next()
        .ok_or_else(|| format!("não achei o commit {hash}"))?;

    // `--first-parent` so a merge shows what it brought in, instead of the
    // empty combined diff `git show` gives by default.
    let names = run_git(
        cwd,
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "-M",
            "--first-parent",
            hash,
        ],
    )?;
    let stats = run_git(
        cwd,
        &[
            "show",
            "--format=",
            "--numstat",
            "-z",
            "-M",
            "--first-parent",
            hash,
        ],
    )?;
    let numbers = crate::git::parse_numstat(&stats.stdout);

    let mut files = Vec::new();
    let (mut additions, mut deletions) = (0u32, 0u32);
    for (status, path, orig) in crate::git::parse_name_status(&names.stdout) {
        let (adds, dels) = numbers.get(&path).copied().unwrap_or((None, None));
        additions += adds.unwrap_or(0);
        deletions += dels.unwrap_or(0);
        files.push(crate::git::ChangedFile {
            path,
            orig_path: orig,
            index: status.clone(),
            worktree: "none".into(),
            status,
            staged: true,
            additions: adds,
            deletions: dels,
            binary: adds.is_none() && dels.is_none(),
            conflict: None,
        });
    }
    Ok(CommitDetail {
        commit,
        files,
        additions,
        deletions,
    })
}

/// The diff of one file inside one commit — what the history rows expand to.
pub fn commit_file_diff(
    cwd: &Path,
    hash: &str,
    path: &str,
) -> Result<crate::git::FileDiff, String> {
    check_hash(hash)?;
    let fenced = rel_paths(&[path.to_string()])?;
    let out = run_git(
        cwd,
        &[
            "show",
            "--format=",
            "-M",
            "--first-parent",
            "--no-color",
            hash,
            "--",
            &fenced[0],
        ],
    )?;
    if !out.status.success() {
        return Err(check(out).unwrap_err());
    }
    let truncated = out.stdout.len() > MAX_DIFF_BYTES;
    let slice = if truncated {
        &out.stdout[..MAX_DIFF_BYTES]
    } else {
        &out.stdout[..]
    };
    let text = String::from_utf8_lossy(slice).into_owned();
    Ok(crate::git::FileDiff {
        path: fenced[0].clone(),
        is_binary: text.contains("Binary files "),
        truncated,
        external: false,
        text,
    })
}

// ---------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// `main`, `feature/x`, `origin/main` — short form, the one people type.
    pub name: String,
    pub current: bool,
    /// Lives under `refs/remotes/`: checking it out detaches `HEAD`, so the
    /// panel offers "criar uma local a partir dela" instead.
    pub remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream it tracks no longer exists (`[gone]`) — the branch was
    /// merged and deleted on the server, which is exactly when it is safe to
    /// delete here too.
    pub gone: bool,
    pub hash: String,
    pub subject: String,
    /// Last commit date, epoch seconds — the list sorts by it.
    pub date: i64,
}

const BRANCH_FORMAT: &str = "--format=%(HEAD)\u{1f}%(refname:short)\u{1f}%(objectname:short)\u{1f}%(upstream:short)\u{1f}%(upstream:track)\u{1f}%(committerdate:unix)\u{1f}%(contents:subject)\u{1f}%(refname)%00";

pub fn branches(cwd: &Path) -> Result<Vec<BranchInfo>, String> {
    let out = run_git(
        cwd,
        &["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"],
    )?;
    if !out.status.success() {
        return Err(check(out).unwrap_err());
    }
    Ok(parse_branch_refs(&out.stdout))
}

pub(crate) fn parse_branch_refs(bytes: &[u8]) -> Vec<BranchInfo> {
    let mut out = Vec::new();
    for record in bytes.split(|b| *b == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim_matches(['\n', '\r']);
        if text.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = text.splitn(8, FS).collect();
        if f.len() < 8 {
            continue;
        }
        let full = f[7];
        // `origin/HEAD` is a pointer to the remote's default branch, not a
        // branch of its own: listing it duplicates whatever it points at.
        if full.ends_with("/HEAD") {
            continue;
        }
        let (ahead, behind, gone) = parse_track(f[4]);
        out.push(BranchInfo {
            name: f[1].to_string(),
            current: f[0].trim() == "*",
            remote: full.starts_with("refs/remotes/"),
            upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
            ahead,
            behind,
            gone,
            hash: f[2].to_string(),
            subject: f[6].to_string(),
            date: f[5].parse().unwrap_or(0),
        });
    }
    out
}

/// `%(upstream:track)`: `[ahead 1, behind 2]`, `[gone]`, or empty.
pub(crate) fn parse_track(text: &str) -> (u32, u32, bool) {
    let inner = text.trim().trim_start_matches('[').trim_end_matches(']');
    if inner.is_empty() {
        return (0, 0, false);
    }
    if inner == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// Names that reach git as positional arguments. `check_branch_name` already
/// enforces git's own `check-ref-format` rules plus the leading-dash refusal;
/// this is the same fence for tags, remotes and revisions.
fn check_ref_name(name: &str) -> Result<(), String> {
    crate::git::check_branch_name(name)
}

fn check_remote_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("o nome do remoto está vazio".into());
    }
    if n.starts_with('-') || n.contains(char::is_whitespace) || n.contains('/') {
        return Err(format!("nome de remoto inválido: {name}"));
    }
    Ok(())
}

pub fn checkout(cwd: &Path, name: &str) -> Result<(), String> {
    check_ref_name(name)?;
    ok(cwd, &["checkout", "-q", name, "--"])
}

/// Creates a branch, optionally from another point, optionally switching to it.
pub fn branch_create(
    cwd: &Path,
    name: &str,
    start_point: Option<&str>,
    switch: bool,
) -> Result<(), String> {
    check_ref_name(name)?;
    // A start point is a revision, not just a branch (`HEAD~1`, a hash), so it
    // gets the looser — but still dash-free — check.
    if let Some(point) = start_point {
        check_revision(point)?;
    }
    let verb: &[&str] = if switch {
        &["checkout", "-q", "-b"]
    } else {
        &["branch"]
    };
    let mut args: Vec<&str> = verb.to_vec();
    args.push(name);
    if let Some(point) = start_point {
        args.push(point);
    }
    ok(cwd, &args)
}

pub fn branch_delete(cwd: &Path, name: &str, force: bool) -> Result<(), String> {
    check_ref_name(name)?;
    ok(
        cwd,
        &["branch", if force { "-D" } else { "-d" }, "--", name],
    )
}

pub fn branch_rename(cwd: &Path, from: &str, to: &str) -> Result<(), String> {
    check_ref_name(from)?;
    check_ref_name(to)?;
    ok(cwd, &["branch", "-m", from, to])
}

/// A revision the user picked from a list (`HEAD~1`, `abc1234`, `origin/main`).
/// Looser than a branch name — `~`, `^` and `@` are meaningful here — but the
/// leading dash and the shell-ish characters are still refused.
fn check_revision(rev: &str) -> Result<(), String> {
    let r = rev.trim();
    if r.is_empty() {
        return Err("a referência está vazia".into());
    }
    if r.starts_with('-') {
        return Err(format!("referência inválida: {rev}"));
    }
    if r.contains(char::is_whitespace) || r.contains(['"', '\'', ';', '|', '&', '$', '\\']) {
        return Err(format!("referência inválida: {rev}"));
    }
    Ok(())
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// It stopped on a collision. Not an error: it is a state, and the panel
    /// draws the "resolva os conflitos" face from it.
    pub conflicted: bool,
    /// What git said, verbatim.
    pub message: String,
}

pub fn merge(cwd: &Path, name: &str, no_ff: bool) -> Result<MergeResult, String> {
    check_ref_name(name)?;
    let mut args: Vec<&str> = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.push(name);
    let out = run_git(cwd, &args)?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        return Ok(MergeResult {
            conflicted: false,
            message: text.trim().to_string(),
        });
    }
    if has_conflicts(cwd) {
        return Ok(MergeResult {
            conflicted: true,
            message: text.trim().to_string(),
        });
    }
    Err(check(out).unwrap_err())
}

/// Rebase is the other way to bring a branch in, and it fails the same way.
pub fn rebase(cwd: &Path, onto: &str) -> Result<MergeResult, String> {
    check_ref_name(onto)?;
    let out = run_git(cwd, &["-c", "core.editor=true", "rebase", onto])?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        return Ok(MergeResult {
            conflicted: false,
            message: text.trim().to_string(),
        });
    }
    if has_conflicts(cwd) {
        return Ok(MergeResult {
            conflicted: true,
            message: text.trim().to_string(),
        });
    }
    Err(check(out).unwrap_err())
}

/// Undoes a commit by recording its opposite — the safe alternative to a reset
/// on a branch other people already pulled.
pub fn revert(cwd: &Path, hash: &str) -> Result<MergeResult, String> {
    check_hash(hash)?;
    let out = run_git(cwd, &["-c", "core.editor=true", "revert", "--no-edit", hash])?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        return Ok(MergeResult {
            conflicted: false,
            message: text.trim().to_string(),
        });
    }
    if has_conflicts(cwd) {
        return Ok(MergeResult {
            conflicted: true,
            message: text.trim().to_string(),
        });
    }
    Err(check(out).unwrap_err())
}

/// Moves the branch pointer. `mode` is `soft` (keep everything prepared),
/// `mixed` (keep the files, empty the index) or `hard` (throw it all away).
pub fn reset(cwd: &Path, rev: &str, mode: &str) -> Result<(), String> {
    check_revision(rev)?;
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("modo de reset desconhecido: {other}")),
    };
    ok(cwd, &["reset", flag, rev, "--"])
}

fn has_conflicts(cwd: &Path) -> bool {
    run_git(cwd, &["diff", "--name-only", "--diff-filter=U"])
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// "Fico com o meu" / "com o deles", then prepare — resolving without staging
/// leaves the merge half-done in a way nothing on screen explains.
pub fn resolve_conflict(cwd: &Path, paths: &[String], side: &str) -> Result<(), String> {
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(format!("lado desconhecido: {other}")),
    };
    let paths = rel_paths(paths)?;
    ok(cwd, &with_paths(&["checkout", flag], &paths))?;
    ok(cwd, &with_paths(&["add"], &paths))
}

/// Gets out of whatever the repository is in the middle of.
pub fn abort_state(cwd: &Path) -> Result<(), String> {
    let state = info(cwd)?.state;
    match state.as_str() {
        "merging" => ok(cwd, &["merge", "--abort"]),
        "rebasing" => ok(cwd, &["rebase", "--abort"]),
        "cherry-picking" => ok(cwd, &["cherry-pick", "--abort"]),
        "reverting" => ok(cwd, &["revert", "--abort"]),
        "bisecting" => ok(cwd, &["bisect", "reset"]),
        _ => Err("não há nada em andamento para abortar".into()),
    }
}

/// Carries on after the conflicts were resolved and prepared.
pub fn continue_state(cwd: &Path) -> Result<(), String> {
    let state = info(cwd)?.state;
    match state.as_str() {
        "rebasing" => ok(cwd, &["-c", "core.editor=true", "rebase", "--continue"]),
        "cherry-picking" => ok(cwd, &["-c", "core.editor=true", "cherry-pick", "--continue"]),
        "reverting" => ok(cwd, &["-c", "core.editor=true", "revert", "--continue"]),
        // A merge has no `--continue`: it ends with a commit, which is the
        // button the panel is already showing.
        "merging" => Err("termine o merge com um commit".into()),
        _ => Err("não há nada em andamento para continuar".into()),
    }
}

// ---------------------------------------------------------------------------
// stash
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Position in the stack — `stash@{0}` is the most recent.
    pub index: u32,
    pub message: String,
    /// The branch it was taken on, when git recorded one.
    pub branch: Option<String>,
    pub date: i64,
    pub hash: String,
}

pub fn stash_list(cwd: &Path) -> Result<Vec<StashEntry>, String> {
    let out = run_git(
        cwd,
        &["stash", "list", "-z", "--format=%gd\u{1f}%gs\u{1f}%at\u{1f}%H"],
    )?;
    if !out.status.success() {
        // No stash ref at all is not a failure — it is an empty list.
        return Ok(Vec::new());
    }
    Ok(parse_stash_list(&out.stdout))
}

pub(crate) fn parse_stash_list(bytes: &[u8]) -> Vec<StashEntry> {
    let mut out = Vec::new();
    for record in bytes.split(|b| *b == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim_matches(['\n', '\r']);
        if text.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = text.splitn(4, FS).collect();
        if f.len() < 4 {
            continue;
        }
        let index = f[0]
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse()
            .unwrap_or(0);
        out.push(StashEntry {
            index,
            branch: stash_branch(f[1]),
            message: f[1].to_string(),
            date: f[2].parse().unwrap_or(0),
            hash: f[3].to_string(),
        });
    }
    out
}

/// `On main: guardando` / `WIP on feature/x: 1234abc assunto` — the branch is
/// what sits between the preposition and the colon.
fn stash_branch(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))?;
    let name = rest.split(':').next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub fn stash_push(
    cwd: &Path,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if keep_index {
        args.push("--keep-index");
    }
    let msg = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = msg {
        args.push("-m");
        args.push(m);
    }
    ok(cwd, &args)
}

/// `pop` = apply and remove. Two buttons, one call: the difference is whether
/// the entry survives, and mixing them up loses work either way.
pub fn stash_apply(cwd: &Path, index: u32, pop: bool) -> Result<(), String> {
    let target = format!("stash@{{{index}}}");
    ok(cwd, &["stash", if pop { "pop" } else { "apply" }, &target])
}

pub fn stash_drop(cwd: &Path, index: u32) -> Result<(), String> {
    let target = format!("stash@{{{index}}}");
    ok(cwd, &["stash", "drop", &target])
}

/// The diff a stash entry holds, so the panel can show it before applying.
pub fn stash_show(cwd: &Path, index: u32) -> Result<String, String> {
    let target = format!("stash@{{{index}}}");
    git_out(
        cwd,
        &["stash", "show", "-p", "--no-color", "-M", &target],
    )
}

// ---------------------------------------------------------------------------
// the remote
// ---------------------------------------------------------------------------

pub fn fetch(cwd: &Path, remote: Option<&str>, prune: bool) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["fetch"];
    if prune {
        args.push("--prune");
    }
    match remote {
        Some(name) => {
            check_remote_name(name)?;
            args.push(name);
        }
        None => args.push("--all"),
    }
    ok(cwd, &args)
}

pub fn pull(cwd: &Path, rebase: bool) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["-c", "core.editor=true", "pull"];
    args.push(if rebase { "--rebase" } else { "--no-rebase" });
    ok(cwd, &args)
}

/// `force` is `--force-with-lease`, never `--force`: it refuses when the
/// remote moved since our last fetch, which is the whole difference between
/// "reescrevi o meu" and "apaguei o de outra pessoa".
pub fn push(
    cwd: &Path,
    remote: &str,
    branch: Option<&str>,
    set_upstream: bool,
    force: bool,
) -> Result<(), String> {
    check_remote_name(remote)?;
    let mut args: Vec<&str> = vec!["push"];
    if set_upstream {
        args.push("--set-upstream");
    }
    if force {
        args.push("--force-with-lease");
    }
    args.push(remote);
    if let Some(name) = branch {
        check_ref_name(name)?;
        args.push(name);
    }
    ok(cwd, &args)
}

/// Deletes the branch on the server — the other half of "apagar a branch",
/// and the one that cannot be undone from here.
pub fn push_delete(cwd: &Path, remote: &str, branch: &str) -> Result<(), String> {
    check_remote_name(remote)?;
    check_ref_name(branch)?;
    ok(cwd, &["push", remote, "--delete", branch])
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub hash: String,
    pub subject: String,
    pub date: i64,
}

const TAG_FORMAT: &str = "--format=%(refname:short)\u{1f}%(objectname:short)\u{1f}%(creatordate:unix)\u{1f}%(contents:subject)%00";

pub fn tags(cwd: &Path) -> Result<Vec<TagInfo>, String> {
    let out = run_git(
        cwd,
        &["for-each-ref", TAG_FORMAT, "--sort=-creatordate", "refs/tags"],
    )?;
    if !out.status.success() {
        return Err(check(out).unwrap_err());
    }
    let mut list = Vec::new();
    for record in out.stdout.split(|b| *b == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim_matches(['\n', '\r']);
        if text.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = text.splitn(4, FS).collect();
        if f.len() < 4 {
            continue;
        }
        list.push(TagInfo {
            name: f[0].to_string(),
            hash: f[1].to_string(),
            date: f[2].parse().unwrap_or(0),
            subject: f[3].to_string(),
        });
    }
    Ok(list)
}

pub fn tag_create(
    cwd: &Path,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> Result<(), String> {
    check_ref_name(name)?;
    if let Some(rev) = target {
        check_revision(rev)?;
    }
    let msg = message.map(str::trim).filter(|m| !m.is_empty());
    let mut args: Vec<&str> = vec!["tag"];
    if let Some(m) = msg {
        args.push("-a");
        args.push("-m");
        args.push(m);
    }
    args.push(name);
    if let Some(rev) = target {
        args.push(rev);
    }
    ok(cwd, &args)
}

pub fn tag_delete(cwd: &Path, name: &str) -> Result<(), String> {
    check_ref_name(name)?;
    ok(cwd, &["tag", "-d", name])
}

// ---------------------------------------------------------------------------
// patches (hunk-level staging)
// ---------------------------------------------------------------------------

/// Applies a patch the panel built from one or more hunks.
///
/// Four gestures come through this one door, and the two booleans are what
/// tell them apart: prepare a hunk (`cached`), unprepare it (`cached` +
/// `reverse`), discard it from the disk (`reverse`), and — the rare one —
/// re-apply it.
pub fn apply_patch(cwd: &Path, patch: &str, cached: bool, reverse: bool) -> Result<(), String> {
    if patch.trim().is_empty() {
        return Err("não há nada para aplicar".into());
    }
    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    // Zero-context hunks (a pure insertion at the top of a file) are legal
    // unified diff and `git apply` refuses them without this.
    args.push("--unidiff-zero");
    args.push("-");
    let out = run_git_stdin(cwd, &args, patch)?;
    check(out).map(|_| ())
}

/// git with something on stdin. Only patches need it, and they need it badly:
/// a temp file would be one more thing to clean up on a crash.
fn run_git_stdin(cwd: &Path, args: &[&str], input: &str) -> Result<Output, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("falha ao rodar git: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("falha ao mandar o patch para o git: {e}"))?;
    }
    // Dropping stdin closes the pipe; without it `git apply` waits forever.
    drop(child.stdin.take());
    child
        .wait_with_output()
        .map_err(|e| format!("falha ao esperar o git: {e}"))
}

// ---------------------------------------------------------------------------
// starting from nothing
// ---------------------------------------------------------------------------

/// `git init` on a folder that has no repository — the only offer the panel
/// can honestly make there.
pub fn init_repo(cwd: &Path) -> Result<(), String> {
    if run_git(cwd, &["init", "-b", "main"])
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
    // Older git has no `-b`; it lands on whatever `init.defaultBranch` says.
    ok(cwd, &["init"])
}


// ---------------------------------------------------------------------------
// side-aware diffs
// ---------------------------------------------------------------------------

/// The diff of one file, on the side the caller is looking at.
///
/// `side`:
/// - `worktree` — the index against the disk. This is the "Alterações" group,
///   and the only correct baseline for **preparing a hunk**: a patch built
///   against `HEAD` will not apply when part of the file is already prepared.
/// - `index` — `HEAD` against the index. The "Preparado" group, and the
///   baseline for *un*preparing a hunk.
/// - `head` — `HEAD` against the disk: everything the next commit would
///   change, which is what the large viewer shows.
pub fn diff(
    cwd: &Path,
    path: &str,
    side: &str,
    orig_path: Option<&str>,
    context: Option<u32>,
) -> Result<crate::git::FileDiff, String> {
    let fenced = rel_paths(&[path.to_string()])?;
    let rel = &fenced[0];
    let base: &[&str] = match side {
        // `--no-index` is not wanted here: an untracked path simply has no
        // entry, and `git diff` answers empty. The synth below is what turns
        // that into the all-additions diff the panel draws.
        "worktree" => &[],
        "index" => &["--cached"],
        "head" => &["HEAD"],
        other => return Err(format!("lado desconhecido: {other}")),
    };
    if !has_head(cwd) && side != "worktree" {
        // Nothing to compare against yet: everything prepared is new.
        return crate::git::file_diff(cwd, rel, true, None, context);
    }

    let ctx = context.map(|n| format!("-U{n}"));
    let mut args: Vec<&str> = vec!["diff", "--no-color", "-M"];
    if let Some(c) = ctx.as_deref() {
        args.push(c);
    }
    args.extend(base.iter().copied());
    args.push("--");
    args.push(rel.as_str());
    if let Some(orig) = orig_path {
        let orig = rel_paths(&[orig.to_string()])?;
        // Borrowing from a temporary would not outlive the call; the vector
        // does, and the pathspec needs both sides for `-M` to see the rename.
        let mut owned = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        owned.push(orig[0].clone());
        let refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        return finish_diff(cwd, &refs, rel, context);
    }
    finish_diff(cwd, &args, rel, context)
}

fn finish_diff(
    cwd: &Path,
    args: &[&str],
    rel: &str,
    context: Option<u32>,
) -> Result<crate::git::FileDiff, String> {
    let out = run_git(cwd, args)?;
    if !out.status.success() {
        return Err(check(out).unwrap_err());
    }
    let truncated = out.stdout.len() > MAX_DIFF_BYTES;
    let slice = if truncated {
        &out.stdout[..MAX_DIFF_BYTES]
    } else {
        &out.stdout[..]
    };
    let text = String::from_utf8_lossy(slice).into_owned();
    if text.trim().is_empty() {
        // Empty from `git diff` means "git has no left side for this path" —
        // an untracked file. The synthesized all-additions diff is the answer
        // the panel is asking for, and `git.rs` already knows how to build it.
        return crate::git::file_diff(cwd, rel, true, None, context);
    }
    Ok(crate::git::FileDiff {
        path: rel.to_string(),
        is_binary: text.lines().any(|l| l.starts_with("Binary files ")),
        truncated,
        external: false,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repo in a temp folder, torn down with the test. `None` when there is
    /// no usable git on the machine — the suite then skips instead of failing
    /// for a reason that has nothing to do with the code.
    struct Repo {
        root: std::path::PathBuf,
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    impl Repo {
        fn new(tag: &str) -> Option<Repo> {
            let root = std::env::temp_dir().join(format!(
                "yard-scm-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).ok()?;
            let repo = Repo { root };
            if !repo.git(&["init", "-b", "main"]) {
                if !repo.git(&["init"]) {
                    return None;
                }
                let _ = repo.git(&["checkout", "-b", "main"]);
            }
            let _ = repo.git(&["config", "user.email", "t@yard.test"]);
            let _ = repo.git(&["config", "user.name", "Yard Test"]);
            let _ = repo.git(&["config", "commit.gpgsign", "false"]);
            let _ = repo.git(&["config", "core.autocrlf", "false"]);
            Some(repo)
        }

        fn git(&self, args: &[&str]) -> bool {
            crate::git::run_git(&self.root, args)
                .map(|o| o.status.success())
                .unwrap_or(false)
        }

        fn write(&self, rel: &str, text: &str) {
            let full = self.root.join(rel);
            if let Some(parent) = full.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(full, text).unwrap();
        }

        fn read(&self, rel: &str) -> String {
            std::fs::read_to_string(self.root.join(rel)).unwrap()
        }

        fn commit(&self, msg: &str) -> bool {
            self.git(&["add", "-A"]) && self.git(&["commit", "-m", msg])
        }

        /// What `git status` says about one path, as the two sides the panel
        /// groups by: `(index, worktree)`.
        fn sides_of(&self, rel: &str) -> (String, String) {
            let summary = crate::git::changes(&self.root).unwrap();
            summary
                .files
                .iter()
                .find(|f| f.path == rel)
                .map(|f| (f.index.clone(), f.worktree.clone()))
                .unwrap_or_else(|| ("clean".into(), "clean".into()))
        }
    }

    // -- the header probe ---------------------------------------------------

    /// `info` used to spend one `git` process per line of the header. On
    /// Windows every one of them costs ~35 ms **before** git does any work,
    /// and `info` runs on every write and on every beat of the watcher — so
    /// three questions that a single `rev-parse` answers were paying triple.
    #[test]
    fn the_rev_parse_probe_answers_root_git_dir_and_head_in_one_go() {
        let output = "C:/proj
C:/proj/.git
abc1234
";
        let probe = parse_head_probe(output);
        assert_eq!(probe.root.as_deref(), Some("C:/proj"));
        assert_eq!(probe.git_dir.as_deref(), Some("C:/proj/.git"));
        assert_eq!(probe.short.as_deref(), Some("abc1234"));
    }

    /// The regression this guards: with no commit yet, `--short HEAD` fails
    /// and prints nothing, so the answer is two lines instead of three. Read
    /// positionally without noticing, the git dir would be taken for the
    /// short hash and an empty repository would claim to have a HEAD.
    #[test]
    fn with_no_commit_the_probe_still_gives_root_and_git_dir_without_inventing_a_head() {
        let probe = parse_head_probe("C:/novo
C:/novo/.git
");
        assert_eq!(probe.root.as_deref(), Some("C:/novo"));
        assert_eq!(probe.git_dir.as_deref(), Some("C:/novo/.git"));
        assert_eq!(probe.short, None);
    }

    #[test]
    fn outside_a_repository_the_probe_answers_nothing() {
        let probe = parse_head_probe("");
        assert_eq!(probe.root, None);
        assert_eq!(probe.git_dir, None);
        assert_eq!(probe.short, None);
    }

    // -- the command line ---------------------------------------------------

    /// The regression that motivated this: "Preparar tudo deste grupo" on a
    /// repository with a few thousand changed paths built one `git add` with
    /// every path on the command line. Windows refuses a command line past
    /// ~32k characters, so the click did nothing and said nothing — and, well
    /// short of that limit, one enormous `git` call is also slower than a
    /// handful of ordinary ones.
    #[test]
    fn the_path_list_is_cut_at_the_command_line_budget() {
        let paths: Vec<String> = (0..5_000)
            .map(|i| format!("src/components/Pasta{i}/arquivo-{i}.tsx"))
            .collect();
        let batches = path_batches(&paths, 24_000);
        assert!(batches.len() > 1, "five thousand paths do not fit in a single call");
        for batch in &batches {
            assert!(!batch.is_empty(), "an empty batch would become a `git add --` with no target");
            let cost: usize = batch.iter().map(|p| p.len() + 3).sum();
            assert!(cost <= 24_000, "a batch of {cost} blew the budget");
        }
        let total: usize = batches.iter().map(|l| l.len()).sum();
        assert_eq!(total, paths.len(), "no path may be lost in the cut");
        assert_eq!(batches[0][0], paths[0], "the order is preserved");
    }

    #[test]
    fn what_fits_in_a_single_call_stays_a_single_call() {
        let paths: Vec<String> = (0..40).map(|i| format!("a{i}.txt")).collect();
        assert_eq!(path_batches(&paths, 24_000).len(), 1);
    }

    /// A single path longer than the whole budget still has to be attempted:
    /// dropping it would silently skip the file the user clicked.
    #[test]
    fn a_path_larger_than_the_budget_still_goes_on_its_own() {
        let huge = "x".repeat(40_000);
        let paths = vec![huge.clone(), "b.txt".into()];
        let batches = path_batches(&paths, 24_000);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0], &[huge]);
        assert_eq!(batches[1], &["b.txt".to_string()]);
    }

    #[test]
    fn an_empty_list_produces_no_call_at_all() {
        assert!(path_batches(&[], 24_000).is_empty());
    }

    // -- the staging area ---------------------------------------------------

    /// The gesture the whole panel is built on: the same path moves from
    /// "Alterações" to "Preparado" and back, and nothing else about it changes.
    #[test]
    fn staging_and_unstaging_move_the_file_between_the_two_sides() {
        let Some(repo) = Repo::new("stage") else { return };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "um\ndois\n");
        assert_eq!(repo.sides_of("a.txt"), ("none".into(), "modified".into()));

        stage(&repo.root, &["a.txt".into()]).unwrap();
        assert_eq!(repo.sides_of("a.txt"), ("modified".into(), "none".into()));

        unstage(&repo.root, &["a.txt".into()]).unwrap();
        assert_eq!(repo.sides_of("a.txt"), ("none".into(), "modified".into()));
    }

    /// Unstaging a file that was **added** in the index has no `HEAD` version
    /// to reset to. `git reset` handles it; `git restore --staged` on a repo
    /// with no commit at all does not — and that empty repo is exactly where a
    /// user is most likely to try.
    #[test]
    fn unstaging_a_new_file_in_a_repo_with_no_commit_makes_it_untracked_again() {
        let Some(repo) = Repo::new("unstage-novo") else {
            return;
        };
        repo.write("novo.txt", "oi\n");
        stage(&repo.root, &["novo.txt".into()]).unwrap();
        assert_eq!(repo.sides_of("novo.txt"), ("added".into(), "none".into()));

        unstage(&repo.root, &["novo.txt".into()]).unwrap();
        assert_eq!(
            repo.sides_of("novo.txt"),
            ("none".into(), "untracked".into()),
            "with no HEAD, unstaging has to remove from the index without deleting the file"
        );
        assert_eq!(repo.read("novo.txt"), "oi\n");
    }

    /// Discard is the one irreversible button in the panel; what it must never
    /// do is *less* than it promised (leaving the edit behind) or *more*
    /// (touching a path nobody selected).
    #[test]
    fn discard_returns_the_file_to_what_head_says() {
        let Some(repo) = Repo::new("discard") else {
            return;
        };
        repo.write("a.txt", "original\n");
        repo.write("b.txt", "vizinho\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "estragado\n");
        repo.write("b.txt", "vizinho mexido\n");
        // Staged *and* edited again: discard has to clear both sides.
        stage(&repo.root, &["a.txt".into()]).unwrap();
        repo.write("a.txt", "estragado de novo\n");

        discard(&repo.root, &["a.txt".into()]).unwrap();
        assert_eq!(repo.read("a.txt"), "original\n");
        assert_eq!(
            repo.read("b.txt"),
            "vizinho mexido\n",
            "discarding one file must not touch its neighbour"
        );
    }

    #[test]
    fn discarding_a_new_file_deletes_it_from_disk() {
        let Some(repo) = Repo::new("discard-novo") else {
            return;
        };
        repo.write("base.txt", "x\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("lixo.txt", "gerado\n");
        repo.write("pasta/dentro.txt", "gerado\n");
        discard(&repo.root, &["lixo.txt".into(), "pasta/dentro.txt".into()]).unwrap();
        assert!(!repo.root.join("lixo.txt").exists());
        assert!(!repo.root.join("pasta/dentro.txt").exists());
    }

    /// The fence. These paths never come from a click: the panel sends what
    /// `git status` gave it, always relative to the root. A rooted path or one
    /// climbing with `..` is a bug upstream or a call that should not be
    /// happening — and `git restore` would happily obey it.
    #[test]
    fn a_path_leaving_the_root_is_refused_before_git_is_called() {
        let root = std::path::Path::new("C:/proj");
        assert!(rel_paths(&["../fora.txt".into()]).is_err());
        assert!(rel_paths(&["a/../../fora.txt".into()]).is_err());
        assert!(rel_paths(&["C:/Windows/system.ini".into()]).is_err());
        assert!(rel_paths(&["/etc/passwd".into()]).is_err());
        assert!(rel_paths(&["arquivo.txt:oculto".into()]).is_err());
        assert!(rel_paths(&["".into()]).is_err());
        assert!(rel_paths(&["   ".into()]).is_err());
        // A leading `-` would be read by git as an option even after `--`
        // in older versions; and no status output ever starts a path with it.
        assert!(rel_paths(&["-rf".into()]).is_err());

        assert_eq!(
            rel_paths(&["src/lib/a.ts".into(), "b.txt".into()]).unwrap(),
            vec!["src/lib/a.ts".to_string(), "b.txt".to_string()]
        );
        // Backslashes are normalized: the tree hands paths out in OS shape.
        assert_eq!(
            rel_paths(&["src\\lib\\a.ts".into()]).unwrap(),
            vec!["src/lib/a.ts".to_string()]
        );

        // And the fence holds at the door, not deep inside: the command
        // refuses without ever spawning git.
        assert!(stage(root, &["../fora.txt".into()]).is_err());
        assert!(discard(root, &["../fora.txt".into()]).is_err());
    }

    // -- what the header shows ----------------------------------------------

    #[test]
    fn info_brings_the_branch_the_head_and_the_clean_state() {
        let Some(repo) = Repo::new("info") else { return };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        let got = info(&repo.root).unwrap();
        assert!(got.is_repo);
        assert!(got.has_head);
        assert_eq!(got.branch.as_deref(), Some("main"));
        assert!(!got.detached);
        assert_eq!(got.state, "clean");
        assert_eq!(got.ahead, 0);
        assert_eq!(got.behind, 0);
        assert!(got.upstream.is_none(), "a local repo has no upstream");
        assert!(got.remotes.is_empty());
        assert_eq!(got.stashes, 0);
        assert!(got.head.is_some_and(|h| h.len() >= 7));
    }

    /// A repo where nobody has committed yet still has a branch name and a
    /// panel to show. Before this, everything that needed `HEAD` errored and
    /// the tab was blank exactly when the first commit was the whole job.
    #[test]
    fn with_no_commit_at_all_info_still_names_the_branch() {
        let Some(repo) = Repo::new("info-vazio") else {
            return;
        };
        let got = info(&repo.root).unwrap();
        assert!(got.is_repo);
        assert!(!got.has_head);
        assert_eq!(got.branch.as_deref(), Some("main"));
        assert!(got.head.is_none());
    }

    #[test]
    fn a_folder_without_git_answers_that_it_is_not_a_repository() {
        let dir = std::env::temp_dir().join(format!("yard-scm-sem-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let got = info(&dir).unwrap();
        assert!(!got.is_repo);
        assert!(got.branch.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Detached HEAD is a real state the panel has to name — committing on it
    /// is how work gets lost. `branch` is `None` and `detached` says why.
    #[test]
    fn a_detached_head_does_not_invent_a_branch_name() {
        let Some(repo) = Repo::new("detached") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "dois\n");
        if !repo.commit("segundo") {
            return;
        }
        if !repo.git(&["checkout", "--detach", "HEAD~1"]) {
            return;
        }
        let got = info(&repo.root).unwrap();
        assert!(got.detached);
        assert!(got.branch.is_none());
        assert!(got.head.is_some());
    }

    // -- committing ---------------------------------------------------------

    #[test]
    fn commit_records_the_message_and_empties_the_staging_area() {
        let Some(repo) = Repo::new("commit") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "um\ndois\n");
        repo.write("b.txt", "novo\n");
        stage(&repo.root, &["a.txt".into()]).unwrap();

        let result = commit(&repo.root, "segundo commit", CommitOpts::default()).unwrap();
        assert_eq!(result.subject, "segundo commit");
        assert_eq!(result.files, 1, "only what was staged goes into the commit");
        assert_eq!(result.additions, 1);
        assert!(result.short.len() >= 7);
        // b.txt stays out, untouched.
        assert_eq!(repo.sides_of("b.txt"), ("none".into(), "untracked".into()));
        assert_eq!(repo.sides_of("a.txt"), ("clean".into(), "clean".into()));
    }

    /// An empty commit is almost never what the button meant, and git's own
    /// refusal ("nothing to commit") arrives as a failed exit with the message
    /// on **stdout** — which is how this used to surface as the useless
    /// "o git falhou sem dizer por quê".
    #[test]
    fn commit_with_nothing_staged_refuses_instead_of_recording_an_empty_commit() {
        let Some(repo) = Repo::new("commit-vazio") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        let err = commit(&repo.root, "nada aqui", CommitOpts::default()).unwrap_err();
        assert!(!err.is_empty());
        assert!(
            !err.contains("sem dizer por quê"),
            "git's refusal has to arrive in full: {err}"
        );
    }

    #[test]
    fn commit_without_a_message_is_refused_before_git_is_called() {
        let root = std::path::Path::new("C:/proj");
        assert!(commit(root, "   \n  ", CommitOpts::default()).is_err());
        assert!(commit(root, "", CommitOpts::default()).is_err());
    }

    /// `stage_all` is the "commit tudo" shortcut: it prepares everything first,
    /// including the untracked, so the button does what its label promises.
    #[test]
    fn commit_all_takes_the_new_file_along() {
        let Some(repo) = Repo::new("commit-tudo") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "um\ndois\n");
        repo.write("novo.txt", "recem-criado\n");
        let result = commit(
            &repo.root,
            "tudo",
            CommitOpts {
                stage_all: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.files, 2);
        assert!(crate::git::changes(&repo.root).unwrap().files.is_empty());
    }

    #[test]
    fn amend_rewrites_the_last_commit_instead_of_creating_another() {
        let Some(repo) = Repo::new("amend") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("mensagem torta") {
            return;
        }
        let before = log(&repo.root, LogQuery::default()).unwrap();
        assert_eq!(before.len(), 1);

        let result = commit(
            &repo.root,
            "mensagem certa",
            CommitOpts {
                amend: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.subject, "mensagem certa");
        let after = log(&repo.root, LogQuery::default()).unwrap();
        assert_eq!(after.len(), 1, "amend does not stack a new commit");
        assert_eq!(after[0].subject, "mensagem certa");
        assert_ne!(after[0].hash, before[0].hash, "the commit is rewritten");
    }

    /// The amend button pre-fills the box with the message it is about to
    /// replace — and a message is a subject *and* a body. Losing the body was
    /// the whole bug: the user amended to fix a typo in the first line and
    /// silently deleted four paragraphs of context.
    #[test]
    fn the_last_commit_message_comes_back_whole_for_the_amend() {
        let Some(repo) = Repo::new("last-msg") else {
            return;
        };
        repo.write("a.txt", "um\n");
        let _ = repo.git(&["add", "-A"]);
        if !repo.git(&["commit", "-m", "assunto", "-m", "corpo com\nduas linhas"]) {
            return;
        }
        let msg = last_message(&repo.root).unwrap().unwrap();
        assert!(msg.starts_with("assunto"));
        assert!(msg.contains("corpo com"));
        assert!(msg.contains("duas linhas"));
    }

    #[test]
    fn with_no_commit_at_all_there_is_no_message_to_reuse() {
        let Some(repo) = Repo::new("last-msg-vazio") else {
            return;
        };
        assert!(last_message(&repo.root).unwrap().is_none());
    }

    // -- branches -----------------------------------------------------------

    #[test]
    fn a_new_branch_enters_the_list_and_checkout_switches_the_current_one() {
        let Some(repo) = Repo::new("branch") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        branch_create(&repo.root, "feature/nova", None, false).unwrap();

        let list = branches(&repo.root).unwrap();
        let created = list.iter().find(|b| b.name == "feature/nova").unwrap();
        assert!(!created.current);
        assert!(!created.remote);
        assert_eq!(created.subject, "inicial");
        assert!(list.iter().any(|b| b.name == "main" && b.current));

        checkout(&repo.root, "feature/nova").unwrap();
        assert_eq!(info(&repo.root).unwrap().branch.as_deref(), Some("feature/nova"));
        let list = branches(&repo.root).unwrap();
        assert!(list.iter().any(|b| b.name == "feature/nova" && b.current));
    }

    #[test]
    fn a_branch_created_from_another_point_is_born_there() {
        let Some(repo) = Repo::new("branch-de") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("primeiro") {
            return;
        }
        repo.write("a.txt", "dois\n");
        if !repo.commit("segundo") {
            return;
        }
        branch_create(&repo.root, "volta", Some("HEAD~1"), true).unwrap();
        assert_eq!(info(&repo.root).unwrap().branch.as_deref(), Some("volta"));
        assert_eq!(repo.read("a.txt"), "um\n", "born from the previous commit");
    }

    /// Argument injection, the same hole `worktree_provision` had: a name that
    /// starts with `-` is read by git as an option, and the error that comes
    /// back talks about anything but the name.
    #[test]
    fn a_branch_name_git_would_read_as_an_option_is_refused() {
        let root = std::path::Path::new("C:/proj");
        assert!(branch_create(root, "--upload-pack=calc", None, false).is_err());
        assert!(branch_create(root, "com espaço", None, false).is_err());
        assert!(branch_create(root, "", None, false).is_err());
        assert!(checkout(root, "-f").is_err());
        assert!(branch_delete(root, "--force", false).is_err());
        assert!(branch_rename(root, "main", "-x").is_err());
        assert!(merge(root, "-x", false).is_err());
    }

    #[test]
    fn deleting_the_branch_we_are_on_is_refused_with_the_reason() {
        let Some(repo) = Repo::new("branch-del") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        let err = branch_delete(&repo.root, "main", false).unwrap_err();
        assert!(!err.is_empty());
        assert!(!err.contains("sem dizer por quê"), "{err}");

        branch_create(&repo.root, "descartavel", None, false).unwrap();
        branch_delete(&repo.root, "descartavel", false).unwrap();
        assert!(!branches(&repo.root)
            .unwrap()
            .iter()
            .any(|b| b.name == "descartavel"));
    }

    #[test]
    fn renaming_the_branch_keeps_the_commit_and_changes_the_name() {
        let Some(repo) = Repo::new("branch-mv") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        branch_rename(&repo.root, "main", "principal").unwrap();
        let current = info(&repo.root).unwrap();
        assert_eq!(current.branch.as_deref(), Some("principal"));
        assert!(current.has_head);
    }

    /// `upstream:track` is git's own vocabulary for the two numbers the branch
    /// list shows; `[gone]` is the third state — the remote branch was deleted
    /// and the local one is now tracking nothing that exists.
    #[test]
    fn for_each_ref_track_becomes_two_numbers_or_gone() {
        assert_eq!(parse_track("[ahead 3]"), (3, 0, false));
        assert_eq!(parse_track("[behind 2]"), (0, 2, false));
        assert_eq!(parse_track("[ahead 1, behind 4]"), (1, 4, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }

    #[test]
    fn the_branch_list_separates_local_from_remote_and_reads_the_tracking() {
        let lines = [
            "*\u{1f}main\u{1f}abc1234\u{1f}origin/main\u{1f}[ahead 2]\u{1f}1700000000\u{1f}último commit\u{1f}refs/heads/main",
            " \u{1f}feature/x\u{1f}def5678\u{1f}\u{1f}\u{1f}1699999999\u{1f}outro\u{1f}refs/heads/feature/x",
            " \u{1f}origin/main\u{1f}abc1234\u{1f}\u{1f}\u{1f}1700000000\u{1f}último commit\u{1f}refs/remotes/origin/main",
            " \u{1f}origin/HEAD\u{1f}abc1234\u{1f}\u{1f}\u{1f}1700000000\u{1f}último commit\u{1f}refs/remotes/origin/HEAD",
        ]
        .join("\0");
        let got = parse_branch_refs(lines.as_bytes());
        assert_eq!(got.len(), 3, "origin/HEAD is an alias, not a branch");
        assert!(got[0].current);
        assert_eq!(got[0].name, "main");
        assert_eq!(got[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(got[0].ahead, 2);
        assert_eq!(got[0].behind, 0);
        assert_eq!(got[0].date, 1_700_000_000);
        assert_eq!(got[0].subject, "último commit");
        assert!(!got[1].current);
        assert!(got[1].upstream.is_none());
        assert!(!got[1].remote);
        assert!(got[2].remote, "refs/remotes/… is remote");
        assert_eq!(got[2].name, "origin/main");
    }

    // -- stash --------------------------------------------------------------

    #[test]
    fn stash_keeps_the_changes_and_pop_brings_them_back() {
        let Some(repo) = Repo::new("stash") else {
            return;
        };
        repo.write("a.txt", "original\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "mexido\n");

        stash_push(&repo.root, Some("guardando"), false, false).unwrap();
        assert_eq!(repo.read("a.txt"), "original\n", "the stash cleans the tree");
        let list = stash_list(&repo.root).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].message.contains("guardando"));
        assert_eq!(list[0].index, 0);

        stash_apply(&repo.root, 0, true).unwrap();
        assert_eq!(repo.read("a.txt"), "mexido\n");
        assert!(stash_list(&repo.root).unwrap().is_empty(), "pop also removes the entry");
    }

    /// Untracked files are not "changes" to git, so a plain `git stash` leaves
    /// them behind — and the tree the user was promised would be clean is not.
    #[test]
    fn stash_with_untracked_takes_the_new_file_along() {
        let Some(repo) = Repo::new("stash-u") else {
            return;
        };
        repo.write("a.txt", "original\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("novo.txt", "recem\n");
        stash_push(&repo.root, None, true, false).unwrap();
        assert!(!repo.root.join("novo.txt").exists());

        stash_apply(&repo.root, 0, false).unwrap();
        assert!(repo.root.join("novo.txt").exists());
        assert_eq!(
            stash_list(&repo.root).unwrap().len(),
            1,
            "apply without pop keeps the entry"
        );
        stash_drop(&repo.root, 0).unwrap();
        assert!(stash_list(&repo.root).unwrap().is_empty());
    }

    #[test]
    fn the_stash_list_reads_the_index_the_message_and_the_date() {
        let bytes = [
            "stash@{0}\u{1f}On main: guardando\u{1f}1700000000\u{1f}abc1234",
            "stash@{1}\u{1f}WIP on feature/x: 1234abc outro\u{1f}1699999999\u{1f}def5678",
        ]
        .join("\0");
        let got = parse_stash_list(bytes.as_bytes());
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].index, 0);
        assert_eq!(got[0].message, "On main: guardando");
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert_eq!(got[0].date, 1_700_000_000);
        assert_eq!(got[1].index, 1);
        assert_eq!(got[1].branch.as_deref(), Some("feature/x"));
    }

    // -- history ------------------------------------------------------------

    #[test]
    fn log_brings_the_commits_from_newest_to_oldest() {
        let Some(repo) = Repo::new("log") else { return };
        repo.write("a.txt", "um\n");
        if !repo.commit("primeiro") {
            return;
        }
        repo.write("b.txt", "dois\n");
        if !repo.commit("segundo") {
            return;
        }

        let commits = log(&repo.root, LogQuery::default()).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "segundo");
        assert_eq!(commits[1].subject, "primeiro");
        assert_eq!(commits[0].author, "Yard Test");
        assert!(commits[0].date > 0);
        assert!(commits[1].parents.is_empty(), "the first commit has no parent");
        assert_eq!(commits[0].parents.len(), 1);

        // Filtered by path: only the commit that touched `b.txt`.
        let only_b = log(
            &repo.root,
            LogQuery {
                path: Some("b.txt".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].subject, "segundo");

        // And the page size is honoured, so the panel can ask for more.
        let only_one = log(
            &repo.root,
            LogQuery {
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_one.len(), 1);
        assert_eq!(only_one[0].subject, "segundo");
    }

    #[test]
    fn log_in_a_repo_with_no_commit_is_an_empty_list_not_an_error() {
        let Some(repo) = Repo::new("log-vazio") else {
            return;
        };
        assert!(log(&repo.root, LogQuery::default()).unwrap().is_empty());
    }

    #[test]
    fn commit_detail_lists_the_files_and_counts_the_lines() {
        let Some(repo) = Repo::new("show") else { return };
        repo.write("a.txt", "um\n");
        if !repo.commit("primeiro") {
            return;
        }
        repo.write("a.txt", "um\ndois\n");
        repo.write("novo.txt", "x\n");
        if !repo.commit("segundo") {
            return;
        }

        let head = log(&repo.root, LogQuery::default()).unwrap()[0].hash.clone();
        let det = commit_detail(&repo.root, &head).unwrap();
        assert_eq!(det.commit.subject, "segundo");
        assert_eq!(det.files.len(), 2);
        assert!(det.files.iter().any(|f| f.path == "novo.txt" && f.status == "added"));
        assert!(det.files.iter().any(|f| f.path == "a.txt" && f.status == "modified"));
        assert_eq!(det.additions, 2);
    }

    /// A hash is a ref, and a ref reaching git unchecked is the same argument
    /// injection as a branch name — `git show --output=…` writes files.
    #[test]
    fn a_hash_that_does_not_look_like_a_hash_is_refused() {
        let root = std::path::Path::new("C:/proj");
        assert!(commit_detail(root, "--output=/tmp/x").is_err());
        assert!(commit_detail(root, "").is_err());
        assert!(commit_detail(root, "abc; rm -rf /").is_err());
        assert!(commit_file_diff(root, "-x", "a.txt").is_err());
    }

    #[test]
    fn the_diff_of_a_file_inside_the_commit_shows_what_changed_there() {
        let Some(repo) = Repo::new("show-file") else {
            return;
        };
        repo.write("a.txt", "um\n");
        if !repo.commit("primeiro") {
            return;
        }
        repo.write("a.txt", "um\ndois\n");
        if !repo.commit("segundo") {
            return;
        }
        let head = log(&repo.root, LogQuery::default()).unwrap()[0].hash.clone();
        let diff = commit_file_diff(&repo.root, &head, "a.txt").unwrap();
        assert!(diff.text.contains("+dois"), "{}", diff.text);
        assert!(!diff.is_binary);
    }

    #[test]
    fn log_with_empty_fields_and_a_multi_line_body_does_not_misalign() {
        // `%x1f` between fields, NUL between records — a body with newlines
        // (and an empty parents field, the first commit) has to survive both.
        let bytes = [
            "aaaa1111\u{1f}aaaa111\u{1f}Alan\u{1f}a@x.dev\u{1f}1700000000\u{1f}bbbb2222 cccc3333\u{1f}HEAD -> main, origin/main\u{1f}merge das duas\u{1f}corpo\ncom quebra",
            "bbbb2222\u{1f}bbbb222\u{1f}Alan\u{1f}a@x.dev\u{1f}1699999999\u{1f}\u{1f}\u{1f}primeiro\u{1f}",
        ]
        .join("\0");
        let got = parse_log(bytes.as_bytes());
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].parents, vec!["bbbb2222", "cccc3333"]);
        assert_eq!(got[0].refs, vec!["HEAD -> main", "origin/main"]);
        assert_eq!(got[0].body, "corpo\ncom quebra");
        assert_eq!(got[1].parents, Vec::<String>::new());
        assert_eq!(got[1].refs, Vec::<String>::new());
        assert_eq!(got[1].body, "");
        assert_eq!(got[1].subject, "primeiro");
    }

    // -- hunks --------------------------------------------------------------

    /// Hunk-level staging: the panel builds a patch with only the selected
    /// hunk and hands it here. The point of the test is the *isolation* — the
    /// other hunk of the same file must stay out of the index.
    #[test]
    fn applying_one_hunk_stages_only_that_hunk() {
        let Some(repo) = Repo::new("hunk") else { return };
        repo.write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "1 mexido\n2\n3\n4\n5\n6\n7\n8\n9\n10 mexido\n");

        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-1\n+1 mexido\n 2\n 3\n";
        apply_patch(&repo.root, patch, true, false).unwrap();

        let staged = git_out(&repo.root, &["diff", "--cached"]).unwrap();
        assert!(staged.contains("+1 mexido"), "{staged}");
        assert!(
            !staged.contains("+10 mexido"),
            "the other hunk must not have gone along: {staged}"
        );
        // And the file on disk still carries both changes.
        assert!(repo.read("a.txt").contains("10 mexido"));
    }

    /// The same call, reversed and on the working tree, is "descartar este
    /// pedaço" — the only way to undo part of a file without an editor.
    #[test]
    fn applying_in_reverse_on_disk_discards_only_that_hunk() {
        let Some(repo) = Repo::new("hunk-rev") else {
            return;
        };
        repo.write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "1 mexido\n2\n3\n4\n5\n6\n7\n8\n9\n10 mexido\n");

        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-1\n+1 mexido\n 2\n 3\n";
        apply_patch(&repo.root, patch, false, true).unwrap();

        let text = repo.read("a.txt");
        assert!(text.starts_with("1\n"), "the hunk went back to the original: {text}");
        assert!(text.contains("10 mexido"), "the other hunk stayed: {text}");
    }

    #[test]
    fn a_patch_that_does_not_match_the_file_fails_saying_so() {
        let Some(repo) = Repo::new("hunk-erro") else {
            return;
        };
        repo.write("a.txt", "1\n2\n3\n");
        if !repo.commit("inicial") {
            return;
        }
        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-nada a ver\n+outra coisa\n 2\n 3\n";
        let err = apply_patch(&repo.root, patch, true, false).unwrap_err();
        assert!(!err.is_empty());
        assert!(!err.contains("sem dizer por quê"), "{err}");
    }

    // -- conflicts, merge and the mid-gesture states ------------------------

    /// The whole conflict path in one test, because it is one flow: a merge
    /// that collides leaves the repo `merging`, the file `conflicted`, and the
    /// panel's two buttons ("ficar com o meu"/"com o deles") have to end with
    /// the choice *prepared* — resolving without staging leaves the merge
    /// half-done in a way nothing on screen explains.
    #[test]
    fn a_merge_conflict_shows_up_named_and_resolves_by_the_chosen_side() {
        let Some(repo) = Repo::new("conflito") else {
            return;
        };
        repo.write("a.txt", "base\n");
        if !repo.commit("inicial") {
            return;
        }
        if !repo.git(&["checkout", "-q", "-b", "outra"]) {
            return;
        }
        repo.write("a.txt", "deles\n");
        if !repo.commit("do outro lado") {
            return;
        }
        if !repo.git(&["checkout", "-q", "main"]) {
            return;
        }
        repo.write("a.txt", "meu\n");
        if !repo.commit("do meu lado") {
            return;
        }

        let res = merge(&repo.root, "outra", false).unwrap();
        assert!(res.conflicted, "both sides touched the same line");
        assert_eq!(info(&repo.root).unwrap().state, "merging");
        let sum = crate::git::changes(&repo.root).unwrap();
        let f = sum.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(f.status, "conflicted");
        assert_eq!(f.conflict.as_deref(), Some("UU"));

        resolve_conflict(&repo.root, &["a.txt".into()], "theirs").unwrap();
        assert_eq!(repo.read("a.txt"), "deles\n");
        assert_eq!(
            repo.sides_of("a.txt"),
            ("modified".into(), "none".into()),
            "resolving already leaves it staged"
        );

        // And the merge ends as an ordinary commit.
        commit(&repo.root, "merge resolvido", CommitOpts::default()).unwrap();
        assert_eq!(info(&repo.root).unwrap().state, "clean");
    }

    #[test]
    fn aborting_the_merge_returns_the_tree_to_what_it_was() {
        let Some(repo) = Repo::new("abort") else {
            return;
        };
        repo.write("a.txt", "base\n");
        if !repo.commit("inicial") {
            return;
        }
        if !repo.git(&["checkout", "-q", "-b", "outra"]) {
            return;
        }
        repo.write("a.txt", "deles\n");
        if !repo.commit("do outro lado") {
            return;
        }
        if !repo.git(&["checkout", "-q", "main"]) {
            return;
        }
        repo.write("a.txt", "meu\n");
        if !repo.commit("do meu lado") {
            return;
        }
        merge(&repo.root, "outra", false).unwrap();

        abort_state(&repo.root).unwrap();
        assert_eq!(info(&repo.root).unwrap().state, "clean");
        assert_eq!(repo.read("a.txt"), "meu\n");
    }

    /// A merge with nothing in the way is not a conflict and must not be
    /// reported as one — the panel shows a very different face for each.
    #[test]
    fn a_merge_that_goes_in_clean_does_not_call_itself_conflicted() {
        let Some(repo) = Repo::new("merge-limpo") else {
            return;
        };
        repo.write("a.txt", "base\n");
        if !repo.commit("inicial") {
            return;
        }
        if !repo.git(&["checkout", "-q", "-b", "outra"]) {
            return;
        }
        repo.write("b.txt", "novo do outro lado\n");
        if !repo.commit("outro arquivo") {
            return;
        }
        if !repo.git(&["checkout", "-q", "main"]) {
            return;
        }
        let res = merge(&repo.root, "outra", false).unwrap();
        assert!(!res.conflicted);
        assert!(repo.root.join("b.txt").exists());
        assert_eq!(info(&repo.root).unwrap().state, "clean");
    }

    // -- the remote ---------------------------------------------------------

    /// A real remote, because everything that matters about push and pull is
    /// what the *other* side ends up holding. A bare repo in the temp folder
    /// is a remote in every way that counts.
    #[test]
    fn publishing_the_branch_creates_the_upstream_and_pull_brings_what_the_other_side_wrote() {
        let Some(origin) = Repo::new("remoto-bare") else {
            return;
        };
        if !origin.git(&["init", "--bare", "--quiet", "bare.git"]) {
            return;
        }
        let bare = origin.root.join("bare.git");
        // A bare repo born with `HEAD -> master` and only a `main` branch
        // pushed into it clones with **no** branch checked out — and the
        // second clone below would then commit onto an unborn `master`.
        let _ = crate::git::run_git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let bare_url = bare.to_string_lossy().replace('\\', "/");

        let Some(a) = Repo::new("remoto-a") else { return };
        a.write("a.txt", "um\n");
        if !a.commit("inicial") {
            return;
        }
        if !a.git(&["remote", "add", "origin", &bare_url]) {
            return;
        }

        push(&a.root, "origin", Some("main"), true, false).unwrap();
        let dep = info(&a.root).unwrap();
        assert_eq!(dep.upstream.as_deref(), Some("origin/main"));
        assert_eq!(dep.ahead, 0);
        assert_eq!(dep.remotes.len(), 1);
        assert_eq!(dep.remotes[0].name, "origin");

        // Another clone writes on top.
        let Some(b) = Repo::new("remoto-b") else { return };
        let _ = std::fs::remove_dir_all(&b.root);
        if !crate::git::run_git(
            std::env::temp_dir().as_path(),
            &["clone", "--quiet", &bare_url, &b.root.to_string_lossy()],
        )
        .map(|o| o.status.success())
        .unwrap_or(false)
        {
            return;
        }
        let _ = b.git(&["config", "user.email", "t@yard.test"]);
        let _ = b.git(&["config", "user.name", "Yard Test"]);
        let _ = b.git(&["config", "commit.gpgsign", "false"]);
        b.write("b.txt", "do outro clone\n");
        if !b.commit("vindo de fora") {
            return;
        }
        push(&b.root, "origin", Some("main"), false, false).unwrap();

        // The first clone does not know yet; fetch counts, pull brings.
        fetch(&a.root, None, false).unwrap();
        let after_fetch = info(&a.root).unwrap();
        assert_eq!(after_fetch.behind, 1, "fetch updates the count without touching the disk");
        assert!(!a.root.join("b.txt").exists());

        pull(&a.root, false).unwrap();
        assert!(a.root.join("b.txt").exists());
        assert_eq!(info(&a.root).unwrap().behind, 0);
    }

    #[test]
    fn remote_v_becomes_one_record_per_remote() {
        let text = "origin\thttps://x.dev/r.git (fetch)\norigin\thttps://x.dev/r.git (push)\nupstream\tgit@y.dev:z.git (fetch)\nupstream\tgit@y.dev:z.git (push)\n";
        let got = parse_remotes(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "origin");
        assert_eq!(got[0].url, "https://x.dev/r.git");
        assert_eq!(got[1].name, "upstream");
    }

    #[test]
    fn a_remote_name_that_looks_like_an_option_is_refused() {
        let root = std::path::Path::new("C:/proj");
        assert!(push(root, "--exec=calc", None, false, false).is_err());
        assert!(fetch(root, Some("-x"), false).is_err());
    }

    // -- tags ---------------------------------------------------------------

    #[test]
    fn a_created_tag_appears_in_the_list_and_vanishes_when_deleted() {
        let Some(repo) = Repo::new("tag") else { return };
        repo.write("a.txt", "um\n");
        if !repo.commit("inicial") {
            return;
        }
        tag_create(&repo.root, "v1.0.0", Some("primeira versão"), None).unwrap();
        let list = tags(&repo.root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "v1.0.0");
        assert_eq!(list[0].subject, "primeira versão");

        tag_delete(&repo.root, "v1.0.0").unwrap();
        assert!(tags(&repo.root).unwrap().is_empty());
    }

    #[test]
    fn a_tag_name_that_looks_like_an_option_is_refused() {
        let root = std::path::Path::new("C:/proj");
        assert!(tag_create(root, "-d", None, None).is_err());
        assert!(tag_delete(root, "--all").is_err());
    }

    // -- starting from nothing ----------------------------------------------

    /// The folder the user just opened has no `.git`. The panel's only honest
    /// offer there is to create one, and it has to end with a repository the
    /// rest of the tab can talk to.
    #[test]
    fn initializing_a_repository_in_a_loose_folder_leaves_it_ready() {
        let dir = std::env::temp_dir().join(format!(
            "yard-scm-init-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!info(&dir).unwrap().is_repo);

        if init_repo(&dir).is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let got = info(&dir).unwrap();
        assert!(got.is_repo);
        assert!(!got.has_head, "just born: there is no commit");
        assert!(got.branch.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- side-aware diffs ---------------------------------------------------

    /// The two groups are two different comparisons, and showing the same diff
    /// under both is what makes hunk staging wrong: "Preparado" is `HEAD` vs
    /// the index, "Alterações" is the index vs the disk. A file changed in two
    /// places with only one of them prepared shows one hunk in each — and a
    /// patch built from the wrong side simply will not apply.
    #[test]
    fn each_side_shows_its_own_comparison_and_not_the_other_one() {
        let Some(repo) = Repo::new("diff-lado") else {
            return;
        };
        repo.write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("a.txt", "1 mexido\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
        stage(&repo.root, &["a.txt".into()]).unwrap();
        repo.write("a.txt", "1 mexido\n2\n3\n4\n5\n6\n7\n8\n9\n10 mexido\n");

        let staged = diff(&repo.root, "a.txt", "index", None, None).unwrap();
        assert!(staged.text.contains("+1 mexido"), "{}", staged.text);
        assert!(!staged.text.contains("+10 mexido"), "{}", staged.text);

        let on_disk = diff(&repo.root, "a.txt", "worktree", None, None).unwrap();
        assert!(on_disk.text.contains("+10 mexido"), "{}", on_disk.text);
        assert!(!on_disk.text.contains("+1 mexido"), "{}", on_disk.text);

        // And the third side, what the whole commit would change, has both.
        let against_head = diff(&repo.root, "a.txt", "head", None, None).unwrap();
        assert!(against_head.text.contains("+1 mexido"));
        assert!(against_head.text.contains("+10 mexido"));
    }

    /// An untracked file has no left side anywhere: the diff is the file. The
    /// panel needs it as a diff all the same, or the row that matters most in
    /// a young repository is the one that cannot be opened.
    #[test]
    fn a_new_file_becomes_a_diff_of_everything_added() {
        let Some(repo) = Repo::new("diff-novo") else {
            return;
        };
        repo.write("base.txt", "x\n");
        if !repo.commit("inicial") {
            return;
        }
        repo.write("novo.txt", "linha um\nlinha dois\n");
        let d = diff(&repo.root, "novo.txt", "worktree", None, None).unwrap();
        assert!(d.text.contains("+linha um"), "{}", d.text);
        assert!(d.text.contains("+linha dois"), "{}", d.text);
        assert!(!d.is_binary);
    }

    #[test]
    fn an_unknown_side_and_a_path_outside_the_root_are_refused() {
        let root = std::path::Path::new("C:/proj");
        assert!(diff(root, "a.txt", "inventado", None, None).is_err());
        assert!(diff(root, "../fora.txt", "worktree", None, None).is_err());
    }
}
