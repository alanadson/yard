//! Agent usage limits (Claude, Codex, Grok) — the TitleBar's "how much can I
//! still run today" bar.
//!
//! Each CLI keeps local credentials (`~/.claude/.credentials.json`,
//! `~/.codex/auth.json`, `~/.grok/auth.json`) and each provider has a usage
//! endpoint authenticated by them. None of these endpoints is documented or
//! officially supported — they are what the official clients call, so they can
//! change or disappear without notice; on failure the widget hides and nothing
//! else is affected. The endpoints:
//!
//! * Claude — `GET api.anthropic.com/api/oauth/usage` (5h and 7d windows, plus
//!   the per-model weekly one inside `limits[]`).
//! * Codex — `GET chatgpt.com/backend-api/wham/usage` (primary and secondary
//!   windows, in seconds).
//! * Grok — `GET cli-chat-proxy.grok.com/v1/billing?format=credits`
//!   (percentage of the period's credits; weekly or monthly).
//!
//! The tokens never leave here: the frontend only receives percentages, windows
//! and reset times. Reading runs on its own thread — a background cycle every
//! `POLL_INTERVAL`, with an immediate refetch when the UI asks (window focus,
//! an agent went idle, the refresh button).

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Background cycle. Claude's OAuth endpoint returns 429 under aggressive
/// polling; 60 s keeps the bar alive without burning anyone's quota.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Floor between fetches of the same provider even on a forced refresh —
/// protects against focus+idle+button arriving together.
const FORCED_MIN_GAP: Duration = Duration::from_secs(5);
/// After a 429, how long to wait before trying the provider again.
const RATE_LIMITED_BACKOFF: Duration = Duration::from_secs(300);
/// After a network/server error.
const ERROR_BACKOFF: Duration = Duration::from_secs(120);
/// Stale data still beats an empty bar — up to this limit.
const STALE_KEEP: Duration = Duration::from_secs(24 * 60 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(12);

pub const TOPIC_UPDATE: &str = "usage://update";

// ---------------------------------------------------------------------------
// types exposed to the frontend (mirrored in lib/ipc.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// "session" (5 h), "weekly", "fable" (per-model weekly) or "monthly".
    pub key: String,
    pub used_percent: f64,
    pub window_minutes: u32,
    /// Epoch ms; `None` when the provider did not report it.
    pub resets_at: Option<i64>,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// "claude" | "codex" | "grok".
    pub id: String,
    pub name: String,
    /// Readable plan ("Max 20x", "Plus") when the endpoint reports one.
    pub plan: Option<String>,
    /// Email or account identifier, to disambiguate multiple accounts.
    pub account: Option<String>,
    pub windows: Vec<UsageWindow>,
    /// "ok" | "stale" (showing old data) | "auth" (session expired) |
    /// "missing" (CLI never logged in) | "error".
    pub status: String,
    pub error: Option<String>,
    /// Epoch ms of the last successful fetch (0 = never).
    pub updated_at: i64,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub providers: Vec<ProviderUsage>,
    pub fetched_at: i64,
}

// ---------------------------------------------------------------------------
// service state
// ---------------------------------------------------------------------------

static SNAPSHOT: Mutex<Option<UsageSnapshot>> = Mutex::new(None);
/// Each message is the set of providers a refresh forces.
static WAKE: OnceLock<mpsc::Sender<Vec<&'static str>>> = OnceLock::new();

const PROVIDERS: [&str; 3] = ["claude", "codex", "grok"];

/// Current snapshot (empty before the first cycle finishes).
pub fn snapshot() -> UsageSnapshot {
    SNAPSHOT.lock().unwrap().clone().unwrap_or(UsageSnapshot {
        providers: Vec::new(),
        fetched_at: 0,
    })
}

/// Asks for an immediate cycle for one provider (`"claude"`, `"codex"`,
/// `"grok"`) or, with `None`, for all of them. Cheap: if the thread is already
/// in the middle of one, the signal just brings the next `recv_timeout`
/// forward. An unknown provider asks for nothing.
pub fn request_refresh(provider: Option<&str>) {
    let forced = forced_by(provider);
    if forced.is_empty() {
        return;
    }
    if let Some(tx) = WAKE.get() {
        let _ = tx.send(forced);
    }
}

