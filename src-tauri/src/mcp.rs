//! MCP manager — one view over the MCP server lists of every CLI.
//!
//! Each CLI keeps its servers in its own file and its own shape (verified
//! against each one's documentation on 2026-08-26):
//!
//! - **Claude Code** — `~/.claude.json`: `mcpServers` at the top level is the
//!   *user* scope; `projects["<abs path>"].mcpServers` is the *local* scope
//!   (this project, this user); `<project>/.mcp.json` `mcpServers` is the
//!   *project* scope. An entry is `{ type?, command, args, env, url, headers }`
//!   and no `type` means stdio.
//! - **Codex** — `~/.codex/config.toml`, `[mcp_servers.<name>]` with `command`,
//!   `args`, `env`, `enabled` for stdio and `url`, `http_headers` for
//!   streamable HTTP.
//! - **Gemini CLI** — `~/.gemini/settings.json` and `<project>/.gemini/settings.json`,
//!   `mcpServers`: `command` = stdio, `httpUrl` = HTTP, `url` = SSE.
//! - **Cursor** — `~/.cursor/mcp.json` and `<project>/.cursor/mcp.json`,
//!   `mcpServers`: `command` = stdio, `url` = remote (no `type` field).
//! - **OpenCode** — `~/.config/opencode/opencode.json` and `<project>/opencode.json`,
//!   `mcp`: `{ type: "local", command: [..], environment, enabled }` or
//!   `{ type: "remote", url, headers, enabled }`.
//!
//! The neutral model is `McpServer`; the per-format readers and writers are
//! pure over text and **preserve what they do not understand** — unknown keys
//! of an entry, the rest of the document, and (for TOML) the comments. Env
//! and header VALUES never travel in a listing: `McpRow` carries only the key
//! names, and the edit form asks for them one server at a time.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use toml_edit::{DocumentMut, Item, Table};

use crate::state::AppState;

/// The CLIs whose format this module knows. Everything else in the catalog
/// is listed as unsupported by the UI, never guessed.
pub const SUPPORTED: &[&str] = &["claude", "codex", "gemini", "cursor-agent", "opencode"];

fn yes() -> bool {
    true
}

/// A server as the manager sees it, whatever CLI it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// `stdio` | `http` | `sse` — plus `ws` passing through from Claude Code,
    /// which the UI shows but never creates.
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// One row of the listing. No secret values: only the names of the env
/// variables and headers the server carries.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRow {
    pub cli: String,
    /// `user` | `local` | `project`.
    pub scope: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub source_file: String,
    pub enabled: bool,
    /// Whether this CLI has a native on/off flag the manager can write.
    pub can_toggle: bool,
}

/// The listing plus the files that could not be read — one broken file must
/// not hide every other CLI's servers.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListing {
    pub rows: Vec<McpRow>,
    pub errors: Vec<String>,
}

/// The values the listing leaves out, for the edit form only.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSecrets {
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    Local,
    Project,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "user" => Some(Scope::User),
            "local" => Some(Scope::Local),
            "project" => Some(Scope::Project),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::User => "user",
            Scope::Local => "local",
            Scope::Project => "project",
        }
    }
}

// ---------------------------------------------------------------------------
// where each CLI keeps its servers
// ---------------------------------------------------------------------------

/// The file a CLI reads for a scope; `None` when the CLI has no such scope
/// (Codex only has the user file; only Claude Code has a local scope).
pub fn config_path(cli: &str, scope: Scope, home: &Path, root: Option<&Path>) -> Option<PathBuf> {
    match (cli, scope) {
        ("claude", Scope::User) | ("claude", Scope::Local) => Some(home.join(".claude.json")),
        ("claude", Scope::Project) => root.map(|r| r.join(".mcp.json")),
        ("codex", Scope::User) => Some(home.join(".codex").join("config.toml")),
        ("gemini", Scope::User) => Some(home.join(".gemini").join("settings.json")),
        ("gemini", Scope::Project) => root.map(|r| r.join(".gemini").join("settings.json")),
        ("cursor-agent", Scope::User) => Some(home.join(".cursor").join("mcp.json")),
        ("cursor-agent", Scope::Project) => root.map(|r| r.join(".cursor").join("mcp.json")),
        ("opencode", Scope::User) => {
            Some(home.join(".config").join("opencode").join("opencode.json"))
        }
        ("opencode", Scope::Project) => root.map(|r| r.join("opencode.json")),
        _ => None,
    }
}

/// Whether the manager can write an on/off flag for this CLI.
pub fn can_toggle(cli: &str) -> bool {
    matches!(cli, "codex" | "opencode")
}

// ---------------------------------------------------------------------------
// the JSON dialects (Claude Code, Gemini CLI, Cursor, OpenCode)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Claude,
    Gemini,
    Cursor,
    OpenCode,
}

fn dialect_of(cli: &str) -> Option<Dialect> {
    match cli {
        "claude" => Some(Dialect::Claude),
        "gemini" => Some(Dialect::Gemini),
        "cursor-agent" => Some(Dialect::Cursor),
        "opencode" => Some(Dialect::OpenCode),
        _ => None,
    }
}

