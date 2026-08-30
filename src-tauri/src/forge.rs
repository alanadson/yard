//! The other half of a front: the pull request.
//!
//! A front is a `git worktree` with a branch of its own, and Yard already
//! knows how to make one, run an agent in it and **land** it (merge onto the
//! ground, `scm.rs` + `lib/floorLand.ts`). What it never knew is that most
//! branches do not get merged locally: they become a pull request, collect
//! review comments and a set of checks, and come back as work. That round
//! trip happened entirely outside the app, which is why the diff annotations
//! (`lib/review.ts`) — the one thing here that already knows how to hand
//! comments to an agent — never saw a single comment from an actual reviewer.
//!
//! Everything goes through the **`gh` CLI**, deliberately:
//!
//! - no token is stored, asked for, or read by Yard. `gh` already holds the
//!   user's credentials, in the same way the `git` subprocess already holds
//!   theirs. An app that keeps agents' output on disk has no business also
//!   keeping a GitHub token;
//! - `gh` speaks GitHub Enterprise, SSH remotes and `hub`-style aliases
//!   without this module knowing any of it;
//! - and when `gh` is not installed, the answer is a clean "not available",
//!   never a broken panel.
//!
//! The two things that get tested here are the two that fail silently: the
//! **arguments** (a title starting with `-` becoming a flag) and the **JSON**
//! (a field that stopped existing quietly turning into a zero).

use std::path::Path;
use std::process::Output;

use serde::{Deserialize, Serialize};

/// What `gh pr view --json` is asked for. Kept in one place because the parse
/// below and the request have to agree.
const PR_FIELDS: &str =
    "number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `OPEN`, `MERGED`, `CLOSED` — as GitHub spells it.
    pub state: String,
    pub draft: bool,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or empty.
    pub review_decision: String,
    pub checks: Checks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Checks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
    /// Path relative to the repository root, git style.
    pub path: String,
    /// The line the comment hangs on. 0 when GitHub gave none (an outdated
    /// comment on a diff that moved).
    pub line: u32,
    pub body: String,
    pub author: String,
    pub url: String,
}

// ---------------------------------------------------------------------------
// argument building — pure, and the half that fails silently
// ---------------------------------------------------------------------------

/// Arguments for `gh pr create`.
///
/// Every user-typed value goes in as the *value* of a flag, never bare: a
/// title of `--repo evil/x` reaching the command line as a positional is the
/// same class of bug `scm.rs` guards against with `--`.
pub fn pr_create_args<'a>(
    branch: &'a str,
    title: &'a str,
    body: &'a str,
    base: Option<&'a str>,
    draft: bool,
) -> Vec<String> {
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--head".to_string(),
        branch.to_string(),
        "--title".to_string(),
        title.to_string(),
        "--body".to_string(),
        body.to_string(),
    ];
    if let Some(base) = base {
        if !base.is_empty() {
            args.push("--base".to_string());
            args.push(base.to_string());
        }
    }
    if draft {
        args.push("--draft".to_string());
    }
    args
}

pub fn pr_view_args(branch: &str) -> Vec<String> {
    vec![
        "pr".into(),
        "view".into(),
        branch.into(),
        "--json".into(),
        PR_FIELDS.into(),
    ]
}

