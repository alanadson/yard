//! Discovery of browsers installed on the machine.
//!
//! Same contract as the agent CLI catalog: every known engine is listed,
//! and `installed` is only true when the binary (or the WebView2 runtime)
//! is actually there. The UI disables the row otherwise — picking Firefox
//! on a machine that never installed it would just fail later.

use std::path::{Path, PathBuf};
use std::process::Command;
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
    let version = bin.as_ref().and_then(|p| read_version(p));
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

fn read_version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().next().unwrap_or("").trim();
        if line.is_empty() {
            return None;
        }
        return Some(trim_version(line));
    }
    Some(trim_version(line))
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

    #[test]
    fn catalogo_comeca_pelo_nativo() {
        assert_eq!(CATALOG[0].id, "webview2");
        assert_eq!(CATALOG[0].family, "webview2");
    }

    #[test]
    fn detect_all_sempre_traz_webview2_instalado() {
        let list = detect_all();
        let nativo = list.iter().find(|b| b.id == "webview2").unwrap();
        assert!(nativo.installed);
        assert!(nativo.bin.is_none());
        assert_eq!(list.len(), CATALOG.len());
    }

    #[test]
    fn trim_version_pega_o_numero() {
        assert_eq!(trim_version("Google Chrome 124.0.6367.91"), "124.0.6367.91");
        assert_eq!(trim_version("Mozilla Firefox 125.0"), "125.0");
        assert_eq!(trim_version("124.0.0.0"), "124.0.0.0");
    }

    #[test]
    fn id_desconhecido_nao_existe() {
        assert!(detect_one_id("netscape").is_none());
        assert!(detect_one_id("webview2").is_some());
    }
}