fn string_map(v: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(m)) = v {
        for (k, val) in m {
            match val {
                Value::String(s) => {
                    out.insert(k.clone(), s.clone());
                }
                Value::Number(n) => {
                    out.insert(k.clone(), n.to_string());
                }
                Value::Bool(b) => {
                    out.insert(k.clone(), b.to_string());
                }
                _ => {}
            }
        }
    }
    out
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn map_value(m: &BTreeMap<String, String>) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
}

fn list_value(items: &[String]) -> Value {
    Value::Array(items.iter().map(|s| Value::String(s.clone())).collect())
}

/// One entry of a dialect, read into the neutral model.
fn entry_from_json(dialect: Dialect, name: &str, v: &Value) -> Option<McpServer> {
    let obj = v.as_object()?;
    let get = |k: &str| obj.get(k);
    let str_of = |k: &str| get(k).and_then(|x| x.as_str()).map(|s| s.to_string());
    let enabled = get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
    match dialect {
        Dialect::OpenCode => {
            let kind = str_of("type").unwrap_or_default();
            if kind == "remote" || (kind.is_empty() && get("url").is_some()) {
                Some(McpServer {
                    name: name.into(),
                    transport: "http".into(),
                    command: None,
                    args: vec![],
                    url: str_of("url"),
                    env: BTreeMap::new(),
                    headers: string_map(get("headers")),
                    enabled,
                })
            } else {
                let mut parts = string_list(get("command"));
                if parts.is_empty() {
                    // A string `command` is not the documented shape, but a
                    // hand-written file may carry one; read it, never write it.
                    if let Some(c) = str_of("command") {
                        parts = vec![c];
                    }
                }
                let command = if parts.is_empty() { None } else { Some(parts.remove(0)) };
                Some(McpServer {
                    name: name.into(),
                    transport: "stdio".into(),
                    command,
                    args: parts,
                    url: None,
                    env: string_map(get("environment")),
                    headers: BTreeMap::new(),
                    enabled,
                })
            }
        }
        Dialect::Gemini => {
            let (transport, url) = if let Some(u) = str_of("httpUrl") {
                ("http", Some(u))
            } else if let Some(u) = str_of("url") {
                ("sse", Some(u))
            } else {
                ("stdio", None)
            };
            Some(McpServer {
                name: name.into(),
                transport: transport.into(),
                command: str_of("command"),
                args: string_list(get("args")),
                url,
                env: string_map(get("env")),
                headers: string_map(get("headers")),
                enabled: true,
            })
        }
        Dialect::Cursor => {
            let url = str_of("url");
            let transport = if url.is_some() { "http" } else { "stdio" };
            Some(McpServer {
                name: name.into(),
                transport: transport.into(),
                command: str_of("command"),
                args: string_list(get("args")),
                url,
                env: string_map(get("env")),
                headers: string_map(get("headers")),
                enabled: true,
            })
        }
        Dialect::Claude => {
            let url = str_of("url");
            let transport = match str_of("type").as_deref() {
                Some("http") | Some("streamable-http") => "http",
                Some("sse") => "sse",
                Some("ws") => "ws",
                Some("stdio") | None => {
                    if url.is_some() {
                        "http"
                    } else {
                        "stdio"
                    }
                }
                Some(_) => "stdio",
            };
            Some(McpServer {
                name: name.into(),
                transport: transport.into(),
                command: str_of("command"),
                args: string_list(get("args")),
                url,
                env: string_map(get("env")),
                headers: string_map(get("headers")),
                enabled: true,
            })
        }
    }
}

/// The keys a dialect owns in an entry: the ones we set or clear on write.
/// Anything else in the object (timeouts, oauth, trust…) is left alone.
fn owned_keys(dialect: Dialect) -> &'static [&'static str] {
    match dialect {
        Dialect::Claude => &["type", "command", "args", "env", "url", "headers"],
        Dialect::Gemini => &["command", "args", "env", "url", "httpUrl", "headers"],
        Dialect::Cursor => &["command", "args", "env", "url", "headers"],
        Dialect::OpenCode => &["type", "command", "environment", "url", "headers", "enabled"],
    }
}

