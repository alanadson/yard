//! Logging via `tracing`, with daily rotation in `%APPDATA%\Yard\logs`; the
//! newest 14 daily files are kept.

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// Initializes the global subscriber. The returned guard must live as long as
/// the app lives — if it drops, the non-blocking writer stops writing.
pub fn init() -> Option<WorkerGuard> {
    let dir = crate::paths::logs_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("yard: nao consegui criar {}: {e}", dir.display());
        return None;
    }

    let appender = match appender(&dir) {
        Ok(appender) => appender,
        Err(e) => {
            eprintln!("yard: nao consegui abrir o log em {}: {e}", dir.display());
            return None;
        }
    };
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_env("YARD_LOG")
        .unwrap_or_else(|_| EnvFilter::new("yard_lib=info,ui=info,warn"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_ansi(false).with_writer(writer))
        .with(fmt::layer().with_ansi(true).with_writer(std::io::stderr))
        .init();

    tracing::info!(dir = %dir.display(), "logging iniciado");
    Some(guard)
}

/// How many daily files the log folder keeps (today's included).
const MAX_LOG_FILES: usize = 14;

/// The daily file writer. The prefix is `yard.log`, so the files keep the
/// `yard.log.<date>` names they always had: the support bundle finds them by
/// that name (`support::recent_logs`), and the cap also clears the backlog of
/// days written before it existed (the appender prunes by prefix).
fn appender(dir: &std::path::Path) -> Result<tracing_appender::rolling::RollingFileAppender, tracing_appender::rolling::InitError> {
    tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("yard.log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)
}

/// The longest message from the webview (`ui_log`) that goes into the log
/// whole. A rendered component tree or a stack with a huge payload used to
/// land as one multi-megabyte line.
const MAX_UI_MESSAGE_BYTES: usize = 4096;

/// `message` cut to `MAX_UI_MESSAGE_BYTES` on a character boundary, with a
/// marker saying how much was left out.
pub fn bounded_message(message: &str) -> std::borrow::Cow<'_, str> {
    if message.len() <= MAX_UI_MESSAGE_BYTES {
        return std::borrow::Cow::Borrowed(message);
    }
    let mut cut = MAX_UI_MESSAGE_BYTES;
    while !message.is_char_boundary(cut) {
        cut -= 1;
    }
    std::borrow::Cow::Owned(format!("{} [truncated {} bytes]", &message[..cut], message.len() - cut))
}

#[cfg(test)]
mod tests {
    // The log folder used to keep one file per day forever, and one webview
    // message could put megabytes into a single line of it.
    use super::*;

    #[test]
    fn the_appender_keeps_the_newest_fourteen_daily_files_under_the_names_the_support_bundle_reads() {
        let dir = std::env::temp_dir().join(format!("yard-logging-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for day in 1..=20 {
            std::fs::write(dir.join(format!("yard.log.2020-01-{day:02}")), b"old day\n").unwrap();
        }
        std::fs::write(dir.join("unrelated.txt"), b"not a log\n").unwrap();
        drop(appender(&dir).unwrap());
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        let logs: Vec<&String> = names.iter().filter(|name| name.starts_with("yard.log.")).collect();
        assert_eq!(logs.len(), 14);
        let today = chrono::Utc::now().format("yard.log.%Y-%m-%d").to_string();
        assert!(names.contains(&today), "today's file keeps the `yard.log.<date>` name");
        assert!(names.contains(&"unrelated.txt".to_string()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_message_longer_than_four_kilobytes_is_cut_on_a_character_boundary_with_a_marker() {
        let message = format!("{}{}", "a".repeat(4095), "ção".repeat(1000));
        let bounded = bounded_message(&message);
        assert!(bounded.starts_with(&"a".repeat(4095)));
        assert!(bounded.ends_with(&format!("[truncated {} bytes]", message.len() - 4095)), "{}", &bounded[4090..]);
        assert!(bounded.len() < 4096 + 40);
        assert_eq!(bounded_message("short"), "short");
    }
}
