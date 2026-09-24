//! Device discovery must distinguish authorization failures from ready Android targets.
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn sdk_adb(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| {
            root.join("platform-tools")
                .join(if cfg!(windows) { "adb.exe" } else { "adb" })
        })
        .find(|path| path.is_file())
}

fn run_adb(args: &[String]) -> Result<Vec<u8>, String> {
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Android").join("Sdk"));
    }
    let adb = which::which("adb").ok().or_else(|| sdk_adb(&roots)).ok_or("ADB not found. Install Android SDK Platform-Tools and set ANDROID_HOME or add adb to PATH.")?;
    let mut command = Command::new(adb);
    command.args(args);
    run_command(command, Duration::from_secs(15))
}

pub fn list() -> Result<Vec<AndroidDevice>, String> {
    let bytes = run_adb(&["devices".into(), "-l".into()])?;
    Ok(parse_devices(&String::from_utf8_lossy(&bytes)))
}

pub fn execute(serial: &str, action: &DeviceAction) -> Result<String, String> {
    execute_with(serial, action, run_adb)
}

fn run_command(mut command: Command, timeout: Duration) -> Result<Vec<u8>, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Missing device stdout")?;
    let stderr = child.stderr.take().ok_or("Missing device stderr")?;
    let read = |pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(crate::clipboard::MAX_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            other => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(other
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "Android command timed out".into()));
            }
        }
    };
    let stdout = out
        .join()
        .map_err(|_| "Device stdout reader failed")?
        .map_err(|e| e.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "Device stderr reader failed")?
        .map_err(|e| e.to_string())?;
    if !status?.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_owned());
    }
    if stdout.len() > crate::clipboard::MAX_BYTES {
        return Err("Device output exceeds 24 MB".into());
    }
    Ok(stdout)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceAction {
    Screenshot,
    Snapshot,
    Text {
        text: String,
    },
    Tap {
        x: u16,
        y: u16,
    },
    Swipe {
        x: u16,
        y: u16,
        #[serde(rename = "toX")]
        to_x: u16,
        #[serde(rename = "toY")]
        to_y: u16,
        duration: u16,
    },
    Key {
        key: String,
    },
    OpenUrl {
        url: String,
    },
    Launch {
        package: String,
    },
    Stop {
        package: String,
    },
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

pub fn action_args(serial: &str, action: &DeviceAction) -> Result<Vec<String>, String> {
    if serial.is_empty()
        || serial.starts_with('-')
        || serial.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Invalid Android serial".into());
    }
    let command = match action {
        DeviceAction::Snapshot => {
            let sequence = SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = format!(
                "/data/local/tmp/yard-window-{}-{sequence}.xml",
                std::process::id()
            );
            format!("uiautomator dump {path} >/dev/null && cat {path} && rm {path}")
        }
        DeviceAction::Screenshot => {
            return Ok(vec![
                "-s".into(),
                serial.into(),
                "exec-out".into(),
                "screencap".into(),
                "-p".into(),
            ])
        }
        DeviceAction::Tap { x, y } => format!("input tap {x} {y}"),
        DeviceAction::Swipe {
            x,
            y,
            to_x,
            to_y,
            duration,
        } => format!(
            "input swipe {x} {y} {to_x} {to_y} {}",
            duration.clamp(&1, &5000)
        ),
        DeviceAction::Key { key } => format!(
            "input keyevent {}",
            match key.as_str() {
                "back" => 4,
                "home" => 3,
                "recents" => 187,
                "enter" => 66,
                "delete" => 67,
                "power" => 26,
                "volumeUp" => 24,
                "volumeDown" => 25,
                _ => return Err("Unsupported Android key".into()),
            }
        ),
        DeviceAction::OpenUrl { url } => {
            if !(url.starts_with("https://") || url.starts_with("http://"))
                || url.chars().any(char::is_control)
            {
                return Err("Expected an HTTP or HTTPS URL".into());
            }
            format!(
                "am start -a android.intent.action.VIEW -d {}",
                shell_quote(url)
            )
        }
        DeviceAction::Launch { package } | DeviceAction::Stop { package } => {
            if package.is_empty()
                || !package
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            {
                return Err("Invalid Android package name".into());
            }
            if matches!(action, DeviceAction::Launch { .. }) {
                format!(
                    "monkey -p {} -c android.intent.category.LAUNCHER 1",
                    shell_quote(package)
                )
            } else {
                format!("am force-stop {}", shell_quote(package))
            }
        }
        DeviceAction::Text { text } => {
            if text.is_empty()
                || text.len() > 4096
                || !text.is_ascii()
                || text.chars().any(char::is_control)
                || text.contains("%s")
            {
                return Err(
                    "Android input supports printable ASCII text without literal %s".into(),
                );
            }
            format!("input text {}", shell_quote(&text.replace(' ', "%s")))
        }
    };
    Ok(vec!["-s".into(), serial.into(), "shell".into(), command])
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    pub serial: String,
    pub name: String,
    pub state: String,
}

fn execute_with(
    serial: &str,
    action: &DeviceAction,
    run: impl FnOnce(&[String]) -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    let bytes = run(&action_args(serial, action)?)?;
    if matches!(action, DeviceAction::Screenshot) {
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Android did not return a PNG screen capture".into());
        }
        Ok(crate::clipboard::encode_base64(&bytes))
    } else {
        Ok(String::from_utf8_lossy(&bytes).trim().into())
    }
}

