//! PTY engine tests — the F1 acceptance criteria.
//!
//! They exercise the real path (ConPTY, reader thread, coalescing,
//! scrollback, Job Objects) with an in-memory event collector instead of the
//! Tauri bus. That is why the engine got the `PtyEvents` trait:
//! testing the heart of the app cannot depend on spinning up a GUI runtime.

#![cfg(windows)]

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::emit::collect::CollectingEvents;
use super::emit::PtyEvents;
use super::{self as pty, SpawnOptions};
use crate::state::AppState;

struct Fixture {
    state: Arc<AppState>,
    events: Arc<CollectingEvents>,
}

/// Sends the tests' scrollback `.bin` files to a temporary folder.
///
/// Without this the tests write to `%APPDATA%\Yard\scrollback` — the same
/// directory as the installed app, which may be open with real work
/// inside.
fn isolate_test_data() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("yard-engine-tests-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("YARD_DATA_DIR", &dir);
    });
}

impl Fixture {
    fn new() -> Self {
        isolate_test_data();
        let db = rusqlite::Connection::open_in_memory().expect("in-memory sqlite");
        Self {
            state: Arc::new(AppState::new(db)),
            events: Arc::new(CollectingEvents::default()),
        }
    }

    fn sink(&self) -> Arc<dyn PtyEvents> {
        Arc::new(self.events.clone())
    }

    fn spawn(&self, id: &str, args: Vec<String>) {
        self.spawn_as(id, "shell", args);
    }

    /// `spawn` with the terminal's kind: `agent` is what turns on the "agent
    /// finished" detector.
    fn spawn_as(&self, id: &str, kind: &str, args: Vec<String>) {
        pty::spawn(
            self.sink(),
            &self.state,
            SpawnOptions {
                id: id.to_string(),
                program: pty::default_shell(),
                args,
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                rows: 24,
                cols: 80,
                kind: kind.into(),
                title: id.to_string(),
                env: vec![],
                keep_scrollback: false,
            },
        )
        .expect("spawn");
        self.auto_respond_dsr(id);
    }

    /// The state the reader and the pump of a live terminal share.
    fn shared(&self, id: &str) -> Arc<super::reader::PtyShared> {
        let handle = self.state.ptys.lock().get(id).cloned().expect("live pty");
        let shared = handle.lock().shared.clone();
        shared
    }

    /// Minimal terminal: answers the `ESC[6n` that ConPTY sends in the handshake.
    ///
    /// Without this, conhost holds back **all** of the application's output — the
    /// process stays alive, mute, and stuck. In real life xterm.js answers it; in
    /// the tests, this thread plays that role. It is the difference between "the
    /// engine is broken" and "there is no emulator on the other side".
    fn auto_respond_dsr(&self, id: &str) {
        let state = self.state.clone();
        let events = self.events.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let mut answered = 0usize;
            let deadline = Instant::now() + Duration::from_secs(180);
            while Instant::now() < deadline {
                let requests = events.output.lock().matches("\u{1b}[6n").count();
                for _ in answered..requests {
                    let _ = pty::write(&state, &id, "\u{1b}[1;1R");
                }
                answered = answered.max(requests);
                if !pty::exists(&state, &id) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        });
    }

    fn exit_reason(&self, id: &str) -> Option<String> {
        self.events
            .exits
            .lock()
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.reason.clone())
    }
}

/// Short PowerShell command, with `-NoProfile` so it does not inherit the user profile.
fn ps(script: &str) -> Vec<String> {
    vec!["-NoProfile".into(), "-Command".into(), script.into()]
}

fn wait_until(timeout: Duration, label: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for: {label}");
}

/// A CLI must not inherit another account's home or API key on launch or restart.
#[test]
fn codex_processes_and_restarts_use_the_pinned_account_home() {
    let fixture = Fixture::new();
    let root = crate::paths::app_dir();
    {
        let db = fixture.state.db.lock();
        db.execute_batch("CREATE TABLE terminals(id TEXT PRIMARY KEY, agent_id TEXT);").unwrap();
        crate::accounts::migrate(&db).unwrap();
        crate::accounts::create_in(&db, &root, "engine-codex", "codex", "Work").unwrap();
    }
    let bin = root.join("account-cli-fixture");
    std::fs::create_dir_all(&bin).unwrap();
    let program = bin.join("codex.ps1");
    std::fs::write(&program, "if (($args -join ' ') -eq 'login status') { if (Test-Path -LiteralPath (Join-Path $env:CODEX_HOME 'verified')) { exit 0 }; exit 1 }; [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME 'launched'), ($env:CODEX_HOME + '|' + $env:OPENAI_API_KEY)); while ($null -ne [Console]::ReadLine()) {}\n").unwrap();
    let directory = root.join("accounts").join("engine-codex").join(".codex");
    std::fs::write(directory.join("verified"), "fixture").unwrap();
    {
        let db = fixture.state.db.lock();
        crate::accounts::check_in_with(&db, &root, "engine-codex", |request| crate::accounts::probe(&program.to_string_lossy(), request, Duration::from_secs(10))).unwrap();
        crate::accounts::select_account(&db, "codex", Some("engine-codex")).unwrap();
    }
    pty::spawn(fixture.sink(), &fixture.state, SpawnOptions { id: "managed-codex".into(), program: program.to_string_lossy().into_owned(), args: vec![], cwd: bin.to_string_lossy().into_owned(), rows: 24, cols: 80, kind: "agent".into(), title: "Account fixture".into(), env: vec![("OPENAI_API_KEY".into(), "must-be-removed".into()), ("CODEX_HOME".into(), bin.to_string_lossy().into_owned())], keep_scrollback: false }).unwrap();
    fixture.auto_respond_dsr("managed-codex");
    wait_until(Duration::from_secs(15), "managed Codex launch", || directory.join("launched").exists());
    assert_eq!(std::fs::read_to_string(directory.join("launched")).unwrap(), format!("{}|", directory.display()));
    crate::accounts::select_account(&fixture.state.db.lock(), "codex", None).unwrap();
    std::fs::remove_file(directory.join("launched")).unwrap();
    pty::restart(fixture.sink(), &fixture.state, "managed-codex").unwrap();
    fixture.auto_respond_dsr("managed-codex");
    wait_until(Duration::from_secs(15), "managed Codex restart", || directory.join("launched").exists());
    assert_eq!(std::fs::read_to_string(directory.join("launched")).unwrap(), format!("{}|", directory.display()));
    pty::kill(&fixture.state, "managed-codex").unwrap();
}

/// OAuth callbacks belong with private account data, outside workspace output exports.
#[test]
fn managed_login_output_stays_outside_exported_workspace_scrollback() {
    let fixture = Fixture::new();
    let root = crate::paths::app_dir();
    {
        let db = fixture.state.db.lock();
        db.execute_batch("CREATE TABLE terminals(id TEXT PRIMARY KEY, agent_id TEXT)").unwrap();
        crate::accounts::migrate(&db).unwrap();
        crate::accounts::create_in(&db, &root, "engine-login", "codex", "Login").unwrap();
        crate::accounts::assign_terminal(&db, "managed-login", "codex", Some("engine-login")).unwrap();
    }
    let bin = root.join("login-cli-fixture");
    std::fs::create_dir_all(&bin).unwrap();
    let program = bin.join("codex.ps1");
    std::fs::write(&program, "Write-Output 'OWNED_OAUTH_CALLBACK_FIXTURE'; while ($null -ne [Console]::ReadLine()) {}\n").unwrap();
    pty::spawn(fixture.sink(), &fixture.state, SpawnOptions { id: "managed-login".into(), program: program.to_string_lossy().into_owned(), args: vec!["login".into()], cwd: bin.to_string_lossy().into_owned(), rows: 24, cols: 80, kind: "shell".into(), title: "Login".into(), env: vec![], keep_scrollback: false }).unwrap();
    fixture.auto_respond_dsr("managed-login");
    wait_until(Duration::from_secs(15), "login output", || fixture.events.output.lock().contains("OWNED_OAUTH_CALLBACK_FIXTURE"));
    let handle = fixture.state.ptys.lock().get("managed-login").cloned().unwrap();
    let scrollback = handle.lock().scrollback.clone();
    scrollback.lock().flush().unwrap();
    pty::kill(&fixture.state, "managed-login").unwrap();
    assert!(!crate::paths::scrollback_file("managed-login").exists());
    assert!(scrollback.lock().path().starts_with(root.join("accounts")));
}

