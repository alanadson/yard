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

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Old path when renamed.
    pub orig_path: Option<String>,
    /// `modified` | `added` | `deleted` | `renamed` | `untracked` | `conflicted`
    pub status: String,
    pub staged: bool,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub is_binary: bool,
    pub truncated: bool,
    pub text: String,
}

/// Cap on the diff text returned to the UI.
const MAX_DIFF_BYTES: usize = 1024 * 1024;
/// Cap on the read when synthesizing a new-file diff.
const MAX_NEW_FILE_BYTES: usize = 512 * 1024;
/// How many new files get their lines counted in the summary.
const MAX_UNTRACKED_COUNTED: usize = 500;

fn run_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
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
    let probe = run_git(cwd, &["rev-parse", "--is-inside-work-tree"]);
    let is_repo = matches!(
        &probe,
        Ok(o) if o.status.success()
            && String::from_utf8_lossy(&o.stdout).trim() == "true"
    );
    if !is_repo {
        return Ok(ChangesSummary::default());
    }

    let out = run_git(cwd, &["status", "--porcelain=v2", "--branch", "-z", "-uall"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let (branch, mut files) = parse_status_v2(&out.stdout);

    // Changed lines per tracked file (staged + worktree in one go).
    if has_head(cwd) {
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
    // (without this a new file shows up as +0).
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
    })
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
    if untracked || !has_head(cwd) {
        return synth_new_file_diff(cwd, path);
    }

    let ctx_arg = context.map(|n| format!("-U{n}"));
    let mut args = vec!["diff", "--no-color", "-M"];
    if let Some(c) = ctx_arg.as_deref() {
        args.push(c);
    }
    args.extend(["HEAD", "--", path]);
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
        text,
    })
}

fn synth_new_file_diff(cwd: &Path, path: &str) -> Result<FileDiff, String> {
    let full = cwd.join(path);
    let file = std::fs::File::open(&full)
        .map_err(|e| format!("nao consegui ler {path}: {e}"))?;

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
            text: String::new(),
        });
    }

    let content = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = content.lines().collect();
    let mut text = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in &lines {
        text.push('+');
        text.push_str(line);
        text.push('\n');
    }

    Ok(FileDiff {
        path: path.to_string(),
        is_binary: false,
        truncated,
        text,
    })
}

/// Counts lines of a small file; `None` = could not read.
/// The returned bool indicates binary (found NUL at the start).
fn count_lines(full: &Path) -> Option<(u32, bool)> {
    let meta = std::fs::metadata(full).ok()?;
    if meta.len() > MAX_NEW_FILE_BYTES as u64 {
        return None;
    }
    let bytes = std::fs::read(full).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Some((0, true));
    }
    let mut lines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    if bytes.last().is_some_and(|b| *b != b'\n') {
        lines += 1;
    }
    Some((lines, false))
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
    if slug.is_empty() { "andar".into() } else { slug }
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
    let atual = std::fs::read_to_string(&path).unwrap_or_default();
    let ja_tem = atual
        .lines()
        .map(str::trim)
        .any(|l| l == ".yard/" || l == ".yard" || l == "/.yard/" || l == "/.yard");
    if ja_tem {
        return Ok(());
    }
    let mut novo = atual;
    if !novo.is_empty() && !novo.ends_with('\n') {
        novo.push('\n');
    }
    novo.push_str(".yard/\n");
    std::fs::write(&path, novo)
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
            "o repositorio ainda nao tem nenhum commit — faca o primeiro commit antes de criar um andar"
                .into(),
        );
    }

    let slug = floor_slug(name);
    let abs = project_path.join(".yard").join("floors").join(&slug);
    if abs.exists() {
        return Err(format!("ja existe um andar em {}", abs.display()));
    }
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

