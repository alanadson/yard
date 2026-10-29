//! Native automation selects durable queue heads independently of a renderer timer.
use std::collections::{HashMap, HashSet};
use serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookPhase { Unknown, Working, Permission, Ready }

pub struct ReadinessSnapshot<'a> {
    pub live: bool,
    pub last_output_at: i64,
    pub last_input_at: i64,
    pub phase: HookPhase,
    pub tail: &'a str,
}

pub fn input_ready(snapshot: &ReadinessSnapshot<'_>, now: i64) -> bool {
    snapshot.live && !matches!(snapshot.phase, HookPhase::Working | HookPhase::Permission)
        && now.saturating_sub(snapshot.last_output_at.max(snapshot.last_input_at)) >= 5000
        && !permission_prompt(snapshot.tail)
}

pub fn native_hooks_configured(program: &str, args: &[String]) -> bool {
    let normalized = program.replace('\\', "/").to_ascii_lowercase();
    let name = normalized.rsplit('/').next().unwrap_or("");
    let name = [".exe", ".cmd", ".bat", ".ps1"].iter().find_map(|suffix| name.strip_suffix(suffix)).unwrap_or(name);
    match name {
        "claude" => args.windows(2).any(|pair| pair[0] == "--settings"
            && pair[1].replace('\\', "/").rsplit('/').next().is_some_and(|file| file.eq_ignore_ascii_case(crate::bridge::CLAUDE_HOOKS_FILE))),
        "codex" => args.iter().any(|argument| argument == "notify=[\"yard\",\"hook\",\"codex\"]"),
        _ => false,
    }
}

pub fn ready_terminal(state: &crate::state::AppState, terminal_id: &str, now: i64) -> bool {
    use std::sync::atomic::Ordering;
    let Some(handle) = state.ptys.lock().get(terminal_id).cloned() else { return false; };
    let (shared, scrollback) = { let handle = handle.lock(); (handle.shared.clone(), handle.scrollback.clone()) };
    let tail = scrollback.lock().tail(16 * 1024);
    input_ready(&ReadinessSnapshot {
        live: shared.reading.load(Ordering::Acquire) && !shared.stopping.load(Ordering::Acquire),
        last_output_at: shared.last_byte_at.load(Ordering::Acquire),
        last_input_at: state.scheduler.last_input_at(terminal_id),
        phase: state.scheduler.phase(terminal_id), tail: &tail,
    }, now)
}

/// The terminals automation already owns: managed work, legacy flows and
/// native flows. None of them is ready for other automatic input.
fn automation_executors(state: &crate::state::AppState) -> Result<HashSet<String>, String> {
    let mut owned = crate::work::active_executors(&state.db.lock()).map_err(|error| error.message)?;
    owned.extend(crate::flows::legacy_executors(&state.db.lock())?);
    owned.extend(crate::flows::active_executors(&state.db.lock())?);
    Ok(owned)
}

/// The live terminals ready for automatic input, without the per-terminal
/// directory work `execution_resources` does for the queue.
fn ready_terminals(state: &crate::state::AppState, now: i64, owned: &HashSet<String>) -> HashSet<String> {
    let ids: Vec<String> = state.ptys.lock().keys().cloned().collect();
    ids.into_iter().filter(|id| !owned.contains(id) && ready_terminal(state, id, now)).collect()
}

pub(crate) fn execution_resources(state: &crate::state::AppState, now: i64) -> Result<Vec<ExecutionResource>, String> {
    use std::sync::atomic::Ordering;
    let owned = automation_executors(state)?;
    let handles: Vec<_> = state.ptys.lock().iter().map(|(id, handle)| (id.clone(), handle.clone())).collect();
    let observed: Vec<_> = handles.into_iter().map(|(id, handle)| {
        let (meta, shared) = { let handle = handle.lock(); (handle.meta.clone(), handle.shared.clone()) };
        let live = shared.reading.load(Ordering::Acquire) && !shared.stopping.load(Ordering::Acquire);
        let ready = !owned.contains(&id) && ready_terminal(state, &id, now);
        (id, meta, live, ready)
    }).collect();
    let mut directories = state.scheduler.directories.lock();
    directories.retain(|terminal| observed.iter().any(|(id, ..)| id == terminal));
    Ok(observed.into_iter().map(|(id, meta, live, ready)| {
        let directory = directories.resolve(&id, &meta.cwd, |cwd| std::fs::canonicalize(cwd)
            .map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|_| cwd.to_string()));
        ExecutionResource { terminal_id: id, directory, active: live && meta.kind == "agent" && !ready, ready }
    }).collect())
}

/// How many waiting flows may start their next stage now: the automation
/// slots `flow_stage_budget` leaves, or none when the busy agents cannot be
/// read.
pub(crate) fn flow_budget(state: &crate::state::AppState, waiting: &HashSet<&str>, now: i64) -> usize {
    let items = match crate::queue::read(&state.db.lock()) {
        Ok(items) => items,
        Err(error) => { state.scheduler.warn("flow-budget", Some(&error), "native flow capacity unavailable"); return 0; }
    };
    let resources = match execution_resources(state, now) {
        Ok(resources) => { state.scheduler.warn("flow-budget", None, ""); resources }
        Err(error) => { state.scheduler.warn("flow-budget", Some(&error), "native flow capacity unavailable"); return 0; }
    };
    let scheduled = state.scheduler.scheduled.lock().iter().filter(|id| !id.starts_with("flow:")).count();
    flow_stage_budget(&items, &resources, waiting, scheduled, dispatch_policy(state).maximum)
}

fn dispatch_policy(state: &crate::state::AppState) -> DispatchPolicy {
    let connection = state.db.lock();
    let maximum = crate::persistence::db::kv_get(&connection, "automationMaxAgents");
    let lock_directories = crate::persistence::db::kv_get(&connection, "automationLockDirectories");
    DispatchPolicy::from_saved(maximum.as_deref(), lock_directories.as_deref())
}

/// Whether automation is paused right now, as saved by the page.
pub(crate) fn paused(state: &crate::state::AppState) -> bool {
    automation_paused(crate::persistence::db::kv_get(&state.db.lock(), AUTOMATION_PAUSED).as_deref())
}

fn admitted_head(state: &crate::state::AppState, id: &str, now: i64) -> bool {
    if paused(state) { return false; }
    let Ok(items) = crate::queue::read(&state.db.lock()) else { return false; };
    let policy = dispatch_policy(state);
    let mut scheduled = state.scheduler.scheduled.lock().clone();
    scheduled.remove(id);
    let Ok(resources) = execution_resources(state, now) else { return false; };
    resource_heads(&items, &resources, policy.maximum, &scheduled, policy.lock_directories).iter().any(|candidate| candidate == id)
}

