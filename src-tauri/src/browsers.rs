//! Discovery of browsers installed on the machine.
//!
//! Same contract as the agent CLI catalog: every known engine is listed,
//! and `installed` is only true when the binary (or the WebView2 runtime)
//! is actually there. The UI disables the row otherwise — picking Firefox
//! on a machine that never installed it would just fail later.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A browser from the catalog, already resolved against this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub id: String,
    pub name: String,
    /// `webview2` (child of the app) | `chromium` | `firefox`
    pub family: String,
    /// Path of the executable found; `None` for the native WebView2 engine.
    pub bin: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
}

struct BrowserSpec {
    id: &'static str,
    name: &'static str,
    family: &'static str,
    /// Bare names looked up on PATH (`chrome`, `firefox`…).
    path_names: &'static [&'static str],
    /// Absolute-ish relative paths under well-known roots.
    win_rel: &'static [&'static str],
}

const CATALOG: &[BrowserSpec] = &[
    BrowserSpec {
        id: "webview2",
        name: "Nativo (WebView2)",
        family: "webview2",
        path_names: &[],
        win_rel: &[],
    },
    BrowserSpec {
        id: "msedge",
        name: "Microsoft Edge",
        family: "chromium",
        path_names: &["msedge", "msedge.exe"],
        win_rel: &[
            r"Microsoft\Edge\Application\msedge.exe",
            r"Microsoft\Edge Beta\Application\msedge.exe",
        ],
    },
    BrowserSpec {
        id: "chrome",
        name: "Google Chrome",
        family: "chromium",
        path_names: &["chrome", "chrome.exe"],
        win_rel: &[
            r"Google\Chrome\Application\chrome.exe",
            r"Google\Chrome Beta\Application\chrome.exe",
        ],
    },
    BrowserSpec {
        id: "brave",
        name: "Brave",
        family: "chromium",
        path_names: &["brave", "brave.exe"],
        win_rel: &[
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
            r"BraveSoftware\Brave-Browser-Beta\Application\brave.exe",
        ],
    },
    BrowserSpec {
        id: "chromium",
        name: "Chromium",
        family: "chromium",
        path_names: &["chromium", "chromium.exe"],
        win_rel: &[r"Chromium\Application\chrome.exe"],
    },
    BrowserSpec {
        id: "vivaldi",
        name: "Vivaldi",
        family: "chromium",
        path_names: &["vivaldi", "vivaldi.exe"],
        win_rel: &[r"Vivaldi\Application\vivaldi.exe"],
    },
    BrowserSpec {
        id: "opera",
        name: "Opera",
        family: "chromium",
        path_names: &["opera", "opera.exe"],
        win_rel: &[r"Programs\Opera\opera.exe"],
    },
    BrowserSpec {
        id: "firefox",
        name: "Mozilla Firefox",
        family: "firefox",
        path_names: &["firefox", "firefox.exe"],
        win_rel: &[
            r"Mozilla Firefox\firefox.exe",
            r"Firefox Developer Edition\firefox.exe",
        ],
    },
];

/// Walks the catalog. WebView2 is installed whenever Yard itself is running
/// (the app is a WebView2 host); the other rows need a real binary.
pub fn detect_all() -> Vec<BrowserInfo> {
    // Nothing here spawns a process: it is a handful of `stat`s per row, in
    // catalog order.
    CATALOG.iter().map(detect_one).collect()
}

pub fn detect_one_id(id: &str) -> Option<BrowserInfo> {
    CATALOG.iter().find(|s| s.id == id).map(detect_one)
}

fn detect_one(spec: &BrowserSpec) -> BrowserInfo {
    if spec.id == "webview2" {
        return BrowserInfo {
            id: spec.id.into(),
            name: spec.name.into(),
            family: spec.family.into(),
            bin: None,
            version: webview2_version(),
            installed: true,
        };
    }

    let bin = find_browser(spec);
    let version = bin.as_ref().and_then(|p| version_from_disk(p));
    BrowserInfo {
        id: spec.id.into(),
        name: spec.name.into(),
        family: spec.family.into(),
        bin: bin.as_ref().map(|p| p.to_string_lossy().into_owned()),
        version,
        installed: bin.is_some(),
    }
}

fn find_browser(spec: &BrowserSpec) -> Option<PathBuf> {
    for name in spec.path_names {
        if let Ok(p) = which::which(name) {
            return Some(p);
        }
    }
    for root in win_roots() {
        for rel in spec.win_rel {
            let p = root.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Program Files, Program Files (x86) and LocalAppData — the three places
/// Windows browsers actually land. PATH is already covered by `which`.
fn win_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                roots.push(PathBuf::from(v));
            }
        }
    }
    if roots.is_empty() {
        roots.push(PathBuf::from(r"C:\Program Files"));
        roots.push(PathBuf::from(r"C:\Program Files (x86)"));
    }
    roots
}

/// The browser version, read off the install layout — never by running the
/// browser.
///
/// `<browser> --version` looks like the obvious probe and is exactly what must
/// not happen here: on Windows Chrome, Edge and friends ignore the flag, open a
/// real window and keep it up until something kills them. Detection runs at
/// startup and inside the test suite, so that probe meant browser windows
/// flashing open on the user's screen on every build.
///
/// What the disk already says, for free: every Chromium browser keeps a folder
/// named after the version next to the executable, and Firefox ships an
/// `application.ini` with `Version=`. No clue, no version — a cosmetic label in
/// the picker is never worth a process.
fn version_from_disk(bin: &Path) -> Option<String> {
    let dir = bin.parent()?;
    chromium_version_dir(dir).or_else(|| firefox_version_ini(dir))
}