pub fn parse_devices(output: &str) -> Vec<AndroidDevice> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            let state = fields.next()?;
            if !matches!(state, "device" | "offline" | "unauthorized") {
                return None;
            }
            let name = fields
                .find_map(|field| field.strip_prefix("model:"))
                .unwrap_or(serial)
                .replace('_', " ");
            Some(AndroidDevice {
                serial: serial.into(),
                name,
                state: state.into(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simultaneous_snapshots_use_distinct_remote_files() {
        let first = action_args("phone", &DeviceAction::Snapshot).unwrap();
        let second = action_args("phone", &DeviceAction::Snapshot).unwrap();
        assert_ne!(first[3], second[3]);
    }

    #[test]
    fn interface_snapshot_returns_the_android_accessibility_hierarchy() {
        let xml = "<?xml version=\"1.0\"?><hierarchy><node text=\"Settings\" /></hierarchy>";
        assert_eq!(
            execute_with("phone", &DeviceAction::Snapshot, |args| {
                assert_eq!(&args[..3], ["-s", "phone", "shell"]);
                assert!(args[3].starts_with("uiautomator dump "));
                Ok(xml.as_bytes().to_vec())
            })
            .unwrap(),
            xml
        );
    }

    #[test]
    fn an_android_sdk_can_supply_adb_when_it_is_missing_from_path() {
        let root = std::env::temp_dir().join(format!("yard-device-sdk-{}", std::process::id()));
        let platform = root.join("platform-tools");
        std::fs::create_dir_all(&platform).unwrap();
        let binary = platform.join(if cfg!(windows) { "adb.exe" } else { "adb" });
        std::fs::write(&binary, b"fixture").unwrap();
        assert_eq!(sdk_adb(&[root.clone()]), Some(binary.clone()));
        std::fs::remove_file(binary).unwrap();
        assert!(sdk_adb(&[root.clone()]).is_none());
        std::fs::remove_dir(platform).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn screen_capture_returns_png_bytes_and_rejects_device_errors() {
        let png = b"\x89PNG\r\n\x1a\nframe";
        let frame = execute_with("phone", &DeviceAction::Screenshot, |args| {
            assert_eq!(args, ["-s", "phone", "exec-out", "screencap", "-p"]);
            Ok(png.to_vec())
        })
        .unwrap();
        assert_eq!(crate::clipboard::decode_base64(&frame).unwrap(), png);
        assert!(execute_with("phone", &DeviceAction::Screenshot, |_| Ok(
            b"device offline".to_vec()
        ))
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn an_unresponsive_device_process_is_terminated_at_its_deadline() {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "while ($true) { [Console]::Out.Write('x') }",
        ]);
        let started = Instant::now();
        let error = run_command(command, Duration::ZERO).unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn device_process_drains_large_frames_without_blocking_the_child() {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write(('x' * 100000))",
        ]);
        let bytes = run_command(command, std::time::Duration::from_secs(15)).unwrap();
        assert_eq!(bytes, vec![b'x'; 100000]);
    }

    #[test]
    fn device_actions_select_the_device_before_issuing_navigation() {
        for (action, expected) in [
            (DeviceAction::Tap { x: 12, y: 34 }, "input tap 12 34"),
            (
                DeviceAction::Swipe {
                    x: 1,
                    y: 2,
                    to_x: 3,
                    to_y: 4,
                    duration: 250,
                },
                "input swipe 1 2 3 4 250",
            ),
            (DeviceAction::Key { key: "back".into() }, "input keyevent 4"),
            (
                DeviceAction::OpenUrl {
                    url: "https://example.com/?a=1&b=2".into(),
                },
                "am start -a android.intent.action.VIEW -d 'https://example.com/?a=1&b=2'",
            ),
            (
                DeviceAction::Launch {
                    package: "com.example.app".into(),
                },
                "monkey -p 'com.example.app' -c android.intent.category.LAUNCHER 1",
            ),
            (
                DeviceAction::Stop {
                    package: "com.example.app".into(),
                },
                "am force-stop 'com.example.app'",
            ),
        ] {
            assert_eq!(
                action_args("emulator-5554", &action).unwrap(),
                ["-s", "emulator-5554", "shell", expected]
            );
        }
        assert!(action_args(
            "phone",
            &DeviceAction::Key {
                key: "3; reboot".into()
            }
        )
        .is_err());
    }

    #[test]
    fn typing_keeps_shell_metacharacters_in_the_device_text() {
        let args = action_args(
            "phone-1",
            &DeviceAction::Text {
                text: "hello; $(id) 'ok'".into(),
            },
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "-s",
                "phone-1",
                "shell",
                "input text 'hello;%s$(id)%s'\"'\"'ok'\"'\"''"
            ]
        );
        assert!(action_args(
            "-d",
            &DeviceAction::Text {
                text: "hello".into()
            }
        )
        .is_err());
    }

    #[test]
    fn discovery_keeps_offline_and_unauthorized_devices_visible() {
        let devices = parse_devices("List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 transport_id:1\nphone-1 unauthorized transport_id:2\nphone-2 offline\n");
        assert_eq!(devices.len(), 3);
        assert_eq!(devices[0].name, "Pixel 8");
        assert_eq!(devices[0].serial, "emulator-5554");
        assert_eq!(devices[1].state, "unauthorized");
        assert_eq!(devices[2].state, "offline");
    }
}