fn prepare_checkpoint_in(
    store: &std::path::Path, program: &str, kind: &str, root: &std::path::Path,
    item: &Value, now: i64,
) -> Result<Option<crate::checkpoints::Checkpoint>, String> {
    let program = program.replace('\\', "/").to_ascii_lowercase();
    let name = program.rsplit('/').next().unwrap_or("");
    if kind != "agent" || item["source"] == "bridge" || matches!(name, "ssh" | "ssh.exe" | "wsl" | "wsl.exe") {
        return Ok(None);
    }
    crate::checkpoint_commands::serialized(|| {
        if !crate::scm::info(root)?.is_repo { return Ok(None); }
        let id = item["taskId"].as_str().or_else(|| item["id"].as_str()).ok_or("Missing checkpoint request identity")?;
        let text = item["text"].as_str().ok_or("Missing checkpoint request text")?;
        let label: String = text.lines().next().unwrap_or("").chars().take(160).collect();
        crate::checkpoints::create(store, root, id, text, &label, now).map(Some)
    })
}

pub(crate) fn prepare_checkpoint(state: &crate::state::AppState, terminal: &str, item: &Value, now: i64) {
    let Some(handle) = state.ptys.lock().get(terminal).cloned() else { return; };
    let meta = handle.lock().meta.clone();
    let outcome = prepare_checkpoint_in(
        &crate::paths::app_dir().join("checkpoints"), &meta.program, &meta.kind,
        std::path::Path::new(&meta.cwd), item, now,
    );
    let mut request = item.clone();
    request["terminalId"] = serde_json::json!(terminal);
    if let Err(error) = crate::work::record_checkpoint_outcome(&mut state.db.lock(), &request, &meta.cwd, outcome, now) {
        tracing::warn!(%error, request = %item["id"], "native checkpoint outcome could not be recorded");
    }
}

pub fn run_once(state: &crate::state::AppState, now: i64, budget: usize) -> Result<Vec<(String, crate::queue::DispatchResult)>, String> {
    if paused(state) { return Ok(Vec::new()); }
    let items = crate::queue::read(&state.db.lock())?;
    let policy = dispatch_policy(state);
    let resources = execution_resources(state, now)?;
    let due = resource_heads(&items, &resources, budget.min(policy.maximum), &state.scheduler.scheduled.lock(), policy.lock_directories);
    let mut outcomes = Vec::new();
    for id in due {
        let item = items.iter().find(|item| item["id"].as_str() == Some(&id)).unwrap();
        let terminal = item["terminalId"].as_str().unwrap();
        if !ready_terminal(state, terminal, now) { continue; }
        prepare_checkpoint(state, terminal, item, now);
        if !ready_terminal(state, terminal, now) { continue; }
        outcomes.push((id.clone(), crate::queue::dispatch_owned(state, &id, terminal, now)?));
    }
    Ok(outcomes)
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HookReport {
    pub terminal_id: String,
    pub sequence: u64,
    pub at: i64,
    pub event: HookEvent,
}

pub type HookSink = std::sync::Arc<dyn Fn(HookReport) + Send + Sync>;

#[derive(Default)]
pub struct SchedulerState {
    hooks: parking_lot::Mutex<HashMap<String, HookReport>>,
    inputs: parking_lot::Mutex<HashMap<String, i64>>,
    expected_hooks: parking_lot::Mutex<HashSet<String>>,
    scheduled: parking_lot::Mutex<HashSet<String>>,
    sequence: std::sync::atomic::AtomicU64,
    hook_sink: parking_lot::Mutex<Option<HookSink>>,
    directories: parking_lot::Mutex<DirectoryCache>,
    warnings: parking_lot::Mutex<RepeatedWarnings>,
}

impl SchedulerState {
    pub fn schedule(&self, id: &str) -> bool { self.scheduled.lock().insert(id.into()) }
    pub fn unschedule(&self, id: &str) { self.scheduled.lock().remove(id); }
    pub fn scheduled_count(&self) -> usize { self.scheduled.lock().len() }

    /// Logs `message` with `error` for `site` once per distinct error
    /// (`RepeatedWarnings`); `None` records that the site works again.
    pub fn warn(&self, site: &str, error: Option<&str>, message: &str) {
        if self.warnings.lock().should_log(site, error) {
            tracing::warn!(error = error.unwrap_or_default(), site, "{message}");
        }
    }

    pub fn expect_hooks(&self, terminal_id: &str, expected: bool) {
        let mut configured = self.expected_hooks.lock();
        if expected { configured.insert(terminal_id.into()); } else { configured.remove(terminal_id); }
    }

    pub fn install_hook_sink(&self, sink: HookSink) {
        *self.hook_sink.lock() = Some(sink);
    }

    pub fn mark_input(&self, terminal_id: &str, at: i64, submitted: bool) -> Option<HookReport> {
        self.inputs.lock().insert(terminal_id.into(), at);
        let previous = self.hooks.lock().get(terminal_id).cloned();
        if !submitted { return None; }
        if previous.is_none() && !self.expected_hooks.lock().contains(terminal_id) { return None; }
        self.record(terminal_id, HookEvent { kind: "turn-start", session_id: previous.and_then(|record| record.event.session_id), ask: None }, at)
    }

    pub fn last_input_at(&self, terminal_id: &str) -> i64 { self.inputs.lock().get(terminal_id).copied().unwrap_or(0) }

    pub fn record(&self, terminal_id: &str, event: HookEvent, at: i64) -> Option<HookReport> {
        if event.kind == "session" { return None; }
        let mut hooks = self.hooks.lock();
        let sequence = self.sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let report = HookReport { terminal_id: terminal_id.into(), sequence, at, event };
        hooks.insert(terminal_id.into(), report.clone());
        drop(hooks);
        let sink = self.hook_sink.lock().clone();
        if let Some(sink) = sink { sink(report.clone()); }
        // A turn that ended (or a permission answered) can make a terminal
        // ready for the work waiting on it.
        wake();
        Some(report)
    }

    pub fn phase(&self, terminal_id: &str) -> HookPhase {
        match self.hooks.lock().get(terminal_id).map(|report| report.event.kind) {
            Some("turn-start" | "working") => HookPhase::Working,
            Some("permission") => HookPhase::Permission,
            Some("turn-end") => HookPhase::Ready,
            _ => HookPhase::Unknown,
        }
    }

    pub fn snapshot(&self) -> Vec<HookReport> {
        let mut reports: Vec<_> = self.hooks.lock().values().cloned().collect();
        reports.sort_by_key(|report| report.sequence);
        reports
    }

    pub fn clear(&self, terminal_id: &str) {
        self.hooks.lock().remove(terminal_id);
        self.inputs.lock().remove(terminal_id);
        self.expected_hooks.lock().remove(terminal_id);
    }
}

/// Remembers the last error each scheduler site logged, so a persistent one
/// is logged once instead of on every pass.
#[derive(Default)]
pub struct RepeatedWarnings(HashMap<String, String>);

impl RepeatedWarnings {
    /// Whether this outcome of `site` deserves a log line: a new or changed
    /// error does, a repeat does not, and `None` (it worked) clears the site.
    pub fn should_log(&mut self, site: &str, error: Option<&str>) -> bool {
        match error {
            None => { self.0.remove(site); false }
            Some(error) if self.0.get(site).map(String::as_str) == Some(error) => false,
            Some(error) => { self.0.insert(site.into(), error.into()); true }
        }
    }
}

/// How many flows may start their next stage now under `automationMaxAgents`.
/// The agents already busy count against it (an active agent, an uncertain
/// queue delivery, a queue delivery scheduled on a lane) but not the executors
/// in `waiting`, which are idle between their stages: counting them would let
/// waiting flows block each other forever.
pub fn flow_stage_budget(items: &[Value], resources: &[ExecutionResource], waiting: &HashSet<&str>, scheduled: usize, maximum: usize) -> usize {
    let uncertain: HashSet<_> = items.iter().filter(|item| item.get("delivery").is_some())
        .filter_map(|item| item["terminalId"].as_str()).collect();
    let busy = resources.iter()
        .filter(|resource| resource.active || uncertain.contains(resource.terminal_id.as_str()))
        .filter(|resource| !waiting.contains(resource.terminal_id.as_str()))
        .count();
    maximum.saturating_sub(busy + scheduled)
}

/// The pass cadence while there is work in progress.
const BUSY_CADENCE_MS: i64 = 2_000;
/// The longest the scheduler sleeps with nothing pending.
const IDLE_CAP_MS: i64 = 30_000;

/// How long the scheduler waits before its next pass (a `wake` ends it
/// sooner): the two-second cadence while work is pending (queued items, an
/// active flow) or a routine is due within it; otherwise until the next
/// routine, at most 30 s.
pub fn next_wait(now: i64, pending_work: bool, next_routine_due: Option<i64>) -> std::time::Duration {
    let until = next_routine_due.map_or(IDLE_CAP_MS, |due| due.saturating_sub(now));
    let wait = if pending_work || until <= BUSY_CADENCE_MS { BUSY_CADENCE_MS } else { until.min(IDLE_CAP_MS) };
    std::time::Duration::from_millis(wait as u64)
}

/// Each terminal's resolved working directory, so the disk is asked once per
/// directory instead of on every pass.
#[derive(Default)]
pub struct DirectoryCache(HashMap<String, (String, String)>);

impl DirectoryCache {
    /// The resolved form of `cwd` for `terminal`, computed with `resolve` only
    /// the first time or when the terminal's working directory changed.
    pub fn resolve(&mut self, terminal: &str, cwd: &str, resolve: impl FnOnce(&str) -> String) -> String {
        match self.0.get(terminal) {
            Some((saved, resolved)) if saved == cwd => resolved.clone(),
            _ => {
                let resolved = resolve(cwd);
                self.0.insert(terminal.into(), (cwd.into(), resolved.clone()));
                resolved
            }
        }
    }

    /// Forgets the terminals `keep` rejects (closed ones).
    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.0.retain(|terminal, _| keep(terminal));
    }
}