/// Writes the neutral model over an existing entry (or an empty one), keeping
/// the keys the dialect does not own.
fn entry_to_json(dialect: Dialect, server: &McpServer, existing: Option<&Value>) -> Value {
    let mut obj: Map<String, Value> = existing
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for k in owned_keys(dialect) {
        obj.remove(*k);
    }
    let remote = server.transport != "stdio";
    match dialect {
        Dialect::OpenCode => {
            if remote {
                obj.insert("type".into(), json!("remote"));
                obj.insert("url".into(), json!(server.url.clone().unwrap_or_default()));
                if !server.headers.is_empty() {
                    obj.insert("headers".into(), map_value(&server.headers));
                }
            } else {
                obj.insert("type".into(), json!("local"));
                let mut parts = Vec::new();
                if let Some(c) = &server.command {
                    parts.push(c.clone());
                }
                parts.extend(server.args.iter().cloned());
                obj.insert("command".into(), list_value(&parts));
                if !server.env.is_empty() {
                    obj.insert("environment".into(), map_value(&server.env));
                }
            }
            obj.insert("enabled".into(), json!(server.enabled));
        }
        Dialect::Gemini => {
            if remote {
                let key = if server.transport == "sse" { "url" } else { "httpUrl" };
                obj.insert(key.into(), json!(server.url.clone().unwrap_or_default()));
                if !server.headers.is_empty() {
                    obj.insert("headers".into(), map_value(&server.headers));
                }
            } else {
                obj.insert("command".into(), json!(server.command.clone().unwrap_or_default()));
                if !server.args.is_empty() {
                    obj.insert("args".into(), list_value(&server.args));
                }
                if !server.env.is_empty() {
                    obj.insert("env".into(), map_value(&server.env));
                }
            }
        }
        Dialect::Cursor => {
            if remote {
                obj.insert("url".into(), json!(server.url.clone().unwrap_or_default()));
                if !server.headers.is_empty() {
                    obj.insert("headers".into(), map_value(&server.headers));
                }
            } else {
                obj.insert("command".into(), json!(server.command.clone().unwrap_or_default()));
                if !server.args.is_empty() {
                    obj.insert("args".into(), list_value(&server.args));
                }
                if !server.env.is_empty() {
                    obj.insert("env".into(), map_value(&server.env));
                }
            }
        }
        Dialect::Claude => {
            if remote {
                obj.insert("type".into(), json!(server.transport));
                obj.insert("url".into(), json!(server.url.clone().unwrap_or_default()));
                if !server.headers.is_empty() {
                    obj.insert("headers".into(), map_value(&server.headers));
                }
            } else {
                obj.insert("type".into(), json!("stdio"));
                obj.insert("command".into(), json!(server.command.clone().unwrap_or_default()));
                if !server.args.is_empty() {
                    obj.insert("args".into(), list_value(&server.args));
                }
                if !server.env.is_empty() {
                    obj.insert("env".into(), map_value(&server.env));
                }
            }
        }
    }
    Value::Object(obj)
}

/// The path of the server map inside the document, per dialect and scope.
fn json_map_path(dialect: Dialect, scope: Scope, root: Option<&str>) -> Vec<String> {
    match (dialect, scope) {
        (Dialect::OpenCode, _) => vec!["mcp".into()],
        (Dialect::Claude, Scope::Local) => {
            vec!["projects".into(), root.unwrap_or_default().to_string(), "mcpServers".into()]
        }
        _ => vec!["mcpServers".into()],
    }
}

fn parse_json_doc(text: &str) -> anyhow::Result<Value> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let v: Value = serde_json::from_str(text)?;
    if !v.is_object() {
        anyhow::bail!("o documento não é um objeto JSON");
    }
    Ok(v)
}

fn json_map<'a>(doc: &'a Value, path: &[String]) -> Option<&'a Map<String, Value>> {
    let mut cur = doc;
    for k in path {
        cur = cur.get(k)?;
    }
    cur.as_object()
}

fn json_map_mut<'a>(doc: &'a mut Value, path: &[String]) -> &'a mut Map<String, Value> {
    let mut cur = doc;
    for k in path {
        if !cur.get(k).map(|v| v.is_object()).unwrap_or(false) {
            cur.as_object_mut()
                .expect("json root is an object")
                .insert(k.clone(), Value::Object(Map::new()));
        }
        cur = cur.get_mut(k).expect("just inserted");
    }
    cur.as_object_mut().expect("path ends in an object")
}

/// Reads a JSON dialect's servers. Empty text is an empty list.
pub fn read_json(cli: &str, text: &str, scope: Scope, root: Option<&str>) -> anyhow::Result<Vec<McpServer>> {
    let dialect = dialect_of(cli).ok_or_else(|| anyhow::anyhow!("{cli}: formato desconhecido"))?;
    let doc = parse_json_doc(text)?;
    let path = json_map_path(dialect, scope, root);
    let Some(map) = json_map(&doc, &path) else {
        return Ok(Vec::new());
    };
    Ok(map
        .iter()
        .filter_map(|(name, v)| entry_from_json(dialect, name, v))
        .collect())
}

/// Makes the dialect's server map be exactly `servers`, entry by entry:
/// an existing entry keeps the keys the dialect does not own, a missing one is
/// removed, and everything else in the document stays as it was.
pub fn write_json(
    cli: &str,
    text: &str,
    scope: Scope,
    root: Option<&str>,
    servers: &[McpServer],
) -> anyhow::Result<String> {
    let dialect = dialect_of(cli).ok_or_else(|| anyhow::anyhow!("{cli}: formato desconhecido"))?;
    let mut doc = parse_json_doc(text)?;
    let path = json_map_path(dialect, scope, root);
    let map = json_map_mut(&mut doc, &path);
    let mut next = Map::new();
    for s in servers {
        let existing = map.get(&s.name);
        next.insert(s.name.clone(), entry_to_json(dialect, s, existing));
    }
    *map = next;
    Ok(serde_json::to_string_pretty(&doc)? + "\n")
}

// ---------------------------------------------------------------------------
// the TOML dialect (Codex)
// ---------------------------------------------------------------------------

fn toml_str(item: Option<&Item>) -> Option<String> {
    item.and_then(|i| i.as_str()).map(|s| s.to_string())
}

fn toml_string_map(item: Option<&Item>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(t) = item.and_then(|i| i.as_table_like()) {
        for (k, v) in t.iter() {
            if let Some(s) = v.as_str() {
                out.insert(k.to_string(), s.to_string());
            }
        }
    }
    out
}