/// Removes the worktree (no `--force`: dirty fails, on purpose) and,
/// optionally, the branch that went with it.
pub fn worktree_remove(
    project_path: &Path,
    worktree_path: &Path,
    delete_branch: Option<&str>,
) -> Result<(), String> {
    let alvo = worktree_path.to_string_lossy();
    let out = run_git(project_path, &["worktree", "remove", &alvo])?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    if let Some(branch) = delete_branch {
        let out = run_git(project_path, &["branch", "-D", branch])?;
        if !out.status.success() {
            return Err(format!("worktree removido, mas a branch ficou: {}", git_err(&out)));
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
    let mut texto = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !texto.is_empty() {
            texto.push('\n');
        }
        texto.push_str(err.trim_end());
    }
    if texto.len() > MAX_HOOK_OUTPUT {
        let mut cut = MAX_HOOK_OUTPUT;
        while !texto.is_char_boundary(cut) {
            cut -= 1;
        }
        texto.truncate(cut);
        texto.push_str("\n…(cortado)");
    }
    Ok(HookResult {
        code: out.status.code().unwrap_or(-1),
        output: texto,
    })
}

/// `git worktree list --porcelain`: blocks separated by a blank line;
/// each block has `worktree <path>` and, when present, `branch refs/heads/<b>`,
/// `bare` or `detached`.
fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut out = Vec::new();
    let mut atual: Option<WorktreeEntry> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(e) = atual.take() {
                out.push(e);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(e) = atual.take() {
                out.push(e);
            }
            atual = Some(WorktreeEntry {
                path: path.to_string(),
                branch: None,
                bare: false,
            });
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(e) = atual.as_mut() {
                e.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        } else if line == "bare" {
            if let Some(e) = atual.as_mut() {
                e.bare = true;
            }
        }
    }
    if let Some(e) = atual.take() {
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
                ..Default::default()
            });
            continue;
        }

        if s.starts_with("1 ") {
            let parts: Vec<&str> = s.splitn(9, ' ').collect();
            if parts.len() == 9 {
                let (status, staged) = classify(parts[1].as_bytes());
                files.push(ChangedFile {
                    path: parts[8].to_string(),
                    status: status.into(),
                    staged,
                    ..Default::default()
                });
            }
            continue;
        }

        if s.starts_with("2 ") {
            let parts: Vec<&str> = s.splitn(10, ' ').collect();
            // The next record is the origin path — always consume it,
            // even if the current record is malformed, so we do not desync.
            let orig = it
                .next()
                .map(|t| String::from_utf8_lossy(t).into_owned());
            if parts.len() == 10 {
                let (_, staged) = classify(parts[1].as_bytes());
                files.push(ChangedFile {
                    path: parts[9].to_string(),
                    orig_path: orig,
                    status: "renamed".into(),
                    staged,
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

/// `git diff --numstat -z`: `ADD\tDEL\tPATH` NUL; on rename the path comes
/// empty and the next two records are origin and destination. `-` = binary.
fn parse_numstat(bytes: &[u8]) -> HashMap<String, (Option<u32>, Option<u32>)> {
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

    fn z(parts: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in parts {
            out.extend_from_slice(p.as_bytes());
            out.push(0);
        }
        out
    }

    #[test]
    fn status_v2_basico() {
        let bytes = z(&[
            "# branch.oid abc123",
            "# branch.head main",
            "1 .M N... 100644 100644 100644 abc def src/App.tsx",
            "1 A. N... 000000 100644 100644 000 abc novo staged.ts",
            "1 D. N... 100644 000000 000000 abc 000 apagado.rs",
            "? nao rastreado.md",
        ]);
        let (branch, files) = parse_status_v2(&bytes);
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

    #[test]
    fn status_v2_rename_consome_origem() {
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
    fn floor_slug_vira_pasta_e_branch_validas() {
        assert_eq!(floor_slug("fix-login"), "fix-login");
        assert_eq!(floor_slug("Correção de Login"), "correcao-de-login");
        assert_eq!(floor_slug("  auth / refresh  "), "auth-refresh");
        // Nothing usable: falls back to the generic name, never an empty folder.
        assert_eq!(floor_slug("???"), "andar");
        assert_eq!(floor_slug(""), "andar");
    }

    #[test]
    fn gitignore_ganha_yard_uma_vez_so() {
        let dir = std::env::temp_dir().join(format!("yard-ign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No .gitignore: creates it with the line.
        ensure_yard_ignored(&dir).unwrap();
        let um = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(um.matches(".yard/").count(), 1);

        // Already there: no duplicate.
        ensure_yard_ignored(&dir).unwrap();
        let dois = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(um, dois);

        // File without a trailing newline: the new line must not stick to the last one.
        std::fs::write(dir.join(".gitignore"), "node_modules").unwrap();
        ensure_yard_ignored(&dir).unwrap();
        let tres = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(tres.lines().any(|l| l == "node_modules"));
        assert!(tres.lines().any(|l| l == ".yard/"));

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

    #[test]
    fn numstat_normal_binario_e_rename() {
        let mut bytes = z(&["10\t2\tsrc/a.ts", "-\t-\timg.png"]);
        // rename: empty path + origin + destination
        bytes.extend_from_slice(b"3\t1\t\0old.ts\0new.ts\0");
        let map = parse_numstat(&bytes);
        assert_eq!(map.get("src/a.ts"), Some(&(Some(10), Some(2))));
        assert_eq!(map.get("img.png"), Some(&(None, None)));
        assert_eq!(map.get("new.ts"), Some(&(Some(3), Some(1))));
    }
}
