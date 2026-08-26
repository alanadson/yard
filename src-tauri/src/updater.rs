//! In-app updates, the Rust side.
//!
//! The plugin does the work (`tauri-plugin-updater`: fetch `latest.json`,
//! verify the minisign signature, run the NSIS installer). What lives here is
//! the part that can be wrong silently: the **configuration** that makes an
//! update possible at all, and the version rule the UI applies on top of the
//! plugin's own comparison ("ignore this version").

/// `tauri.conf.json` as this crate was built with it — the file the plugin
/// reads its public key and endpoints from.
pub const CONFIG: &str = include_str!("../tauri.conf.json");

/// The one place a release becomes an update: the manifest `tauri-action`
/// uploads next to the installer.
pub const ENDPOINT: &str =
    "https://github.com/alanadson/yard/releases/latest/download/latest.json";

/// A version as the comparison sees it: the three numbers, plus whether a
/// pre-release tag follows them (`1.0.0-rc.1` sorts *before* `1.0.0`).
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// `true` for a final release: with derived `Ord` a release outranks any
    /// pre-release of the same three numbers.
    release: bool,
    pre: String,
}

fn parse(version: &str) -> Option<Version> {
    let v = version.trim().trim_start_matches('v');
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, p),
        None => (v, ""),
    };
    let mut nums = core.split('.').map(|n| n.parse::<u64>().ok());
    let major = nums.next()??;
    let minor = nums.next()??;
    let patch = nums.next()??;
    if nums.next().is_some() {
        return None;
    }
    Some(Version {
        major,
        minor,
        patch,
        release: pre.is_empty(),
        pre: pre.to_string(),
    })
}

/// Whether `remote` is strictly newer than `current`. Anything that does not
/// parse as `major.minor.patch[-pre]` is not an update — the plugin would
/// refuse it too, but the UI must not announce it first.
pub fn is_newer(current: &str, remote: &str) -> bool {
    match (parse(current), parse(remote)) {
        (Some(c), Some(r)) => r > c,
        _ => false,
    }
}

/// The rule the UI applies over the plugin's answer: newer than what runs,
/// and not the one version the user chose to ignore. Ignoring is per
/// version, so the next release is offered again.
pub fn should_offer(current: &str, remote: &str, skipped: Option<&str>) -> bool {
    if !is_newer(current, remote) {
        return false;
    }
    match skipped {
        Some(s) => parse(s) != parse(remote),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dropped key or a retyped endpoint would not fail the build and would
    /// not fail at runtime either — the app would simply never see an update.
    #[test]
    fn tauri_conf_carries_the_public_key_the_github_endpoint_and_updater_artifacts() {
        let conf: serde_json::Value = serde_json::from_str(CONFIG).expect("valid json");
        let updater = &conf["plugins"]["updater"];
        let pubkey = updater["pubkey"].as_str().unwrap_or("");
        assert!(
            pubkey.starts_with("dW50cnVzdGVkIGNvbW1lbnQ6"),
            "pubkey must be the minisign public key (base64 'untrusted comment:' header), got {pubkey:?}"
        );
        let endpoints: Vec<&str> = updater["endpoints"]
            .as_array()
            .expect("endpoints array")
            .iter()
            .filter_map(|e| e.as_str())
            .collect();
        assert_eq!(endpoints, vec![ENDPOINT]);
        assert_eq!(updater["windows"]["installMode"].as_str(), Some("passive"));
        assert_eq!(
            conf["bundle"]["createUpdaterArtifacts"].as_bool(),
            Some(true),
            "without updater artifacts the release has no .sig and no latest.json"
        );
    }

    #[test]
    fn a_newer_remote_version_is_offered() {
        assert!(should_offer("0.1.0", "0.2.0", None));
        assert!(should_offer("0.1.9", "0.1.10", None));
        assert!(should_offer("1.0.0-beta.1", "1.0.0", None));
    }

    #[test]
    fn the_same_or_an_older_version_is_never_offered() {
        assert!(!should_offer("0.2.0", "0.2.0", None));
        assert!(!should_offer("0.2.0", "0.1.9", None));
        assert!(!should_offer("1.0.0", "1.0.0-rc.1", None));
    }

    #[test]
    fn a_version_the_user_ignored_stays_quiet_until_a_newer_one_appears() {
        assert!(!should_offer("0.1.0", "0.2.0", Some("0.2.0")));
        assert!(should_offer("0.1.0", "0.2.1", Some("0.2.0")));
    }

    #[test]
    fn garbage_versions_are_not_an_update() {
        assert!(!should_offer("0.1.0", "latest", None));
        assert!(!should_offer("", "0.2.0", None));
        assert!(!should_offer("0.1.0", "", None));
    }
}