fn toml_string_list(item: Option<&Item>) -> Vec<String> {
    item.and_then(|i| i.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

/// Reads Codex's `[mcp_servers.<name>]` tables (regular or inline).
pub fn read_codex(text: &str) -> anyhow::Result<Vec<McpServer>> {
    let doc: DocumentMut = text.parse()?;
    let Some(servers) = doc.get("mcp_servers").and_then(|i| i.as_table_like()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, item) in servers.iter() {
        let Some(t) = item.as_table_like() else { continue };
        let url = toml_str(t.get("url"));
        let transport = if url.is_some() { "http" } else { "stdio" };
        out.push(McpServer {
            name: name.to_string(),
            transport: transport.into(),
            command: toml_str(t.get("command")),
            args: toml_string_list(t.get("args")),
            url,
            env: toml_string_map(t.get("env")),
            headers: toml_string_map(t.get("http_headers")),
            enabled: t.get("enabled").and_then(|i| i.as_bool()).unwrap_or(true),
        });
    }
    Ok(out)
}

const CODEX_OWNED: &[&str] = &["command", "args", "url", "env", "http_headers", "enabled"];

fn toml_map_item(m: &BTreeMap<String, String>) -> Item {
    let mut t = toml_edit::InlineTable::new();
    for (k, v) in m {
        t.insert(k, v.as_str().into());
    }
    Item::Value(toml_edit::Value::InlineTable(t))
}

fn toml_list_item(items: &[String]) -> Item {
    let mut a = toml_edit::Array::new();
    for s in items {
        a.push(s.as_str());
    }
    Item::Value(toml_edit::Value::Array(a))
}

/// Makes `[mcp_servers]` hold exactly `servers`, keeping comments, layout, the
/// other tables and any key of an entry this module does not own
/// (`bearer_token_env_var`, `startup_timeout_sec`, tool lists…).
pub fn write_codex(text: &str, servers: &[McpServer]) -> anyhow::Result<String> {
    let mut doc: DocumentMut = text.parse()?;
    let wanted: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
    // Drop the ones no longer wanted (from either table shape).
    if let Some(existing) = doc.get_mut("mcp_servers").and_then(|i| i.as_table_like_mut()) {
        let gone: Vec<String> = existing
            .iter()
            .map(|(k, _)| k.to_string())
            .filter(|k| !wanted.contains(&k.as_str()))
            .collect();
        for k in gone {
            existing.remove(&k);
        }
    }
    if !doc.contains_key("mcp_servers") {
        let mut parent = Table::new();
        parent.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(parent));
    }
    for s in servers {
        let parent = doc
            .get_mut("mcp_servers")
            .and_then(|i| i.as_table_like_mut())
            .ok_or_else(|| anyhow::anyhow!("mcp_servers não é uma tabela"))?;
        if parent.get(&s.name).and_then(|i| i.as_table_like()).is_none() {
            parent.insert(&s.name, Item::Table(Table::new()));
        }
        let entry = parent
            .get_mut(&s.name)
            .and_then(|i| i.as_table_like_mut())
            .expect("just inserted");
        for k in CODEX_OWNED {
            entry.remove(k);
        }
        if s.transport == "stdio" {
            entry.insert("command", toml_edit::value(s.command.clone().unwrap_or_default()));
            if !s.args.is_empty() {
                entry.insert("args", toml_list_item(&s.args));
            }
            if !s.env.is_empty() {
                entry.insert("env", toml_map_item(&s.env));
            }
        } else {
            entry.insert("url", toml_edit::value(s.url.clone().unwrap_or_default()));
            if !s.headers.is_empty() {
                entry.insert("http_headers", toml_map_item(&s.headers));
            }
        }
        if !s.enabled {
            entry.insert("enabled", toml_edit::value(false));
        }
    }
    Ok(doc.to_string())
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

fn read_servers(cli: &str, path: &Path, scope: Scope, root: Option<&str>) -> anyhow::Result<Vec<McpServer>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => anyhow::bail!("{}: {e}", path.display()),
    };
    let parsed = if cli == "codex" {
        read_codex(&text)
    } else {
        read_json(cli, &text, scope, root)
    };
    parsed.map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

fn write_servers(
    cli: &str,
    path: &Path,
    scope: Scope,
    root: Option<&str>,
    servers: &[McpServer],
) -> anyhow::Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => anyhow::bail!("{}: {e}", path.display()),
    };
    let next = if cli == "codex" {
        write_codex(&text, servers)
    } else {
        write_json(cli, &text, scope, root, servers)
    }
    .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, next).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;
    Ok(())
}

fn row_of(cli: &str, scope: Scope, path: &Path, s: &McpServer) -> McpRow {
    McpRow {
        cli: cli.into(),
        scope: scope.as_str().into(),
        name: s.name.clone(),
        transport: s.transport.clone(),
        command: s.command.clone(),
        args: s.args.clone(),
        url: s.url.clone(),
        env_keys: s.env.keys().cloned().collect(),
        header_keys: s.headers.keys().cloned().collect(),
        source_file: path.to_string_lossy().into_owned(),
        enabled: s.enabled,
        can_toggle: can_toggle(cli),
    }
}

