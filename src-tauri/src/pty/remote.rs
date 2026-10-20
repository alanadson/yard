//! Persistable SSH commands keep transport values as session-time placeholders.

pub const TOKEN_MARK: &str = "{{YARD_BRIDGE_TOKEN}}";
const LOCAL_PORT_MARK: &str = "{{YARD_LOCAL_PORT}}";
const REMOTE_PORT_MARK: &str = "{{YARD_REMOTE_PORT}}";

fn transport_range(command: &str) -> Option<std::ops::Range<usize>> {
    let delimiter = "\nYARD_SHIM_EOF\n";
    let beginning = command.find(delimiter)? + delimiter.len();
    let mut quote = None;
    let mut escaped = false;
    for (offset, character) in command[beginning..].char_indices() {
        if escaped { escaped = false; continue; }
        if character == '\\' && quote != Some('\'') { escaped = true; continue; }
        if let Some(open) = quote {
            if character == open { quote = None; }
            continue;
        }
        let start = beginning + offset;
        let rest = &command[start..];
        let boundary = offset == 0 || command.as_bytes()[start - 1].is_ascii_whitespace();
        if boundary && rest.starts_with("exec ") { return None; }
        if boundary && rest.starts_with("YARD_PTY_ID='") {
            let identity = &rest["YARD_PTY_ID='".len()..];
            let identity_end = identity.find('\'')?;
            let token = identity[identity_end..].strip_prefix("' YARD_TOKEN='")?;
            let token_end = token.find('\'')?;
            let port = token[token_end..].strip_prefix("' YARD_PORT=")?;
            let port_end = port.find(" exec ")?;
            if &port[..port_end] != REMOTE_PORT_MARK && !port[..port_end].bytes().all(|byte| byte.is_ascii_digit()) { return None; }
            let end = command.len() - port.len() + port_end;
            return Some(start..end);
        }
        if matches!(character, '\'' | '"') { quote = Some(character); }
    }
    None
}

pub fn normalize_remote_launch(args: &[String]) -> Vec<String> {
    let mut saved = args.to_vec();
    let mut bridge_ports = std::collections::HashSet::new();
    for arg in &mut saved {
        let Some(range) = transport_range(arg) else { continue };
        if let Some((_, port)) = arg[range.clone()].rsplit_once("YARD_PORT=") { bridge_ports.insert(port.to_string()); }
        arg.replace_range(range, &format!("YARD_PTY_ID='{}' YARD_TOKEN='{TOKEN_MARK}' YARD_PORT={REMOTE_PORT_MARK}", super::PTY_ID_MARK));
    }
    if !bridge_ports.is_empty() {
        for index in 1..saved.len() {
            if saved[index - 1] == "-R" && saved[index].split_once(":127.0.0.1:").is_some_and(|(remote_port, _)| bridge_ports.contains(remote_port)) {
                saved[index] = format!("{REMOTE_PORT_MARK}:127.0.0.1:{LOCAL_PORT_MARK}");
            }
        }
    }
    saved
}

pub fn expand_remote_launch(args: &[String], id: &str, token: &str, port: Option<u16>) -> Vec<String> {
    let mut saved = normalize_remote_launch(args);
    for index in 0..saved.len() {
        if let Some(range) = transport_range(&saved[index]) {
            let transport = port.map(|port| format!("YARD_PTY_ID='{id}' YARD_TOKEN='{token}' YARD_PORT={}", 40000 + port % 20000)).unwrap_or_default();
            saved[index].replace_range(range, &transport);
        } else if index > 0 && saved[index - 1] == "-R" && saved[index] == format!("{REMOTE_PORT_MARK}:127.0.0.1:{LOCAL_PORT_MARK}") {
            if let Some(port) = port { saved[index] = format!("{}:127.0.0.1:{port}", 40000 + port % 20000); }
        }
    }
    if port.is_none() {
        let forwarding = format!("{REMOTE_PORT_MARK}:127.0.0.1:{LOCAL_PORT_MARK}");
        let mut index = 0;
        while index + 1 < saved.len() {
            if saved[index] == "-R" && saved[index + 1] == forwarding {
                saved.drain(index..index + 2);
            } else { index += 1; }
        }
    }
    saved
}

