//! Account bindings keep existing terminals on their original provider login.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub accounts: Vec<Account>,
    pub selected: BTreeMap<String, Option<String>>,
    pub bindings: Vec<AccountBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountBinding {
    pub terminal_id: String,
    pub provider: String,
    pub account_id: Option<String>,
}

pub fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'auth_required'
    );
    CREATE TABLE IF NOT EXISTS terminal_account_bindings (
        terminal_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_id TEXT
    );
    CREATE TABLE IF NOT EXISTS account_defaults (
        provider TEXT PRIMARY KEY,
        account_id TEXT
    );
    INSERT OR IGNORE INTO terminal_account_bindings(terminal_id, provider, account_id)
    SELECT id, agent_id, NULL FROM terminals WHERE agent_id IN ('codex', 'claude');",
    )
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn supported(provider: &str) -> bool {
    matches!(provider, "codex" | "claude")
}

pub fn runtime_dir(app_dir: &Path, account: &Account) -> Result<PathBuf, String> {
    if !valid_id(&account.id) || !supported(&account.provider) {
        return Err("invalid_account".into());
    }
    Ok(app_dir
        .join("accounts")
        .join(&account.id)
        .join(format!(".{}", account.provider)))
}

pub fn create_in(
    connection: &Connection,
    app_dir: &Path,
    id: &str,
    provider: &str,
    label: &str,
) -> Result<Account, String> {
    if !valid_id(id)
        || !supported(provider)
        || label.trim().is_empty()
        || label.len() > 80
        || label.chars().any(char::is_control)
    {
        return Err("invalid_account".into());
    }
    let account = Account {
        id: id.into(),
        provider: provider.into(),
        label: label.trim().into(),
        status: "auth_required".into(),
    };
    let root = runtime_dir(app_dir, &account)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO agent_accounts(id, provider, label) VALUES (?1, ?2, ?3)",
            rusqlite::params![account.id, account.provider, account.label],
        )
        .map_err(|error| error.to_string())?;
    let owner = root.parent().ok_or("invalid_account")?;
    std::fs::create_dir_all(app_dir.join("accounts"))
        .map_err(|_| "account_directory_unavailable")?;
    std::fs::create_dir(owner).map_err(|_| "account_directory_unavailable")?;
    if std::fs::create_dir(&root).is_err() {
        let _ = std::fs::remove_dir(owner);
        return Err("account_directory_unavailable".into());
    }
    if provider == "claude" && crate::bridge::install_agent_docs_in(owner).is_err() {
        let _ = std::fs::remove_dir_all(owner);
        return Err("account_directory_unavailable".into());
    }
    if let Err(error) = transaction.commit() {
        let _ = std::fs::remove_dir_all(owner);
        return Err(error.to_string());
    }
    Ok(account)
}

pub fn snapshot(connection: &Connection) -> Result<AccountSnapshot, String> {
    let mut query = connection
        .prepare("SELECT id, provider, label, status FROM agent_accounts ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    let accounts = query
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                provider: row.get(1)?,
                label: row.get(2)?,
                status: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let selected = connection
        .prepare("SELECT provider, account_id FROM account_defaults")
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|error| error.to_string())?;
    let bindings = connection.prepare("SELECT terminal_id, provider, account_id FROM terminal_account_bindings ORDER BY terminal_id").map_err(|error| error.to_string())?
        .query_map([], |row| Ok(AccountBinding { terminal_id: row.get(0)?, provider: row.get(1)?, account_id: row.get(2)? }))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(AccountSnapshot {
        accounts,
        selected,
        bindings,
    })
}