/// The scheduler's doorbell: whoever creates work rings it (`wake`), and the
/// scheduler waits on it between passes instead of polling.
pub struct Wakeup {
    rung: parking_lot::Mutex<bool>,
    signal: parking_lot::Condvar,
}

impl Wakeup {
    pub const fn new() -> Self {
        Self { rung: parking_lot::Mutex::new(false), signal: parking_lot::Condvar::new() }
    }

    pub fn wake(&self) {
        *self.rung.lock() = true;
        self.signal.notify_all();
    }

    /// Waits until rung or `timeout`; `true` when it was rung. A ring that
    /// came before the wait counts, and each ring ends one wait.
    pub fn wait(&self, timeout: std::time::Duration) -> bool {
        let mut rung = self.rung.lock();
        if !*rung {
            let _ = self.signal.wait_for(&mut rung, timeout);
        }
        std::mem::take(&mut *rung)
    }
}

impl Default for Wakeup {
    fn default() -> Self { Self::new() }
}

static WAKEUP: Wakeup = Wakeup::new();

/// Asks the native scheduler to look again now: queued work, a flow start, a
/// saved workspace (routines), the pause switched, a terminal that changed.
pub fn wake() { WAKEUP.wake(); }

struct ScheduledJob {
    state: std::sync::Arc<crate::state::AppState>,
    id: String,
}

impl Drop for ScheduledJob {
    fn drop(&mut self) { self.state.scheduler.unschedule(&self.id); }
}

pub fn start(state: std::sync::Arc<crate::state::AppState>, runtime: crate::runtime::AutomationRuntime) {
    let spawned = std::thread::Builder::new().name("native-scheduler".into()).spawn(move || {
        let mut routines = crate::routines::RoutineClock::default();
        let mut wait = std::time::Duration::from_millis(BUSY_CADENCE_MS as u64);
        loop {
            WAKEUP.wait(wait);
            wait = tick(&runtime, &state, &mut routines, crate::pty::reader::now_ms());
            // The scheduler's own writes are announced but do not ring its
            // doorbell: it already decided when to look again.
            runtime.publish_changes();
        }
    });
    if let Err(error) = spawned {
        tracing::error!(%error, "native scheduler thread could not start");
    }
}

/// One pass of the native scheduler: flows, routines, then queue heads.
/// Returns how long to wait before the next pass (`next_wait`).
fn tick(runtime: &crate::runtime::AutomationRuntime, state: &std::sync::Arc<crate::state::AppState>, routines: &mut crate::routines::RoutineClock, now: i64) -> std::time::Duration {
    let paused = paused(state);
    let flows_active = crate::flows::schedule(runtime, state, paused, now);
    if paused {
        return next_wait(now, flows_active, None);
    }
    let ready = if routines.may_be_due(now) {
        match automation_executors(state) {
            Ok(owned) => { state.scheduler.warn("resources", None, ""); ready_terminals(state, now, &owned) }
            Err(error) => { state.scheduler.warn("resources", Some(&error), "native scheduler could not read active work"); HashSet::new() }
        }
    } else {
        HashSet::new()
    };
    match crate::routines::enqueue_due(&mut state.db.lock(), now, |id| ready.contains(id), routines) {
        Ok(_) => state.scheduler.warn("routines", None, ""),
        Err(error) => state.scheduler.warn("routines", Some(&error), "native routine reservation failed"),
    }
    let live: HashSet<String> = state.ptys.lock().keys().cloned().collect();
    let routine_waiting = routines.waiting_on().iter().any(|terminal| live.contains(terminal));
    let items = match crate::queue::read(&state.db.lock()) {
        Ok(items) => { state.scheduler.warn("queue", None, ""); items }
        Err(error) => {
            state.scheduler.warn("queue", Some(&error), "native queue scheduler could not read durable work");
            return next_wait(now, true, routines.next_due());
        }
    };
    let queued = items.iter().any(|item| item.get("delivery").is_none());
    if queued {
        dispatch_heads(runtime, state, &items, now);
    }
    next_wait(now, flows_active || queued || routine_waiting, routines.next_due())
}

