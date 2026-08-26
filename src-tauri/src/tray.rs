//! Notification-area icon and the summon hotkey's decision.
//!
//! Yard runs for hours behind other windows — a browser, a game — and can
//! be closed to the tray with the CLIs still working. The icon is then the
//! one place the agents' state still shows (its tooltip), and the global
//! hotkey (registered by the frontend through the global-shortcut plugin,
//! decided here) is the way back without alt-tabbing through everything.
//!
//! The icon is created with a fixed id and looked up through
//! `AppHandle::tray_by_id` when the tooltip changes — no handle in
//! `AppState`, no static.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "tray-show";
const MENU_QUIT: &str = "tray-quit";

/// Emitted to the main window when "Sair" is picked in the tray menu. The
/// frontend runs its normal exit flow (save the workspace, ask about live
/// agents, destroy) — the one `onCloseRequested` runs, but skipping the
/// close-to-tray branch, because "Sair" means quit.
pub const TOPIC_QUIT: &str = "tray://quit";

/// The tooltip: the two numbers that matter while nobody is looking.
pub fn tooltip(blocked: u32, running: u32) -> String {
    let blocked_part = match blocked {
        0 => None,
        1 => Some("1 agente bloqueado".to_string()),
        n => Some(format!("{n} agentes bloqueados")),
    };
    let running_part = match (blocked, running) {
        (_, 0) => None,
        (0, 1) => Some("1 CLI rodando".to_string()),
        (0, n) => Some(format!("{n} CLIs rodando")),
        (_, n) => Some(format!("{n} rodando")),
    };
    let parts: Vec<String> = [blocked_part, running_part].into_iter().flatten().collect();
    if parts.is_empty() {
        "Yard".to_string()
    } else {
        format!("Yard — {}", parts.join(" · "))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Summon {
    Show,
    Hide,
}

/// What the summon hotkey does. It is a toggle only when the window is
/// really in front: a visible window behind something else must come
/// forward, and a minimized one is "visible" to the OS but not to the user.
pub fn summon_action(visible: bool, focused: bool, minimized: bool) -> Summon {
    if visible && focused && !minimized {
        Summon::Hide
    } else {
        Summon::Show
    }
}

impl Summon {
    pub fn as_str(self) -> &'static str {
        match self {
            Summon::Show => "show",
            Summon::Hide => "hide",
        }
    }
}

/// Builds the icon at setup. A failure here is logged, not fatal: the app
/// works without a tray icon, only the way back from "close to tray" is
/// then the hotkey.
pub fn start(app: AppHandle) {
    match build(&app) {
        Ok(_) => tracing::info!("icone da bandeja criado"),
        Err(e) => tracing::warn!(error = %e, "nao consegui criar o icone da bandeja"),
    }
}

fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Mostrar o Yard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Sair", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip(0, 0))
        // Left click brings the window; the menu is the right button's.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => bring_front(app),
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                bring_front(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)
}

/// Show + unminimize + focus — the same three calls the single-instance
/// handler makes when a second launch knocks.
pub fn bring_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// "Sair" from the tray: the frontend owns the exit flow (autosave debounce,
/// the confirmation with live agents), so it is asked rather than bypassed.
/// With no window to ask, exit outright — `RunEvent::ExitRequested` still
/// kills the process trees.
fn request_quit(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => {
            if w.emit(TOPIC_QUIT, ()).is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// The tooltip follows the agents: the frontend pushes the counts when they
/// change (`hooks/useTray.ts`).
#[tauri::command]
pub fn tray_set_status(app: AppHandle, blocked: u32, running: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Err("icone da bandeja nao existe".into());
    };
    tray.set_tooltip(Some(tooltip(blocked, running)))
        .map_err(|e| e.to_string())
}

/// The summon hotkey's effect. Returns what it did, for the UI log.
#[tauri::command]
pub fn window_summon(app: AppHandle) -> &'static str {
    let Some(w) = app.get_webview_window("main") else {
        return Summon::Show.as_str();
    };
    let action = summon_action(
        w.is_visible().unwrap_or(false),
        w.is_focused().unwrap_or(false),
        w.is_minimized().unwrap_or(false),
    );
    match action {
        Summon::Hide => {
            let _ = w.hide();
        }
        Summon::Show => bring_front(&app),
    }
    action.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tooltip is the only place the agents' state still shows while
    /// the window is hidden: it has to say the two numbers that matter.
    #[test]
    fn tooltip_names_blocked_agents_before_running_ones() {
        assert_eq!(tooltip(0, 0), "Yard");
        assert_eq!(tooltip(0, 1), "Yard — 1 CLI rodando");
        assert_eq!(tooltip(0, 3), "Yard — 3 CLIs rodando");
        assert_eq!(tooltip(1, 2), "Yard — 1 agente bloqueado · 2 rodando");
        assert_eq!(tooltip(2, 0), "Yard — 2 agentes bloqueados");
    }

    /// The hotkey is a toggle only when the window is really in front:
    /// a visible window behind a game must come forward, not vanish.
    #[test]
    fn summon_hides_only_a_window_that_is_visible_and_focused() {
        assert_eq!(summon_action(true, true, false), Summon::Hide);
        assert_eq!(summon_action(true, false, false), Summon::Show);
        assert_eq!(summon_action(false, false, false), Summon::Show);
        assert_eq!(summon_action(true, true, true), Summon::Show);
        assert_eq!(summon_action(false, true, false), Summon::Show);
    }
}
