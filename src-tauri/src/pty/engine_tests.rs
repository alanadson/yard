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
fn isolar_dados_de_teste() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join("yard-testes");
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("YARD_DATA_DIR", &dir);
    });
}

impl Fixture {
    fn new() -> Self {
        isolar_dados_de_teste();
        let db = rusqlite::Connection::open_in_memory().expect("sqlite em memoria");
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
            let mut respondidas = 0usize;
            let limite = Instant::now() + Duration::from_secs(180);
            while Instant::now() < limite {
                let pedidos = events.output.lock().matches("\u{1b}[6n").count();
                for _ in respondidas..pedidos {
                    let _ = pty::write(&state, &id, "\u{1b}[1;1R");
                }
                respondidas = respondidas.max(pedidos);
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
    panic!("timeout esperando: {label}");
}

#[test]
fn spawn_le_saida_emite_evento_e_encerra_sozinho() {
    let f = Fixture::new();
    let marca = "yard-vivo-42";
    f.spawn("t-echo", ps(&format!("Write-Output '{marca}'")));

    // The scrollback (source of truth) must contain the output...
    wait_until(Duration::from_secs(30), "saida no scrollback", || {
        pty::attach(&f.state, "t-echo").data.contains(marca)
    });
    // ...and the UI must have received the same bytes via coalescing.
    wait_until(Duration::from_secs(10), "saida emitida para a UI", || {
        f.events.output.lock().contains(marca)
    });
    // ...and the process must exit on its own, clearing the registry.
    wait_until(Duration::from_secs(30), "processo sair", || {
        !pty::exists(&f.state, "t-echo")
    });

    // After it is dead, attach still delivers the history (read from `.bin`) and
    // the exit reason — that is what feeds the "resume" banner.
    let after = pty::attach(&f.state, "t-echo");
    assert!(!after.alive, "nao deveria estar vivo");
    assert!(after.data.contains(marca), "historico perdido apos a saida");
    assert_eq!(
        after.exit.as_ref().map(|e| e.reason.as_str()),
        Some("normal"),
        "motivo de saida errado: {:?}",
        after.exit
    );
    assert_eq!(f.exit_reason("t-echo").as_deref(), Some("normal"));

    pty::scrollback::Scrollback::delete_file("t-echo");
}

#[test]
fn write_chega_ao_processo() {
    let f = Fixture::new();
    f.spawn("t-write", vec!["-NoProfile".into()]);

    wait_until(Duration::from_secs(40), "prompt do shell", || {
        !pty::attach(&f.state, "t-write").data.is_empty()
    });

    pty::write(&f.state, "t-write", "Write-Output 'eco-do-teste'\r\n").expect("write");

    // The first "eco-do-teste" is the echo of what we typed; the second is the
    // actual command output. Two occurrences prove the shell ran it.
    wait_until(Duration::from_secs(40), "comando executar", || {
        pty::attach(&f.state, "t-write")
            .data
            .matches("eco-do-teste")
            .count()
            >= 2
    });

    pty::kill(&f.state, "t-write").expect("kill");
    wait_until(Duration::from_secs(25), "kill limpar o registry", || {
        !pty::exists(&f.state, "t-write")
    });
    pty::scrollback::Scrollback::delete_file("t-write");
}

#[test]
fn kill_derruba_a_arvore_inteira() {
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
        map.get("t-tree").and_then(|h| h.pid).expect("pid da raiz")
    };
    wait_until(Duration::from_secs(40), "arvore crescer", || {
        f.state.procs.lock().tree_of(root).len() >= 2
    });

    let antes = f.state.procs.lock().tree_of(root);
    assert!(antes.len() >= 2, "arvore nao cresceu: {antes:?}");

    pty::kill(&f.state, "t-tree").expect("kill");

    wait_until(Duration::from_secs(25), "registry limpar", || {
        !pty::exists(&f.state, "t-tree")
    });
    wait_until(Duration::from_secs(30), "arvore inteira morrer", || {
        let mut procs = f.state.procs.lock();
        !antes.iter().any(|pid| procs.is_alive(*pid))
    });

    assert_eq!(
        pty::attach(&f.state, "t-tree")
            .exit
            .as_ref()
            .map(|e| e.reason.as_str()),
        Some("killed"),
        "kill deveria reportar motivo 'killed'"
    );

    pty::scrollback::Scrollback::delete_file("t-tree");
}

#[test]
fn suspend_reporta_motivo_e_preserva_historico() {
    let f = Fixture::new();
    let marca = "antes-de-suspender";
    f.spawn(
        "t-susp",
        ps(&format!("Write-Output '{marca}'; Start-Sleep 300")),
    );

    wait_until(Duration::from_secs(40), "marca aparecer", || {
        pty::attach(&f.state, "t-susp").data.contains(marca)
    });

    pty::suspend(&f.state, "t-susp").expect("suspend");
    wait_until(Duration::from_secs(25), "suspensao concluir", || {
        !pty::exists(&f.state, "t-susp")
    });

    let after = pty::attach(&f.state, "t-susp");
    assert_eq!(
        after.exit.as_ref().map(|e| e.reason.as_str()),
        Some("suspended")
    );
    assert!(
        after.data.contains(marca),
        "suspender precisa preservar o scrollback"
    );

    pty::scrollback::Scrollback::delete_file("t-susp");
}

#[test]
fn restart_reusa_o_id_e_mantem_o_historico() {
    let f = Fixture::new();
    f.spawn(
        "t-restart",
        ps("Write-Output 'primeira-vida'; Start-Sleep 300"),
    );

    wait_until(Duration::from_secs(40), "primeira vida", || {
        pty::attach(&f.state, "t-restart")
            .data
            .contains("primeira-vida")
    });

    let pid_antes = {
        let map = f.state.ptys.lock();
        map.get("t-restart").and_then(|h| h.pid)
    };

    pty::restart(f.sink(), &f.state, "t-restart").expect("restart");

    assert!(
        pty::exists(&f.state, "t-restart"),
        "deveria estar vivo de novo"
    );
    let pid_depois = {
        let map = f.state.ptys.lock();
        map.get("t-restart").and_then(|h| h.pid)
    };
    assert_ne!(
        pid_antes, pid_depois,
        "restart deveria criar um processo novo"
    );
    assert!(
        pty::attach(&f.state, "t-restart")
            .data
            .contains("primeira-vida"),
        "restart deveria preservar o scrollback anterior"
    );

    pty::kill(&f.state, "t-restart").ok();
    pty::scrollback::Scrollback::delete_file("t-restart");
}

#[test]
fn spawn_limpa_vetos_de_cor_herdados_e_assume_identidade_de_terminal() {
    // Simulates Yard launched from inside a terminal that turns colors off
    // (some terminal hosts export NO_COLOR=1). The child must not inherit the veto, otherwise
    // every CLI (claude, codex, git) renders monochrome.
    std::env::set_var("NO_COLOR", "1");

    let f = Fixture::new();
    f.spawn(
        "t-cor",
        ps(r#"Write-Output ("cor=[" + $env:NO_COLOR + "] prog=[" + $env:TERM_PROGRAM + "]")"#),
    );

    wait_until(Duration::from_secs(40), "sonda de env responder", || {
        pty::attach(&f.state, "t-cor").data.contains("cor=[")
    });

    let data = pty::attach(&f.state, "t-cor").data;
    assert!(
        data.contains("cor=[] prog=[Yard]"),
        "env do filho errado (NO_COLOR deveria sumir, TERM_PROGRAM=Yard): {data}"
    );

    std::env::remove_var("NO_COLOR");
    pty::kill(&f.state, "t-cor").ok();
    pty::scrollback::Scrollback::delete_file("t-cor");
}

#[test]
fn saida_volumosa_nao_estoura_a_memoria_do_buffer_de_emissao() {
    let f = Fixture::new();
    // ~6 MB of output at once: above the emit buffer cap (2 MB) and
    // the scrollback ring (4 MB). Nothing may grow without a limit.
    f.spawn(
        "t-flood",
        ps("1..60000 | ForEach-Object { 'linha-de-teste-com-uma-centena-de-bytes-para-encher-o-buffer-rapido-' + $_ }"),
    );

    wait_until(Duration::from_secs(90), "processo terminar", || {
        !pty::exists(&f.state, "t-flood")
    });

    let sb_len = pty::attach(&f.state, "t-flood").data.len();
    assert!(
        sb_len <= super::scrollback::RING_CAP,
        "scrollback estourou o teto de 4 MB: {sb_len} bytes"
    );
    assert!(sb_len > 0, "scrollback vazio — nada foi capturado");

    pty::scrollback::Scrollback::delete_file("t-flood");
}