/// The providers a refresh request forces: the one named, or every provider
/// for `None`; none for a name that is not a provider.
fn forced_by(provider: Option<&str>) -> Vec<&'static str> {
    match provider {
        None => PROVIDERS.to_vec(),
        Some(name) => PROVIDERS.iter().copied().filter(|id| *id == name).collect(),
    }
}

/// Whether a cycle fetches this provider: a forced one when its own rules
/// allow (`ProviderPoll::due`), any other by its timer, and the timer only
/// for a window on screen.
fn selected(poll: &ProviderPoll, now: Instant, forced: &[&str], window_shown: bool) -> bool {
    if forced.contains(&poll.id) {
        poll.due(now, true)
    } else {
        window_shown && poll.due(now, false)
    }
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Vec<&'static str>>();
    // A second `start` (does not happen today) would keep the old sender;
    // harmless, the new loop still wakes up on the timeout.
    let _ = WAKE.set(tx);

    std::thread::Builder::new()
        .name("usage-poller".into())
        .spawn(move || {
            let agent = match http_client() {
                Ok(agent) => agent,
                Err(error) => {
                    tracing::warn!(%error, "usage poller has no HTTP client");
                    return;
                }
            };
            let mut providers = [
                ProviderPoll::new("claude"),
                ProviderPoll::new("codex"),
                ProviderPoll::new("grok"),
            ];
            // The first cycle fetches everything right away.
            let mut forced: Vec<&'static str> = PROVIDERS.to_vec();
            loop {
                let shown = window_on_screen(&app);
                if cycle_runs(!forced.is_empty(), shown) {
                    let now = Instant::now();
                    let mut changed = false;
                    for p in providers.iter_mut() {
                        if !selected(p, now, &forced, shown) {
                            continue;
                        }
                        changed |= p.fetch(&agent);
                    }
                    if changed || !forced.is_empty() {
                        publish(&app, &providers);
                    }
                }
                forced = match rx.recv_timeout(POLL_INTERVAL) {
                    Ok(asked) => asked,
                    Err(mpsc::RecvTimeoutError::Timeout) => Vec::new(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                };
                // Collapse a burst of requests (focus + idle + button) into a
                // single cycle.
                while let Ok(more) = rx.try_recv() {
                    for id in more {
                        if !forced.contains(&id) {
                            forced.push(id);
                        }
                    }
                }
            }
        })
        .expect("thread usage-poller");
}

/// Whether a cycle fetches at all. The timer's turn is skipped while the
/// window is off screen (hidden to the tray, minimized): nobody sees the bar,
/// and the page asks for a refresh the moment the window is focused again.
/// A refresh someone asked for always runs.
fn cycle_runs(forced: bool, window_shown: bool) -> bool {
    forced || window_shown
}

/// The app-wide "window on screen" flag (`AppState::window_shown`).
fn window_on_screen(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.state::<std::sync::Arc<crate::state::AppState>>()
        .window_shown
        .load(std::sync::atomic::Ordering::Acquire)
}

fn publish(app: &AppHandle, providers: &[ProviderPoll]) {
    let snap = UsageSnapshot {
        providers: providers.iter().filter_map(|p| p.current.clone()).collect(),
        fetched_at: epoch_ms_now(),
    };
    *SNAPSHOT.lock().unwrap() = Some(snap.clone());
    if let Err(e) = app.emit(TOPIC_UPDATE, &snap) {
        tracing::warn!(error = %e, "falha ao emitir usage://update");
    }
}

/// One provider in the loop: current result, last success and backoff window.
struct ProviderPoll {
    id: &'static str,
    current: Option<ProviderUsage>,
    last_ok: Option<ProviderUsage>,
    next_allowed: Instant,
    last_attempt: Option<Instant>,
    /// Whether the last fetch failed (429, auth, network...): its backoff then
    /// holds even for a forced refresh.
    failed: bool,
}

impl ProviderPoll {
    fn new(id: &'static str) -> Self {
        Self {
            id,
            current: None,
            last_ok: None,
            next_allowed: Instant::now(),
            last_attempt: None,
            failed: false,
        }
    }

    fn due(&self, now: Instant, forced: bool) -> bool {
        if forced && !self.failed {
            // Even when forced, respect the anti-burst floor. A provider whose
            // last fetch failed keeps its backoff: asking again early is what
            // keeps a 429 going.
            return self
                .last_attempt
                .is_none_or(|t| now.duration_since(t) >= FORCED_MIN_GAP);
        }
        now >= self.next_allowed
    }

    /// Fetches and applies the stale-data policy. Returns whether the snapshot changed.
    fn fetch(&mut self, agent: &crate::http::Client) -> bool {
        let now = Instant::now();
        self.last_attempt = Some(now);
        let outcome = match self.id {
            "claude" => fetch_claude(agent),
            "codex" => fetch_codex(agent),
            _ => fetch_grok(agent),
        };
        let fresh = match outcome {
            Ok(usage) => {
                self.failed = false;
                self.next_allowed = now + POLL_INTERVAL;
                self.last_ok = Some(usage.clone());
                usage
            }
            Err(e) => {
                self.failed = true;
                self.next_allowed = now
                    + match e.kind {
                        FetchErrorKind::RateLimited => RATE_LIMITED_BACKOFF,
                        FetchErrorKind::Auth | FetchErrorKind::Missing => POLL_INTERVAL,
                        FetchErrorKind::Other => ERROR_BACKOFF,
                    };
                self.degraded(e)
            }
        };
        if self.current.as_ref() != Some(&fresh) {
            self.current = Some(fresh);
            return true;
        }
        false
    }

    /// Failed: keeps the windows from the last recent success as "stale"; with
    /// no useful history, returns just the error.
    fn degraded(&self, e: FetchError) -> ProviderUsage {
        let status = match e.kind {
            FetchErrorKind::Auth => "auth",
            FetchErrorKind::Missing => "missing",
            _ => "error",
        };
        if let Some(ok) = &self.last_ok {
            let age = epoch_ms_now() - ok.updated_at;
            if age >= 0 && (age as u64) < STALE_KEEP.as_millis() as u64 {
                return ProviderUsage {
                    status: if status == "error" { "stale" } else { status }.into(),
                    error: Some(e.message),
                    ..ok.clone()
                };
            }
        }
        ProviderUsage {
            id: self.id.into(),
            name: display_name(self.id),
            plan: None,
            account: None,
            windows: Vec::new(),
            status: status.into(),
            error: Some(e.message),
            updated_at: 0,
        }
    }
}

fn display_name(id: &str) -> String {
    match id {
        "claude" => "Claude",
        "codex" => "Codex",
        "grok" => "Grok",
        other => other,
    }
    .into()
}

// ---------------------------------------------------------------------------
// fetch errors
// ---------------------------------------------------------------------------

enum FetchErrorKind {
    /// Credential missing — the CLI never logged in on this machine.
    Missing,
    /// Token expired or refused — the CLI itself renews it when opened.
    Auth,
    RateLimited,
    Other,
}

struct FetchError {
    kind: FetchErrorKind,
    message: String,
}

impl FetchError {
    fn missing(msg: impl Into<String>) -> Self {
        Self {
            kind: FetchErrorKind::Missing,
            message: msg.into(),
        }
    }
    fn auth(msg: impl Into<String>) -> Self {
        Self {
            kind: FetchErrorKind::Auth,
            message: msg.into(),
        }
    }
    fn other(msg: impl Into<String>) -> Self {
        Self {
            kind: FetchErrorKind::Other,
            message: msg.into(),
        }
    }
}

/// The poller's client, made once per poller thread.
fn http_client() -> Result<crate::http::Client, String> {
    crate::http::client(HTTP_TIMEOUT, None, true)
}

/// The most of a usage answer that is read (they are a few hundred bytes).
const MAX_BODY: u64 = 10 * 1024 * 1024;

/// GET with Bearer + extra headers; classifies 401/403/429 for the backoff
/// policy. Returns the body already parsed.
fn get_json(agent: &crate::http::Client, url: &str, headers: &[(&str, &str)]) -> Result<Value, FetchError> {
    let mut req = agent.get(url).header("Accept", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().map_err(|e| FetchError::other(format!("Rede: {e}")))?;
    match crate::http::refused(&resp) {
        Some(429) => {
            return Err(FetchError {
                kind: FetchErrorKind::RateLimited,
                message: "Muitas consultas — aguardando para tentar de novo".into(),
            })
        }
        Some(code @ (401 | 403)) => {
            return Err(FetchError::auth(format!("Sessão recusada (HTTP {code})")))
        }
        Some(code) => return Err(FetchError::other(format!("Consulta falhou (HTTP {code})"))),
        None => {}
    }
    let mut body = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(resp, MAX_BODY), &mut body)
        .map_err(|e| FetchError::other(format!("Resposta ilegível: {e}")))?;
    serde_json::from_str(&body).map_err(|e| FetchError::other(format!("JSON inesperado: {e}")))
}

fn read_json_file(path: &PathBuf) -> Result<Value, FetchError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|_| FetchError::missing(format!("{} não encontrado", path.to_string_lossy())))?;
    serde_json::from_str(&raw)
        .map_err(|e| FetchError::other(format!("{}: {e}", path.to_string_lossy())))
}