/// Flow reservations must never deliver their input to a different process generation.
#[test]
fn a_flow_delivery_for_an_earlier_process_cannot_write_into_its_replacement() {
    let fixture = Fixture::new();
    fixture.spawn("flow-process-guard", ps("Write-Output 'GUARD_READY'; $line = [Console]::ReadLine(); Write-Output ('RECEIVED:' + $line)"));
    wait_until(Duration::from_secs(30), "guard fixture ready", || pty::attach(&fixture.state, "flow-process-guard").data.contains("GUARD_READY"));
    let identity = pty::process_identity(&fixture.state, "flow-process-guard").unwrap();
    assert!(pty::inject_for_process(&fixture.state, "flow-process-guard", pty::ProcessIdentity { pid: identity.pid.wrapping_add(1), ..identity }, "Obsolete request", true).is_err());
    pty::inject_for_process(&fixture.state, "flow-process-guard", identity, "Current request", true).unwrap();
    wait_until(Duration::from_secs(30), "current request received", || pty::attach(&fixture.state, "flow-process-guard").data.contains("RECEIVED:Current request"));
    assert!(!pty::attach(&fixture.state, "flow-process-guard").data.contains("Obsolete request"));
}

/// Prompt submission must complete inside the native process after the renderer call returns.
#[test]
fn a_native_prompt_operation_writes_the_request_and_submits_it_without_a_second_renderer_call() {
    let fixture = Fixture::new();
    fixture.spawn("native-prompt-submit", ps("Write-Output 'PROMPT_READY'; $line = [Console]::ReadLine(); Write-Output ('RECEIVED:' + $line)"));
    wait_until(Duration::from_secs(30), "prompt fixture ready", || pty::attach(&fixture.state, "native-prompt-submit").data.contains("PROMPT_READY"));
    pty::inject(&fixture.state, "native-prompt-submit", "Native prompt body", true).unwrap();
    wait_until(Duration::from_secs(30), "complete submitted request", || pty::attach(&fixture.state, "native-prompt-submit").data.contains("RECEIVED:Native prompt body"));
    wait_until(Duration::from_secs(30), "prompt fixture exits", || !pty::exists(&fixture.state, "native-prompt-submit"));
}

#[test]
fn native_prompt_input_updates_readiness_before_the_next_cli_output() {
    let fixture = Fixture::new();
    fixture.spawn("native-input-clock", ps("Write-Output 'INPUT_CLOCK_READY'; $first = [Console]::ReadLine(); Write-Output ('INPUT_CLOCK_RECEIVED:' + $first); $null = [Console]::ReadLine()"));
    wait_until(Duration::from_secs(30), "input clock fixture ready", || pty::attach(&fixture.state, "native-input-clock").data.contains("INPUT_CLOCK_READY"));
    let event = crate::scheduler::parse_hook(&serde_json::json!({"terminal":"native-input-clock","argv":["hook","stop"]})).unwrap().1;
    fixture.state.scheduler.record("native-input-clock", event, 1000);
    pty::inject(&fixture.state, "native-input-clock", "Clocked prompt", true).unwrap();
    assert!(fixture.state.scheduler.last_input_at("native-input-clock") > 1000);
    assert_eq!(fixture.state.scheduler.phase("native-input-clock"), crate::scheduler::HookPhase::Working);
    pty::kill(&fixture.state, "native-input-clock").unwrap();
    wait_until(Duration::from_secs(30), "input clock fixture exits", || !pty::exists(&fixture.state, "native-input-clock"));
}

#[test]
fn a_native_scheduler_tick_delivers_durable_work_without_a_renderer_timer() {
    let fixture = Fixture::new();
    fixture.state.db.lock().execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
    fixture.spawn("native-scheduled-input", ps("Write-Output 'SCHEDULE_READY'; $line = [Console]::ReadLine(); Write-Output ('SCHEDULE_RECEIVED:' + $line); $null = [Console]::ReadLine()"));
    wait_until(Duration::from_secs(30), "native scheduler fixture ready", || pty::attach(&fixture.state, "native-scheduled-input").data.contains("SCHEDULE_READY"));
    crate::queue::apply(&mut fixture.state.db.lock(), &[], &[serde_json::json!({"id":"native-scheduled-request","terminalId":"native-scheduled-input","text":"Autonomous native request","at":1000,"source":"bridge"})]).unwrap();
    let outcomes = crate::scheduler::run_once(&fixture.state, super::reader::now_ms() + 6000, 2).unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].1.status, "delivered");
    assert!(crate::queue::read(&fixture.state.db.lock()).unwrap().is_empty());
    wait_until(Duration::from_secs(30), "scheduled request reaches the real process", || pty::attach(&fixture.state, "native-scheduled-input").data.contains("SCHEDULE_RECEIVED:Autonomous native request"));
    pty::kill(&fixture.state, "native-scheduled-input").unwrap();
    wait_until(Duration::from_secs(30), "native scheduler fixture exits", || !pty::exists(&fixture.state, "native-scheduled-input"));
}

/// A pause (budget, quota or the user) must stop deliveries without failing
/// or dropping the queued work: it is delivered once automation resumes.
#[test]
fn a_paused_native_scheduler_tick_keeps_ready_work_queued_until_automation_resumes() {
    let fixture = Fixture::new();
    fixture.state.db.lock().execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
    fixture.spawn("native-paused-input", ps("Write-Output 'PAUSED_READY'; $line = [Console]::ReadLine(); Write-Output ('PAUSED_RECEIVED:' + $line); $null = [Console]::ReadLine()"));
    wait_until(Duration::from_secs(30), "paused scheduler fixture ready", || pty::attach(&fixture.state, "native-paused-input").data.contains("PAUSED_READY"));
    let request = serde_json::json!({"id":"native-paused-request","terminalId":"native-paused-input","text":"Paused native request","at":1000,"source":"bridge"});
    crate::queue::apply(&mut fixture.state.db.lock(), &[], std::slice::from_ref(&request)).unwrap();
    crate::persistence::db::kv_set(&fixture.state.db.lock(), crate::scheduler::AUTOMATION_PAUSED, r#"{"reason":"budget","at":1000}"#).unwrap();
    assert!(crate::scheduler::run_once(&fixture.state, super::reader::now_ms() + 6000, 2).unwrap().is_empty());
    assert_eq!(crate::queue::read(&fixture.state.db.lock()).unwrap(), vec![request]);
    crate::persistence::db::kv_delete(&fixture.state.db.lock(), crate::scheduler::AUTOMATION_PAUSED).unwrap();
    let outcomes = crate::scheduler::run_once(&fixture.state, super::reader::now_ms() + 6000, 2).unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].1.status, "delivered");
    pty::kill(&fixture.state, "native-paused-input").unwrap();
    wait_until(Duration::from_secs(30), "paused scheduler fixture exits", || !pty::exists(&fixture.state, "native-paused-input"));
}