pub fn select_account(
    connection: &Connection,
    provider: &str,
    id: Option<&str>,
) -> Result<(), String> {
    if !supported(provider) {
        return Err("unsupported_account_provider".into());
    }
    if let Some(id) = id {
        let ready = connection
            .query_row(
                "SELECT 1 FROM agent_accounts WHERE id = ?1 AND provider = ?2 AND status = 'ready'",
                rusqlite::params![id, provider],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if ready.is_none() {
            return Err("account_auth_required".into());
        }
    }
    connection
        .execute(
            "INSERT INTO account_defaults(provider, account_id) VALUES (?1, ?2)
        ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id",
            rusqlite::params![provider, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn bind_terminal(
    connection: &Connection,
    terminal: &str,
    provider: &str,
) -> Result<AccountBinding, String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO terminal_account_bindings(terminal_id, provider, account_id)
        VALUES (?1, ?2, (SELECT account_id FROM account_defaults WHERE provider = ?2))",
            rusqlite::params![terminal, provider],
        )
        .map_err(|error| error.to_string())?;
    connection.query_row("SELECT terminal_id, provider, account_id FROM terminal_account_bindings WHERE terminal_id = ?1",
        [terminal], |row| Ok(AccountBinding { terminal_id: row.get(0)?, provider: row.get(1)?, account_id: row.get(2)? }))
        .map_err(|error| error.to_string())
}

pub fn assign_terminal(
    connection: &Connection,
    terminal: &str,
    provider: &str,
    account_id: Option<&str>,
) -> Result<(), String> {
    if !valid_id(terminal) || !supported(provider) {
        return Err("invalid_account_binding".into());
    }
    if let Some(id) = account_id {
        if get_account(connection, id)?.provider != provider {
            return Err("account_provider_mismatch".into());
        }
    }
    connection.execute("INSERT OR IGNORE INTO terminal_account_bindings(terminal_id, provider, account_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![terminal, provider, account_id]).map_err(|error| error.to_string())?;
    let bound = bind_terminal(connection, terminal, provider)?;
    if bound.provider != provider || bound.account_id.as_deref() != account_id {
        return Err("account_already_bound".into());
    }
    Ok(())
}

pub struct AuthenticationRequest {
    pub provider: String,
    pub directory: PathBuf,
    pub args: Vec<String>,
    pub is_login: bool,
}

impl AuthenticationRequest {
    pub fn environment_key(&self) -> &'static str {
        if self.provider == "claude" {
            "CLAUDE_CONFIG_DIR"
        } else {
            "CODEX_HOME"
        }
    }
    pub fn removed_environment(&self) -> &'static [&'static str] {
        if self.provider == "claude" {
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
                "CLAUDE_CONFIG_DIR",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
                "ANTHROPIC_BASE_URL",
            ]
        } else {
            &[
                "OPENAI_API_KEY",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_HOME",
                "OPENAI_BASE_URL",
            ]
        }
    }
}

pub fn probe(
    program: &str,
    request: &AuthenticationRequest,
    timeout: std::time::Duration,
) -> Result<bool, String> {
    use std::process::{Command, Stdio};
    use std::time::Instant;
    let (program, args) = crate::agents::resolver::resolve_launch(program, &request.args);
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in request.removed_environment() {
        command.env_remove(key);
    }
    command.env(request.environment_key(), &request.directory);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|_| "account_cli_unavailable")?;
    let job = crate::pty::job::JobHandle::create_and_assign(child.id());
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            outcome => {
                if !job.as_ref().is_some_and(|job| job.terminate()) {
                    crate::process_tree::ProcSnapshot::default().kill_tree(child.id());
                    let _ = child.kill();
                }
                let _ = child.wait();
                return Err(if outcome.is_err() {
                    "account_probe_failed"
                } else {
                    "account_probe_timeout"
                }
                .into());
            }
        }
    }
}

pub fn prepare_launch(
    connection: &Connection,
    app_dir: &Path,
    terminal: &str,
    program: &str,
    args: &[String],
) -> Result<Option<AuthenticationRequest>, String> {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let provider = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".cmd"))
        .or_else(|| name.strip_suffix(".ps1"))
        .unwrap_or(&name);
    if !supported(provider) {
        let exists = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'terminal_account_bindings')", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
        if exists {
            let account = connection
                .query_row(
                    "SELECT account_id FROM terminal_account_bindings WHERE terminal_id = ?1",
                    [terminal],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .flatten();
            if account.is_some() {
                return Err("account_transport_unsupported".into());
            }
        }
        return Ok(None);
    }
    let binding = bind_terminal(connection, terminal, provider)?;
    if binding.provider != provider {
        return Err("account_provider_mismatch".into());
    }
    let Some(id) = binding.account_id else {
        return Ok(None);
    };
    let account = get_account(connection, &id)?;
    let login: &[&str] = if provider == "claude" {
        &["auth", "login"]
    } else {
        &["login"]
    };
    if account.provider != provider {
        return Err("account_provider_mismatch".into());
    }
    if args == login {
        std::fs::create_dir_all(runtime_dir(app_dir, &account)?)
            .map_err(|_| "account_directory_unavailable")?;
        connection
            .execute(
                "UPDATE agent_accounts SET status = 'auth_required' WHERE id = ?1",
                [&id],
            )
            .map_err(|error| error.to_string())?;
    } else if account.status != "ready" {
        return Err("account_auth_required".into());
    }
    let mut request = authentication_request(connection, app_dir, &id)?;
    request.is_login = args == login;
    if provider == "claude" {
        crate::bridge::install_agent_docs_in(request.directory.parent().ok_or("invalid_account")?)
            .map_err(|_| "account_directory_unavailable")?;
    }
    Ok(Some(request))
}