/// Every server of every supported CLI: the user file when the CLI is
/// installed or the file exists, the local/project files when a root is given.
pub fn list_in(home: &Path, root: Option<&Path>, installed: &[String]) -> McpListing {
    let mut out = McpListing::default();
    let root_str = root.map(|r| r.to_string_lossy().into_owned());
    for cli in SUPPORTED {
        let is_installed = installed.iter().any(|i| i == cli);
        for scope in [Scope::User, Scope::Local, Scope::Project] {
            let Some(path) = config_path(cli, scope, home, root) else { continue };
            if scope != Scope::User && root.is_none() {
                continue;
            }
            if !is_installed && !path.exists() {
                continue;
            }
            match read_servers(cli, &path, scope, root_str.as_deref()) {
                Ok(servers) => {
                    for s in &servers {
                        out.rows.push(row_of(cli, scope, &path, s));
                    }
                }
                Err(e) => out.errors.push(e.to_string()),
            }
        }
    }
    out
}

/// Creates or replaces a server by name.
pub fn save_in(home: &Path, cli: &str, scope: Scope, root: Option<&Path>, server: McpServer) -> anyhow::Result<()> {
    let path = config_path(cli, scope, home, root)
        .ok_or_else(|| anyhow::anyhow!("{cli} não tem servidores no escopo {}", scope.as_str()))?;
    let root_str = root.map(|r| r.to_string_lossy().into_owned());
    let mut servers = read_servers(cli, &path, scope, root_str.as_deref())?;
    match servers.iter_mut().find(|s| s.name == server.name) {
        Some(slot) => *slot = server,
        None => servers.push(server),
    }
    write_servers(cli, &path, scope, root_str.as_deref(), &servers)
}

/// Removes a server by name; a name that is not there is not an error.
pub fn delete_in(home: &Path, cli: &str, scope: Scope, root: Option<&Path>, name: &str) -> anyhow::Result<()> {
    let path = config_path(cli, scope, home, root)
        .ok_or_else(|| anyhow::anyhow!("{cli} não tem servidores no escopo {}", scope.as_str()))?;
    let root_str = root.map(|r| r.to_string_lossy().into_owned());
    let servers = read_servers(cli, &path, scope, root_str.as_deref())?;
    let kept: Vec<McpServer> = servers.into_iter().filter(|s| s.name != name).collect();
    write_servers(cli, &path, scope, root_str.as_deref(), &kept)
}

/// The env and header values of one server — for the edit form.
pub fn secrets_in(home: &Path, cli: &str, scope: Scope, root: Option<&Path>, name: &str) -> anyhow::Result<McpSecrets> {
    let path = config_path(cli, scope, home, root)
        .ok_or_else(|| anyhow::anyhow!("{cli} não tem servidores no escopo {}", scope.as_str()))?;
    let root_str = root.map(|r| r.to_string_lossy().into_owned());
    let servers = read_servers(cli, &path, scope, root_str.as_deref())?;
    let s = servers
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("{name}: servidor não encontrado em {}", path.display()))?;
    Ok(McpSecrets { env: s.env, headers: s.headers })
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

fn home() -> Result<PathBuf, String> {
    crate::paths::home_dir().ok_or_else(|| "não achei a pasta do usuário".to_string())
}

fn scope_of(s: &str) -> Result<Scope, String> {
    Scope::parse(s).ok_or_else(|| format!("escopo desconhecido: {s}"))
}

fn installed_ids(app: &AppHandle) -> Vec<String> {
    let state = app.state::<Arc<AppState>>();
    let cached = state.agents_cache.lock().clone();
    let agents = cached.unwrap_or_else(crate::agents::resolver::detect_all);
    agents.into_iter().filter(|a| a.installed).map(|a| a.id).collect()
}

#[tauri::command]
pub async fn mcp_list(app: AppHandle, project_root: Option<String>) -> Result<McpListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home()?;
        let installed = installed_ids(&app);
        Ok(list_in(&home, project_root.as_deref().map(Path::new), &installed))
    })
    .await
    .map_err(|e| format!("listagem MCP interrompida: {e}"))?
}

#[tauri::command]
pub async fn mcp_save(
    cli: String,
    scope: String,
    project_root: Option<String>,
    server: McpServer,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home()?;
        save_in(&home, &cli, scope_of(&scope)?, project_root.as_deref().map(Path::new), server)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("gravação MCP interrompida: {e}"))?
}

#[tauri::command]
pub async fn mcp_delete(
    cli: String,
    scope: String,
    project_root: Option<String>,
    name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home()?;
        delete_in(&home, &cli, scope_of(&scope)?, project_root.as_deref().map(Path::new), &name)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("remoção MCP interrompida: {e}"))?
}