/// `gh api` for the review comments of a PR. The REST endpoint is used rather
/// than `gh pr view --comments` because only this one carries `path` and
/// `line`, which is the whole point: a comment without a file is not something
/// the diff annotations can show.
pub fn pr_comments_args(number: u64) -> Vec<String> {
    vec![
        "api".into(),
        format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments"),
        "--paginate".into(),
    ]
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawCheck {
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    /// A required status context (as opposed to a check run) has this instead.
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct RawPr {
    #[serde(default)]
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
    #[serde(default, rename = "isDraft")]
    is_draft: bool,
    #[serde(default, rename = "reviewDecision")]
    review_decision: String,
    #[serde(default, rename = "statusCheckRollup")]
    checks: Vec<RawCheck>,
}

/// Folds the rollup into three numbers. GitHub mixes two shapes in that array
/// (check runs, with `status`/`conclusion`, and legacy statuses, with
/// `state`), and a rollup entry with neither is counted as pending rather than
/// silently dropped — an unknown check is not a passing one.
pub fn parse_pr(json: &str) -> Result<PullRequest, String> {
    let raw: RawPr =
        serde_json::from_str(json).map_err(|e| format!("resposta do gh ilegível: {e}"))?;
    let mut checks = Checks::default();
    for check in &raw.checks {
        let verdict = if !check.conclusion.is_empty() {
            check.conclusion.to_ascii_uppercase()
        } else if !check.state.is_empty() {
            check.state.to_ascii_uppercase()
        } else if check.status.eq_ignore_ascii_case("COMPLETED") {
            // Completed with no conclusion: nothing to celebrate.
            "UNKNOWN".to_string()
        } else {
            "PENDING".to_string()
        };
        match verdict.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => checks.passed += 1,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "ERROR" => {
                checks.failed += 1
            }
            _ => checks.pending += 1,
        }
    }
    Ok(PullRequest {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state: raw.state,
        draft: raw.is_draft,
        review_decision: raw.review_decision,
        checks,
    })
}

#[derive(Deserialize)]
struct RawUser {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct RawComment {
    #[serde(default)]
    path: String,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    original_line: Option<u32>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    user: Option<RawUser>,
}

/// Review comments, in the order GitHub returned them.
///
/// `line` is null on a comment whose diff has moved since; GitHub keeps
/// `original_line` for exactly that case, and a comment pinned to the line it
/// was written about is worth more than no comment at all.
pub fn parse_comments(json: &str) -> Result<Vec<ReviewNote>, String> {
    let raw: Vec<RawComment> =
        serde_json::from_str(json).map_err(|e| format!("resposta do gh ilegível: {e}"))?;
    Ok(raw
        .into_iter()
        .filter(|c| !c.path.is_empty() && !c.body.trim().is_empty())
        .map(|c| ReviewNote {
            path: c.path,
            line: c.line.or(c.original_line).unwrap_or(0),
            body: c.body,
            author: c.user.map(|u| u.login).unwrap_or_default(),
            url: c.html_url,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// running gh
// ---------------------------------------------------------------------------

fn run_gh(cwd: &Path, args: &[String]) -> Result<Output, String> {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(args)
        .current_dir(cwd)
        // `gh` paints its own progress and colours when it thinks it has a
        // terminal. It does not have one here.
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output().map_err(|e| format!("falha ao rodar gh: {e}"))
}

fn text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn failure(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("gh terminou com {}", out.status)
    } else {
        stderr
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStatus {
    /// Empty when `gh` is not on the machine.
    pub version: String,
    /// Whether `gh auth status` is happy for this repository's host.
    pub authenticated: bool,
}

/// Is there a `gh`, and is it logged in? Both answers are needed before the
/// panel can offer anything, and neither is worth an error: a machine without
/// `gh` is a normal machine.
pub fn status(cwd: &Path) -> ForgeStatus {
    let Ok(out) = run_gh(cwd, &["--version".to_string()]) else {
        return ForgeStatus {
            version: String::new(),
            authenticated: false,
        };
    };
    if !out.status.success() {
        return ForgeStatus {
            version: String::new(),
            authenticated: false,
        };
    }
    let version = text(&out).lines().next().unwrap_or_default().to_string();
    let authenticated = run_gh(cwd, &["auth".to_string(), "status".to_string()])
        .map(|o| o.status.success())
        .unwrap_or(false);
    ForgeStatus {
        version,
        authenticated,
    }
}

/// The PR of `branch`, or `None` when there is not one. "No pull request" is
/// the common case and is not an error.
pub fn pr_for(cwd: &Path, branch: &str) -> Result<Option<PullRequest>, String> {
    let out = run_gh(cwd, &pr_view_args(branch))?;
    if !out.status.success() {
        let why = failure(&out);
        // `gh` says this when the branch has no PR — every other failure is
        // real and worth showing.
        if why.contains("no pull requests found") || why.contains("no open pull requests") {
            return Ok(None);
        }
        return Err(why);
    }
    parse_pr(&text(&out)).map(Some)
}

pub fn pr_create(
    cwd: &Path,
    branch: &str,
    title: &str,
    body: &str,
    base: Option<&str>,
    draft: bool,
) -> Result<String, String> {
    let out = run_gh(cwd, &pr_create_args(branch, title, body, base, draft))?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    // `gh pr create` prints the URL, and that is the whole answer.
    Ok(text(&out)
        .lines()
        .last()
        .unwrap_or_default()
        .trim()
        .to_string())
}

pub fn pr_comments(cwd: &Path, number: u64) -> Result<Vec<ReviewNote>, String> {
    let out = run_gh(cwd, &pr_comments_args(number))?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    parse_comments(&text(&out))
}

/// Why these rules matter: everything here is a subprocess whose output shape
/// belongs to somebody else. The failures that hurt are not crashes — they are
/// a rollup silently counted as green, a title that became a flag, and a
/// review comment dropped because GitHub moved its line.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_that_looks_like_a_flag_goes_in_as_a_value() {
        let args = pr_create_args("minha-frente", "--repo evil/x", "corpo", None, false);
        let at = args.iter().position(|a| a == "--repo evil/x").unwrap();
        assert_eq!(args[at - 1], "--title");
    }

    #[test]
    fn the_base_is_left_out_when_there_is_none() {
        let args = pr_create_args("f", "t", "b", None, false);
        assert!(!args.contains(&"--base".to_string()));
        let with = pr_create_args("f", "t", "b", Some("main"), false);
        assert!(with.contains(&"--base".to_string()));
        assert!(with.contains(&"main".to_string()));
        // An empty base is "not given", not a branch called "".
        let empty = pr_create_args("f", "t", "b", Some(""), false);
        assert!(!empty.contains(&"--base".to_string()));
    }

    #[test]
    fn draft_is_a_flag_only_when_asked_for() {
        assert!(!pr_create_args("f", "t", "b", None, false).contains(&"--draft".to_string()));
        assert!(pr_create_args("f", "t", "b", None, true).contains(&"--draft".to_string()));
    }

    #[test]
    fn the_pr_view_asks_for_the_fields_the_parse_reads() {
        let args = pr_view_args("minha-frente");
        assert!(args.contains(&"--json".to_string()));
        for field in ["number", "url", "statusCheckRollup", "reviewDecision"] {
            assert!(PR_FIELDS.contains(field), "{field} is parsed but not asked for");
        }
        assert_eq!(args[2], "minha-frente");
    }

    #[test]
    fn a_pull_request_comes_back_whole() {
        let pr = parse_pr(
            r#"{"number":42,"title":"Uma frente","url":"https://github.com/a/b/pull/42",
                "state":"OPEN","isDraft":false,"reviewDecision":"APPROVED",
                "statusCheckRollup":[]}"#,
        )
        .unwrap();
        assert_eq!(pr.number, 42);
        assert_eq!(pr.state, "OPEN");
        assert_eq!(pr.review_decision, "APPROVED");
        assert!(!pr.draft);
    }

    /// The regression this locks down: the rollup mixes check runs with legacy
    /// statuses, and reading only `conclusion` counted every legacy status as
    /// pending — a red build showing as "esperando".
    #[test]
    fn the_rollup_counts_both_shapes_of_check() {
        let pr = parse_pr(
            r#"{"statusCheckRollup":[
                {"status":"COMPLETED","conclusion":"SUCCESS"},
                {"status":"COMPLETED","conclusion":"FAILURE"},
                {"status":"IN_PROGRESS","conclusion":""},
                {"state":"SUCCESS"},
                {"state":"FAILURE"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(pr.checks.passed, 2);
        assert_eq!(pr.checks.failed, 2);
        assert_eq!(pr.checks.pending, 1);
    }

    #[test]
    fn a_check_nobody_understands_is_pending_never_green() {
        let pr = parse_pr(r#"{"statusCheckRollup":[{"status":"COMPLETED"}]}"#).unwrap();
        assert_eq!(pr.checks.passed, 0);
        assert_eq!(pr.checks.pending, 1);
    }

    #[test]
    fn a_field_that_is_not_there_does_not_break_the_panel() {
        let pr = parse_pr(r#"{"number":7}"#).unwrap();
        assert_eq!(pr.number, 7);
        assert_eq!(pr.checks, Checks::default());
        assert!(pr.review_decision.is_empty());
    }

    #[test]
    fn junk_is_an_error_not_a_zeroed_pull_request() {
        assert!(parse_pr("nao e json").is_err());
    }

    #[test]
    fn a_review_comment_keeps_its_file_line_and_author() {
        let notes = parse_comments(
            r#"[{"path":"src/a.ts","line":12,"body":"isso quebra","html_url":"u",
                "user":{"login":"alguem"}}]"#,
        )
        .unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "src/a.ts");
        assert_eq!(notes[0].line, 12);
        assert_eq!(notes[0].author, "alguem");
    }

    /// A comment whose diff has moved comes back with `line: null`. Dropping
    /// it loses a reviewer's actual words; GitHub keeps the line it was
    /// written about, and that is where it goes.
    #[test]
    fn an_outdated_comment_falls_back_to_the_line_it_was_written_on() {
        let notes = parse_comments(
            r#"[{"path":"src/a.ts","line":null,"original_line":40,"body":"aqui"}]"#,
        )
        .unwrap();
        assert_eq!(notes[0].line, 40);
    }

    #[test]
    fn a_comment_with_no_file_is_not_an_annotation() {
        let notes =
            parse_comments(r#"[{"path":"","body":"comentário geral do PR"}]"#).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn an_empty_comment_is_dropped_instead_of_pinning_a_blank_row() {
        let notes = parse_comments(r#"[{"path":"a.ts","body":"   "}]"#).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn the_comments_endpoint_names_the_pull_request() {
        let args = pr_comments_args(42);
        assert!(args[1].ends_with("/pulls/42/comments"));
        assert!(args.contains(&"--paginate".to_string()));
    }
}
