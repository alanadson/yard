//! Is there a WSL to run an agent in, and which distros does it have?
//!
//! The whole feature hangs on this answer: the "Windows / WSL" choice in
//! Configurações › Agentes is only clickable when a distro really exists, and
//! a wrong "yes" here means a terminal that dies on `wsl.exe` with no distro
//! and nothing on screen explaining why.
//!
//! The one trap worth writing down: **`wsl.exe -l -q` answers in UTF-16LE**,
//! not UTF-8. Read as UTF-8 the output is a string of NULs — every distro name
//! comes out mangled, and the naive `String::from_utf8_lossy` version of this
//! reported a machine with Ubuntu installed as having a distro called
//! `U\0b\0u\0n\0t\0u\0`.

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::process::Command;

/// What the settings screen needs to draw the choice.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    /// `wsl.exe` answered and there is at least one distro to run in.
    pub available: bool,
    /// Registered distros, in the order WSL lists them (the first is default).
    pub distros: Vec<String>,
    /// Why it cannot be used, for the line under the disabled control.
    pub reason: Option<String>,
}

/// Decodes what `wsl.exe -l -q` wrote: UTF-16LE, one name per line.
///
/// An odd trailing byte is dropped instead of failing: a truncated read must
/// not cost the whole list, and the names before it are still names.
pub fn parse_distros(raw: &[u8]) -> Vec<String> {
    let units: Vec<u16> = raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|line| {
            line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0')
        })
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// Runs `wsl.exe -l -q` and reports what it found.
///
/// A `wsl.exe` that exists is not the answer — Windows ships the launcher even
/// with the feature turned off, and it is a distro, not the binary, that an
/// agent runs inside. So "available" means **at least one distro**.
pub fn status() -> WslStatus {
    #[cfg(not(windows))]
    {
        WslStatus {
            available: false,
            distros: Vec::new(),
            reason: Some("o WSL só existe no Windows".into()),
        }
    }

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: without it every check flashes a console window on
        // top of whatever the user is doing.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match Command::new("wsl.exe")
            .args(["-l", "-q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Err(_) => WslStatus {
                available: false,
                distros: Vec::new(),
                reason: Some("não achei o wsl.exe nesta máquina".into()),
            },
            Ok(out) => {
                let distros = parse_distros(&out.stdout);
                if distros.is_empty() {
                    WslStatus {
                        available: false,
                        distros,
                        reason: Some(
                            "o WSL está aqui, mas sem nenhuma distribuição instalada".into(),
                        ),
                    }
                } else {
                    WslStatus {
                        available: true,
                        distros,
                        reason: None,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes like `wsl.exe` does, so the test exercises the real decoding
    /// rather than a convenient ASCII shortcut.
    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// The regression this locks: read as UTF-8, `wsl -l -q` reports a machine
    /// with Ubuntu as having a distro named `U\0b\0u\0n\0t\0u\0`.
    #[test]
    fn utf16_output_of_wsl_list_becomes_plain_names() {
        let raw = utf16le("Ubuntu\r\nDebian\r\n");
        assert_eq!(parse_distros(&raw), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn a_bom_and_blank_lines_do_not_become_distros() {
        let raw = utf16le("\u{feff}Ubuntu-22.04\r\n\r\n   \r\n");
        assert_eq!(parse_distros(&raw), vec!["Ubuntu-22.04"]);
    }

    #[test]
    fn a_machine_with_no_distro_lists_nothing() {
        assert!(parse_distros(&[]).is_empty());
        assert!(parse_distros(&utf16le("\r\n")).is_empty());
    }

    /// A truncated read must not cost the names that did arrive.
    #[test]
    fn an_odd_trailing_byte_does_not_swallow_the_list() {
        let mut raw = utf16le("Ubuntu\r\n");
        raw.push(0x55);
        assert_eq!(parse_distros(&raw), vec!["Ubuntu"]);
    }
}
