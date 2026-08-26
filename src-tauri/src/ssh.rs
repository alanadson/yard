//! Is there an `ssh` to run an agent through, and which hosts are known?
//!
//! The third "where it runs" of Configurações › Agentes, next to Windows and
//! WSL (`wsl.rs`). Same contract: the choice is only clickable when the
//! launcher really exists, and the picker offers the aliases the user already
//! wrote in `~/.ssh/config` — an alias is what `ssh.exe` itself reads, so the
//! app never has to know the real host, user or key.
//!
//! Only the *aliases* are read out of the config: `Host` lines, one name or
//! several per line, minus the wildcard patterns (`*`, `?`) that name no
//! machine. `Match` blocks and `Include` lines are skipped rather than
//! resolved — a wrong alias here is one the user did not write, which is
//! worse than a missing one.

use std::path::Path;

use serde::Serialize;

/// What the settings screen needs to draw the choice.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshStatus {
    /// An `ssh` launcher exists on this machine.
    pub available: bool,
    /// Where it was found, for the line under the control.
    pub path: Option<String>,
    /// Aliases from `~/.ssh/config`, in file order.
    pub hosts: Vec<String>,
    /// Why it cannot be used, for the line under the disabled control.
    pub reason: Option<String>,
}

/// The `Host` aliases of an OpenSSH client config, in file order.
///
/// A `Host` line may name several aliases; patterns carrying `*` or `?` are
/// matching rules, not machines, and are dropped. Anything inside a `Match`
/// block is ignored, and so is `Include` — resolving other files is ssh's
/// job, not the settings screen's.
pub fn parse_ssh_config(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `Host name` and `Host=name` are both legal; split on the first
        // whitespace or `=`.
        let (key, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
            Some(at) => (&line[..at], line[at..].trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
            None => (line, ""),
        };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for name in split_words(rest) {
            // A negated pattern (`!foo`) and any wildcard name no machine.
            if name.starts_with('!') || name.contains('*') || name.contains('?') {
                continue;
            }
            if !name.is_empty() && !hosts.contains(&name) {
                hosts.push(name);
            }
        }
    }
    hosts
}

/// The words of a `Host` line: whitespace-separated, with `"…"` keeping a
/// name that carries spaces together (ssh_config allows it).
fn split_words(rest: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// Reads the aliases out of a config file; a missing or unreadable file is
/// simply no aliases — the user can still type a host by hand.
pub fn hosts_from(config: &Path) -> Vec<String> {
    std::fs::read_to_string(config)
        .map(|text| parse_ssh_config(&text))
        .unwrap_or_default()
}

/// Where `ssh` lives on this machine, if anywhere.
///
/// Windows 10/11 ship OpenSSH as `ssh.exe`; a Git for Windows or MSYS
/// install may only answer to `ssh`. Either is fine — `-tt host command` is
/// the same on both.
pub fn find_ssh() -> Option<String> {
    which::which("ssh.exe")
        .or_else(|_| which::which("ssh"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// The answer for a given launcher and config file — the seam the tests use.
pub fn status_from(ssh: Option<String>, config: &Path) -> SshStatus {
    match ssh {
        None => SshStatus {
            available: false,
            path: None,
            hosts: Vec::new(),
            reason: Some("não achei o ssh.exe nesta máquina — instale o OpenSSH Client do Windows".into()),
        },
        Some(path) => SshStatus {
            available: true,
            path: Some(path),
            hosts: hosts_from(config),
            reason: None,
        },
    }
}

/// Runs the real lookup: the launcher on the PATH and `~/.ssh/config`.
pub fn status() -> SshStatus {
    let config = crate::paths::home_dir()
        .map(|h| h.join(".ssh").join("config"))
        .unwrap_or_default();
    status_from(find_ssh(), &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_lines_become_aliases_in_file_order_one_or_several_per_line() {
        let text = "Host devbox\n  HostName 10.0.0.5\n  User alan\n\nHost build gpu-01\n  User ci\n";
        assert_eq!(parse_ssh_config(text), vec!["devbox", "build", "gpu-01"]);
    }

    #[test]
    fn wildcard_and_negated_patterns_name_no_machine() {
        let text = "Host *\n  ServerAliveInterval 30\nHost *.internal !secret devbox\nHost ?box\n";
        assert_eq!(parse_ssh_config(text), vec!["devbox"]);
    }

    #[test]
    fn comments_indentation_and_the_equals_form_are_all_read() {
        let text = "# my hosts\n   host=devbox\n\t Host   \"quoted name\"  \n#Host commented\n";
        assert_eq!(parse_ssh_config(text), vec!["devbox", "quoted name"]);
    }

    #[test]
    fn match_blocks_and_include_lines_are_skipped_not_fatal() {
        let text = "Include ~/.ssh/work/*\nMatch host devbox user alan\n  IdentityFile ~/.ssh/id\nHost devbox\n";
        assert_eq!(parse_ssh_config(text), vec!["devbox"]);
    }

    #[test]
    fn the_same_alias_twice_is_offered_once() {
        assert_eq!(parse_ssh_config("Host a\nHost a b\n"), vec!["a", "b"]);
    }

    #[test]
    fn no_launcher_means_not_available_with_a_reason_and_no_hosts() {
        let dir = std::env::temp_dir().join(format!("yard-ssh-{}", std::process::id()));
        let s = status_from(None, &dir.join("config"));
        assert!(!s.available);
        assert!(s.reason.is_some());
        assert!(s.hosts.is_empty());
    }

    #[test]
    fn a_missing_config_file_is_no_aliases_not_an_error() {
        let dir = std::env::temp_dir().join(format!("yard-ssh-{}", std::process::id()));
        let s = status_from(Some("C:\\Windows\\System32\\OpenSSH\\ssh.exe".into()), &dir.join("config"));
        assert!(s.available);
        assert!(s.hosts.is_empty());
        assert_eq!(s.path.as_deref(), Some("C:\\Windows\\System32\\OpenSSH\\ssh.exe"));
    }

    #[test]
    fn aliases_come_out_of_the_config_file_on_disk() {
        let dir = std::env::temp_dir().join(format!("yard-ssh-{}-cfg", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config");
        std::fs::write(&cfg, "Host devbox\nHost *\n").unwrap();
        let s = status_from(Some("ssh".into()), &cfg);
        assert_eq!(s.hosts, vec!["devbox"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
