//! Export the registered desktop API for the frontend without starting the app.

use crate::events;

/// Payloads emitted by native producers, keyed like the generated topic table.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EventPayloads {
    pub accounts_changed: crate::accounts::AccountSnapshot,
    pub agents_changed: (),
    pub native_hook: crate::scheduler::HookReport,
    pub queue_changed: (),
    pub flow_changed: (),
    pub checkpoint_notices: (),
    pub routine_changed: (),
    pub session_feed: crate::agents::tail::SessionFeed,
    pub files_activity: events::FilesActivity,
    pub resources_tick: events::ResourcesTick,
    pub window_shown: events::WindowShown,
    pub bridge_request: serde_json::Value,
    pub usage_update: crate::usage::UsageSnapshot,
    pub portal_nav: crate::portal::PortalNav,
    pub portal_popup: crate::portal::PortalPopup,
    pub portal_escape: crate::portal::PortalId,
    pub portal_menu: crate::portal::PortalMenu,
    pub tray_quit: (),
    pub lsp_message: crate::lsp::LspMessage,
    pub lsp_exit: crate::lsp::LspExit,
}

pub fn topics() -> serde_json::Value {
    serde_json::json!({
        "accountsChanged": events::ACCOUNTS_CHANGED,
        "agentsChanged": events::AGENTS_CHANGED,
        "nativeHook": events::NATIVE_HOOK,
        "queueChanged": events::QUEUE_CHANGED,
        "flowChanged": events::FLOW_CHANGED,
        "checkpointNotices": events::CHECKPOINT_NOTICES,
        "routineChanged": events::ROUTINE_CHANGED,
        "sessionFeed": events::SESSION_FEED,
        "filesActivity": events::FILES_ACTIVITY,
        "resourcesTick": events::RESOURCES_TICK,
        "windowShown": events::WINDOW_SHOWN,
        "bridgeRequest": events::BRIDGE_REQUEST,
        "usageUpdate": events::USAGE_UPDATE,
        "portalNav": events::PORTAL_NAV,
        "portalPopup": events::PORTAL_POPUP,
        "portalEscape": events::PORTAL_ESCAPE,
        "portalMenu": events::PORTAL_MENU,
        "trayQuit": events::TRAY_QUIT,
        "lspMessage": events::LSP_MESSAGE,
        "lspExit": events::LSP_EXIT,
    })
}

pub fn export(path: &std::path::Path) -> Result<(), String> {
    crate::command_contract()
        .export(specta_typescript::Typescript::default(), path)
        .map_err(|error| error.to_string())?;
    // Source documentation follows the repository's punctuation convention.
    let source = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    // Specta rc.26 does not escape this JavaScript keyword. Keep the wire key.
    let source = source
        .replace(", switch: boolean", ", switchBranch: boolean")
        .replace(", switch })", ", switch: switchBranch })");
    std::fs::write(path, source.replace('\u{2014}', ",")).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn checked_in_frontend_contract_matches_current_rust_api() {
        let path =
            std::env::temp_dir().join(format!("yard-current-contract-{}.ts", std::process::id()));
        super::export(&path).unwrap();
        let generated = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\r\n", "\n");
        let committed = include_str!("../../../src/desktop/bindings.ts").replace("\r\n", "\n");
        std::fs::remove_file(path).unwrap();
        assert!(
            generated == committed,
            "Rust API changed: run npm run contracts:generate and commit the bindings"
        );
    }

    // Event listeners must use the same names and payloads as their native producers.
    #[test]
    fn exports_event_topics_and_payloads_for_the_desktop_listener() {
        let path =
            std::env::temp_dir().join(format!("yard-event-contract-{}.ts", std::process::id()));
        super::export(&path).unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(source.contains("export const topics"));
        assert!(source.contains(crate::events::QUEUE_CHANGED));
        assert!(source.contains("EventPayloads"));
        assert!(source.contains("sessionFeed: SessionFeed"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn exports_reserved_argument_names_without_changing_the_wire_key() {
        let path =
            std::env::temp_dir().join(format!("yard-reserved-contract-{}.ts", std::process::id()));
        super::export(&path).unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(!source.contains(", switch: boolean"));
        assert!(source.contains("switch: switchBranch"));
        std::fs::remove_file(path).unwrap();
    }

    /// Generated bindings must carry actual command inputs, not unchecked invoke strings.
    #[test]
    fn exports_registered_terminal_commands_with_their_rust_argument_types() {
        let directory =
            std::env::temp_dir().join(format!("yard-contract-export-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("bindings.ts");
        super::export(&path).unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(source.contains("spawn_pty"));
        assert!(source.contains("SpawnOptions"));
        assert!(source.contains("submitPrompt: boolean | null"));
        assert!(
            !source.contains("AppState"),
            "injected backend state is not a wire argument"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