fn epoch_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// "2026-08-19T15:00:00.219104+00:00" → epoch ms.
fn parse_iso_ms(v: &Value) -> Option<i64> {
    let s = v.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn percent(v: &Value) -> Option<f64> {
    v.as_f64().map(|p| p.clamp(0.0, 100.0))
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().unwrap_or_default().join(".claude"))
}

fn fetch_claude(agent: &crate::http::Client) -> Result<ProviderUsage, FetchError> {
    let creds =
        read_json_file(&claude_config_dir().join(".credentials.json")).map_err(|e| {
            match e.kind {
                FetchErrorKind::Missing => {
                    FetchError::missing("Não conectado — rode `claude` e faça login")
                }
                _ => e,
            }
        })?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| FetchError::missing("Não conectado — rode `claude` e faça login"))?;
    // Expired token: Claude Code is what renews it (the file changes on disk and
    // the next cycle picks it up). Renewing here would race the CLI for the
    // refresh_token.
    if oauth["expiresAt"]
        .as_i64()
        .is_some_and(|t| t <= epoch_ms_now())
    {
        return Err(FetchError::auth(
            "Sessão do Claude expirada — abra o Claude Code para renovar",
        ));
    }

    let auth = format!("Bearer {token}");
    let data = get_json(
        agent,
        "https://api.anthropic.com/api/oauth/usage",
        &[
            ("Authorization", &auth),
            ("anthropic-beta", "oauth-2025-04-20"),
            ("User-Agent", "claude-code/2.1.0"),
        ],
    )?;

    let mut windows = Vec::new();
    if let Some(pct) = percent(&data["five_hour"]["utilization"]) {
        windows.push(UsageWindow {
            key: "session".into(),
            used_percent: pct,
            window_minutes: 300,
            resets_at: parse_iso_ms(&data["five_hour"]["resets_at"]),
        });
    }
    if let Some(pct) = percent(&data["seven_day"]["utilization"]) {
        windows.push(UsageWindow {
            key: "weekly".into(),
            used_percent: pct,
            window_minutes: 10_080,
            resets_at: parse_iso_ms(&data["seven_day"]["resets_at"]),
        });
    }
    // The per-model weekly window (today "Fable") lives in `limits[]`.
    if let Some(limits) = data["limits"].as_array() {
        for l in limits {
            if l["kind"].as_str() != Some("weekly_scoped") {
                continue;
            }
            let Some(pct) = percent(&l["percent"]) else {
                continue;
            };
            let model = l["scope"]["model"]["display_name"]
                .as_str()
                .unwrap_or("Modelo");
            // "fable" today; if Anthropic scopes another model tomorrow, the key
            // follows the name and the frontend shows it just the same.
            let key = model.to_lowercase();
            // This is the only key that comes from outside — two limits for the
            // same model (or a model named "session") would repeat the key,
            // which on the other side is React's list key. Same dedup already
            // applied to the Codex windows.
            if windows.iter().any(|w: &UsageWindow| w.key == key) {
                continue;
            }
            windows.push(UsageWindow {
                key,
                used_percent: pct,
                window_minutes: 10_080,
                resets_at: parse_iso_ms(&l["resets_at"]),
            });
        }
    }
    if windows.is_empty() {
        return Err(FetchError::other("Resposta sem janelas de uso"));
    }

    let plan = match oauth["subscriptionType"].as_str() {
        Some("max") => {
            // rateLimitTier: "default_claude_max_20x" → "Max 20x"
            let tier = oauth["rateLimitTier"].as_str().unwrap_or("");
            Some(if tier.ends_with("20x") {
                "Max 20x".into()
            } else if tier.ends_with("5x") {
                "Max 5x".into()
            } else {
                "Max".into()
            })
        }
        Some("pro") => Some("Pro".into()),
        Some(other) if !other.is_empty() => Some(other.into()),
        _ => None,
    };

    Ok(ProviderUsage {
        id: "claude".into(),
        name: "Claude".into(),
        plan,
        account: None,
        windows,
        status: "ok".into(),
        error: None,
        updated_at: epoch_ms_now(),
    })
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