/// Hands each admitted queue head to its terminal's lane.
fn dispatch_heads(runtime: &crate::runtime::AutomationRuntime, state: &std::sync::Arc<crate::state::AppState>, items: &[Value], now: i64) {
    let resources = match execution_resources(state, now) {
        Ok(resources) => { state.scheduler.warn("resources", None, ""); resources }
        Err(error) => { state.scheduler.warn("resources", Some(&error), "native scheduler could not read active work"); return; }
    };
    let policy = dispatch_policy(state);
    let due = resource_heads(items, &resources, policy.maximum,
        &state.scheduler.scheduled.lock(), policy.lock_directories);
    for id in due {
        if !state.scheduler.schedule(&id) { continue; }
        let terminal = items.iter().find(|item| item["id"].as_str() == Some(&id)).unwrap()["terminalId"].as_str().unwrap().to_string();
        let job = ScheduledJob { state: state.clone(), id: id.clone() };
        runtime.submit(&format!("pty:{terminal}"), move || {
            deliver_head(&job, &terminal);
        });
    }
}

/// A lane job: checks the head is still admitted, takes its checkpoint and
/// writes it to the terminal.
fn deliver_head(job: &ScheduledJob, terminal: &str) {
    let now = crate::pty::reader::now_ms();
    if !ready_terminal(&job.state, terminal, now) || !admitted_head(&job.state, &job.id, now) { return; }
    let current = match crate::queue::read(&job.state.db.lock()) {
        Ok(items) => items.into_iter().find(|item| item["terminalId"] == terminal),
        Err(error) => { tracing::warn!(%error, "native checkpoint queue lookup failed"); return; }
    };
    let Some(item) = current.filter(|item| item["id"] == job.id && item.get("delivery").is_none()) else { return; };
    prepare_checkpoint(&job.state, terminal, &item, now);
    let now = crate::pty::reader::now_ms();
    if !ready_terminal(&job.state, terminal, now) || !admitted_head(&job.state, &job.id, now) { return; }
    if let Err(error) = crate::queue::dispatch_owned(&job.state, &job.id, terminal, now) {
        tracing::warn!(%error, request = %job.id, "native queue delivery requires reconciliation");
    }
}

pub fn parse_hook(request: &Value) -> Option<(String, HookEvent)> {
    let terminal = request["terminal"].as_str().filter(|value| !value.trim().is_empty())?;
    let args = request["argv"].as_array()?;
    if !args.first()?.as_str()?.eq_ignore_ascii_case("hook") { return None; }
    let verb = args.get(1)?.as_str()?.to_ascii_lowercase();
    if verb == "codex" {
        let body: Value = serde_json::from_str(args.get(2)?.as_str()?).ok()?;
        return (body["type"] == "agent-turn-complete").then(|| (terminal.to_string(), HookEvent { kind: "turn-end", session_id: None, ask: None }));
    }
    let kind = match verb.as_str() {
        "prompt" => "turn-start", "stop" => "turn-end", "permission" => "permission", "tool" => "working", "session" => "session",
        _ => return None,
    };
    let body: Value = serde_json::from_str(request["stdin"].as_str().unwrap_or("")).unwrap_or(Value::Null);
    let session_id = body["session_id"].as_str().map(str::trim).filter(|id| !id.is_empty()).map(str::to_string);
    let ask = (kind == "permission").then(|| body["message"].as_str().unwrap_or("").trim().to_string());
    Some((terminal.to_string(), HookEvent { kind, session_id, ask }))
}

pub fn due_heads(items: &[Value], ready: impl Fn(&str) -> bool, budget: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut due = Vec::new();
    for item in items {
        if due.len() >= budget { break; }
        let Some(terminal) = item["terminalId"].as_str() else { continue; };
        if !seen.insert(terminal) || item.get("delivery").is_some() || !ready(terminal) { continue; }
        if let Some(id) = item["id"].as_str() { due.push(id.to_string()); }
    }
    due
}

pub struct ExecutionResource {
    pub terminal_id: String,
    pub directory: String,
    pub active: bool,
    pub ready: bool,
}

pub struct DispatchPolicy {
    pub maximum: usize,
    pub lock_directories: bool,
}

impl DispatchPolicy {
    pub fn from_saved(maximum: Option<&str>, lock_directories: Option<&str>) -> Self {
        let maximum = maximum.and_then(|value| value.parse::<f64>().ok()).filter(|value| value.is_finite())
            .unwrap_or(2.0).round().clamp(1.0, 16.0) as usize;
        Self { maximum, lock_directories: lock_directories != Some("false") }
    }
}

fn directory_key(directory: &str) -> String {
    let key = directory.replace('\\', "/").trim_end_matches('/').to_string();
    #[cfg(windows)]
    let key = key.to_ascii_lowercase();
    key
}

pub fn resource_heads(items: &[Value], resources: &[ExecutionResource], maximum: usize, scheduled: &HashSet<String>, lock_directories: bool) -> Vec<String> {
    let due = due_heads(items, |id| resources.iter().any(|resource| resource.terminal_id == id && resource.ready), items.len());
    let uncertain: HashSet<_> = items.iter().filter(|item| item.get("delivery").is_some())
        .filter_map(|item| item["terminalId"].as_str()).collect();
    let active = resources.iter().filter(|resource| resource.active || uncertain.contains(resource.terminal_id.as_str())).count();
    let budget = maximum.saturating_sub(active).saturating_sub(scheduled.len()).min(2usize.saturating_sub(scheduled.len()));
    let mut selected = Vec::new();
    let mut directories: HashSet<_> = resources.iter().filter(|resource| resource.active || uncertain.contains(resource.terminal_id.as_str()))
        .map(|resource| directory_key(&resource.directory)).collect();
    for item in items.iter().filter(|item| item["id"].as_str().is_some_and(|id| scheduled.contains(id))) {
        if let Some(resource) = resources.iter().find(|resource| item["terminalId"] == resource.terminal_id) {
            directories.insert(directory_key(&resource.directory));
        }
    }
    for id in due {
        if selected.len() >= budget { break; }
        if scheduled.contains(&id) { continue; }
        let terminal = items.iter().find(|item| item["id"] == id).unwrap()["terminalId"].as_str().unwrap();
        let resource = resources.iter().find(|resource| resource.terminal_id == terminal).unwrap();
        if lock_directories && !directories.insert(directory_key(&resource.directory)) { continue; }
        selected.push(id);
    }
    selected
}

/// The kv key the page writes to pause automation:
/// `{"reason":"budget"|"quota"|"user","at":<epoch ms>}`.
pub const AUTOMATION_PAUSED: &str = "automation.paused";