/// `…\Application\151.0.7922.170\` next to `chrome.exe`. An update leaves the
/// previous folder behind for a while, so the newest one wins.
fn chromium_version_dir(dir: &Path) -> Option<String> {
    let mut best: Option<(Vec<u64>, String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(key) = version_key(&name) else {
            continue;
        };
        if best.as_ref().is_none_or(|(seen, _)| key > *seen) {
            best = Some((key, name));
        }
    }
    best.map(|(_, name)| name)
}

/// `151.0.7922.170` -> the numbers, for ordering. Anything else (`SetupMetrics`,
/// `Locales`) is not a version folder.
fn version_key(name: &str) -> Option<Vec<u64>> {
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    parts.iter().map(|p| p.parse::<u64>().ok()).collect()
}

/// Firefox has no version folder; the `[App]` section of `application.ini`
/// carries it. `MinVersion=` in `[Gecko]` does not match — the line has to
/// start with the key.
fn firefox_version_ini(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("application.ini")).ok()?;
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("Version="))
        .map(str::trim)
        .find(|v| !v.is_empty())
        .map(trim_version)
}

fn trim_version(s: &str) -> String {
    // "Google Chrome 124.0.6367.91" / "Mozilla Firefox 125.0" -> keep it short.
    s.split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or(s)
        .chars()
        .take(32)
        .collect()
}

/// Best-effort WebView2 runtime version. Absence does not mean "not
/// installed": Yard would not be on screen without a host.
fn webview2_version() -> Option<String> {
    #[cfg(windows)]
    {
        let pf = std::env::var("PROGRAMFILES(X86)")
            .or_else(|_| std::env::var("PROGRAMFILES"))
            .ok()?;
        let root = PathBuf::from(pf).join(r"Microsoft\EdgeWebView\Application");
        if let Ok(rd) = std::fs::read_dir(&root) {
            for ent in rd.flatten() {
                let name = ent.file_name();
                let s = name.to_string_lossy();
                if s.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                    return Some(s.into_owned());
                }
            }
        }
    }
    None
}

/// Sleep helper used by the portal spawn wait-loop (kept here so detection
/// and launch share the same timeout unit).
#[allow(dead_code)]
pub fn brief_wait() -> Duration {
    Duration::from_millis(80)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp folder of our own: a test never touches a real install.
    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yard-browsers-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The regression that motivated the change: detection used to run
    /// `chrome.exe --version`. On Windows those GUI binaries ignore the flag,
    /// open a real window and only die on the timeout — Edge and Chrome
    /// flashing on screen at every startup and every `cargo test`. The version
    /// now comes off the disk, so even a file that could never be executed
    /// still reports it.
    #[test]
    fn chromium_version_comes_off_the_disk_without_running_the_browser() {
        let dir = temp("chromium");
        let app = dir.join("Application");
        std::fs::create_dir_all(app.join("151.0.7922.170")).unwrap();
        std::fs::create_dir_all(app.join("SetupMetrics")).unwrap();
        let bin = app.join("chrome.exe");
        std::fs::write(&bin, b"").unwrap(); // 0 bytes: spawning this would fail

        assert_eq!(version_from_disk(&bin).as_deref(), Some("151.0.7922.170"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Chromium keeps the old folder around for a while after an update.
    #[test]
    fn between_two_versions_on_disk_the_higher_one_wins() {
        let dir = temp("two");
        std::fs::create_dir_all(dir.join("99.0.1")).unwrap();
        std::fs::create_dir_all(dir.join("151.0.7922.170")).unwrap();
        let bin = dir.join("msedge.exe");
        std::fs::write(&bin, b"").unwrap();

        assert_eq!(version_from_disk(&bin).as_deref(), Some("151.0.7922.170"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn firefox_version_comes_from_application_ini() {
        let dir = temp("firefox");
        std::fs::write(
            dir.join("application.ini"),
            "[App]\nName=Firefox\nVersion=154.0\n\n[Gecko]\nMinVersion=154.0\n",
        )
        .unwrap();
        let bin = dir.join("firefox.exe");
        std::fs::write(&bin, b"").unwrap();

        assert_eq!(version_from_disk(&bin).as_deref(), Some("154.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No clue on disk is an empty version — never an excuse to launch the
    /// browser and ask.
    #[test]
    fn with_no_clue_on_disk_the_version_stays_empty() {
        let dir = temp("empty");
        let bin = dir.join("chrome.exe");
        std::fs::write(&bin, b"").unwrap();

        assert_eq!(version_from_disk(&bin), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_catalog_starts_with_the_native_engine() {
        assert_eq!(CATALOG[0].id, "webview2");
        assert_eq!(CATALOG[0].family, "webview2");
    }

    #[test]
    fn detect_all_always_reports_webview2_as_installed() {
        let list = detect_all();
        let native = list.iter().find(|b| b.id == "webview2").unwrap();
        assert!(native.installed);
        assert!(native.bin.is_none());
        assert_eq!(list.len(), CATALOG.len());
    }

    #[test]
    fn trim_version_keeps_the_number() {
        assert_eq!(trim_version("Google Chrome 124.0.6367.91"), "124.0.6367.91");
        assert_eq!(trim_version("Mozilla Firefox 125.0"), "125.0");
        assert_eq!(trim_version("124.0.0.0"), "124.0.0.0");
    }

    #[test]
    fn an_unknown_id_does_not_exist() {
        assert!(detect_one_id("netscape").is_none());
        assert!(detect_one_id("webview2").is_some());
    }
}