#[test]
fn spawn_reads_output_emits_event_and_exits_on_its_own() {
    // Regression: publishing registry absence before the final flush and exit status exposed a dead attach with no exit reason.
    let f = Fixture::new();
    let marker = "yard-vivo-42";
    f.spawn("t-echo", ps(&format!("Write-Output '{marker}'")));

    // The scrollback (source of truth) must contain the output...
    wait_until(Duration::from_secs(30), "output in the scrollback", || {
        pty::attach(&f.state, "t-echo").data.contains(marker)
    });
    // ...and the UI must have received the same bytes via coalescing.
    wait_until(Duration::from_secs(10), "output emitted to the UI", || {
        f.events.output.lock().contains(marker)
    });
    // ...and the process must exit on its own, clearing the registry.
    wait_until(Duration::from_secs(30), "process to exit", || {
        !pty::exists(&f.state, "t-echo")
    });

    // After it is dead, attach still delivers the history (read from `.bin`) and
    // the exit reason — that is what feeds the "resume" banner.
    let after = pty::attach(&f.state, "t-echo");
    assert!(!after.alive, "should not be alive");
    assert!(after.data.contains(marker), "history lost after exit");
    assert_eq!(
        after.exit.as_ref().map(|e| e.reason.as_str()),
        Some("normal"),
        "wrong exit reason: {:?}",
        after.exit
    );
    assert_eq!(f.exit_reason("t-echo").as_deref(), Some("normal"));

    pty::scrollback::Scrollback::delete_file("t-echo");
}

/// Revoked credentials must not retain access to a stopped card's connections.
#[test]
fn a_terminal_credential_authenticates_only_while_its_process_is_live() {
    let fixture = Fixture::new();
    let id = "t-credential-lifetime";
    fixture.spawn(id, ps("Write-Output ('bridge-token:' + $env:YARD_TOKEN); [Console]::ReadLine() | Out-Null"));
    wait_until(Duration::from_secs(30), "process credential output", || fixture.events.output.lock().contains("bridge-token:"));
    let output = fixture.events.output.lock().clone();
    let token: String = output.split("bridge-token:").last().unwrap().chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    assert_eq!(token.len(), 64);
    let request = serde_json::json!({ "terminal": id, "token": token });
    assert!(crate::bridge::credentials().authenticate(&request));
    pty::write(&fixture.state, id, "\r").unwrap();
    wait_until(Duration::from_secs(30), "process exits and revokes its credential", || !pty::exists(&fixture.state, id));
    assert!(!crate::bridge::credentials().authenticate(&request));
    pty::scrollback::Scrollback::delete_file(id);
}

/// A process exit cannot silently leave its unfinished work marked as running.
#[test]
fn an_exited_executor_leaves_its_unsubmitted_task_waiting_for_attention() {
    let fixture = Fixture::new();
    let id = "t-task-interrupted";
    {
        let mut connection = fixture.state.db.lock();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask {
            id: "interrupted-work".into(), title: "Verify API".into(), request: "Keep this request after process exit".into(),
            criteria: vec!["Keep all callers working".into()],
            links: crate::work::TaskLinks { terminal_ids: vec![id.into()], ..Default::default() },
        }, 1000).unwrap();
        let queued = crate::work::transition(&mut connection, &task.id, task.revision, "queued", 2000).unwrap();
        crate::work::transition(&mut connection, &task.id, queued.revision, "running", 3000).unwrap();
    }
    fixture.spawn(id, ps("Write-Output 'executor-ended'"));
    wait_until(Duration::from_secs(30), "executor exit", || !pty::exists(&fixture.state, id));
    let task = crate::work::get(&fixture.state.db.lock(), "interrupted-work").unwrap();
    assert_eq!(task.status, "blocked");
    assert_eq!(task.request, "Keep this request after process exit");
    assert_eq!(task.criteria[0].text, "Keep all callers working");
    assert_eq!(crate::work::events(&fixture.state.db.lock(), &task.id).unwrap().last().unwrap().kind, "interrupted");
    pty::scrollback::Scrollback::delete_file(id);
}

fn credential_from_output(fixture: &Fixture, id: &str) -> String {
    let marker = format!("{id}-token:");
    let read = || fixture.events.output.lock().rsplit_once(&marker)
        .map(|(_, tail)| tail.chars().take_while(|c| c.is_ascii_hexdigit()).collect::<String>()).unwrap_or_default();
    wait_until(Duration::from_secs(30), "process credential output", || read().len() == 64);
    read()
}

#[test]
fn restarting_a_terminal_keeps_its_id_and_history_but_rejects_its_old_credential() {
    let fixture = Fixture::new();
    let id = "t-credential-restart";
    fixture.spawn(id, ps(&format!("Write-Output ('{id}-token:' + $env:YARD_TOKEN); [Console]::ReadLine() | Out-Null")));
    let old = credential_from_output(&fixture, id);
    assert!(crate::bridge::credentials().authenticate(&serde_json::json!({ "terminal": id, "token": old })));
    pty::restart(fixture.sink(), &fixture.state, id).unwrap();
    fixture.auto_respond_dsr(id);
    wait_until(Duration::from_secs(30), "replacement process credential", || credential_from_output(&fixture, id) != old);
    let next = credential_from_output(&fixture, id);
    assert!(crate::bridge::credentials().authenticate(&serde_json::json!({ "terminal": id, "token": next })));
    assert!(!crate::bridge::credentials().authenticate(&serde_json::json!({ "terminal": id, "token": old })));
    assert!(pty::attach(&fixture.state, id).data.contains(&old));
    pty::kill(&fixture.state, id).unwrap();
    wait_until(Duration::from_secs(30), "restarted terminal exits", || !pty::exists(&fixture.state, id));
    pty::scrollback::Scrollback::delete_file(id);
}

#[test]
fn kill_and_suspend_revoke_credentials_when_termination_is_requested() {
    let fixture = Fixture::new();
    for (id, suspend) in [("t-credential-kill", false), ("t-credential-suspend", true)] {
        fixture.spawn(id, ps(&format!("Write-Output ('{id}-token:' + $env:YARD_TOKEN); [Console]::ReadLine() | Out-Null")));
        let token = credential_from_output(&fixture, id);
        let request = serde_json::json!({ "terminal": id, "token": token });
        assert!(crate::bridge::credentials().authenticate(&request));
        if suspend { pty::suspend(&fixture.state, id).unwrap(); } else { pty::kill(&fixture.state, id).unwrap(); }
        assert!(!crate::bridge::credentials().authenticate(&request));
        wait_until(Duration::from_secs(30), "terminated process exits", || !pty::exists(&fixture.state, id));
        pty::scrollback::Scrollback::delete_file(id);
    }
}

#[test]
fn a_failed_spawn_releases_its_registered_identity_for_a_later_attempt() {
    let fixture = Fixture::new();
    let id = "t-credential-failed";
    let result = pty::spawn(fixture.sink(), &fixture.state, SpawnOptions {
        id: id.into(), program: "yard-nonexistent-program.exe".into(), args: vec![],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(), rows: 24, cols: 80,
        kind: "shell".into(), title: id.into(), env: vec![], keep_scrollback: false,
    });
    assert!(result.is_err());
    let retry = crate::bridge::credentials().issue(id).expect("failed startup revoked its credential");
    assert!(crate::bridge::credentials().authenticate(&serde_json::json!({ "terminal": id, "token": retry.token() })));
}

/// A launch profile must not replace the identity pair assigned by the bridge.
#[test]
fn spawn_assigns_bridge_credentials_after_custom_environment_values() {
    let fixture = Fixture::new();
    let id = "t-bridge-credential";
    pty::spawn(fixture.sink(), &fixture.state, SpawnOptions {
        id: id.into(), program: pty::default_shell(),
        args: ps("Write-Output ('credential-ok:' + (($env:YARD_TOKEN -match '^[a-f0-9]{64}$') -and ($env:YARD_PTY_ID -eq 't-bridge-credential')) )"),
        cwd: std::env::temp_dir().to_string_lossy().into_owned(), rows: 24, cols: 80,
        kind: "shell".into(), title: id.into(), keep_scrollback: false,
        env: vec![("YARD_TOKEN".into(), "override".into()), ("YARD_PTY_ID".into(), "other-terminal".into())],
    }).unwrap();
    fixture.auto_respond_dsr(id);
    wait_until(Duration::from_secs(30), "credential comparison", || pty::attach(&fixture.state, id).data.contains("credential-ok:"));
    assert!(pty::attach(&fixture.state, id).data.contains("credential-ok:True"));
    wait_until(Duration::from_secs(30), "credential process exit", || !pty::exists(&fixture.state, id));
    pty::scrollback::Scrollback::delete_file(id);
}