/// Whether the saved `automation.paused` value pauses automation. Only a
/// pause record (a JSON object) does; a missing, empty, `null` or unreadable
/// value means automation runs.
pub fn automation_paused(value: Option<&str>) -> bool {
    value.and_then(|raw| serde_json::from_str::<Value>(raw).ok()).is_some_and(|record| record.is_object())
}

/// The shortest interval a routine runs at, in minutes. A routine saved with
/// less is not rejected: it runs at this floor.
pub const ROUTINE_MIN_INTERVAL_MIN: f64 = 5.0;

/// A routine's interval in milliseconds, raised to the floor when saved below
/// it; `None` for an interval that is not a positive number.
pub fn routine_interval_ms(routine: &Value) -> Option<f64> {
    routine["everyMin"].as_f64().filter(|value| value.is_finite() && *value > 0.0)
        .map(|minutes| minutes.max(ROUTINE_MIN_INTERVAL_MIN) * 60_000.0)
}

/// When a routine is next due (epoch ms), or `None` when it never is.
pub fn routine_deadline(routine: &Value, last_delivery: Option<i64>) -> Option<i64> {
    if routine["enabled"] != true { return None; }
    let interval = routine_interval_ms(routine)?;
    let created = routine["createdAt"].as_i64()?;
    let saved = routine["lastRunAt"].as_i64().unwrap_or(created);
    let since = last_delivery.map_or(saved, |delivery| saved.max(delivery));
    Some(since.saturating_add(interval.ceil() as i64))
}

pub fn routine_due(routine: &Value, last_delivery: Option<i64>, now: i64) -> bool {
    routine_deadline(routine, last_delivery).is_some_and(|deadline| now >= deadline)
}

/// Whether a routine is overdue by more than one full interval: occurrences
/// were missed (the app was closed), not just the one it is due for.
pub fn routine_missed(routine: &Value, last_delivery: Option<i64>, now: i64) -> bool {
    let (Some(deadline), Some(interval)) = (routine_deadline(routine, last_delivery), routine_interval_ms(routine)) else { return false; };
    now.saturating_sub(deadline) as f64 > interval
}

pub fn permission_prompt(raw: &str) -> bool {
    static YES_NO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let yes_no = YES_NO.get_or_init(|| regex::Regex::new(r"(?i)[(\[]\s*(?:y|yes|s|sim)\s*/\s*(?:n|no|nao|não)\s*[)\]]").unwrap());
    let bytes = crate::pty_export::strip_ansi(raw.as_bytes());
    let plain = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<_> = plain.lines().map(|line| line.trim_matches(|character: char| character.is_whitespace() || "│┃║╎┆┇┊┋|".contains(character)))
        .filter(|line| !line.is_empty() && !line.chars().all(|character| character.is_whitespace() || "─━═╌╍┄┅┈┉╭╮╯╰┌┐└┘├┤┬┴┼╔╗╚╝║│┃▁▔_-".contains(character)))
        .rev().take(14).collect();
    lines.reverse();
    if lines.iter().rev().take(4).any(|line| yes_no.is_match(line)) { return true; }
    static PROMPTS: std::sync::OnceLock<(regex::Regex, regex::Regex)> = std::sync::OnceLock::new();
    let (secret, press_key) = PROMPTS.get_or_init(|| (
        regex::Regex::new(r"(?i)\b(?:password|passphrase|senha|token|api[\s_-]?key|secret|otp|2fa|c[oó]digo de verifica[cç][aã]o|verification code)\b.*:\s*$").unwrap(),
        regex::Regex::new(r"(?i)(?:press\s+(?:any\s+key|enter|return|\[enter\])|pressione\s+(?:enter|qualquer\s+tecla)|^--\s*more\s*--$|^\(end\)$)").unwrap(),
    ));
    if lines.iter().rev().take(2).any(|line| line.chars().count() <= 90 && secret.is_match(line))
        || lines.iter().rev().take(3).any(|line| press_key.is_match(line)) { return true; }
    static MENUS: std::sync::OnceLock<(regex::Regex, regex::Regex)> = std::sync::OnceLock::new();
    let (numbered, radio) = MENUS.get_or_init(|| (
        regex::Regex::new(r"^([❯➤▸▶►→>›»*]\s*)?\d{1,2}[.)]\s+\S").unwrap(),
        regex::Regex::new(r"(?i)^([●◉◆✔✓☑]|\(\s*[x*]\s*\)|\[\s*[x*]\s*\])\s+\S|^(?:[○◯◇☐]|\(\s*\)|\[\s*\])\s+\S").unwrap(),
    ));
    let (mut numbered_count, mut radio_count) = (0, 0);
    let (mut numbered_marked, mut radio_marked) = (false, false);
    let mut first = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some(entry) = numbered.captures(line) {
            numbered_count += 1;
            numbered_marked |= entry.get(1).is_some();
            first.get_or_insert(index);
        } else if let Some(entry) = radio.captures(line) {
            radio_count += 1;
            radio_marked |= entry.get(1).is_some();
            first.get_or_insert(index);
        }
    }
    ((numbered_count >= 2 && numbered_marked) || (radio_count >= 2 && radio_marked))
        && first.is_some_and(|index| lines[..index].iter().any(|line| line.ends_with('?')))
}

#[cfg(test)]
mod tests {
    // Autonomous delivery must preserve terminal FIFO and uncertainty barriers.
    use super::*;
    use serde_json::json;

    #[test]
    fn automatic_dispatch_selects_only_one_ready_terminal_for_the_same_working_directory() {
        let items = vec![json!({"id":"first","terminalId":"one"}), json!({"id":"same-directory","terminalId":"two"}), json!({"id":"other-directory","terminalId":"three"})];
        let resources = vec![
            ExecutionResource { terminal_id: "one".into(), directory: "C:/Repo/".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "two".into(), directory: "c:\\repo".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "three".into(), directory: "C:/Other".into(), active: false, ready: true },
        ];
        assert_eq!(resource_heads(&items, &resources, 2, &HashSet::new(), true), vec!["first", "other-directory"]);
        assert_eq!(resource_heads(&items, &resources, 2, &HashSet::new(), false), vec!["first", "same-directory"]);
    }

    #[test]
    fn automatic_dispatch_counts_existing_active_agents_against_the_global_limit() {
        let items = vec![json!({"id":"first","terminalId":"one"}), json!({"id":"second","terminalId":"two"})];
        let resources = vec![
            ExecutionResource { terminal_id: "one".into(), directory: "C:/One".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "two".into(), directory: "C:/Two".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "already-working".into(), directory: "C:/Busy".into(), active: true, ready: false },
        ];
        assert_eq!(resource_heads(&items, &resources, 2, &HashSet::new(), true), vec!["first"]);
        assert!(resource_heads(&items, &resources, 1, &HashSet::new(), true).is_empty());
        assert_eq!(resource_heads(&items, &resources, 16, &HashSet::new(), true), vec!["first", "second"]);
    }

