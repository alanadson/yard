//! Support bundle — the `.zip` a user attaches to an issue.
//!
//! The log in `%APPDATA%\Yard\logs` only ever helped the author: a user
//! with a problem is not going to dig it out, and the one who does sends
//! either the wrong day or the whole folder. The bundle picks the last two
//! days of logs and adds two small JSONs (what build, what OS, which CLIs
//! are installed) — and **nothing else**. No database, no scrollback, no
//! `kv`, no notes, no session files, nothing from the user's projects: the
//! file exists to be posted on a public tracker, and its contents are the
//! whole privacy contract.

use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use chrono::NaiveDate;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::agents::resolver::AgentInfo;
use crate::state::AppState;

/// Prefix the rolling appender gives every log file (`logging.rs`): the
/// date follows it as `yard.log.2026-08-26`.
const LOG_PREFIX: &str = "yard.log.";

/// What the UI shows after the zip is written — and the list it can show
/// the user, which is the point: the contents are the privacy contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSummary {
    pub path: String,
    pub bytes: u64,
    pub entries: Vec<String>,
    /// The build the bundle describes, for the issue's first line.
    pub version: String,
}

/// `about.json`: which build, which machine. No user name, no project path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct About {
    version: String,
    os: String,
    data_dir: String,
    /// Whether this instance runs on a redirected data dir (`YARD_DATA_DIR`),
    /// which also turns the single-instance lock off — worth knowing when
    /// the report is about two windows.
    custom_data_dir: bool,
}

/// Writes the bundle for the app's data directory. Blocking: the agent
/// detection may run `--version` on every CLI, so the command wraps it in
/// `spawn_blocking`.
#[tauri::command]
pub async fn support_bundle(app: AppHandle, dest: String) -> Result<SupportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // The cache `detect_agents` fills is the same list the "Nova aba"
        // grid shows; a cold cache means paying for the detection once.
        let state = app.state::<Arc<AppState>>();
        let cached = state.agents_cache.lock().clone();
        let agents = cached.unwrap_or_else(crate::agents::resolver::detect_all);
        let today = chrono::Local::now().date_naive();
        bundle_in(&crate::paths::app_dir(), Path::new(&dest), today, &agents)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("pacote de suporte interrompido: {e}"))?
}

/// The `_in` twin (see `persistence/backup.rs`): tests drive their own
/// directory instead of fighting over the process-global `YARD_DATA_DIR`.
pub fn bundle_in(
    app_dir: &Path,
    dest: &Path,
    today: NaiveDate,
    agents: &[AgentInfo],
) -> anyhow::Result<SupportSummary> {
    let logs_dir = app_dir.join("logs");
    let listing: Vec<String> = match std::fs::read_dir(&logs_dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .collect(),
        // A fresh install has no `logs` yet; the bundle still says what
        // build and which CLIs.
        Err(_) => Vec::new(),
    };
    let names: Vec<&str> = listing.iter().map(String::as_str).collect();
    let logs = recent_logs(&names, today);

    let file = File::create(dest)
        .map_err(|e| anyhow::anyhow!("nao consegui criar {}: {e}", dest.display()))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut entries = Vec::new();

    let about = About {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: sysinfo::System::long_os_version().unwrap_or_else(|| "desconhecido".into()),
        data_dir: app_dir.to_string_lossy().into_owned(),
        custom_data_dir: std::env::var_os("YARD_DATA_DIR").is_some(),
    };
    zip.start_file("about.json", opts)?;
    std::io::Write::write_all(&mut zip, serde_json::to_string_pretty(&about)?.as_bytes())?;
    entries.push("about.json".to_string());

    zip.start_file("agents.json", opts)?;
    std::io::Write::write_all(&mut zip, serde_json::to_string_pretty(agents)?.as_bytes())?;
    entries.push("agents.json".to_string());

    // Streamed like the backup does: a chatty day of `debug` can be tens of
    // megabytes, and nothing here needs it in memory.
    for name in logs {
        let path = logs_dir.join(&name);
        let mut src = match File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let entry = format!("logs/{name}");
        zip.start_file(&entry, opts)?;
        std::io::copy(&mut src, &mut zip)?;
        entries.push(entry);
    }

    zip.finish()?;
    let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    tracing::info!(dest = %dest.display(), entries = entries.len(), "pacote de suporte gerado");
    Ok(SupportSummary {
        path: dest.to_string_lossy().into_owned(),
        bytes,
        entries,
        version: about.version,
    })
}