/// The size the UI dedupes against.
///
/// `attach` has to report what the process is really on, and the handle has to
/// record the **clamped** pair — the one ConPTY got. Recording `opts.cols`
/// instead used to mean that a terminal born in a sliver of a pane (cols below
/// the floor) would then have its first honest resize skipped as "no change",
/// and the CLI would stay squeezed for the rest of the session.
#[test]
fn attach_reports_the_real_size_and_resize_ignores_repeats() {
    let f = Fixture::new();
    pty::spawn(
        f.sink(),
        &f.state,
        SpawnOptions {
            id: "t-size".into(),
            program: pty::default_shell(),
            args: vec!["-NoProfile".into()],
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            // Below both floors: what ConPTY gets is 2x10.
            rows: 1,
            cols: 4,
            kind: "shell".into(),
            title: "t-size".into(),
            env: vec![],
            keep_scrollback: false,
        },
    )
    .expect("spawn");
    f.auto_respond_dsr("t-size");

    let initial = pty::attach(&f.state, "t-size");
    assert!(initial.alive);
    assert_eq!(
        (initial.cols, initial.rows),
        (10, 2),
        "the handle must record the clamped pair, not what the UI asked for"
    );

    pty::resize(&f.state, "t-size", 40, 160).expect("resize");
    let after = pty::attach(&f.state, "t-size");
    assert_eq!((after.cols, after.rows), (160, 40));

    // Repeated: still Ok and the size does not change (what does not happen
    // again is conhost's reflow — that is what scrambles a TUI's drawing).
    pty::resize(&f.state, "t-size", 40, 160).expect("repeated resize");
    assert_eq!(
        {
            let a = pty::attach(&f.state, "t-size");
            (a.cols, a.rows)
        },
        (160, 40)
    );

    // A dead pty does not accept a resize — that Err is what makes the UI
    // resend later, instead of assuming the backend already knows.
    pty::kill(&f.state, "t-size").expect("kill");
    wait_until(Duration::from_secs(25), "kill to clear registry", || {
        !pty::exists(&f.state, "t-size")
    });
    assert!(pty::resize(&f.state, "t-size", 24, 80).is_err());

    let dead = pty::attach(&f.state, "t-size");
    assert!(!dead.alive);
    assert_eq!((dead.cols, dead.rows), (0, 0));

    pty::scrollback::Scrollback::delete_file("t-size");
}

#[test]
fn write_reaches_the_process() {
    let f = Fixture::new();
    f.spawn("t-write", vec!["-NoProfile".into()]);

    wait_until(Duration::from_secs(40), "shell prompt", || {
        !pty::attach(&f.state, "t-write").data.is_empty()
    });

    pty::write(&f.state, "t-write", "Write-Output 'eco-do-teste'\r\n").expect("write");

    // The first "eco-do-teste" is the echo of what we typed; the second is the
    // actual command output. Two occurrences prove the shell ran it.
    wait_until(Duration::from_secs(40), "command to run", || {
        pty::attach(&f.state, "t-write")
            .data
            .matches("eco-do-teste")
            .count()
            >= 2
    });

    pty::kill(&f.state, "t-write").expect("kill");
    wait_until(Duration::from_secs(25), "kill to clear registry", || {
        !pty::exists(&f.state, "t-write")
    });
    pty::scrollback::Scrollback::delete_file("t-write");
}

#[test]
fn kill_takes_down_the_whole_tree() {
    let f = Fixture::new();
    // The shell stays alive and spawns a grandchild that would sleep for a long
    // time. Without a Job Object (or the tree fallback), that grandchild becomes
    // an orphan — complaint number 1 of terminal apps on Windows (§9.6).
    f.spawn(
        "t-tree",
        ps("Start-Process -NoNewWindow powershell '-NoProfile -Command Start-Sleep 300'; Start-Sleep 300"),
    );

    let root = {
        let map = f.state.ptys.lock();
        map.get("t-tree")
            .and_then(|h| h.lock().pid)
            .expect("root pid")
    };
    wait_until(Duration::from_secs(40), "tree to grow", || {
        f.state.procs.lock().tree_of(root).len() >= 2
    });

    let before = f.state.procs.lock().tree_of(root);
    assert!(before.len() >= 2, "tree did not grow: {before:?}");

    pty::kill(&f.state, "t-tree").expect("kill");

    wait_until(Duration::from_secs(25), "registry to clear", || {
        !pty::exists(&f.state, "t-tree")
    });
    wait_until(Duration::from_secs(30), "whole tree to die", || {
        let mut procs = f.state.procs.lock();
        !before.iter().any(|pid| procs.is_alive(*pid))
    });

    assert_eq!(
        pty::attach(&f.state, "t-tree")
            .exit
            .as_ref()
            .map(|e| e.reason.as_str()),
        Some("killed"),
        "kill should report reason 'killed'"
    );

    pty::scrollback::Scrollback::delete_file("t-tree");
}

#[test]
fn suspend_reports_reason_and_preserves_history() {
    let f = Fixture::new();
    let marker = "antes-de-suspender";
    f.spawn(
        "t-susp",
        ps(&format!("Write-Output '{marker}'; Start-Sleep 300")),
    );

    wait_until(Duration::from_secs(40), "marker to appear", || {
        pty::attach(&f.state, "t-susp").data.contains(marker)
    });

    pty::suspend(&f.state, "t-susp").expect("suspend");
    wait_until(Duration::from_secs(25), "suspension to finish", || {
        !pty::exists(&f.state, "t-susp")
    });

    let after = pty::attach(&f.state, "t-susp");
    assert_eq!(
        after.exit.as_ref().map(|e| e.reason.as_str()),
        Some("suspended")
    );
    assert!(
        after.data.contains(marker),
        "suspend must preserve the scrollback"
    );

    pty::scrollback::Scrollback::delete_file("t-susp");
}

#[test]
fn restart_reuses_the_id_and_keeps_the_history() {
    let f = Fixture::new();
    f.spawn(
        "t-restart",
        ps("Write-Output 'primeira-vida'; Start-Sleep 300"),
    );

    wait_until(Duration::from_secs(40), "first life", || {
        pty::attach(&f.state, "t-restart")
            .data
            .contains("primeira-vida")
    });

    let pid_before = {
        let map = f.state.ptys.lock();
        map.get("t-restart").and_then(|h| h.lock().pid)
    };

    pty::restart(f.sink(), &f.state, "t-restart").expect("restart");

    assert!(pty::exists(&f.state, "t-restart"), "should be alive again");
    let pid_after = {
        let map = f.state.ptys.lock();
        map.get("t-restart").and_then(|h| h.lock().pid)
    };
    assert_ne!(pid_before, pid_after, "restart should create a new process");
    assert!(
        pty::attach(&f.state, "t-restart")
            .data
            .contains("primeira-vida"),
        "restart should preserve the previous scrollback"
    );

    pty::kill(&f.state, "t-restart").ok();
    pty::scrollback::Scrollback::delete_file("t-restart");
}