    #[test]
    fn automatic_dispatch_keeps_an_active_agents_directory_reserved_for_its_whole_turn() {
        let items = vec![json!({"id":"competing","terminalId":"ready-peer"}), json!({"id":"independent","terminalId":"independent"})];
        let resources = vec![
            ExecutionResource { terminal_id: "working".into(), directory: "C:/Shared".into(), active: true, ready: false },
            ExecutionResource { terminal_id: "ready-peer".into(), directory: "C:/Shared".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "independent".into(), directory: "C:/Independent".into(), active: false, ready: true },
        ];
        assert_eq!(resource_heads(&items, &resources, 3, &HashSet::new(), true), vec!["independent"]);
    }

    #[test]
    fn a_pending_lane_job_holds_its_directory_before_terminal_input_starts() {
        let items = vec![json!({"id":"pending","terminalId":"one"}), json!({"id":"competing","terminalId":"two"}), json!({"id":"independent","terminalId":"three"})];
        let resources = vec![
            ExecutionResource { terminal_id: "one".into(), directory: "C:/Shared".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "two".into(), directory: "C:/Shared".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "three".into(), directory: "C:/Independent".into(), active: false, ready: true },
        ];
        assert_eq!(resource_heads(&items, &resources, 3, &HashSet::from(["pending".into()]), true), vec!["independent"]);
    }

    /// The regression: a persistent error in the scheduler logged a warning
    /// every two seconds. It is logged once, again when it changes, and again
    /// after it cleared and came back.
    #[test]
    fn a_repeated_scheduler_error_is_logged_once_until_it_changes_or_clears() {
        let mut warnings = RepeatedWarnings::default();
        assert!(warnings.should_log("queue", Some("database is locked")));
        assert!(!warnings.should_log("queue", Some("database is locked")));
        assert!(warnings.should_log("flows", Some("database is locked")), "each site on its own");
        assert!(warnings.should_log("queue", Some("disk I/O error")));
        assert!(!warnings.should_log("queue", None));
        assert!(warnings.should_log("queue", Some("disk I/O error")));
    }

    /// The regression: `automationMaxAgents` held queue and routine deliveries
    /// back, but a flow started its next stage regardless of how many agents
    /// automation already kept busy.
    #[test]
    fn a_flow_stage_only_gets_the_automation_slots_left_by_busy_agents() {
        let resource = |id: &str, active: bool| ExecutionResource { terminal_id: id.into(), directory: format!("C:/{id}"), active, ready: !active };
        let waiting = HashSet::from(["first", "second", "third"]);
        let flows = vec![resource("first", true), resource("second", true), resource("third", true)];
        assert_eq!(flow_stage_budget(&[], &flows, &waiting, 0, 2), 2, "executors waiting for a stage are not busy");
        let mut busy = flows;
        busy.push(resource("working", true));
        assert_eq!(flow_stage_budget(&[], &busy, &waiting, 0, 2), 1);
        assert_eq!(flow_stage_budget(&[], &busy, &waiting, 1, 2), 0, "a queue delivery already on its way");
        busy.push(resource("reviewing", false));
        let uncertain = vec![json!({"id":"unknown","terminalId":"reviewing","text":"Request","delivery":{"status":"uncertain","attemptedAt":1000}})];
        assert_eq!(flow_stage_budget(&uncertain, &busy, &waiting, 0, 3), 1, "an uncertain delivery keeps its slot");
    }

    /// The regression: the scheduler woke every two seconds forever, with the
    /// window hidden and nothing to do. That cadence is kept only while work
    /// is pending; otherwise it sleeps until the next routine, at most 30 s.
    #[test]
    fn the_scheduler_keeps_its_two_second_cadence_only_while_work_is_pending() {
        let seconds = std::time::Duration::from_secs;
        assert_eq!(next_wait(1_000, true, None), seconds(2), "pending work");
        assert_eq!(next_wait(1_000, true, Some(900_000)), seconds(2));
        assert_eq!(next_wait(1_000, false, None), seconds(30), "nothing to do");
        assert_eq!(next_wait(1_000, false, Some(11_000)), seconds(10), "until the next routine");
        assert_eq!(next_wait(1_000, false, Some(900_000)), seconds(30), "capped");
        assert_eq!(next_wait(1_000, false, Some(3_000)), seconds(2), "a routine due within two seconds");
        assert_eq!(next_wait(1_000, false, Some(500)), seconds(2), "a due routine waiting for its terminal");
    }

    /// The regression: `canonicalize` touched the disk for every terminal on
    /// every tick. A terminal's directory is resolved once per working
    /// directory, and a closed terminal is forgotten.
    #[test]
    fn a_terminal_directory_is_resolved_once_until_its_working_directory_changes() {
        let mut cache = DirectoryCache::default();
        let calls = std::cell::Cell::new(0);
        let resolve = |cwd: &str| { calls.set(calls.get() + 1); cwd.to_uppercase() };
        assert_eq!(cache.resolve("one", "c:/repo", resolve), "C:/REPO");
        assert_eq!(cache.resolve("one", "c:/repo", resolve), "C:/REPO");
        assert_eq!(calls.get(), 1);
        assert_eq!(cache.resolve("one", "c:/other", resolve), "C:/OTHER");
        assert_eq!(calls.get(), 2);
        cache.retain(|terminal| terminal == "two");
        cache.resolve("one", "c:/other", resolve);
        assert_eq!(calls.get(), 3);
    }

    /// A wake that arrives before the scheduler starts waiting is not lost:
    /// the next wait returns at once instead of sleeping through new work.
    #[test]
    fn a_wake_before_the_wait_ends_the_next_wait_at_once_and_only_that_one() {
        let wakeup = Wakeup::new();
        wakeup.wake();
        let started = std::time::Instant::now();
        assert!(wakeup.wait(std::time::Duration::from_secs(30)));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(!wakeup.wait(std::time::Duration::ZERO), "one wake ends one wait");
    }

    #[test]
    fn a_wake_from_another_thread_ends_a_wait_in_progress() {
        let wakeup = std::sync::Arc::new(Wakeup::new());
        let waiting = wakeup.clone();
        let waiter = std::thread::spawn(move || waiting.wait(std::time::Duration::from_secs(30)));
        wakeup.wake();
        assert!(waiter.join().unwrap());
    }