pub fn sanitize_transport_json(json: &str) -> serde_json::Result<String> {
    fn visit(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                for (key, value) in fields {
                    if matches!(key.as_str(), "args" | "resume") {
                        if let Ok(args) = serde_json::from_value::<Vec<String>>(value.clone()) {
                            *value = serde_json::json!(normalize_remote_launch(&args));
                        }
                    } else { visit(value); }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(visit),
            _ => {}
        }
    }
    let mut value: serde_json::Value = serde_json::from_str(json)?;
    let original = value.clone();
    visit(&mut value);
    if value == original { Ok(json.to_string()) } else { serde_json::to_string_pretty(&value) }
}

pub fn scrub_saved_transports(conn: &rusqlite::Connection, app_dir: &std::path::Path) -> anyhow::Result<()> {
    let mut statement = conn.prepare("SELECT id, args_json, resume_json FROM terminals")?;
    let rows: Vec<(String, String, Option<String>)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect::<Result<_, _>>()?;
    drop(statement);
    let transaction = conn.unchecked_transaction()?;
    for (id, args, resume) in rows {
        let clean = |text: &str| -> String {
            serde_json::from_str::<Vec<String>>(text).ok().map(|args| serde_json::to_string(&normalize_remote_launch(&args)).unwrap()).unwrap_or_else(|| text.to_string())
        };
        let safe_args = clean(&args);
        let safe_resume = resume.as_deref().map(clean);
        if safe_args != args || safe_resume != resume {
            transaction.execute("UPDATE terminals SET args_json = ?1, resume_json = ?2 WHERE id = ?3", rusqlite::params![safe_args, safe_resume, id])?;
        }
    }
    transaction.commit()?;
    let directory = app_dir.join("partituras");
    if directory.is_dir() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(path = %directory.display(), %error, "score transport maintenance unavailable");
                return Ok(());
            }
        };
        for entry in entries {
            let result = (|| -> std::io::Result<()> {
                let entry = entry?;
                if !entry.file_type()?.is_file() || entry.path().extension().and_then(|extension| extension.to_str()) != Some("json") { return Ok(()); }
                let original = std::fs::read_to_string(entry.path())?;
                let Ok(safe) = sanitize_transport_json(&original) else { return Ok(()); };
                if safe != original {
                    let temporary = entry.path().with_extension("json.transport-tmp");
                    std::fs::write(&temporary, safe)?;
                    if let Err(error) = std::fs::rename(&temporary, entry.path()) {
                        let _ = std::fs::remove_file(&temporary);
                        return Err(error);
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                tracing::warn!(path = %directory.display(), %error, "score transport maintenance skipped; workspace remains available");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Transport normalization must never interpret quoted prompt examples as environment assignments.
    #[test]
    fn ssh_prompts_keep_transport_examples_while_the_actual_connection_is_refreshed() {
        for prompt in [
            "Explain YARD_PTY_ID='demo' in the documentation.",
            "Explain YARD_PTY_ID='demo' YARD_TOKEN='sample' YARD_PORT=12345 exec tool.",
            "Explain {{YARD_PTY_ID}} and {{YARD_BRIDGE_TOKEN}} and {{YARD_LOCAL_PORT}}.",
        ] {
            let quoted = format!("'{}'", prompt.replace('\'', "'\\''"));
            let args = vec!["-R".into(), "51515:127.0.0.1:51515".into(), "host".into(),
                format!("cat <<'YARD_SHIM_EOF'\nshim\nYARD_SHIM_EOF\nYARD_PTY_ID='old' YARD_TOKEN='old-secret' YARD_PORT=51515 exec claude {quoted}")];
            let saved = normalize_remote_launch(&args);
            assert!(!saved[3].contains("old-secret"));
            assert!(saved[3].ends_with(&format!("exec claude {quoted}")));
            let launched = expand_remote_launch(&saved, "current", "current-secret", Some(62001));
            assert_eq!(launched[1], "42001:127.0.0.1:62001");
            assert!(launched[3].contains("YARD_PTY_ID='current' YARD_TOKEN='current-secret' YARD_PORT=42001 exec claude"));
            assert!(launched[3].ends_with(&format!("exec claude {quoted}")));
        }
    }

    #[test]
    fn ssh_still_launches_without_the_optional_bridge_and_preserves_other_forwardings() {
        let args = vec!["-R".into(), "51515:127.0.0.1:51515".into(), "-R".into(), "19000:127.0.0.1:9000".into(), "host".into(),
            "cat <<'YARD_SHIM_EOF'\nshim\nYARD_SHIM_EOF\nPATH=$HOME/.yard/bin:$PATH YARD_PTY_ID='old' YARD_TOKEN='old-secret' YARD_PORT=51515 exec claude 'original prompt'".into()];
        let launched = expand_remote_launch(&args, "current", "current-secret", None);
        assert_eq!(&launched[..3], &["-R", "19000:127.0.0.1:9000", "host"]);
        assert!(!launched.join(" ").contains("current-secret"));
        assert!(!launched.join(" ").contains("YARD_PORT="));
        assert!(!launched.join(" ").contains(LOCAL_PORT_MARK));
        assert!(launched.last().unwrap().ends_with("exec claude 'original prompt'"));
    }

    #[cfg(windows)]
    #[test]
    fn a_read_only_score_does_not_prevent_migrating_the_usable_workspace() {
        let root = std::env::temp_dir().join(format!("yard-ssh-readonly-{}", std::process::id()));
        std::fs::create_dir_all(root.join("partituras")).unwrap();
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE terminals (id TEXT, args_json TEXT, resume_json TEXT)").unwrap();
        let args = vec!["cat <<'YARD_SHIM_EOF'\nshim\nYARD_SHIM_EOF\nYARD_PTY_ID='ssh' YARD_TOKEN='old-secret' YARD_PORT=51515 exec claude".to_string()];
        connection.execute("INSERT INTO terminals VALUES ('ssh', ?1, NULL)", [serde_json::to_string(&args).unwrap()]).unwrap();
        let score = root.join("partituras/review.json");
        let original = serde_json::to_string(&serde_json::json!({ "terminals": [{ "args": args }] })).unwrap();
        std::fs::write(&score, &original).unwrap();
        let permissions = std::fs::metadata(&score).unwrap().permissions();
        let mut read_only = permissions.clone();
        read_only.set_readonly(true);
        std::fs::set_permissions(&score, read_only).unwrap();
        let result = scrub_saved_transports(&connection, &root);
        std::fs::set_permissions(&score, permissions).unwrap();
        assert!(result.is_ok(), "score maintenance must not discard the workspace: {result:?}");
        let saved: String = connection.query_row("SELECT args_json FROM terminals", [], |row| row.get(0)).unwrap();
        assert!(!saved.contains("old-secret"));
        assert_eq!(std::fs::read_to_string(score).unwrap(), original);
        std::fs::remove_dir_all(root).unwrap();
    }

    // Previously generated SSH launches copied credentials into the workspace and reusable scores.
    #[test]
    fn boot_scrubs_legacy_credentials_from_owned_workspace_and_score_files() {
        let root = std::env::temp_dir().join(format!("yard-ssh-scrub-{}", std::process::id()));
        std::fs::create_dir_all(root.join("partituras")).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE terminals (id TEXT, args_json TEXT, resume_json TEXT)").unwrap();
        let args = vec!["cat <<'YARD_SHIM_EOF'\nshim\nYARD_SHIM_EOF\nYARD_PTY_ID='ssh' YARD_TOKEN='old-secret' YARD_PORT=51515 exec claude".to_string()];
        conn.execute("INSERT INTO terminals VALUES ('ssh', ?1, NULL)", [serde_json::to_string(&args).unwrap()]).unwrap();
        let score_path = root.join("partituras/review.json");
        std::fs::write(&score_path, serde_json::to_vec(&serde_json::json!({ "name": "review", "terminals": [{ "args": args }] })).unwrap()).unwrap();
        scrub_saved_transports(&conn, &root).unwrap();
        let saved: String = conn.query_row("SELECT args_json FROM terminals", [], |row| row.get(0)).unwrap();
        let score = std::fs::read_to_string(&score_path).unwrap();
        assert!(!saved.contains("old-secret"));
        assert!(!score.contains("old-secret"));
        assert!(score.contains(TOKEN_MARK));
        assert!(score.contains("review"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