#[test]
fn spawn_clears_inherited_color_vetoes_and_assumes_terminal_identity() {
    // Simulates Yard launched from inside a terminal that turns colors off
    // (some terminal hosts export NO_COLOR=1). The child must not inherit the veto, otherwise
    // every CLI (claude, codex, git) renders monochrome.
    std::env::set_var("NO_COLOR", "1");

    let f = Fixture::new();
    f.spawn(
        "t-cor",
        ps(r#"Write-Output ("cor=[" + $env:NO_COLOR + "] prog=[" + $env:TERM_PROGRAM + "]")"#),
    );

    wait_until(Duration::from_secs(40), "env probe to answer", || {
        pty::attach(&f.state, "t-cor").data.contains("cor=[")
    });

    let data = pty::attach(&f.state, "t-cor").data;
    assert!(
        data.contains("cor=[] prog=[Yard]"),
        "wrong child env (NO_COLOR should be gone, TERM_PROGRAM=Yard): {data}"
    );

    std::env::remove_var("NO_COLOR");
    pty::kill(&f.state, "t-cor").ok();
    pty::scrollback::Scrollback::delete_file("t-cor");
}

#[test]
fn bulky_output_does_not_blow_the_emit_buffer_memory() {
    let f = Fixture::new();
    // ~6 MB of output at once: above the emit buffer cap (2 MB) and
    // the scrollback ring (4 MB). Nothing may grow without a limit.
    f.spawn(
        "t-flood",
        // Emit the same lines as one burst so shell formatting speed cannot
        // replace the buffer-volume contract this test exercises.
        ps("$text = [Text.StringBuilder]::new(); for ($index = 1; $index -le 60000; $index++) { [void]$text.AppendLine('linha-de-teste-com-uma-centena-de-bytes-para-encher-o-buffer-rapido-' + $index) }; $bytes = [Text.Encoding]::UTF8.GetBytes($text.ToString()); $stdout = [Console]::OpenStandardOutput(); $stdout.Write($bytes, 0, $bytes.Length); $stdout.Flush()"),
    );

    wait_until(Duration::from_secs(90), "process to finish", || {
        !pty::exists(&f.state, "t-flood")
    });

    let sb_len = pty::attach(&f.state, "t-flood").data.len();
    assert!(
        sb_len <= super::scrollback::RING_CAP,
        "scrollback blew past the 4 MB cap: {sb_len} bytes"
    );
    assert_eq!(sb_len, super::scrollback::RING_CAP, "the full burst did not fill the retained history");

    pty::scrollback::Scrollback::delete_file("t-flood");
}

/// A flood past the 8 MB cap of the `.bin`: the compaction runs on its own
/// thread while the output keeps coming, and what is left on disk is the end
/// of the history, whole. Under the cap, ending with the last line, starting
/// on a character, and with no `.bin.tmp` left behind.
#[test]
fn a_flood_past_the_file_cap_leaves_the_end_of_the_history_on_disk() {
    let f = Fixture::new();
    let id = "t-flood-cap";
    f.spawn(
        id,
        ps("$line = 'ç' * 100 + ('x' * 100); $text = [Text.StringBuilder]::new(); for ($index = 1; $index -le 60000; $index++) { [void]$text.AppendLine($line + $index) }; [void]$text.AppendLine('FIM-DA-ENXURRADA'); $bytes = [Text.Encoding]::UTF8.GetBytes($text.ToString()); $stdout = [Console]::OpenStandardOutput(); $stdout.Write($bytes, 0, $bytes.Length); $stdout.Flush()"),
    );
    wait_until(Duration::from_secs(120), "process to finish", || {
        !pty::exists(&f.state, id)
    });

    let bin = crate::paths::scrollback_file(id);
    let len = std::fs::metadata(&bin).expect("the .bin").len();
    // A compacted file is the ring: 4 MB, minus at most the 3 bytes that move
    // its start to a character, plus whatever came after.
    assert!(
        len <= super::scrollback::FILE_CAP && len >= super::scrollback::RING_CAP as u64 - 3,
        "{len} bytes on disk: no compaction, or one that lost the tail"
    );
    let tail = pty::scrollback::Scrollback::read_tail_from_disk(id, 256 * 1024);
    assert!(tail.contains("FIM-DA-ENXURRADA"), "the last line never reached the disk");
    let bytes = std::fs::read(&bin).expect("the .bin");
    assert!(
        bytes[0] & 0b1100_0000 != 0b1000_0000,
        "the compacted file starts in the middle of a character"
    );
    assert!(!bin.with_extension("bin.tmp").exists(), "a .bin.tmp was left behind");

    pty::scrollback::Scrollback::delete_file(id);
}

/// The layout switch that used to empty an agent's pane.
///
/// A full-screen CLI paints on the alternate screen, and its scrollback is a
/// log of incremental redraws — replaying it into a pane of another size
/// rebuilds almost nothing. So the engine has to (a) know it is looking at one
/// and (b) be able to ask the console host for the frame, without the process
/// having to cooperate: the script below draws once and then sleeps forever,
/// exactly like an agent waiting at a prompt.
#[test]
fn alternate_screen_is_repainted_on_request() {
    let f = Fixture::new();
    let marker = "ANCORA-DA-TELA";
    f.spawn(
        "t-alt",
        ps("$e=[char]27; [Console]::Write($e+'[?1049h'+$e+'[2J'+$e+'[H'); \
            1..12 | ForEach-Object { [Console]::Write('ANCORA-DA-TELA linha ' + $_ + $e + '[K' + [char]13 + [char]10) }; \
            Start-Sleep -Seconds 120"),
    );

    wait_until(Duration::from_secs(60), "the screen to be drawn", || {
        f.events.output.lock().contains(marker)
    });

    let attached = pty::attach(&f.state, "t-alt");
    assert!(attached.alive);
    assert!(
        attached.alt_screen,
        "the CLI is on the alternate screen and attach did not say so — \
         the UI will try to rebuild the screen from the log and fail"
    );

    // From here on the process writes nothing more on its own.
    let already_seen = f.events.output.lock().len();
    pty::repaint(&f.state, "t-alt").expect("repaint");

    wait_until(Duration::from_secs(30), "host to re-emit screen", || {
        f.events.output.lock()[already_seen..].contains(marker)
    });

    // And the size is back to what it was: a repaint is a request, not a resize.
    let after = pty::attach(&f.state, "t-alt");
    assert_eq!((after.cols, after.rows), (attached.cols, attached.rows));

    pty::kill(&f.state, "t-alt").ok();
    pty::scrollback::Scrollback::delete_file("t-alt");
}

/// The other half: a shell writes *lines*, its scrollback is a real history,
/// and nothing may make the UI throw it away.
#[test]
fn ordinary_shell_is_not_mistaken_for_alternate_screen() {
    let f = Fixture::new();
    f.spawn(
        "t-normal",
        ps("Write-Output 'sem-tela-alternativa'; Start-Sleep -Seconds 60"),
    );

    wait_until(Duration::from_secs(60), "shell output", || {
        pty::attach(&f.state, "t-normal")
            .data
            .contains("sem-tela-alternativa")
    });
    assert!(
        !pty::attach(&f.state, "t-normal").alt_screen,
        "an ordinary shell was flagged as alternate screen — its history \
         would be discarded instead of repainted"
    );

    pty::kill(&f.state, "t-normal").ok();
    pty::scrollback::Scrollback::delete_file("t-normal");
}

/// The restart case the cut exists for: every terminal that was running comes
/// back dead with auto-start, and the view discards the history before
/// painting anything. The `.bin` is still there for the view that asks for it
/// (a manual "Retomar"), and nothing about the process changes.
#[test]
fn a_dead_terminal_about_to_start_again_is_attached_without_its_history() {
    let f = Fixture::new();
    let id = "t-dead-omit";
    let mut sb = pty::scrollback::Scrollback::fresh(id).expect("fresh scrollback");
    sb.push("historia-da-sessao-anterior\r\n".as_bytes());
    sb.flush().expect("flush");

    let omitted = pty::attach_with(
        &f.state,
        id,
        pty::AttachWants {
            omit_dead_history: true,
            alt_tail: Some(65_536),
        },
    );
    assert!(!omitted.alive);
    assert_eq!(
        omitted.data, "",
        "the discarded history still crossed the IPC"
    );

    let whole = pty::attach(&f.state, id);
    assert_eq!(whole.data, "historia-da-sessao-anterior\r\n");
    assert_eq!(
        (
            omitted.alive,
            omitted.pid,
            omitted.rows,
            omitted.cols,
            omitted.alt_screen
        ),
        (
            whole.alive,
            whole.pid,
            whole.rows,
            whole.cols,
            whole.alt_screen
        )
    );

    pty::scrollback::Scrollback::delete_file(id);
}

/// A live full-screen CLI gets its screen from a repaint; the history only
/// feeds the URL scanner and the blocked detector, which read its end. So the
/// attach sends that end, and it is the end of the very history `attach` has.
#[test]
fn a_live_alternate_screen_is_attached_with_only_the_tail_the_view_reads() {
    let f = Fixture::new();
    let id = "t-alt-tail";
    f.spawn(
        id,
        ps("$e=[char]27; [Console]::Write($e+'[?1049h'+$e+'[2J'+$e+'[H'); \
            1..12 | ForEach-Object { [Console]::Write('RABO-DA-TELA linha ' + $_ + $e + '[K' + [char]13 + [char]10) }; \
            Start-Sleep -Seconds 120"),
    );
    wait_until(Duration::from_secs(60), "the screen to be drawn", || {
        f.events.output.lock().contains("RABO-DA-TELA linha 12")
    });

    let wants = pty::AttachWants {
        omit_dead_history: true,
        alt_tail: Some(16),
    };
    // Two reads of a live ring: retried until no output landed between them.
    let mut pair = None;
    wait_until(
        Duration::from_secs(30),
        "a tail that ends the whole history",
        || {
            let tail = pty::attach_with(&f.state, id, wants);
            let whole = pty::attach(&f.state, id);
            let settled = whole.data.ends_with(&tail.data);
            pair = Some((tail, whole));
            settled
        },
    );
    let (tail, whole) = pair.expect("attached");
    assert!(
        tail.alive && tail.alt_screen,
        "not the alternate-screen path: {tail:?}"
    );
    assert!(!tail.data.is_empty());
    // Three bytes per unit, plus at most three back to a character start.
    assert!(
        tail.data.len() <= 3 * 16 + 3 && tail.data.len() < whole.data.len(),
        "{} of {} bytes",
        tail.data.len(),
        whole.data.len()
    );

    pty::kill(&f.state, id).ok();
    pty::scrollback::Scrollback::delete_file(id);
}

/// Milliseconds since the last byte the terminal read.
fn silence_ms(shared: &super::reader::PtyShared) -> i64 {
    super::reader::now_ms() - shared.last_byte_at.load(Ordering::Acquire)
}

/// Waits for a stretch of silence that runs from `from_ms` to `to_ms` after
/// the last byte, retrying when the process writes in the middle of it (a
/// shell may repaint its title). Returns the heartbeats and the pump wakes
/// counted inside the stretch, and the last byte it was measured against.
fn quiet_stretch(
    f: &Fixture,
    shared: &super::reader::PtyShared,
    from_ms: i64,
    to_ms: i64,
) -> (usize, u64, i64) {
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        wait_until(Duration::from_secs(60), "the start of the silence", || {
            silence_ms(shared) >= from_ms
        });
        let last = shared.last_byte_at.load(Ordering::Acquire);
        let beats = f.events.beats.lock().len();
        let wakes = shared.pump_wakes.load(Ordering::Acquire);
        wait_until(Duration::from_secs(60), "the end of the silence", || {
            silence_ms(shared) >= to_ms || shared.last_byte_at.load(Ordering::Acquire) != last
        });
        if shared.last_byte_at.load(Ordering::Acquire) == last {
            return (
                f.events.beats.lock().len() - beats,
                shared.pump_wakes.load(Ordering::Acquire) - wakes,
                last,
            );
        }
    }
    panic!("the process never stayed quiet long enough");
}