#[tauri::command]
pub async fn mcp_env_values(
    cli: String,
    scope: String,
    project_root: Option<String>,
    name: String,
) -> Result<McpSecrets, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home()?;
        secrets_in(&home, &cli, scope_of(&scope)?, project_root.as_deref().map(Path::new), &name)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("leitura MCP interrompida: {e}"))?
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// Every CLI keeps its MCP servers in a file the user also edits by hand.
/// What these rules guard is the *rest* of that file: a manager that wrote a
/// clean list and dropped a `timeout`, a comment or an unrelated table would
/// be worse than no manager at all.
#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str, cmd: &str, args: &[&str]) -> McpServer {
        McpServer {
            name: name.into(),
            transport: "stdio".into(),
            command: Some(cmd.into()),
            args: args.iter().map(|s| s.to_string()).collect(),
            url: None,
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            enabled: true,
        }
    }

    fn remote(name: &str, transport: &str, url: &str) -> McpServer {
        McpServer {
            name: name.into(),
            transport: transport.into(),
            command: None,
            args: vec![],
            url: Some(url.into()),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            enabled: true,
        }
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    const CLAUDE_USER: &str = r#"{
  "numStartups": 12,
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": { "TOKEN": "x" } },
    "stripe": { "type": "http", "url": "https://mcp.stripe.com", "headers": { "Authorization": "Bearer k" } },
    "legacy": { "type": "sse", "url": "https://old.example/sse", "timeout": 60000 }
  },
  "projects": {
    "C:\\repo": { "mcpServers": { "local-db": { "command": "db-mcp" } }, "allowedTools": [] }
  }
}"#;

    #[test]
    fn claude_reads_stdio_http_and_sse_entries_of_the_user_scope() {
        let list = read_json("claude", CLAUDE_USER, Scope::User, None).unwrap();
        assert_eq!(list.len(), 3);
        let c7 = list.iter().find(|s| s.name == "context7").unwrap();
        assert_eq!(c7.transport, "stdio");
        assert_eq!(c7.command.as_deref(), Some("npx"));
        assert_eq!(c7.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(c7.env.get("TOKEN").map(String::as_str), Some("x"));
        let stripe = list.iter().find(|s| s.name == "stripe").unwrap();
        assert_eq!(stripe.transport, "http");
        assert_eq!(stripe.url.as_deref(), Some("https://mcp.stripe.com"));
        assert_eq!(stripe.headers.get("Authorization").map(String::as_str), Some("Bearer k"));
        assert_eq!(list.iter().find(|s| s.name == "legacy").unwrap().transport, "sse");
    }

    #[test]
    fn claude_local_scope_lives_under_the_project_entry() {
        let list = read_json("claude", CLAUDE_USER, Scope::Local, Some("C:\\repo")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "local-db");
        // Another project has nothing — and that is a list, not an error.
        assert!(read_json("claude", CLAUDE_USER, Scope::Local, Some("D:\\other")).unwrap().is_empty());
    }

    #[test]
    fn claude_write_keeps_unknown_keys_and_the_rest_of_the_document() {
        let mut servers = read_json("claude", CLAUDE_USER, Scope::User, None).unwrap();
        // Replace one, drop one, add one.
        servers.retain(|s| s.name != "stripe");
        servers.iter_mut().find(|s| s.name == "legacy").unwrap().url = Some("https://new.example/sse".into());
        servers.push(stdio("fs", "node", &["fs.js"]));
        let out = write_json("claude", CLAUDE_USER, Scope::User, None, &servers).unwrap();
        let doc: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(doc["numStartups"], 12, "a sibling key survived");
        assert_eq!(doc["projects"]["C:\\repo"]["allowedTools"], json!([]), "the projects block survived");
        assert_eq!(doc["mcpServers"]["legacy"]["timeout"], 60000, "a key we do not own survived");
        assert_eq!(doc["mcpServers"]["legacy"]["url"], "https://new.example/sse");
        assert!(doc["mcpServers"].get("stripe").is_none());
        assert_eq!(doc["mcpServers"]["fs"]["command"], "node");
        assert_eq!(doc["mcpServers"]["fs"]["args"], json!(["fs.js"]));
    }

    #[test]
    fn claude_switching_a_server_to_remote_drops_its_stdio_keys() {
        let servers = vec![remote("context7", "http", "https://c7.example/mcp")];
        let out = write_json("claude", CLAUDE_USER, Scope::User, None, &servers).unwrap();
        let doc: Value = serde_json::from_str(&out).unwrap();
        let e = &doc["mcpServers"]["context7"];
        assert_eq!(e["type"], "http");
        assert!(e.get("command").is_none() && e.get("args").is_none() && e.get("env").is_none());
    }

    const CODEX: &str = r#"# my codex config
model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env = { TOKEN = "x" }
startup_timeout_sec = 30

[mcp_servers.remote]
url = "https://mcp.example/mcp"
bearer_token_env_var = "MCP_TOKEN"
enabled = false

[sandbox]
mode = "workspace-write"
"#;

    #[test]
    fn codex_reads_tables_with_enabled_env_and_the_remote_shape() {
        let list = read_codex(CODEX).unwrap();
        assert_eq!(list.len(), 2);
        let c7 = &list[0];
        assert_eq!((c7.name.as_str(), c7.transport.as_str()), ("context7", "stdio"));
        assert_eq!(c7.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(c7.env, env(&[("TOKEN", "x")]));
        assert!(c7.enabled);
        let r = &list[1];
        assert_eq!((r.transport.as_str(), r.url.as_deref()), ("http", Some("https://mcp.example/mcp")));
        assert!(!r.enabled);
    }

    #[test]
    fn codex_write_preserves_comments_other_tables_and_keys_it_does_not_own() {
        let mut servers = read_codex(CODEX).unwrap();
        servers.iter_mut().find(|s| s.name == "context7").unwrap().args = vec!["-y".into(), "c7@2".into()];
        servers.retain(|s| s.name != "remote");
        let mut fresh = stdio("fs", "node", &["fs.js"]);
        fresh.enabled = false;
        servers.push(fresh);
        let out = write_codex(CODEX, &servers).unwrap();
        assert!(out.starts_with("# my codex config\n"), "the comment survived: {out}");
        assert!(out.contains("model = \"gpt-5\""));
        assert!(out.contains("[sandbox]\nmode = \"workspace-write\""));
        assert!(out.contains("startup_timeout_sec = 30"), "a key we do not own survived: {out}");
        assert!(!out.contains("[mcp_servers.remote]"));
        assert!(out.contains("[mcp_servers.fs]"));
        // And it reads back the way it was written.
        let back = read_codex(&out).unwrap();
        assert_eq!(back.iter().find(|s| s.name == "context7").unwrap().args, vec!["-y", "c7@2"]);
        assert!(!back.iter().find(|s| s.name == "fs").unwrap().enabled);
    }

    #[test]
    fn codex_write_into_an_empty_file_makes_a_readable_document() {
        let out = write_codex("", &[stdio("fs", "node", &["fs.js"])]).unwrap();
        assert!(out.contains("[mcp_servers.fs]"), "{out}");
        assert!(!out.contains("[mcp_servers]\n"), "no empty parent header: {out}");
        assert_eq!(read_codex(&out).unwrap()[0].command.as_deref(), Some("node"));
    }

    const GEMINI: &str = r#"{
  "theme": "Default",
  "mcpServers": {
    "py": { "command": "python", "args": ["-m", "srv"], "cwd": "./tools", "env": { "K": "v" }, "timeout": 15000 },
    "http": { "httpUrl": "http://localhost:3000/mcp", "timeout": 5000 },
    "events": { "url": "http://localhost:3001/sse" }
  }
}"#;

    #[test]
    fn gemini_maps_httpurl_to_http_and_url_to_sse_and_writes_them_back_apart() {
        let list = read_json("gemini", GEMINI, Scope::User, None).unwrap();
        let by = |n: &str| list.iter().find(|s| s.name == n).unwrap().clone();
        assert_eq!(by("py").transport, "stdio");
        assert_eq!(by("http").transport, "http");
        assert_eq!(by("events").transport, "sse");
        let servers = vec![remote("a", "http", "http://a/mcp"), remote("b", "sse", "http://b/sse")];
        let out = write_json("gemini", GEMINI, Scope::User, None, &servers).unwrap();
        let doc: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(doc["mcpServers"]["a"]["httpUrl"], "http://a/mcp");
        assert!(doc["mcpServers"]["a"].get("url").is_none());
        assert_eq!(doc["mcpServers"]["b"]["url"], "http://b/sse");
        assert_eq!(doc["theme"], "Default");
    }

    #[test]
    fn cursor_infers_the_transport_from_url_or_command() {
        let text = r#"{ "mcpServers": { "a": { "command": "npx", "args": ["x"] }, "b": { "url": "http://h/mcp", "headers": { "K": "v" } } } }"#;
        let list = read_json("cursor-agent", text, Scope::User, None).unwrap();
        assert_eq!(list.iter().find(|s| s.name == "a").unwrap().transport, "stdio");
        let b = list.iter().find(|s| s.name == "b").unwrap();
        assert_eq!(b.transport, "http");
        assert_eq!(b.header_keys_for_test(), vec!["K"]);
        let out = write_json("cursor-agent", text, Scope::User, None, &[remote("b", "sse", "http://h/sse")]).unwrap();
        let doc: Value = serde_json::from_str(&out).unwrap();
        // Cursor has no transport field: sse still lands as a plain url.
        assert_eq!(doc["mcpServers"]["b"]["url"], "http://h/sse");
        assert!(doc["mcpServers"]["b"].get("type").is_none());
    }

    const OPENCODE: &str = r#"{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "local": { "type": "local", "command": ["npx", "-y", "my-mcp"], "environment": { "K": "v" }, "enabled": true },
    "remote": { "type": "remote", "url": "https://my.example", "headers": { "Authorization": "Bearer t" }, "enabled": false, "oauth": {} }
  }
}"#;

    #[test]
    fn opencode_reads_command_arrays_and_remote_urls_and_writes_them_back() {
        let list = read_json("opencode", OPENCODE, Scope::User, None).unwrap();
        let l = list.iter().find(|s| s.name == "local").unwrap();
        assert_eq!((l.transport.as_str(), l.command.as_deref()), ("stdio", Some("npx")));
        assert_eq!(l.args, vec!["-y", "my-mcp"]);
        assert_eq!(l.env, env(&[("K", "v")]));
        let r = list.iter().find(|s| s.name == "remote").unwrap();
        assert_eq!((r.transport.as_str(), r.enabled), ("http", false));
        let mut kept = list.clone();
        kept.iter_mut().find(|s| s.name == "remote").unwrap().enabled = true;
        let out = write_json("opencode", OPENCODE, Scope::User, None, &kept).unwrap();
        let doc: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(doc["mcp"]["local"]["command"], json!(["npx", "-y", "my-mcp"]));
        assert_eq!(doc["mcp"]["local"]["environment"]["K"], "v");
        assert_eq!(doc["mcp"]["remote"]["enabled"], true);
        assert_eq!(doc["mcp"]["remote"]["oauth"], json!({}), "a key we do not own survived");
        assert_eq!(doc["$schema"], "https://opencode.ai/config.json");
    }

    #[test]
    fn config_path_knows_each_cli_and_scope() {
        let home = Path::new("H:\\home");
        let root = Path::new("R:\\proj");
        assert_eq!(config_path("claude", Scope::User, home, None), Some(home.join(".claude.json")));
        assert_eq!(config_path("claude", Scope::Local, home, Some(root)), Some(home.join(".claude.json")));
        assert_eq!(config_path("claude", Scope::Project, home, Some(root)), Some(root.join(".mcp.json")));
        assert_eq!(config_path("claude", Scope::Project, home, None), None, "no root, no project file");
        assert_eq!(config_path("codex", Scope::Project, home, Some(root)), None, "codex has only the user file");
        assert_eq!(config_path("gemini", Scope::Project, home, Some(root)), Some(root.join(".gemini").join("settings.json")));
        assert_eq!(config_path("cursor-agent", Scope::User, home, None), Some(home.join(".cursor").join("mcp.json")));
        assert_eq!(config_path("opencode", Scope::Project, home, Some(root)), Some(root.join("opencode.json")));
        assert_eq!(config_path("aider", Scope::User, home, None), None, "unsupported CLIs have no file");
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yard-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_home_without_any_config_file_lists_nothing_and_errs_nowhere() {
        let home = temp("empty");
        let listing = list_in(&home, None, &["claude".into(), "codex".into()]);
        assert!(listing.rows.is_empty());
        assert!(listing.errors.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn save_in_creates_the_file_and_delete_in_removes_only_that_entry() {
        let home = temp("save");
        let root = home.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        save_in(&home, "claude", Scope::User, None, stdio("fs", "node", &["fs.js"])).unwrap();
        save_in(&home, "claude", Scope::Project, Some(&root), remote("api", "http", "https://api/mcp")).unwrap();
        save_in(&home, "codex", Scope::User, None, stdio("fs", "node", &["fs.js"])).unwrap();
        let listing = list_in(&home, Some(&root), &[]);
        assert!(listing.errors.is_empty(), "{:?}", listing.errors);
        let mut keys: Vec<(String, String, String)> = listing
            .rows
            .iter()
            .map(|r| (r.cli.clone(), r.scope.clone(), r.name.clone()))
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                ("claude".into(), "project".into(), "api".into()),
                ("claude".into(), "user".into(), "fs".into()),
                ("codex".into(), "user".into(), "fs".into()),
            ]
        );
        assert!(listing.rows.iter().all(|r| r.env_keys.is_empty()));
        assert_eq!(listing.rows.iter().find(|r| r.cli == "codex").unwrap().can_toggle, true);
        assert_eq!(listing.rows.iter().find(|r| r.cli == "claude").unwrap().can_toggle, false);

        delete_in(&home, "claude", Scope::User, None, "fs").unwrap();
        delete_in(&home, "claude", Scope::User, None, "never-there").unwrap();
        let after = list_in(&home, Some(&root), &[]);
        assert!(after.rows.iter().all(|r| !(r.cli == "claude" && r.scope == "user")));
        assert_eq!(after.rows.len(), 2);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_listing_hides_the_values_and_the_secrets_call_returns_them() {
        let home = temp("secrets");
        let mut s = stdio("db", "db-mcp", &[]);
        s.env = env(&[("DATABASE_URL", "postgres://secret")]);
        save_in(&home, "gemini", Scope::User, None, s).unwrap();
        let row = &list_in(&home, None, &[]).rows[0];
        assert_eq!(row.env_keys, vec!["DATABASE_URL"]);
        let json = serde_json::to_string(row).unwrap();
        assert!(!json.contains("postgres://secret"), "a value leaked into the listing: {json}");
        let secrets = secrets_in(&home, "gemini", Scope::User, None, "db").unwrap();
        assert_eq!(secrets.env.get("DATABASE_URL").map(String::as_str), Some("postgres://secret"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_malformed_file_names_its_path_in_the_error_and_spoils_only_itself() {
        let home = temp("broken");
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::write(home.join(".cursor").join("mcp.json"), "{ not json").unwrap();
        save_in(&home, "claude", Scope::User, None, stdio("fs", "node", &[])).unwrap();
        let listing = list_in(&home, None, &[]);
        assert_eq!(listing.rows.len(), 1, "claude's file still lists");
        assert_eq!(listing.errors.len(), 1);
        assert!(listing.errors[0].contains("mcp.json"), "{}", listing.errors[0]);
        let err = save_in(&home, "cursor-agent", Scope::User, None, stdio("x", "y", &[])).unwrap_err();
        assert!(err.to_string().contains("mcp.json"), "{err}");
        let _ = std::fs::remove_dir_all(&home);
    }

    impl McpServer {
        fn header_keys_for_test(&self) -> Vec<&str> {
            self.headers.keys().map(String::as_str).collect()
        }
    }
}