    /// The page pauses automation by writing this key and may clear it by
    /// deleting it or writing `null`; anything that is not a pause record must
    /// read as running, or a stray value would silently stop every routine.
    #[test]
    fn automation_reads_as_paused_only_for_a_pause_record_object() {
        assert_eq!(AUTOMATION_PAUSED, "automation.paused");
        assert!(!automation_paused(None));
        assert!(!automation_paused(Some("")));
        assert!(!automation_paused(Some("not json")));
        assert!(!automation_paused(Some("null")));
        assert!(automation_paused(Some(r#"{"reason":"budget","at":1000}"#)));
        assert!(automation_paused(Some(r#"{"reason":"quota","at":1000}"#)));
        assert!(automation_paused(Some(r#"{"reason":"user","at":1000}"#)));
    }

    #[test]
    fn saved_dispatch_preferences_are_bounded_and_keep_directory_protection_on_by_default() {
        let default = DispatchPolicy::from_saved(None, None);
        assert_eq!(default.maximum, 2);
        assert!(default.lock_directories);
        assert_eq!(DispatchPolicy::from_saved(Some("0"), None).maximum, 1);
        assert_eq!(DispatchPolicy::from_saved(Some("999"), None).maximum, 16);
        assert_eq!(DispatchPolicy::from_saved(Some("1.6"), None).maximum, 2);
        assert_eq!(DispatchPolicy::from_saved(Some("NaN"), None).maximum, 2);
        assert!(!DispatchPolicy::from_saved(None, Some("false")).lock_directories);
    }

    #[test]
    fn an_uncertain_delivery_keeps_its_agent_slot_and_directory_reserved_until_review() {
        let items = vec![json!({"id":"unknown-outcome","terminalId":"one","delivery":{"status":"uncertain","attemptedAt":1000}}),
            json!({"id":"competing","terminalId":"two"})];
        let resources = vec![
            ExecutionResource { terminal_id: "one".into(), directory: "C:/Shared".into(), active: false, ready: true },
            ExecutionResource { terminal_id: "two".into(), directory: "C:/Shared".into(), active: false, ready: true },
        ];
        assert!(resource_heads(&items, &resources, 2, &HashSet::new(), true).is_empty());
        assert!(resource_heads(&items, &resources, 1, &HashSet::new(), false).is_empty());
    }

    #[test]
    fn native_routine_deadlines_honor_the_last_delivery_and_reject_invalid_saved_schedules() {
        let mut routine = json!({"id":"reminder","terminalId":"agent","text":"Review the work","everyMin":5,"enabled":true,"createdAt":1000});
        assert!(!routine_due(&routine, None, 300999));
        assert!(routine_due(&routine, None, 301000));
        assert!(!routine_due(&routine, Some(301000), 600999));
        assert!(routine_due(&routine, Some(301000), 601000));
        routine["enabled"] = json!(false);
        assert!(!routine_due(&routine, None, 1000000));
        routine["enabled"] = json!(true);
        routine["everyMin"] = json!(-1);
        assert!(!routine_due(&routine, None, 1000000));
    }

    /// A one-minute routine kept an agent busy (and billed) around the clock.
    /// Five minutes is the floor everywhere; a routine saved with less keeps
    /// working at the floor instead of being rejected.
    #[test]
    fn a_routine_saved_below_five_minutes_runs_every_five_minutes() {
        let mut routine = json!({"id":"reminder","terminalId":"agent","text":"Review the work","everyMin":1,"enabled":true,"createdAt":1000});
        assert!(!routine_due(&routine, None, 300_999));
        assert!(routine_due(&routine, None, 301_000));
        routine["everyMin"] = json!(10);
        assert!(!routine_due(&routine, None, 600_999));
        assert!(routine_due(&routine, None, 601_000));
    }

    #[test]
    fn one_ready_head_per_terminal_respects_the_dispatch_budget_and_uncertain_barriers() {
        let item = |id: &str, terminal: &str| json!({"id":id,"terminalId":terminal});
        let mut uncertain = item("uncertain", "blocked");
        uncertain["delivery"] = json!({"status":"uncertain","attemptedAt":1000});
        let items = vec![item("first", "one"), item("second", "one"), uncertain,
            item("behind-uncertain", "blocked"), item("busy", "busy"), item("other", "two")];
        let ready = |id: &str| id != "busy";
        assert_eq!(due_heads(&items, ready, 2), vec!["first", "other"]);
        assert_eq!(due_heads(&items, ready, 1), vec!["first"]);
        assert!(due_heads(&items, ready, 0).is_empty());
    }

    #[test]
    fn a_colored_yes_no_prompt_is_blocked_even_after_a_long_silence() {
        assert!(permission_prompt("\u{1b}[1mProceed with this edit? (y/N)\u{1b}[0m\r\n"));
        assert!(!permission_prompt("Completed the requested edit.\r\nReady for the next request.\r\n"));
    }

    #[test]
    fn a_boxed_selected_permission_menu_is_blocked_but_an_unselected_plan_is_ready() {
        let permission = "╭──────────────╮\n│ Apply this edit? │\n│ ❯ 1. Yes │\n│ 2. No │\n╰──────────────╯";
        assert!(permission_prompt(permission));
        assert!(!permission_prompt("Here is the plan:\n1. Read files\n2. Run checks"));
        assert!(!permission_prompt("What should I explain?\n1. Read files\n2. Run checks"));
    }

    #[test]
    fn a_short_secret_prompt_or_pager_wait_blocks_automatic_input() {
        for prompt in ["Password for 'https://github.com':", "Senha:", "Enter verification code:", "Press any key to continue", "-- More --"] {
            assert!(permission_prompt(prompt), "{prompt}");
        }
        assert!(!permission_prompt("The password handler was updated. Tests passed."));
    }

    #[test]
    fn documented_native_hooks_preserve_the_callers_permission_and_session_context() {
        let request = json!({"terminal":"agent","argv":["hook","permission","--stdin"],"stdin":"{\"session_id\":\"session-1\",\"message\":\" Allow this edit? \"}"});
        let (terminal, event) = parse_hook(&request).unwrap();
        assert_eq!(terminal, "agent");
        assert_eq!(serde_json::to_value(event).unwrap(), json!({"kind":"permission","sessionId":"session-1","ask":"Allow this edit?"}));
        assert!(parse_hook(&json!({"terminal":"agent","argv":["hook","unknown"]})).is_none());
        assert!(parse_hook(&json!({"terminal":"agent","argv":["hook","codex","{\"type\":\"unknown\"}"]})).is_none());
    }

    #[test]
    fn native_hook_state_keeps_work_and_permission_blocked_until_a_turn_ends() {
        let state = SchedulerState::default();
        let event = |verb: &str| parse_hook(&json!({"terminal":"agent","argv":["hook",verb]})).unwrap().1;
        state.record("agent", event("prompt"), 1000);
        assert_eq!(state.phase("agent"), HookPhase::Working);
        state.record("agent", event("permission"), 2000);
        assert_eq!(state.phase("agent"), HookPhase::Permission);
        state.record("agent", event("tool"), 3000);
        assert_eq!(state.phase("agent"), HookPhase::Working);
        let finished = state.record("agent", event("stop"), 4000).unwrap();
        assert_eq!(state.phase("agent"), HookPhase::Ready);
        assert_eq!(finished.terminal_id, "agent");
        assert_eq!(finished.event.kind, "turn-end");
        assert_eq!(state.snapshot().len(), 1);
        state.clear("agent");
        assert_eq!(state.phase("agent"), HookPhase::Unknown);
        assert!(state.snapshot().is_empty());
    }

    #[test]
    fn a_native_hook_snapshot_retains_the_event_time_instead_of_its_read_time() {
        let state = SchedulerState::default();
        let event = parse_hook(&json!({"terminal":"agent","argv":["hook","stop"]})).unwrap().1;
        state.record("agent", event, 1234);
        assert_eq!(state.snapshot()[0].at, 1234);
    }

    #[test]
    fn native_readiness_requires_a_live_quiet_process_with_no_work_or_permission_pending() {
        let mut snapshot = ReadinessSnapshot { live: true, last_output_at: 1000, last_input_at: 0, phase: HookPhase::Unknown, tail: "Ready" };
        assert!(input_ready(&snapshot, 6000));
        assert!(!input_ready(&snapshot, 5999));
        snapshot.phase = HookPhase::Working;
        assert!(!input_ready(&snapshot, 100000));
        snapshot.phase = HookPhase::Permission;
        assert!(!input_ready(&snapshot, 100000));
        snapshot.phase = HookPhase::Ready;
        snapshot.last_input_at = 98000;
        assert!(!input_ready(&snapshot, 100000));
        snapshot.last_input_at = 0;
        snapshot.tail = "Proceed? (y/N)";
        assert!(!input_ready(&snapshot, 100000));
        snapshot.tail = "Ready";
        snapshot.live = false;
        assert!(!input_ready(&snapshot, 100000));
    }

    #[test]
    fn submitting_input_keeps_a_hook_reporting_agent_working_until_its_next_completion() {
        let state = SchedulerState::default();
        let event = parse_hook(&json!({"terminal":"agent","argv":["hook","stop"]})).unwrap().1;
        state.record("agent", event, 1000);
        let submitted = state.mark_input("agent", 2000, true).unwrap();
        assert_eq!(state.last_input_at("agent"), 2000);
        assert_eq!(submitted.event.kind, "turn-start");
        assert_eq!(state.phase("agent"), HookPhase::Working);
        assert!(state.mark_input("plain-shell", 3000, true).is_none());
        assert_eq!(state.phase("plain-shell"), HookPhase::Unknown);
        assert_eq!(state.last_input_at("plain-shell"), 3000);
    }

    #[test]
    fn native_hook_and_input_signals_publish_the_same_records_available_in_the_snapshot() {
        let state = SchedulerState::default();
        let delivered = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let received = delivered.clone();
        state.install_hook_sink(std::sync::Arc::new(move |record| { received.lock().push(record); }));
        let event = parse_hook(&json!({"terminal":"agent","argv":["hook","stop"]})).unwrap().1;
        state.record("agent", event, 1000);
        state.mark_input("agent", 2000, true);
        let records = delivered.lock();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].event.kind, "turn-end");
        assert_eq!(records[1].event.kind, "turn-start");
        assert_eq!(records[1].at, 2000);
        assert_eq!(records[1].sequence, state.snapshot()[0].sequence);
    }

    #[test]
    fn the_first_input_to_a_configured_hook_agent_is_working_before_its_first_completion() {
        let state = SchedulerState::default();
        state.expect_hooks("agent", true);
        assert!(state.mark_input("agent", 1000, true).is_some());
        assert_eq!(state.phase("agent"), HookPhase::Working);
        state.clear("agent");
        assert!(state.mark_input("agent", 2000, true).is_none());
        assert_eq!(state.phase("agent"), HookPhase::Unknown);
    }

    #[test]
    fn local_yard_hook_flags_are_recognized_without_assuming_remote_or_unconfigured_adapters() {
        let args = |values: &[&str]| values.iter().map(|value| value.to_string()).collect::<Vec<_>>();
        assert!(native_hooks_configured("C:/bin/claude.cmd", &args(&["--settings", "C:/data/bin/claude-hooks.json"])));
        assert!(native_hooks_configured("codex.exe", &args(&["-c", "notify=[\"yard\",\"hook\",\"codex\"]"])));
        assert!(!native_hooks_configured("claude.cmd", &args(&["--settings", "C:/custom/settings.json"])));
        assert!(!native_hooks_configured("wsl.exe", &args(&["claude", "--settings", "C:/data/bin/claude-hooks.json"])));
        assert!(!native_hooks_configured("codex.exe", &[]));
    }

    #[test]
    fn a_scheduled_identity_cannot_be_queued_again_before_its_lane_job_finishes() {
        let state = SchedulerState::default();
        assert!(state.schedule("request"));
        assert!(!state.schedule("request"));
        assert_eq!(state.scheduled_count(), 1);
        state.unschedule("request");
        assert_eq!(state.scheduled_count(), 0);
        assert!(state.schedule("request"));
    }

    #[test]
    fn native_user_delivery_captures_the_original_files_under_the_same_queue_identity() {
        let base = std::env::temp_dir().join(format!("yard-native-checkpoint-{}", std::process::id()));
        let root = base.join("repo");
        let store = base.join("checkpoints");
        std::fs::create_dir_all(&root).unwrap();
        assert!(crate::git::run_git(&root, &["init"]).unwrap().status.success());
        std::fs::write(root.join("code.txt"), b"original\n").unwrap();
        let request = json!({"id":"queue-identity","terminalId":"agent","text":"Change the implementation","source":"user"});
        let checkpoint = prepare_checkpoint_in(&store, "claude.cmd", "agent", &root, &request, 1000).unwrap().unwrap();
        assert_eq!(checkpoint.task_id, "queue-identity");
        std::fs::write(root.join("code.txt"), b"changed\n").unwrap();
        let compared = crate::checkpoints::compare_file(&store, &root, &checkpoint.id, "code.txt").unwrap();
        assert_eq!(compared.before.as_deref(), Some("original\n"));
        assert_eq!(compared.after.as_deref(), Some("changed\n"));
        let real_base = std::fs::canonicalize(&base).unwrap();
        assert!(real_base.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        std::fs::remove_dir_all(real_base).unwrap();
    }

    #[test]
    fn a_queued_work_task_owns_its_checkpoint_instead_of_the_delivery_attempt() {
        let base = std::env::temp_dir().join(format!("yard-linked-checkpoint-{}", std::process::id()));
        let root = base.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        assert!(crate::git::run_git(&root, &["init"]).unwrap().status.success());
        std::fs::write(root.join("code.txt"), b"original\n").unwrap();
        let checkpoint = prepare_checkpoint_in(&base.join("checkpoints"), "claude.cmd", "agent", &root,
            &json!({"id":"delivery-attempt","taskId":"work-task","text":"Original request","source":"user"}), 1000).unwrap().unwrap();
        assert_eq!(checkpoint.task_id, "work-task");
        let real_base = std::fs::canonicalize(&base).unwrap();
        assert!(real_base.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        std::fs::remove_dir_all(real_base).unwrap();
    }
}