/// What a terminal nobody is using costs. The pump used to wake about six
/// times a second (the 250 ms disk flush tick and the 450 ms heartbeat, with
/// nothing to flush) and to post an `activity` message to the WebView's
/// main thread every 450 ms, forever, per terminal. Once the last byte is
/// reported and the "writing" second is over, a quiet shell has nothing new
/// to say: no event, no wakeup, until it writes again.
#[test]
fn a_quiet_shell_stops_reporting_and_its_pump_stops_waking() {
    let f = Fixture::new();
    let id = "t-quiet";
    f.spawn(id, ps("Write-Output 'quieto-agora'; Start-Sleep -Seconds 120"));
    wait_until(Duration::from_secs(60), "the shell output", || {
        f.events.output.lock().contains("quieto-agora")
    });
    let shared = f.shared(id);

    let (beats, wakes, last) = quiet_stretch(&f, &shared, 2_000, 4_000);
    assert_eq!(
        beats, 0,
        "{beats} heartbeats in two seconds of silence, with nothing new to report \
         (and {wakes} pump wakeups)"
    );
    assert_eq!(wakes, 0, "the pump woke {wakes} times in two seconds of silence");
    // Silence is not blindness: the last byte did reach the front end.
    assert!(
        f.events.beats.lock().iter().any(|b| b.last_byte_at == last),
        "the heartbeat carrying the last byte never went out"
    );

    pty::kill(&f.state, id).ok();
    pty::scrollback::Scrollback::delete_file(id);
}

/// The pump sleeping through silence must not sleep through the one thing
/// silence is for: an agent that goes quiet still gets its single "finished"
/// event (§7), and only after that does its pump go quiet too.
///
/// One event per silence, counted from the last byte: on a loaded machine
/// ConPTY or PowerShell can still write a late burst seconds after the text,
/// and the silence before that burst rightly got its own event. Counting
/// every event of the run failed the full suite with `[4980, 4801]`: two
/// silences, two correct events.
#[test]
fn a_quiet_agent_gets_one_idle_event_and_then_its_pump_goes_quiet() {
    let f = Fixture::new();
    let id = "t-agent-idle";
    f.spawn_as(id, "agent", ps("Write-Output 'turno-concluido'; Start-Sleep -Seconds 120"));
    wait_until(Duration::from_secs(60), "the agent output", || {
        f.events.output.lock().contains("turno-concluido")
    });
    let shared = f.shared(id);
    let idles_of = || -> Vec<u64> {
        f.events.idles.lock().iter().filter(|e| e.id == id).map(|e| e.idle_ms).collect()
    };

    let deadline = Instant::now() + Duration::from_secs(120);
    let (fresh, beats, wakes) = loop {
        assert!(Instant::now() < deadline, "the agent never stayed quiet long enough");
        let last = shared.last_byte_at.load(Ordering::Acquire);
        // This silence is at most one poll old, and its event needs 4.5 s of
        // it: none of the events counted here can be this silence's.
        let before = idles_of().len();
        let moved = || shared.last_byte_at.load(Ordering::Acquire) != last;
        wait_until(Duration::from_secs(60), "6 s of silence", || silence_ms(&shared) >= 6_000 || moved());
        if moved() {
            continue;
        }
        let beats = f.events.beats.lock().len();
        let wakes = shared.pump_wakes.load(Ordering::Acquire);
        wait_until(Duration::from_secs(60), "8 s of silence", || silence_ms(&shared) >= 8_000 || moved());
        if moved() {
            continue;
        }
        break (
            idles_of()[before..].to_vec(),
            f.events.beats.lock().len() - beats,
            shared.pump_wakes.load(Ordering::Acquire) - wakes,
        );
    };
    assert_eq!(fresh.len(), 1, "one silence, one event: {fresh:?} (all: {:?})", idles_of());
    assert!(fresh[0] >= 4_500, "fired before 4.5 s of silence: {fresh:?}");
    assert_eq!((beats, wakes), (0, 0), "(heartbeats, pump wakeups) after the idle event");

    pty::kill(&f.state, id).ok();
    pty::scrollback::Scrollback::delete_file(id);
}