fn fetch_codex(agent: &crate::http::Client) -> Result<ProviderUsage, FetchError> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().unwrap_or_default().join(".codex"));
    let auth = read_json_file(&home.join("auth.json")).map_err(|e| match e.kind {
        FetchErrorKind::Missing => FetchError::missing("Não conectado — rode `codex` e faça login"),
        _ => e,
    })?;
    let token = auth["tokens"]["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| FetchError::missing("Não conectado — rode `codex` e faça login"))?;

    let bearer = format!("Bearer {token}");
    let mut headers: Vec<(&str, &str)> = vec![
        ("Authorization", &bearer),
        ("User-Agent", "codex-cli"),
        ("OpenAI-Beta", "codex-1"),
        ("originator", "Codex Desktop"),
    ];
    let account_id = auth["tokens"]["account_id"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if !account_id.is_empty() {
        headers.push(("ChatGPT-Account-Id", &account_id));
    }
    let data = get_json(
        agent,
        "https://chatgpt.com/backend-api/wham/usage",
        &headers,
    )
    .map_err(|e| match e.kind {
        FetchErrorKind::Auth => {
            FetchError::auth("Sessão do Codex expirada — rode `codex` para renovar")
        }
        _ => e,
    })?;

    let mut windows: Vec<UsageWindow> = Vec::new();
    for raw in [
        &data["rate_limit"]["primary_window"],
        &data["rate_limit"]["secondary_window"],
    ] {
        let Some(pct) = percent(&raw["used_percent"]) else {
            continue;
        };
        let minutes = raw["limit_window_seconds"]
            .as_u64()
            .map(|s| (s / 60) as u32)
            .unwrap_or(10_080);
        let key = key_for_minutes(minutes);
        if windows.iter().any(|w| w.key == key) {
            continue; // two windows of the same size: the primary one is enough
        }
        windows.push(UsageWindow {
            key,
            used_percent: pct,
            window_minutes: minutes,
            resets_at: raw["reset_at"].as_i64().map(|s| s * 1000),
        });
    }
    if windows.is_empty() {
        return Err(FetchError::other("Resposta sem janelas de uso"));
    }

    let plan = data["plan_type"].as_str().map(|p| match p {
        "plus" => "Plus".into(),
        "pro" => "Pro".into(),
        "team" => "Team".into(),
        other => other.to_owned(),
    });

    Ok(ProviderUsage {
        id: "codex".into(),
        name: "Codex".into(),
        plan,
        account: data["email"].as_str().map(str::to_owned),
        windows,
        status: "ok".into(),
        error: None,
        updated_at: epoch_ms_now(),
    })
}

/// Names the window by its actual size, not by its position in the JSON: Codex
/// has already swapped which one is "primary" between weekly and 5 h across versions.
fn key_for_minutes(minutes: u32) -> String {
    match minutes {
        0..=1_440 => "session",
        1_441..=20_160 => "weekly",
        _ => "monthly",
    }
    .into()
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

fn fetch_grok(agent: &crate::http::Client) -> Result<ProviderUsage, FetchError> {
    let path = crate::paths::home_dir().unwrap_or_default().join(".grok/auth.json");
    let auth = read_json_file(&path).map_err(|e| match e.kind {
        FetchErrorKind::Missing => FetchError::missing("Não conectado — rode `grok` e faça login"),
        _ => e,
    })?;
    // The file is a map "<issuer>::<client>" → session; take the first one with
    // a usable key.
    let entry = auth
        .as_object()
        .and_then(|m| {
            m.values()
                .find(|v| v["key"].as_str().is_some_and(|k| !k.is_empty()))
        })
        .ok_or_else(|| FetchError::missing("Não conectado — rode `grok` e faça login"))?;
    if parse_iso_ms(&entry["expires_at"]).is_some_and(|t| t <= epoch_ms_now()) {
        return Err(FetchError::auth(
            "Sessão do Grok expirada — rode `grok` para renovar",
        ));
    }
    let token = entry["key"].as_str().unwrap_or_default();

    let bearer = format!("Bearer {token}");
    let mut headers: Vec<(&str, &str)> = vec![
        ("Authorization", &bearer),
        ("X-XAI-Token-Auth", "xai-grok-cli"),
    ];
    let user_id = entry["user_id"].as_str().unwrap_or("").to_owned();
    if !user_id.is_empty() {
        headers.push(("x-userid", &user_id));
    }
    let data = get_json(
        agent,
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        &headers,
    )
    .map_err(|e| match e.kind {
        FetchErrorKind::Auth => {
            FetchError::auth("Sessão do Grok expirada — rode `grok` para renovar")
        }
        _ => e,
    })?;
    let config = if data["config"].is_object() {
        &data["config"]
    } else {
        &data
    };

    let mut windows = Vec::new();
    if let Some(pct) = percent(&config["creditUsagePercent"]) {
        let weekly = config["currentPeriod"]["type"]
            .as_str()
            .is_none_or(|t| t.contains("WEEKLY"));
        let resets_at = parse_iso_ms(&config["currentPeriod"]["end"])
            .or_else(|| parse_iso_ms(&config["billingPeriodEnd"]));
        windows.push(UsageWindow {
            key: if weekly { "weekly" } else { "monthly" }.into(),
            used_percent: pct,
            window_minutes: if weekly { 10_080 } else { 43_200 },
            resets_at,
        });
    }
    if windows.is_empty() {
        return Err(FetchError::other("Resposta sem janelas de uso"));
    }

    Ok(ProviderUsage {
        id: "grok".into(),
        name: "Grok".into(),
        plan: config["subscriptionTier"]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
        account: entry["email"].as_str().map(str::to_owned),
        windows,
        status: "ok".into(),
        error: None,
        updated_at: epoch_ms_now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned when the client moved from ureq to reqwest: the backoff policy
    /// depends on these three classes, and the user reads their messages.
    #[test]
    fn refused_usage_requests_are_classified_for_the_backoff() {
        use crate::http::testing::serve_once;
        let (url, server) = serve_once("429 Too Many Requests", &[], "");
        let error = get_json(&http_client().unwrap(), &url, &[("Authorization", "Bearer token")]).unwrap_err();
        assert!(matches!(error.kind, FetchErrorKind::RateLimited));
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("authorization: bearer token") && request.contains("accept: application/json"));
        let (url, server) = serve_once("403 Forbidden", &[], "");
        let error = get_json(&http_client().unwrap(), &url, &[]).unwrap_err();
        assert!(matches!(error.kind, FetchErrorKind::Auth));
        assert_eq!(error.message, "Sessão recusada (HTTP 403)");
        server.join().unwrap();
        let (url, server) = serve_once("500 Internal Server Error", &[], "");
        let error = get_json(&http_client().unwrap(), &url, &[]).unwrap_err();
        assert!(matches!(error.kind, FetchErrorKind::Other));
        assert_eq!(error.message, "Consulta falhou (HTTP 500)");
        server.join().unwrap();
    }

    #[test]
    fn an_answered_usage_request_comes_back_parsed() {
        let (url, server) = crate::http::testing::serve_once("200 OK", &["Content-Type: application/json"], r#"{"five_hour":{"utilization":12}}"#);
        let value = get_json(&http_client().unwrap(), &url, &[]).map_err(|error| error.message).unwrap();
        assert_eq!(value["five_hour"]["utilization"], 12);
        server.join().unwrap();
    }

    /// Three HTTPS requests a minute, all night, for a bar on a window hidden
    /// to the tray: the timer skips its turn while the window is off screen.
    /// A refresh someone asked for (the window coming back into focus, an
    /// agent that went idle, the button) still goes, as it always did.
    #[test]
    fn the_timer_fetches_only_for_a_window_on_screen_and_an_asked_refresh_always_does() {
        assert!(cycle_runs(false, true), "the timer, window on screen");
        assert!(!cycle_runs(false, false), "the timer, window hidden");
        assert!(cycle_runs(true, false), "an asked refresh, window hidden");
        assert!(cycle_runs(true, true));
    }

    /// A provider whose last fetch was polled at `base`, next due by its timer
    /// at `next`, with the last result a success or a failure.
    fn polled(id: &'static str, base: Instant, next: Duration, failed: bool) -> ProviderPoll {
        let mut poll = ProviderPoll::new(id);
        poll.last_attempt = Some(base);
        poll.next_allowed = base + next;
        poll.failed = failed;
        poll
    }

    /// The regression: focus, an idle agent and the button each forced a
    /// fetch, and a forced fetch ignored the backoff, so a provider answering
    /// 429 was asked again every few seconds and stayed rate limited.
    #[test]
    fn a_forced_refresh_waits_out_the_backoff_of_a_provider_whose_last_fetch_failed() {
        let base = Instant::now();
        let limited = polled("claude", base, RATE_LIMITED_BACKOFF, true);
        assert!(!limited.due(base + Duration::from_secs(10), true));
        assert!(limited.due(base + RATE_LIMITED_BACKOFF, true));
        let broken = polled("codex", base, ERROR_BACKOFF, true);
        assert!(!broken.due(base + Duration::from_secs(10), true));
        assert!(broken.due(base + ERROR_BACKOFF, true));
    }

    #[test]
    fn a_forced_refresh_of_a_provider_whose_last_fetch_succeeded_only_waits_the_anti_burst_floor() {
        let base = Instant::now();
        let healthy = polled("claude", base, POLL_INTERVAL, false);
        assert!(!healthy.due(base + Duration::from_secs(4), true));
        assert!(healthy.due(base + FORCED_MIN_GAP, true));
        assert!(!healthy.due(base + FORCED_MIN_GAP, false), "the timer still waits its full interval");
    }

    #[test]
    fn a_refresh_asked_for_one_provider_forces_that_provider_and_none_forces_all() {
        assert_eq!(forced_by(Some("claude")), vec!["claude"]);
        assert_eq!(forced_by(Some("grok")), vec!["grok"]);
        assert_eq!(forced_by(None), vec!["claude", "codex", "grok"]);
        assert!(forced_by(Some("unknown")).is_empty());
        let base = Instant::now();
        let at = base + Duration::from_secs(10);
        let claude = polled("claude", base, POLL_INTERVAL, false);
        let codex = polled("codex", base, POLL_INTERVAL, false);
        assert!(selected(&claude, at, &["claude"], true));
        assert!(!selected(&codex, at, &["claude"], true), "the other providers keep their timer");
        assert!(selected(&codex, base + POLL_INTERVAL, &["claude"], true));
        assert!(!selected(&codex, base + POLL_INTERVAL, &["claude"], false), "and their timer skips a hidden window");
    }
}
