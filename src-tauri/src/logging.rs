//! Logging via `tracing`, with daily rotation in `%APPDATA%\Yard\logs`.

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

    let appender = tracing_appender::rolling::daily(&dir, "yard.log");
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