/// The way out of the silence: the first byte after it wakes the pump, the
/// front end hears about it as "writing" (so a stale "blocked" clears, as it
/// always did), and the disk gets it.
#[test]
fn writing_again_after_a_silence_is_reported_and_reaches_the_disk() {
    let f = Fixture::new();
    let id = "t-back";
    f.spawn(id, vec!["-NoProfile".into()]);
    wait_until(Duration::from_secs(40), "shell prompt", || {
        !pty::attach(&f.state, id).data.is_empty()
    });
    let shared = f.shared(id);
    let (_, wakes, last) = quiet_stretch(&f, &shared, 1_500, 2_500);
    assert_eq!(wakes, 0, "the pump was not asleep to begin with");

    pty::write(&f.state, id, "Write-Output 'de-volta'\r\n").expect("write");
    wait_until(Duration::from_secs(40), "a heartbeat for the new output", || {
        f.events
            .beats
            .lock()
            .iter()
            .any(|b| b.last_byte_at > last && b.idle_ms < 1_000)
    });
    wait_until(Duration::from_secs(40), "the new output on disk", || {
        pty::scrollback::Scrollback::read_tail_from_disk(id, 64 * 1024)
            .matches("de-volta")
            .count()
            >= 2
    });

    pty::kill(&f.state, id).ok();
    wait_until(Duration::from_secs(25), "kill to clear registry", || {
        !pty::exists(&f.state, id)
    });
    pty::scrollback::Scrollback::delete_file(id);
}

/// Close to the tray and the page calls `hide()`, which no pane hears about:
/// every pane that was on the canvas kept streaming at 60 messages a second
/// into a WebView nobody could see. The window is one flag for the whole
/// app, and every terminal follows it: one spawned behind a hidden window is
/// paced for a hidden pane (450 ms), and for the screen again once the window
/// shows. (The pump's side of that, holding and releasing real output, is
/// `reader::tests`; this is that a spawned terminal reads the app's flag.)
#[test]
fn a_terminal_spawned_behind_a_hidden_window_follows_the_window() {
    let f = Fixture::new();
    let id = "t-janela";
    assert!(pty::set_window_shown(&f.state, false), "the window was on screen");
    f.spawn(id, ps("Write-Output 'escondido'; Start-Sleep -Seconds 120"));
    let shared = f.shared(id);
    assert_eq!(
        shared.emit_period(),
        Duration::from_millis(450),
        "a terminal behind a hidden window is paced for the screen"
    );
    assert!(pty::set_window_shown(&f.state, true));
    assert_eq!(
        shared.emit_period(),
        Duration::from_millis(16),
        "the window came back and the terminal stayed at the hidden pace"
    );

    pty::kill(&f.state, id).ok();
    wait_until(Duration::from_secs(25), "kill to clear registry", || {
        !pty::exists(&f.state, id)
    });
    pty::scrollback::Scrollback::delete_file(id);
}

/// The window coming back must not wait for each pump's next deadline: a
/// pump asleep (nothing armed) or on its 450 ms wait is woken, so output held
/// behind the hidden window goes out at once.
#[test]
fn showing_the_window_wakes_a_sleeping_pump() {
    let f = Fixture::new();
    let id = "t-acorda";
    pty::set_window_shown(&f.state, false);
    f.spawn(id, ps("Write-Output 'dormindo'; Start-Sleep -Seconds 120"));
    wait_until(Duration::from_secs(60), "the shell output", || {
        f.events.output.lock().contains("dormindo")
    });
    let shared = f.shared(id);
    let (_, wakes, _) = quiet_stretch(&f, &shared, 1_500, 2_500);
    assert_eq!(wakes, 0, "the pump was not asleep to begin with");

    let before = shared.pump_wakes.load(Ordering::Acquire);
    assert!(pty::set_window_shown(&f.state, true));
    wait_until(Duration::from_secs(5), "the pump to wake", || {
        shared.pump_wakes.load(Ordering::Acquire) > before
    });

    pty::kill(&f.state, id).ok();
    wait_until(Duration::from_secs(25), "kill to clear registry", || {
        !pty::exists(&f.state, id)
    });
    pty::scrollback::Scrollback::delete_file(id);
}

/// What a listener that registered late asks for, since the pump no longer
/// repeats itself: the beat the pump would send right now, and nothing for a
/// terminal with no live process.
#[test]
fn the_current_beat_is_there_for_whoever_asks() {
    let f = Fixture::new();
    let id = "t-beat";
    assert!(pty::activity(&f.state, id).is_none(), "a beat for a terminal that never ran");

    f.spawn(id, ps("Write-Output 'batida'; Start-Sleep -Seconds 120"));
    wait_until(Duration::from_secs(60), "the output", || {
        f.events.output.lock().contains("batida")
    });
    let shared = f.shared(id);
    let (_, _, last) = quiet_stretch(&f, &shared, 1_500, 1_600);
    let beat = pty::activity(&f.state, id).expect("a live terminal has a beat");
    assert_eq!(beat.id, id);
    assert_eq!(beat.last_byte_at, last);
    assert!(beat.idle_ms >= 1_500, "idle {} ms", beat.idle_ms);

    pty::kill(&f.state, id).ok();
    wait_until(Duration::from_secs(25), "kill to clear registry", || {
        !pty::exists(&f.state, id)
    });
    assert!(pty::activity(&f.state, id).is_none(), "a beat for a dead terminal");
    pty::scrollback::Scrollback::delete_file(id);
}

/// Why this rule matters: an SSH launch carries its whole remote command in
/// one argument, written by the frontend *before* the terminal row exists. If
/// the placeholder does not get filled in, the remote `yard` announces itself
/// as a terminal called `{{YARD_PTY_ID}}` and every call it makes is refused
/// with "não registrado no workspace".
#[test]
fn the_pty_id_placeholder_is_filled_in_at_spawn() {
    let args = vec![
        "-tt".to_string(),
        "host".to_string(),
        "YARD_PTY_ID='{{YARD_PTY_ID}}' exec claude".to_string(),
    ];
    let out = super::expand_pty_id(&args, "abc123");
    assert_eq!(out[0], "-tt");
    assert_eq!(out[2], "YARD_PTY_ID='abc123' exec claude");
}

#[test]
fn an_argument_without_the_placeholder_is_untouched() {
    let args = vec!["--resume".to_string(), "{{outra coisa}}".to_string()];
    assert_eq!(super::expand_pty_id(&args, "abc123"), args);
}

/// SSH commands must retain placeholders on disk while each process receives the current credential.
#[test]
fn session_credentials_are_resolved_without_mutating_the_saved_launch() {
    let args = vec!["YARD_TOKEN='{{YARD_BRIDGE_TOKEN}}' exec claude".to_string()];
    let expanded = super::expand_bridge_token(&args, "fixture-secret");
    assert_eq!(expanded[0], "YARD_TOKEN='fixture-secret' exec claude");
    assert_eq!(args[0], "YARD_TOKEN='{{YARD_BRIDGE_TOKEN}}' exec claude");
}

