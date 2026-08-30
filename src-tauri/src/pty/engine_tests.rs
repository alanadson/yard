//! PTY engine tests — the F1 acceptance criteria.
//!
//! They exercise the real path (ConPTY, reader thread, coalescing,
//! scrollback, Job Objects) with an in-memory event collector instead of the
//! Tauri bus. That is why the engine got the `PtyEvents` trait:
//! testing the heart of the app cannot depend on spinning up a GUI runtime.

#![cfg(windows)]

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
        let dir = std::env::temp_dir().join("yard-testes");
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
                kind: "shell".into(),
                title: id.to_string(),
                env: vec![],
                keep_scrollback: false,
            },
        )
        .expect("spawn");
        self.auto_respond_dsr(id);
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

#[test]
fn spawn_reads_output_emits_event_and_exits_on_its_own() {
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
        ps("1..60000 | ForEach-Object { 'linha-de-teste-com-uma-centena-de-bytes-para-encher-o-buffer-rapido-' + $_ }"),
    );

    wait_until(Duration::from_secs(90), "process to finish", || {
        !pty::exists(&f.state, "t-flood")
    });

    let sb_len = pty::attach(&f.state, "t-flood").data.len();
    assert!(
        sb_len <= super::scrollback::RING_CAP,
        "scrollback blew past the 4 MB cap: {sb_len} bytes"
    );
    assert!(sb_len > 0, "empty scrollback — nothing was captured");

    pty::scrollback::Scrollback::delete_file("t-flood");
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