pub fn get_account(connection: &Connection, id: &str) -> Result<Account, String> {
    connection
        .query_row(
            "SELECT id, provider, label, status FROM agent_accounts WHERE id = ?1",
            [id],
            |row| {
                Ok(Account {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    label: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "account_not_found".into())
}

pub fn remove_in(
    connection: &Connection,
    app_dir: &Path,
    id: &str,
    active: &[String],
) -> Result<(), String> {
    let account = get_account(connection, id)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let bindings = snapshot(&transaction)?.bindings;
    for binding in bindings
        .iter()
        .filter(|binding| binding.account_id.as_deref() == Some(id))
    {
        let saved = transaction
            .query_row(
                "SELECT 1 FROM terminals WHERE id = ?1",
                [&binding.terminal_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if saved || active.contains(&binding.terminal_id) {
            return Err("account_in_use".into());
        }
    }
    let root = runtime_dir(app_dir, &account)?;
    let owner = root.parent().ok_or("invalid_account")?;
    if owner.exists() {
        std::fs::remove_dir_all(owner).map_err(|_| "account_directory_unavailable")?;
    }
    transaction
        .execute("DELETE FROM account_defaults WHERE account_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    // Retained identities make an old terminal fail closed after account removal.
    transaction
        .execute("DELETE FROM agent_accounts WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn authentication_request(
    connection: &Connection,
    app_dir: &Path,
    id: &str,
) -> Result<AuthenticationRequest, String> {
    let account = get_account(connection, id)?;
    let directory = runtime_dir(app_dir, &account)?;
    if !directory.is_dir() {
        return Err("account_directory_unavailable".into());
    }
    let args = if account.provider == "claude" {
        vec!["auth".into(), "status".into()]
    } else {
        vec!["login".into(), "status".into()]
    };
    Ok(AuthenticationRequest {
        provider: account.provider,
        directory,
        args,
        is_login: false,
    })
}

pub fn config_home(
    connection: &Connection,
    app_dir: &Path,
    system: &Path,
    provider: &str,
    account_id: Option<&str>,
) -> Result<PathBuf, String> {
    if !supported(provider) {
        return Ok(system.to_path_buf());
    }
    let selected = connection
        .query_row(
            "SELECT account_id FROM account_defaults WHERE provider = ?1",
            [provider],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let id = account_id.or(selected.as_deref()).unwrap_or_default();
    if id.is_empty() {
        return Ok(system.to_path_buf());
    }
    let account = get_account(connection, id)?;
    if account.provider != provider {
        return Err("account_provider_mismatch".into());
    }
    let runtime = runtime_dir(app_dir, &account)?;
    if !runtime.is_dir() {
        return Err("account_directory_unavailable".into());
    }
    Ok(if provider == "codex" {
        runtime.parent().ok_or("invalid_account")?.to_path_buf()
    } else {
        runtime
    })
}

pub type SessionRoot = (String, String, PathBuf);

pub fn session_roots(app_dir: &Path, accounts: &[Account]) -> Result<Vec<SessionRoot>, String> {
    accounts
        .iter()
        .map(|account| {
            let directory = runtime_dir(app_dir, account)?.join(if account.provider == "codex" {
                "sessions"
            } else {
                "projects"
            });
            Ok((account.provider.clone(), account.id.clone(), directory))
        })
        .collect()
}

pub fn check_in_with(
    connection: &Connection,
    app_dir: &Path,
    id: &str,
    probe: impl FnOnce(&AuthenticationRequest) -> Result<bool, String>,
) -> Result<Account, String> {
    let request = authentication_request(connection, app_dir, id)?;
    let status = if probe(&request)? {
        "ready"
    } else {
        "auth_required"
    };
    connection
        .execute(
            "UPDATE agent_accounts SET status = ?2 WHERE id = ?1",
            rusqlite::params![id, status],
        )
        .map_err(|error| error.to_string())?;
    get_account(connection, id)
}

fn announce(app: &tauri::AppHandle, connection: &Connection) -> Result<AccountSnapshot, String> {
    use tauri::Emitter;
    let metadata = snapshot(connection)?;
    let _ = app.emit(crate::events::ACCOUNTS_CHANGED, &metadata);
    crate::usage::request_refresh(None);
    Ok(metadata)
}

#[tauri::command]
#[specta::specta]
pub async fn accounts_snapshot(app: tauri::AppHandle) -> Result<AccountSnapshot, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<crate::state::AppState>>();
        let result = snapshot(&state.db.lock());
        result
    })
    .await
    .map_err(|_| "account_operation_interrupted".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn account_create(
    app: tauri::AppHandle,
    id: String,
    provider: String,
    label: String,
) -> Result<AccountSnapshot, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<crate::state::AppState>>();
        let db = state.db.lock();
        create_in(&db, &crate::paths::app_dir(), &id, &provider, &label)?;
        announce(&app, &db)
    })
    .await
    .map_err(|_| "account_operation_interrupted".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn account_select(
    app: tauri::AppHandle,
    provider: String,
    account_id: Option<String>,
) -> Result<AccountSnapshot, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<crate::state::AppState>>();
        let db = state.db.lock();
        select_account(&db, &provider, account_id.as_deref())?;
        announce(&app, &db)
    })
    .await
    .map_err(|_| "account_operation_interrupted".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn account_assign(
    app: tauri::AppHandle,
    terminal_id: String,
    provider: String,
    account_id: Option<String>,
) -> Result<AccountSnapshot, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<crate::state::AppState>>();
        let db = state.db.lock();
        assign_terminal(&db, &terminal_id, &provider, account_id.as_deref())?;
        announce(&app, &db)
    })
    .await
    .map_err(|_| "account_operation_interrupted".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn account_verify(app: tauri::AppHandle, id: String) -> Result<AccountSnapshot, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<crate::state::AppState>>();
        let request = authentication_request(&state.db.lock(), &crate::paths::app_dir(), &id)?;
        let program = crate::agents::resolver::find_binary(&request.provider)
            .ok_or("account_cli_unavailable")?;
        let ready = probe(
            &program.to_string_lossy(),
            &request,
            std::time::Duration::from_secs(12),
        )?;
        let db = state.db.lock();
        check_in_with(&db, &crate::paths::app_dir(), &id, |_| Ok(ready))?;
        announce(&app, &db)
    })
    .await
    .map_err(|_| "account_operation_interrupted".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn account_remove(app: tauri::AppHandle, id: String) -> Result<AccountSnapshot, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<crate::state::AppState>>();
        let db = state.db.lock();
        let mut active = state.running_ids();
        active.extend(state.spawning_ptys.lock().iter().cloned());
        remove_in(&db, &crate::paths::app_dir(), &id, &active)?;
        announce(&app, &db)
    })
    .await
    .map_err(|_| "account_operation_interrupted".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        connection: Connection,
        root: std::path::PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let connection = Connection::open_in_memory().unwrap();
            connection
                .execute_batch("CREATE TABLE terminals(id TEXT PRIMARY KEY, agent_id TEXT);")
                .unwrap();
            migrate(&connection).unwrap();
            let root =
                std::env::temp_dir().join(format!("yard-accounts-{name}-{}", std::process::id()));
            Self { connection, root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_managed_codex_account_has_an_isolated_runtime_directory() {
        let fixture = Fixture::new("codex-home");
        let account = create_in(
            &fixture.connection,
            &fixture.root,
            "personal",
            "codex",
            "Personal",
        )
        .unwrap();
        assert_eq!(account.label, "Personal");
        assert!(runtime_dir(&fixture.root, &account).unwrap().is_dir());
        assert_eq!(snapshot(&fixture.connection).unwrap().accounts, [account]);
    }

    #[test]
    fn selecting_a_codex_account_only_changes_future_terminal_bindings() {
        let fixture = Fixture::new("codex-selection");
        let original = bind_terminal(&fixture.connection, "original", "codex").unwrap();
        let account =
            create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        fixture
            .connection
            .execute(
                "UPDATE agent_accounts SET status = 'ready' WHERE id = ?1",
                [&account.id],
            )
            .unwrap();
        select_account(&fixture.connection, "codex", Some(&account.id)).unwrap();
        assert_eq!(
            bind_terminal(&fixture.connection, "original", "codex").unwrap(),
            original
        );
        assert_eq!(original.account_id, None);
        assert_eq!(
            bind_terminal(&fixture.connection, "new", "codex")
                .unwrap()
                .account_id
                .as_deref(),
            Some("work")
        );
        assert_eq!(
            snapshot(&fixture.connection).unwrap().selected.get("codex"),
            Some(&Some("work".to_string()))
        );
    }

    #[test]
    fn a_codex_launch_keeps_its_home_after_the_default_changes() {
        let fixture = Fixture::new("codex-launch");
        for id in ["work", "personal"] {
            create_in(&fixture.connection, &fixture.root, id, "codex", id).unwrap();
            check_in_with(&fixture.connection, &fixture.root, id, |_| Ok(true)).unwrap();
        }
        select_account(&fixture.connection, "codex", Some("work")).unwrap();
        let first = prepare_launch(
            &fixture.connection,
            &fixture.root,
            "terminal",
            "C:/bin/codex.cmd",
            &[],
        )
        .unwrap()
        .unwrap();
        select_account(&fixture.connection, "codex", Some("personal")).unwrap();
        let resumed = prepare_launch(
            &fixture.connection,
            &fixture.root,
            "terminal",
            "codex",
            &["resume".into()],
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.directory, fixture.root.join("accounts/work/.codex"));
        assert_eq!(resumed.directory, first.directory);
        assert_eq!(resumed.environment_key(), "CODEX_HOME");
        assert!(resumed.removed_environment().contains(&"OPENAI_API_KEY"));
        assert!(
            prepare_launch(&fixture.connection, &fixture.root, "remote", "wsl.exe", &[])
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_codex_login_uses_the_requested_account_without_enabling_normal_launches() {
        let fixture = Fixture::new("codex-login");
        create_in(
            &fixture.connection,
            &fixture.root,
            "personal",
            "codex",
            "Personal",
        )
        .unwrap();
        assign_terminal(&fixture.connection, "login-tab", "codex", Some("personal")).unwrap();
        assert!(prepare_launch(
            &fixture.connection,
            &fixture.root,
            "login-tab",
            "codex",
            &[]
        )
        .is_err());
        let login = prepare_launch(
            &fixture.connection,
            &fixture.root,
            "login-tab",
            "codex",
            &["login".into()],
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            login.directory,
            fixture.root.join("accounts/personal/.codex")
        );
        assert!(snapshot(&fixture.connection).unwrap().selected.is_empty());
        assert!(assign_terminal(&fixture.connection, "login-tab", "codex", None).is_err());
    }

    #[test]
    fn a_claude_account_uses_its_own_auth_command_and_directory() {
        let fixture = Fixture::new("claude-home");
        let account = create_in(
            &fixture.connection,
            &fixture.root,
            "claude-work",
            "claude",
            "Work",
        )
        .unwrap();
        let checked = check_in_with(&fixture.connection, &fixture.root, &account.id, |request| {
            assert_eq!(request.args, ["auth", "status"]);
            assert_eq!(request.environment_key(), "CLAUDE_CONFIG_DIR");
            assert_eq!(
                request.directory,
                fixture.root.join("accounts/claude-work/.claude")
            );
            assert!(request
                .removed_environment()
                .contains(&"CLAUDE_CODE_OAUTH_TOKEN"));
            Ok(true)
        })
        .unwrap();
        assert_eq!(checked.status, "ready");
        select_account(&fixture.connection, "claude", Some(&account.id)).unwrap();
        let launch = prepare_launch(
            &fixture.connection,
            &fixture.root,
            "claude-tab",
            "claude.cmd",
            &[],
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            launch.directory,
            runtime_dir(&fixture.root, &account).unwrap()
        );
        fixture
            .connection
            .execute(
                "INSERT INTO terminals VALUES ('legacy-claude', 'claude')",
                [],
            )
            .unwrap();
        migrate(&fixture.connection).unwrap();
        assert_eq!(
            bind_terminal(&fixture.connection, "legacy-claude", "claude")
                .unwrap()
                .account_id,
            None
        );
    }

    #[test]
    fn creating_an_account_never_adopts_credentials_left_in_an_existing_directory() {
        let fixture = Fixture::new("orphan-home");
        let orphan = fixture.root.join("accounts/personal/.codex");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("auth.json"), "private-fixture").unwrap();
        assert!(create_in(
            &fixture.connection,
            &fixture.root,
            "personal",
            "codex",
            "Personal"
        )
        .is_err());
        assert!(snapshot(&fixture.connection).unwrap().accounts.is_empty());
        assert_eq!(
            std::fs::read_to_string(orphan.join("auth.json")).unwrap(),
            "private-fixture"
        );
    }

    #[test]
    fn a_registry_snapshot_exposes_terminal_bindings_without_reading_credentials() {
        let fixture = Fixture::new("metadata");
        let account =
            create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        std::fs::write(
            runtime_dir(&fixture.root, &account)
                .unwrap()
                .join("auth.json"),
            "private-fixture-token",
        )
        .unwrap();
        assign_terminal(&fixture.connection, "terminal", "codex", Some("work")).unwrap();
        let metadata = snapshot(&fixture.connection).unwrap();
        assert_eq!(
            metadata.bindings,
            [AccountBinding {
                terminal_id: "terminal".into(),
                provider: "codex".into(),
                account_id: Some("work".into())
            }]
        );
        let serialized = serde_json::to_string(&metadata).unwrap();
        assert!(!serialized.contains("private-fixture-token"));
        assert!(!serialized.contains("auth.json"));
    }

    #[test]
    fn an_account_in_use_cannot_be_removed_and_an_unused_account_loses_its_local_credentials() {
        let fixture = Fixture::new("remove-account");
        let used = create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        assign_terminal(&fixture.connection, "terminal", "codex", Some("work")).unwrap();
        assert_eq!(
            remove_in(
                &fixture.connection,
                &fixture.root,
                &used.id,
                &["terminal".into()]
            )
            .unwrap_err(),
            "account_in_use"
        );
        let unused = create_in(
            &fixture.connection,
            &fixture.root,
            "unused",
            "claude",
            "Unused",
        )
        .unwrap();
        let directory = runtime_dir(&fixture.root, &unused).unwrap();
        std::fs::write(directory.join(".credentials.json"), "private-fixture-token").unwrap();
        remove_in(&fixture.connection, &fixture.root, &unused.id, &[]).unwrap();
        assert!(!directory.exists());
        assert_eq!(snapshot(&fixture.connection).unwrap().accounts, [used]);
    }

    #[test]
    fn a_managed_terminal_cannot_silently_start_in_an_unmanaged_transport() {
        let fixture = Fixture::new("remote-binding");
        create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        assign_terminal(&fixture.connection, "terminal", "codex", Some("work")).unwrap();
        assert!(prepare_launch(
            &fixture.connection,
            &fixture.root,
            "terminal",
            "wsl.exe",
            &["codex".into()]
        )
        .is_err());
        assert!(prepare_launch(
            &fixture.connection,
            &fixture.root,
            "terminal",
            "ssh.exe",
            &["host".into()]
        )
        .is_err());
    }

    #[test]
    fn managed_claude_accounts_keep_the_yard_bridge_skills() {
        let fixture = Fixture::new("claude-skills");
        let account =
            create_in(&fixture.connection, &fixture.root, "work", "claude", "Work").unwrap();
        let runtime = runtime_dir(&fixture.root, &account).unwrap();
        for name in ["yard", "yard-portal", "yard-flow"] {
            let skill = std::fs::read_to_string(runtime.join("skills").join(name).join("SKILL.md"))
                .expect("the managed Claude home has Yard skills");
            assert!(skill.contains("yard"));
        }
        assert!(!runtime.join(".credentials.json").exists());
    }

    #[test]
    fn a_restored_account_can_recreate_its_missing_home_only_for_an_explicit_login() {
        let fixture = Fixture::new("restored-account");
        let account =
            create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        check_in_with(&fixture.connection, &fixture.root, "work", |_| Ok(true)).unwrap();
        select_account(&fixture.connection, "codex", Some("work")).unwrap();
        assign_terminal(&fixture.connection, "terminal", "codex", Some("work")).unwrap();
        std::fs::remove_dir_all(runtime_dir(&fixture.root, &account).unwrap()).unwrap();
        assert!(
            prepare_launch(&fixture.connection, &fixture.root, "terminal", "codex", &[]).is_err()
        );
        let login = prepare_launch(
            &fixture.connection,
            &fixture.root,
            "terminal",
            "codex",
            &["login".into()],
        )
        .unwrap()
        .unwrap();
        assert!(login.directory.is_dir());
        assert!(
            prepare_launch(&fixture.connection, &fixture.root, "terminal", "codex", &[]).is_err()
        );
        check_in_with(&fixture.connection, &fixture.root, "work", |_| Ok(true)).unwrap();
        assert_eq!(
            prepare_launch(&fixture.connection, &fixture.root, "terminal", "codex", &[])
                .unwrap()
                .unwrap()
                .directory,
            login.directory
        );
    }

    #[test]
    fn session_discovery_includes_registered_codex_and_claude_accounts() {
        let fixture = Fixture::new("session-roots");
        for provider in ["codex", "claude"] {
            create_in(
                &fixture.connection,
                &fixture.root,
                provider,
                provider,
                "Work",
            )
            .unwrap();
        }
        let metadata = snapshot(&fixture.connection).unwrap();
        let roots = session_roots(&fixture.root, &metadata.accounts).unwrap();
        assert_eq!(
            roots,
            vec![
                (
                    "codex".into(),
                    "codex".into(),
                    fixture.root.join("accounts/codex/.codex/sessions")
                ),
                (
                    "claude".into(),
                    "claude".into(),
                    fixture.root.join("accounts/claude/.claude/projects")
                ),
            ]
        );
    }

    #[test]
    fn removing_an_unused_account_never_rebinds_an_old_terminal_to_system_credentials() {
        let fixture = Fixture::new("removed-binding");
        create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        check_in_with(&fixture.connection, &fixture.root, "work", |_| Ok(true)).unwrap();
        select_account(&fixture.connection, "codex", Some("work")).unwrap();
        assign_terminal(&fixture.connection, "old-terminal", "codex", Some("work")).unwrap();
        remove_in(&fixture.connection, &fixture.root, "work", &[]).unwrap();
        assert!(prepare_launch(
            &fixture.connection,
            &fixture.root,
            "old-terminal",
            "codex",
            &[]
        )
        .is_err());
        assert_eq!(
            bind_terminal(&fixture.connection, "old-terminal", "codex")
                .unwrap()
                .account_id
                .as_deref(),
            Some("work")
        );
    }

    #[test]
    fn a_failed_codex_login_does_not_replace_the_selected_account() {
        let fixture = Fixture::new("codex-auth-failure");
        create_in(&fixture.connection, &fixture.root, "work", "codex", "Work").unwrap();
        fixture
            .connection
            .execute(
                "UPDATE agent_accounts SET status = 'ready' WHERE id = 'work'",
                [],
            )
            .unwrap();
        select_account(&fixture.connection, "codex", Some("work")).unwrap();
        create_in(
            &fixture.connection,
            &fixture.root,
            "personal",
            "codex",
            "Personal",
        )
        .unwrap();
        let checked = check_in_with(&fixture.connection, &fixture.root, "personal", |request| {
            assert_eq!(request.args, ["login", "status"]);
            assert_eq!(
                request.directory,
                fixture.root.join("accounts/personal/.codex")
            );
            Ok(false)
        })
        .unwrap();
        assert_eq!(checked.status, "auth_required");
        assert!(select_account(&fixture.connection, "codex", Some("personal")).is_err());
        assert_eq!(
            snapshot(&fixture.connection).unwrap().selected.get("codex"),
            Some(&Some("work".to_string()))
        );
    }
}