#[test]
fn old_generated_ssh_launches_keep_no_credentials_and_reconnect_to_the_current_session() {
    let args = vec!["-tt".into(), "-R".into(), "51515:127.0.0.1:51515".into(), "host".into(),
        "cat <<'YARD_SHIM_EOF'\nshim\nYARD_SHIM_EOF\nYARD_PTY_ID='old' YARD_TOKEN='old-secret' YARD_PORT=51515 exec claude".into()];
    let saved = super::normalize_remote_launch(&args);
    assert!(!saved.join(" ").contains("old-secret"));
    let launched = super::expand_remote_launch(&saved, "current", "new-secret", Some(51000));
    assert_eq!(launched[2], "51000:127.0.0.1:51000");
    assert!(launched[4].contains("YARD_PTY_ID='current' YARD_TOKEN='new-secret' YARD_PORT=51000"));
    assert!(saved[4].contains("{{YARD_BRIDGE_TOKEN}}"));
}

/// A child that stops draining its stdin plus a large write used to block
/// inside `write` with the terminal's lock held, and terminate/resize/attach
/// and the resources supervisor wedged behind it. The lock is released
/// before the bytes go out: only the writer's own mutex stays busy.
#[test]
fn a_stalled_write_does_not_hold_the_terminal_lock() {
    use std::io::Write;
    use std::sync::mpsc;

    struct Stalled {
        entered: mpsc::Sender<()>,
        gate: mpsc::Receiver<()>,
    }
    impl Write for Stalled {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.entered.send(());
            let _ = self.gate.recv();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    struct Fake {
        writer: pty::SharedWriter,
    }

    let (entered_tx, entered) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let handle = Arc::new(parking_lot::Mutex::new(Fake {
        writer: Arc::new(parking_lot::Mutex::new(Box::new(Stalled {
            entered: entered_tx,
            gate,
        }))),
    }));
    let writer_thread = {
        let handle = handle.clone();
        std::thread::spawn(move || pty::write_through(&handle, |f| f.writer.clone(), b"payload"))
    };
    entered
        .recv_timeout(Duration::from_secs(5))
        .expect("the write never started");
    let guard = handle.try_lock_for(Duration::from_secs(2));
    assert!(
        guard.is_some(),
        "the terminal lock is still held while the write is stalled"
    );
    drop(guard);
    release.send(()).unwrap();
    assert!(writer_thread.join().unwrap().is_ok());
}

/// `std::env::vars()` panics on a variable that is not Unicode. An unpaired
/// surrogate in some unrelated variable must not stop a terminal from
/// spawning, and PATH and the Claude session markers are still found
/// around it, in their original spelling.
#[test]
fn a_non_unicode_variable_in_the_environment_does_not_break_the_scan() {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    let bad = OsString::from_wide(&[0xD800]);
    let vars = vec![
        (bad.clone(), bad),
        (OsString::from("Path"), OsString::from(r"C:\bin")),
        (OsString::from("CLAUDECODE"), OsString::from("1")),
        (OsString::from("CLAUDE_CODE_ENTRYPOINT"), OsString::from("cli")),
        (OsString::from("CLAUDE_OTHER"), OsString::from("x")),
    ];
    let (key, value) = pty::inherited_path(vars.clone());
    assert_eq!(key, OsString::from("Path"));
    assert_eq!(value, OsString::from(r"C:\bin"));
    assert_eq!(
        pty::claude_session_markers(vars),
        vec![
            OsString::from("CLAUDECODE"),
            OsString::from("CLAUDE_CODE_ENTRYPOINT")
        ]
    );
}

/// Without a PATH at all the spelling falls back to `PATH` and an empty
/// value, so the `yard` shim directory still gets prepended.
#[test]
fn a_missing_path_falls_back_to_the_canonical_spelling() {
    use std::ffi::OsString;
    let (key, value) = pty::inherited_path(Vec::<(OsString, OsString)>::new());
    assert_eq!(key, OsString::from("PATH"));
    assert_eq!(value, OsString::new());
}

// -- the page channel, end to end --------------------------------------------

/// A page that keeps every message it was sent, in order.
#[derive(Clone, Default)]
struct KeptPage(Arc<parking_lot::Mutex<Vec<super::pages::PageMessage>>>);

impl super::pages::PageLink for KeptPage {
    fn send(&self, body: super::pages::PageMessage) {
        self.0.lock().push(body);
    }
}

/// Hands every event to the page channel first and to the collector second,
/// so whatever the collector holds the page already got (the DSR answerer
/// reads the collector).
struct Tee(Arc<super::pages::Pages>, Arc<CollectingEvents>);

impl PtyEvents for Tee {
    fn output(&self, id: &str, data: String) -> bool {
        self.0.output(id, data.clone());
        self.1.output(id, data)
    }
    fn exit(&self, payload: crate::events::ExitPayload) {
        self.0.exit(payload.clone());
        self.1.exit(payload);
    }
    fn activity(&self, payload: crate::events::ActivityPayload) {
        self.0.activity(payload.clone());
        self.1.activity(payload);
    }
    fn idle(&self, payload: crate::events::IdlePayload) {
        self.0.idle(payload.clone());
        self.1.idle(payload);
    }
}

/// The real engine (ConPTY, reader, pump, watcher) behind the page channel:
/// the text a watching page puts back together is exactly the text the
/// engine handed out, raw chunks and JSON ones alike, and the exit arrives
/// after the last of it, which is what lets the page clear the prompt tail
/// knowing nothing of the dead run is still on its way.
#[test]
fn a_live_terminal_reaches_a_watching_page_byte_for_byte_and_its_exit_after_it() {
    use super::pages::PageMessage;

    let f = Fixture::new();
    let pages = Arc::new(super::pages::Pages::default());
    let page = KeptPage::default();
    let link = pages.open("main", "p1", Box::new(page.clone()));
    pages.subscribe(link, 1, super::pages::Topic::Output("t-page".into())).unwrap();
    pages.subscribe(link, 2, super::pages::Topic::Exit("t-page".into())).unwrap();

    let marker = "yard-fim-7";
    pty::spawn(
        Arc::new(Tee(pages.clone(), f.events.clone())),
        &f.state,
        SpawnOptions {
            id: "t-page".into(),
            program: pty::default_shell(),
            // Tens of KB: the pump hands out chunks well past the raw cut.
            args: ps(&format!("Write-Output ('acao cafe ' * 3000); Write-Output '{marker}'")),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
            kind: "shell".into(),
            title: "t-page".into(),
            env: vec![],
            keep_scrollback: false,
        },
    )
    .expect("spawn");
    f.auto_respond_dsr("t-page");

    wait_until(Duration::from_secs(60), "the exit", || f.exit_reason("t-page").is_some());

    let mut text = String::new();
    let (mut raw, mut last_output, mut exit_at) = (0, None, None);
    for (n, body) in page.0.lock().iter().enumerate() {
        match body {
            PageMessage::Json(json) => {
                let message: serde_json::Value = serde_json::from_str(json).unwrap();
                if let Some(output) = message.get("output") {
                    assert_eq!(output["id"], "t-page");
                    assert_eq!(message["to"], serde_json::json!([1]));
                    text.push_str(output["data"].as_str().unwrap());
                    last_output = Some(n);
                } else if message.get("exit").is_some() {
                    assert_eq!(message["to"], serde_json::json!([2]));
                    exit_at = Some(n);
                }
            }
            PageMessage::Raw(bytes) => {
                let (rest, len) = bytes.split_at(bytes.len() - 4);
                let len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
                let (data, trailer) = rest.split_at(rest.len() - len);
                let trailer: serde_json::Value = serde_json::from_slice(trailer).unwrap();
                assert_eq!(trailer, serde_json::json!({ "to": [1], "id": "t-page" }));
                text.push_str(std::str::from_utf8(data).unwrap());
                raw += 1;
                last_output = Some(n);
            }
        }
    }

    assert_eq!(text, *f.events.output.lock());
    assert!(text.contains(marker), "the marker never reached the page");
    assert!(raw > 0, "no chunk went as raw bytes");
    assert!(exit_at > last_output, "the exit overtook the output");

    pty::scrollback::Scrollback::delete_file("t-page");
}