/// Picks today's and yesterday's log file names out of a directory listing,
/// oldest first. Anything that is not `yard.log.<date>` — a stray file, the
/// undated `yard.log` of an older build — is left out.
pub fn recent_logs(names: &[&str], today: NaiveDate) -> Vec<String> {
    let yesterday = today.pred_opt().unwrap_or(today);
    let mut picked: Vec<(NaiveDate, String)> = names
        .iter()
        .filter_map(|name| {
            let stamp = name.strip_prefix(LOG_PREFIX)?;
            let date = NaiveDate::parse_from_str(stamp, "%Y-%m-%d").ok()?;
            (date == today || date == yesterday).then(|| (date, (*name).to_string()))
        })
        .collect();
    picked.sort();
    picked.into_iter().map(|(_, name)| name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rolling appender names files `yard.log.<date>`; a folder that has
    /// been around for months holds one per day, and the bundle wants today
    /// and yesterday — the day the problem happened and the one before it,
    /// which is where a crash at 00:05 actually lives.
    #[test]
    fn recent_logs_keeps_today_and_yesterday_and_nothing_else() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 26).unwrap();
        let names = [
            "yard.log.2026-08-24",
            "yard.log.2026-08-26",
            "yard.log.2026-08-25",
            "notes.txt",
            "yard.log.2026-08-27",
            "yard.log",
        ];
        assert_eq!(
            recent_logs(&names, today),
            vec!["yard.log.2026-08-25".to_string(), "yard.log.2026-08-26".to_string()]
        );
    }

    /// A data dir the way a real one looks after a month of use.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-support-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::create_dir_all(dir.join("scrollback")).unwrap();
        std::fs::write(dir.join("app.db"), b"sqlite").unwrap();
        std::fs::write(dir.join("scrollback").join("abc.bin"), b"\x1b[31mterminal\x1b[0m").unwrap();
        std::fs::write(dir.join("logs").join("yard.log.2026-08-20"), b"old\n").unwrap();
        std::fs::write(dir.join("logs").join("yard.log.2026-08-25"), b"yesterday\n").unwrap();
        std::fs::write(dir.join("logs").join("yard.log.2026-08-26"), b"today\n").unwrap();
        dir
    }

    fn entries_of(zip: &std::path::Path) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        names
    }

    /// The privacy contract, as a list: the two recent logs and the two JSONs
    /// — never `app.db`, never a scrollback, never an older log.
    #[test]
    fn bundle_holds_recent_logs_and_the_two_jsons_and_nothing_else() {
        let dir = scratch("contract");
        let dest = dir.join("out.zip");
        let today = NaiveDate::from_ymd_opt(2026, 8, 26).unwrap();
        let summary = bundle_in(&dir, &dest, today, &[]).unwrap();
        assert_eq!(
            entries_of(&dest),
            vec![
                "about.json".to_string(),
                "agents.json".to_string(),
                "logs/yard.log.2026-08-25".to_string(),
                "logs/yard.log.2026-08-26".to_string(),
            ]
        );
        let mut listed = summary.entries.clone();
        listed.sort();
        assert_eq!(listed, entries_of(&dest));
        assert_eq!(summary.path, dest.to_string_lossy());
        assert!(summary.bytes > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `about.json` is what makes the bundle answer "which build, which
    /// machine" without a back-and-forth on the tracker.
    #[test]
    fn about_json_carries_version_and_data_dir() {
        let dir = scratch("about");
        let dest = dir.join("out.zip");
        let today = NaiveDate::from_ymd_opt(2026, 8, 26).unwrap();
        let summary = bundle_in(&dir, &dest, today, &[]).unwrap();
        assert_eq!(summary.version, env!("CARGO_PKG_VERSION"));
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        let mut about = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("about.json").unwrap(), &mut about)
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&about).unwrap();
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(json["dataDir"], dir.to_string_lossy().as_ref());
        assert!(json["os"].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh install has no log yet: the bundle still says what build and
    /// which CLIs, instead of failing on an empty folder.
    #[test]
    fn bundle_without_logs_still_carries_about_and_agents() {
        let dir = std::env::temp_dir().join(format!("yard-support-nolog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.zip");
        let today = NaiveDate::from_ymd_opt(2026, 8, 26).unwrap();
        bundle_in(&dir, &dest, today, &[]).unwrap();
        assert_eq!(entries_of(&dest), vec!["about.json".to_string(), "agents.json".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
