//! Queue patches describe only the caller's edits and preserve independently queued work.

use serde_json::Value;

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub status: String,
    pub items: Vec<Value>,
    pub error: Option<String>,
}

pub struct ActiveDispatch<'a> {
    active: &'a parking_lot::Mutex<std::collections::HashSet<String>>,
    id: String,
}

impl<'a> ActiveDispatch<'a> {
    pub fn claim(active: &'a parking_lot::Mutex<std::collections::HashSet<String>>, id: &str) -> Option<Self> {
        active.lock().insert(id.to_string()).then(|| Self { active, id: id.to_string() })
    }
}

impl Drop for ActiveDispatch<'_> {
    fn drop(&mut self) { self.active.lock().remove(&self.id); }
}

pub fn reconcile_native(connection: &mut rusqlite::Connection, active: &std::collections::HashSet<String>) -> Result<Vec<Value>, String> {
    let before = read(connection)?;
    let mut after = before.clone();
    for item in &mut after {
        if item["delivery"]["status"] == "sending" && item["delivery"]["owner"] == "native"
            && !active.contains(item["id"].as_str().unwrap()) {
            item["delivery"]["status"] = Value::String("uncertain".into());
            item["delivery"]["error"] = Value::String("QUEUE_NATIVE_UNACKNOWLEDGED".into());
        }
    }
    if after != before { apply(connection, &before, &after) } else { Ok(before) }
}

pub fn dispatch_owned(state: &crate::state::AppState, id: &str, terminal_id: &str, attempted_at: i64) -> Result<DispatchResult, String> {
    let Some(_operation) = ActiveDispatch::claim(&state.native_queue_dispatches, id) else {
        return Ok(DispatchResult { status: "skipped".into(), items: read(&state.db.lock())?, error: None });
    };
    dispatch(&state.db, id, terminal_id, attempted_at, |text| crate::pty::inject(state, terminal_id, text, true))
}

pub fn recover_on_boot(connection: &mut rusqlite::Connection) -> Result<usize, String> {
    let before = read(connection)?;
    let mut after = before.clone();
    let mut recovered = 0;
    for item in &mut after {
        if item["delivery"]["status"] == "sending" {
            item["delivery"]["status"] = Value::String("uncertain".into());
            item["delivery"]["error"] = Value::String("QUEUE_NATIVE_INTERRUPTED".into());
            recovered += 1;
        }
    }
    if recovered > 0 { apply(connection, &before, &after)?; }
    Ok(recovered)
}

/// The process write is the only injected effect; SQLite owns both durable boundaries.
pub fn dispatch(database: &parking_lot::Mutex<rusqlite::Connection>, id: &str, terminal_id: &str, now: i64,
    write: impl FnOnce(&str) -> Result<(), String>) -> Result<DispatchResult, String> {
    let (text, claim_error, managed) = {
        let mut connection = database.lock();
        let before = read(&connection)?;
        let Some(index) = before.iter().position(|item| item["terminalId"].as_str() == Some(terminal_id)) else {
            return Ok(DispatchResult { status: "skipped".into(), items: before, error: None });
        };
        if before[index]["id"].as_str() != Some(id) || before[index].get("delivery").is_some()
            || !crate::routines::allows_delivery(&connection, &before[index])? {
            return Ok(DispatchResult { status: "skipped".into(), items: before, error: None });
        }
        let mut reserved = before.clone();
        reserved[index]["delivery"] = serde_json::json!({"status":"sending","attemptedAt":now,"owner":"native"});
        apply(&mut connection, &before, &reserved)?;
        let claim_error = before[index].get("taskId").and_then(Value::as_str)
            .and_then(|task_id| crate::work::claim(&mut connection, task_id, id, terminal_id, now).err())
            .map(|error| error.message);
        (before[index]["text"].as_str().unwrap().to_string(), claim_error, before[index].get("taskId").is_some())
    };
    let written = match claim_error { Some(error) => Err(error), None => write(&text) };
    let mut connection = database.lock();
    if written.is_err() && managed {
        crate::work::interrupt_attempt(&mut connection, id, terminal_id, now).map_err(|error| error.message)?;
    }
    let before = read(&connection)?;
    let mut after = before.clone();
    let (status, error) = match written {
        Ok(()) => { after.retain(|item| item["id"].as_str() != Some(id)); ("delivered", None) },
        Err(error) => {
            if let Some(item) = after.iter_mut().find(|item| item["id"].as_str() == Some(id)) {
                item["delivery"] = serde_json::json!({"status":"uncertain","attemptedAt":now,"owner":"native","error":error});
            }
            ("uncertain", Some(error))
        }
    };
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let items = apply_in(&transaction, &before, &after)?;
    if let Some(item) = before.iter().find(|item| item["id"].as_str() == Some(id)) {
        crate::routines::record_outcome(&transaction, item, status, now)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(DispatchResult { status: status.into(), items, error })
}

pub fn read(connection: &rusqlite::Connection) -> Result<Vec<Value>, String> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = connection.query_row("SELECT value FROM kv WHERE key = 'queue.items'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let items: Vec<Value> = serde_json::from_str(raw.as_deref().unwrap_or("[]")).map_err(|error| error.to_string())?;
    validate(&items)?;
    Ok(items)
}

pub fn apply(connection: &mut rusqlite::Connection, before: &[Value], after: &[Value]) -> Result<Vec<Value>, String> {
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let merged = apply_in(&transaction, before, after)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(merged)
}

pub(crate) fn apply_in(transaction: &rusqlite::Connection, before: &[Value], after: &[Value]) -> Result<Vec<Value>, String> {
    let current = read(transaction)?;
    let merged = merge(&current, before, after)?;
    for item in &merged {
        let id = item.get("id").and_then(Value::as_str).unwrap();
        if is_retired(transaction, id).map_err(|error| error.to_string())? { return Err("QUEUE_ID_RETIRED".into()); }
    }
    retire_removed(transaction, &current, &merged).map_err(|error| error.to_string())?;
    crate::persistence::db::kv_set(transaction, "queue.items", &serde_json::to_string(&merged).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(merged)
}

/// How long a retired identity is remembered: far longer than any renderer
/// stays stale, and no longer, so the table does not grow forever.
pub const RETIRED_KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Retired identities have their own table (they were `queue.retired.{id}`
/// keys in `kv`). Created where it is missing: a database another branch
/// stamped, or a caller that only made `kv`.
fn ensure_retired_table(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    connection.prepare_cached("CREATE TABLE IF NOT EXISTS queue_retired(id TEXT PRIMARY KEY, at INTEGER NOT NULL)")?.execute([])?;
    Ok(())
}

/// Boot step (`persistence::db::migrate`): the retired table and its index,
/// the markers an earlier version saved in `kv` moved into it (stamped
/// `now`), and the expired ones pruned.
pub fn init(connection: &rusqlite::Connection, now: i64) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    ensure_retired_table(&transaction)?;
    transaction.execute("CREATE INDEX IF NOT EXISTS idx_queue_retired_at ON queue_retired(at)", [])?;
    let kv: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv')", [], |row| row.get(0))?;
    if kv {
        transaction.execute("INSERT OR IGNORE INTO queue_retired(id, at)
            SELECT substr(key, 15), ?1 FROM kv WHERE key >= 'queue.retired.' AND key < 'queue.retired/'", [now])?;
        transaction.execute("DELETE FROM kv WHERE key >= 'queue.retired.' AND key < 'queue.retired/'", [])?;
    }
    prune_retired(&transaction, now)?;
    transaction.commit()
}

/// Forgets the identities retired more than `RETIRED_KEEP_MS` before `now`.
pub fn prune_retired(connection: &rusqlite::Connection, now: i64) -> rusqlite::Result<()> {
    ensure_retired_table(connection)?;
    connection.execute("DELETE FROM queue_retired WHERE at < ?1", [now.saturating_sub(RETIRED_KEEP_MS)])?;
    Ok(())
}

pub fn is_retired(connection: &rusqlite::Connection, id: &str) -> rusqlite::Result<bool> {
    ensure_retired_table(connection)?;
    connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM queue_retired WHERE id = ?1)")?.query_row([id], |row| row.get(0))
}

pub fn retire_removed(connection: &rusqlite::Connection, before: &[Value], after: &[Value]) -> rusqlite::Result<()> {
    for item in before {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            if !after.iter().any(|next| next.get("id").and_then(Value::as_str) == Some(id)) {
                ensure_retired_table(connection)?;
                connection.prepare_cached("INSERT OR IGNORE INTO queue_retired(id, at)
                    VALUES (?1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)")?.execute([id])?;
            }
        }
    }
    Ok(())
}

pub fn retry_reviewed(connection: &mut rusqlite::Connection, id: &str, new_id: &str, attempted_at: i64) -> Result<Vec<Value>, String> {
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let mut items = read(&transaction)?;
    let before = items.clone();
    if is_retired(&transaction, new_id).map_err(|error| error.to_string())? { return Err("QUEUE_ID_RETIRED".into()); }
    if new_id.trim().is_empty() || new_id.len() > 256 || new_id == id || items.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(new_id)) {
        return Err("INVALID_QUEUE_ID".into());
    }
    let index = items.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id)).ok_or("QUEUE_ITEM_CHANGED")?;
    let item = &items[index];
    if item.get("taskId").is_some() { return Err("LINKED_QUEUE_RETRY_REQUIRED".into()); }
    let delivery = item.get("delivery");
    let eligible = delivery.and_then(|delivery| delivery.get("status")).and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "sending" | "uncertain"));
    if !eligible || delivery.and_then(|delivery| delivery.get("attemptedAt")).and_then(Value::as_i64) != Some(attempted_at)
        || items.iter().position(|other| other.get("terminalId") == item.get("terminalId")) != Some(index) {
        return Err("QUEUE_RETRY_CHANGED".into());
    }
    let item = &mut items[index];
    item["id"] = Value::String(new_id.to_string());
    item.as_object_mut().unwrap().remove("delivery");
    crate::routines::retry_occurrence(&transaction, &before[index], new_id)?;
    validate(&items)?;
    retire_removed(&transaction, &before, &items).map_err(|error| error.to_string())?;
    crate::persistence::db::kv_set(&transaction, "queue.items", &serde_json::to_string(&items).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(items)
}

pub fn remove_reviewed(connection: &mut rusqlite::Connection, id: &str, attempted_at: Option<i64>) -> Result<Vec<Value>, String> {
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let mut items = read(&transaction)?;
    let before = items.clone();
    if let Some(item) = items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id)) {
        if let Some(task_id) = item.get("taskId") {
            let task_id = task_id.as_str().ok_or("LINKED_QUEUE_CANCEL_REQUIRED")?;
            let task = crate::work::get(&transaction, task_id).map_err(|_| "LINKED_QUEUE_CANCEL_REQUIRED")?;
            if matches!(task.status.as_str(), "queued" | "blocked") { return Err("LINKED_QUEUE_CANCEL_REQUIRED".into()); }
        }
        let delivery = item.get("delivery");
        let stored_at = delivery.and_then(|delivery| delivery.get("attemptedAt")).and_then(Value::as_i64);
        if (delivery.is_some() && (attempted_at.is_none() || attempted_at != stored_at))
            || (delivery.is_none() && attempted_at.is_some()) {
            return Err("QUEUE_ITEM_CHANGED".into());
        }
    }
    items.retain(|item| item.get("id").and_then(Value::as_str) != Some(id));
    retire_removed(&transaction, &before, &items).map_err(|error| error.to_string())?;
    crate::persistence::db::kv_set(&transaction, "queue.items", &serde_json::to_string(&items).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(items)
}

pub fn merge(current: &[Value], before: &[Value], after: &[Value]) -> Result<Vec<Value>, String> {
    for items in [current, before, after] { validate(items)?; }
    for next in after.iter().filter(|next| !before.iter().any(|previous| previous.get("id") == next.get("id"))) {
        if let Some(existing) = current.iter().find(|existing| existing.get("id") == next.get("id")) {
            if existing != next { return Err("QUEUE_PATCH_CONFLICT".into()); }
        }
    }
    for previous in before {
        let next = after.iter().find(|next| next.get("id") == previous.get("id"));
        if next == Some(previous) { continue; }
        let existing = current.iter().find(|existing| existing.get("id") == previous.get("id"));
        if existing != Some(previous) && existing != next { return Err("QUEUE_PATCH_CONFLICT".into()); }
    }
    let mut merged = current.to_vec();
    merged.retain(|item| !before.iter().any(|previous| previous.get("id") == item.get("id"))
        || after.iter().any(|next| next.get("id") == item.get("id")));
    for item in after {
        if let Some(previous) = before.iter().find(|previous| previous.get("id") == item.get("id")) {
            if previous != item {
                if let Some(existing) = merged.iter_mut().find(|existing| existing.get("id") == item.get("id")) { *existing = item.clone(); }
            }
        }
        if !before.iter().any(|previous| previous.get("id") == item.get("id"))
            && !merged.iter().any(|existing| existing.get("id") == item.get("id")) {
            merged.push(item.clone());
        }
    }
    let terminals: std::collections::HashSet<_> = before.iter().filter_map(|item| item.get("terminalId").and_then(Value::as_str)).collect();
    for terminal in terminals {
        let ids = |items: &[Value]| items.iter().filter(|item| item.get("terminalId").and_then(Value::as_str) == Some(terminal))
            .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string)).collect::<Vec<_>>();
        let before_ids = ids(before);
        let after_ids = ids(after);
        let known: std::collections::HashSet<_> = before_ids.iter().filter(|id| after_ids.contains(id)
            && merged.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))).cloned().collect();
        let old_order: Vec<_> = before_ids.into_iter().filter(|id| known.contains(id)).collect();
        let new_order: Vec<_> = after_ids.into_iter().filter(|id| known.contains(id)).collect();
        if old_order == new_order { continue; }
        let current_order: Vec<_> = ids(current).into_iter().filter(|id| known.contains(id)).collect();
        if current_order != old_order && current_order != new_order { return Err("QUEUE_PATCH_CONFLICT".into()); }
        let positions: Vec<_> = merged.iter().enumerate().filter(|(_, item)| item.get("id").and_then(Value::as_str).is_some_and(|id| known.contains(id))).map(|(index, _)| index).collect();
        let values: Vec<_> = new_order.iter().map(|id| merged.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str())).unwrap().clone()).collect();
        for (index, value) in positions.into_iter().zip(values) { merged[index] = value; }
    }
    let mut counts = std::collections::HashMap::new();
    for item in &merged {
        let count = counts.entry(item.get("terminalId").and_then(Value::as_str)).or_insert(0);
        *count += 1;
        if *count > 20 { return Err("QUEUE_FULL".into()); }
    }
    Ok(merged)
}

fn validate(items: &[Value]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for item in items {
        let id = item.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
        let terminal = item.get("terminalId").and_then(Value::as_str).filter(|id| !id.trim().is_empty());
        let text = item.get("text").and_then(Value::as_str).filter(|text| !text.trim().is_empty());
        if id.is_none() || terminal.is_none() || text.is_none() || !ids.insert(id)
            || id.is_some_and(|id| id.len() > 256) || terminal.is_some_and(|id| id.len() > 256)
            || text.is_some_and(|text| text.len() > 1_048_576) {
            return Err("INVALID_QUEUE_PATCH".into());
        }
        if let Some(delivery) = item.get("delivery") {
            if !delivery.get("status").and_then(Value::as_str).is_some_and(|status| matches!(status, "sending" | "uncertain"))
                || !delivery.get("attemptedAt").and_then(Value::as_i64).is_some_and(|at| at >= 0) {
                return Err("INVALID_QUEUE_PATCH".into());
            }
        }
        if let Some(task_id) = item.get("taskId") {
            if !task_id.as_str().is_some_and(|id| !id.trim().is_empty() && id.len() <= 256) {
                return Err("INVALID_QUEUE_PATCH".into());
            }
        }
        if item.get("routineKey").is_some() || item["source"] == "routine" {
            let valid = item["routineKey"].as_str().and_then(|key| key.strip_prefix("routine.run."))
                .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')));
            if item["source"] != "routine" || !valid { return Err("INVALID_QUEUE_PATCH".into()); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Delivery must persist its reservation and acknowledgment independently of the renderer.
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn malformed_routine_references_are_rejected_before_the_queue_is_persisted() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        for key in [json!("workspace_rev"), json!("routine.run."), json!(42), Value::Null] {
            let candidate = json!({"id":"request","terminalId":"agent","text":"Scheduled work","at":1000,"source":"routine","routineKey":key});
            assert_eq!(apply(&mut connection, &[], &[candidate]), Err("INVALID_QUEUE_PATCH".into()));
            assert!(read(&connection).unwrap().is_empty());
        }
    }

    fn item(id: &str, terminal: &str) -> Value {
        json!({ "id": id, "terminalId": terminal, "text": format!("Request {id}"), "at": 1000, "source": "user" })
    }

    #[test]
    fn a_native_queue_operation_reserves_before_input_and_retires_only_after_the_write() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        apply(&mut connection, &[], &[item("request", "one"), item("next", "one")]).unwrap();
        let database = parking_lot::Mutex::new(connection);
        let result = dispatch(&database, "request", "one", 2000, |text| {
            assert_eq!(text, "Request request");
            let saved = read(&database.lock()).unwrap();
            assert_eq!(saved[0]["delivery"], serde_json::json!({"status":"sending","attemptedAt":2000,"owner":"native"}));
            assert!(!is_retired(&database.lock(), "request").unwrap());
            Ok(())
        }).unwrap();
        assert_eq!(result.status, "delivered");
        assert_eq!(result.items, vec![item("next", "one")]);
        assert_eq!(read(&database.lock()).unwrap(), result.items);
        assert!(is_retired(&database.lock(), "request").unwrap());
    }

    #[test]
    fn a_native_managed_delivery_claims_its_exact_task_before_input() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE terminals(id TEXT PRIMARY KEY, kind TEXT NOT NULL);
            INSERT INTO terminals VALUES ('executor', 'agent');").unwrap();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "managed".into(), title: "Managed work".into(),
            request: "Complete the original task".into(), criteria: Vec::new(), links: Default::default() }, 1000).unwrap();
        crate::work::enqueue(&mut connection, &task.id, task.revision, "executor", "linked", 2000).unwrap();
        let database = parking_lot::Mutex::new(connection);
        dispatch(&database, "linked", "executor", 3000, |text| {
            assert!(text.contains("Complete the original task"));
            let task = crate::work::get(&database.lock(), "managed").unwrap();
            assert_eq!(task.status, "running");
            assert_eq!(task.links.queue_item_id.as_deref(), Some("linked"));
            assert_eq!(task.links.executor_terminal_id.as_deref(), Some("executor"));
            Ok(())
        }).unwrap();
        assert!(read(&database.lock()).unwrap().is_empty());
    }

    #[test]
    fn restarting_the_native_process_marks_its_unfinished_reservations_uncertain() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let mut pending = item("interrupted", "one");
        pending["delivery"] = serde_json::json!({"status":"sending","attemptedAt":2000,"owner":"native"});
        apply(&mut connection, &[], &[pending, item("next", "one")]).unwrap();
        assert_eq!(recover_on_boot(&mut connection).unwrap(), 1);
        let recovered = read(&connection).unwrap();
        assert_eq!(recovered[0]["delivery"]["status"], "uncertain");
        assert_eq!(recovered[0]["delivery"]["attemptedAt"], 2000);
        assert_eq!(recovered[1], item("next", "one"));
        assert_eq!(recover_on_boot(&mut connection).unwrap(), 0);
    }

    #[test]
    fn an_unacknowledged_finished_operation_requires_review_while_active_operations_stay_pending() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let mut finished = item("finished", "one");
        finished["delivery"] = serde_json::json!({"status":"sending","attemptedAt":2000,"owner":"native"});
        let mut active = item("active", "two");
        active["delivery"] = finished["delivery"].clone();
        apply(&mut connection, &[], &[finished, active]).unwrap();
        let active_ids = std::collections::HashSet::from(["active".to_string()]);
        let reconciled = reconcile_native(&mut connection, &active_ids).unwrap();
        assert_eq!(reconciled[0]["delivery"]["status"], "uncertain");
        assert_eq!(reconciled[1]["delivery"]["status"], "sending");
        assert_eq!(read(&connection).unwrap(), reconciled);
    }

    #[test]
    fn a_failed_managed_input_blocks_its_task_instead_of_leaving_unstarted_work_running() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE terminals(id TEXT PRIMARY KEY, kind TEXT NOT NULL);
            INSERT INTO terminals VALUES ('executor', 'agent');").unwrap();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "managed".into(), title: "Managed work".into(),
            request: "Complete the original task".into(), criteria: Vec::new(), links: Default::default() }, 1000).unwrap();
        crate::work::enqueue(&mut connection, &task.id, task.revision, "executor", "linked", 2000).unwrap();
        let database = parking_lot::Mutex::new(connection);
        let outcome = dispatch(&database, "linked", "executor", 3000, |_| Err("Terminal closed".into())).unwrap();
        assert_eq!(outcome.status, "uncertain");
        assert_eq!(outcome.items[0]["delivery"]["status"], "uncertain");
        assert_eq!(crate::work::get(&database.lock(), "managed").unwrap().status, "blocked");
    }

    #[test]
    fn an_invalid_task_reference_is_rejected_before_it_can_bypass_managed_delivery() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        for task_id in [serde_json::json!(12), serde_json::json!(null), serde_json::json!(" ")] {
            let mut malformed = item("malformed", "one");
            malformed["taskId"] = task_id;
            assert_eq!(apply(&mut connection, &[], &[malformed]).unwrap_err(), "INVALID_QUEUE_PATCH");
            assert!(read(&connection).unwrap().is_empty());
        }
    }

    #[test]
    fn a_process_write_with_a_rejected_database_acknowledgment_is_preserved_for_review() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        apply(&mut connection, &[], &[item("request", "one")]).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_ack BEFORE UPDATE ON kv
            WHEN NEW.key = 'queue.items' AND NEW.value = '[]'
            BEGIN SELECT RAISE(ABORT, 'acknowledgment rejected'); END;").unwrap();
        let database = parking_lot::Mutex::new(connection);
        let mut written = false;
        assert!(dispatch(&database, "request", "one", 2000, |_| { written = true; Ok(()) }).is_err());
        assert!(written);
        assert!(!is_retired(&database.lock(), "request").unwrap());
        let recovered = reconcile_native(&mut database.lock(), &Default::default()).unwrap();
        assert_eq!(recovered[0]["delivery"]["status"], "uncertain");
        assert_eq!(recovered[0]["text"], "Request request");
    }

    /// The regression: every delivered or removed request left a
    /// `queue.retired.{id}` key in the preferences table, forever, and the
    /// page received them all at every boot. Retired identities live in
    /// their own table, and the markers already saved move there.
    #[test]
    fn retired_identities_stay_out_of_the_preferences_and_saved_markers_move_to_their_table() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        crate::persistence::db::kv_set(&connection, "queue.retired.legacy", "1").unwrap();
        crate::persistence::db::kv_set(&connection, "theme", "dark").unwrap();
        init(&connection, 5_000_000).unwrap();
        assert!(is_retired(&connection, "legacy").unwrap());
        let request = item("request", "one");
        apply(&mut connection, &[], std::slice::from_ref(&request)).unwrap();
        apply(&mut connection, &[request], &[]).unwrap();
        assert!(is_retired(&connection, "request").unwrap());
        assert!(crate::persistence::db::kv_prefix_values(&connection, "queue.retired.").unwrap().is_empty());
        assert_eq!(crate::persistence::db::kv_get(&connection, "theme").as_deref(), Some("dark"));
    }

    /// Thirty days is far longer than any renderer stays stale; past that a
    /// retired identity is pruned instead of kept forever.
    #[test]
    fn a_retired_identity_is_kept_for_thirty_days_and_pruned_after() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        crate::persistence::db::kv_set(&connection, "queue.retired.old", "1").unwrap();
        init(&connection, 1_000_000).unwrap();
        prune_retired(&connection, 1_000_000 + RETIRED_KEEP_MS).unwrap();
        assert!(is_retired(&connection, "old").unwrap());
        prune_retired(&connection, 1_000_000 + RETIRED_KEEP_MS + 1).unwrap();
        assert!(!is_retired(&connection, "old").unwrap());
    }

    /// The page refetches the queue on `queue://changed` instead of polling it:
    /// an edit, a review and a reconciliation that changed something must
    /// announce it, and one that changed nothing must not.
    #[test]
    fn every_queue_mutation_is_announced_and_an_unchanged_reconciliation_is_not() {
        let changes = || crate::events::take_kv_changes().topics();
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let _ = changes();
        apply(&mut connection, &[], &[item("request", "one")]).unwrap();
        assert_eq!(changes(), vec![crate::events::QUEUE_CHANGED], "patch");
        reconcile_native(&mut connection, &Default::default()).unwrap();
        assert!(changes().is_empty(), "nothing to reconcile");
        let mut sending = item("sending", "two");
        sending["delivery"] = json!({"status":"sending","attemptedAt":2000,"owner":"native"});
        apply(&mut connection, &[], &[sending]).unwrap();
        let _ = changes();
        reconcile_native(&mut connection, &Default::default()).unwrap();
        assert_eq!(changes(), vec![crate::events::QUEUE_CHANGED], "reconciliation");
        retry_reviewed(&mut connection, "sending", "fresh", 2000).unwrap();
        assert_eq!(changes(), vec![crate::events::QUEUE_CHANGED], "retry");
        remove_reviewed(&mut connection, "request", None).unwrap();
        assert_eq!(changes(), vec![crate::events::QUEUE_CHANGED], "removal");
    }

    #[test]
    fn a_native_delivery_announces_its_reservation_and_a_skipped_one_announces_nothing() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        apply(&mut connection, &[], &[item("first", "one"), item("second", "one")]).unwrap();
        let database = parking_lot::Mutex::new(connection);
        let _ = crate::events::take_kv_changes();
        assert_eq!(dispatch(&database, "second", "one", 2000, |_| Ok(())).unwrap().status, "skipped");
        assert!(crate::events::take_kv_changes().is_empty());
        assert_eq!(dispatch(&database, "first", "one", 3000, |_| Ok(())).unwrap().status, "delivered");
        assert_eq!(crate::events::take_kv_changes().topics(), vec![crate::events::QUEUE_CHANGED]);
    }

    #[test]
    fn an_active_native_operation_owns_its_identity_until_its_scope_finishes() {
        let active = parking_lot::Mutex::new(std::collections::HashSet::new());
        {
            let _operation = ActiveDispatch::claim(&active, "request").unwrap();
            assert!(ActiveDispatch::claim(&active, "request").is_none());
            assert!(active.lock().contains("request"));
        }
        assert!(active.lock().is_empty());
        assert!(ActiveDispatch::claim(&active, "request").is_some());
    }

    /// A renderer's older snapshot must not discard a task queued by another native request.
    #[test]
    fn applying_a_queue_edit_preserves_items_the_caller_never_observed() {
        let first = item("first", "one");
        let native = item("native-task", "two");
        let added = item("added", "one");
        let merged = merge(&[first.clone(), native.clone()], std::slice::from_ref(&first), &[first.clone(), added.clone()]).unwrap();
        assert_eq!(merged, vec![item("first", "one"), native, added]);
    }

    #[test]
    fn cancelling_an_observed_queue_item_preserves_independently_added_work() {
        let cancelled = item("cancelled", "one");
        let unseen = item("native-task", "two");
        assert_eq!(merge(&[cancelled.clone(), unseen.clone()], &[cancelled], &[]).unwrap(), vec![unseen]);
    }

    #[test]
    fn reserving_an_observed_queue_head_updates_only_its_delivery_record() {
        let pending = item("first", "one");
        let unseen = item("native-task", "two");
        let mut reserved = pending.clone();
        reserved["delivery"] = json!({ "status": "sending", "attemptedAt": 2000 });
        assert_eq!(merge(&[pending.clone(), unseen.clone()], &[pending], &[reserved.clone()]).unwrap(), vec![reserved, unseen]);
    }

    #[test]
    fn a_stale_queue_edit_cannot_remove_or_overwrite_a_new_delivery_reservation() {
        let pending = item("first", "one");
        let mut reserved = pending.clone();
        reserved["delivery"] = json!({ "status": "sending", "attemptedAt": 2000 });
        let mut edited = pending.clone(); edited["text"] = json!("Changed request");
        for after in [Vec::new(), vec![edited]] {
            assert_eq!(merge(std::slice::from_ref(&reserved), std::slice::from_ref(&pending), &after).unwrap_err(), "QUEUE_PATCH_CONFLICT");
            assert_eq!(reserved["delivery"]["status"], "sending");
        }
    }

    #[test]
    fn repeating_an_addition_is_idempotent_only_when_the_existing_request_matches() {
        let original = item("request", "one");
        assert_eq!(merge(std::slice::from_ref(&original), &[], std::slice::from_ref(&original)).unwrap(), vec![original.clone()]);
        let mut different = original.clone(); different["text"] = json!("Another request");
        assert_eq!(merge(&[original], &[], &[different]).unwrap_err(), "QUEUE_PATCH_CONFLICT");
    }

    #[test]
    fn reordering_observed_items_preserves_unseen_entries_and_other_terminal_positions() {
        let first = item("first", "one");
        let last = item("last", "one");
        let unseen = item("native-task", "one");
        let other = item("other", "two");
        let result = merge(&[first.clone(), unseen.clone(), last.clone(), other.clone()],
            &[first.clone(), last.clone(), other.clone()], &[last.clone(), first.clone(), other.clone()]).unwrap();
        assert_eq!(result, vec![last, unseen, first, other]);
    }

    #[test]
    fn an_outdated_reorder_cannot_replace_a_newer_order_for_the_same_terminal() {
        let first = item("first", "one");
        let middle = item("middle", "one");
        let last = item("last", "one");
        assert_eq!(merge(&[first.clone(), last.clone(), middle.clone()],
            &[first.clone(), middle.clone(), last.clone()], &[middle, first, last]).unwrap_err(), "QUEUE_PATCH_CONFLICT");
    }

    #[test]
    fn malformed_or_duplicate_queue_identities_are_rejected_before_applying_an_edit() {
        let valid = item("request", "one");
        let mut invalid_delivery = valid.clone(); invalid_delivery["delivery"] = json!({ "status": "delivered", "attemptedAt": 2000 });
        let mut empty = valid.clone(); empty["text"] = json!(" ");
        for after in [vec![Value::Null], vec![json!({ "id": 3 })], vec![valid.clone(), valid.clone()], vec![invalid_delivery], vec![empty]] {
            assert_eq!(merge(&[], &[], &after).unwrap_err(), "INVALID_QUEUE_PATCH");
        }
    }

    #[test]
    fn the_terminal_capacity_is_checked_after_preserving_concurrently_added_items() {
        let current: Vec<_> = (0..20).map(|index| item(&format!("native-{index}"), "one")).collect();
        let before = current[..19].to_vec();
        let mut after = before.clone(); after.push(item("local-added", "one"));
        assert_eq!(merge(&current, &before, &after).unwrap_err(), "QUEUE_FULL");
    }

    #[test]
    fn a_database_queue_patch_commits_the_merged_result_without_discarding_unseen_tasks() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let first = item("first", "one");
        let native = item("native-task", "two");
        let added = item("local-added", "one");
        crate::persistence::db::kv_set(&connection, "queue.items", &serde_json::to_string(&vec![first.clone(), native.clone()]).unwrap()).unwrap();
        let result = apply(&mut connection, std::slice::from_ref(&first), &[first.clone(), added.clone()]).unwrap();
        assert_eq!(result, vec![first, native, added]);
        let saved: Vec<Value> = serde_json::from_str(&crate::persistence::db::kv_get(&connection, "queue.items").unwrap()).unwrap();
        assert_eq!(saved, result);
    }

    /// An old renderer must not resurrect work after its removal was durably acknowledged.
    #[test]
    fn an_acknowledged_removal_cannot_be_reintroduced_by_a_late_queue_addition() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let request = item("completed-request", "one");
        apply(&mut connection, &[], std::slice::from_ref(&request)).unwrap();
        apply(&mut connection, std::slice::from_ref(&request), &[]).unwrap();
        assert_eq!(apply(&mut connection, &[], &[request]).unwrap_err(), "QUEUE_ID_RETIRED");
        assert!(read(&connection).unwrap().is_empty());
        assert_eq!(apply(&mut connection, &[], &[item("fresh-request", "one")]).unwrap()[0]["id"], "fresh-request");
    }

    #[test]
    fn reviewed_recovery_retires_the_old_identity_before_a_late_renderer_can_reuse_it() {
        for retry in [false, true] {
            let mut connection = rusqlite::Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
            let mut request = item("interrupted", "one");
            request["delivery"] = json!({ "status": "sending", "attemptedAt": 2000 });
            apply(&mut connection, &[], std::slice::from_ref(&request)).unwrap();
            let expected = if retry { retry_reviewed(&mut connection, "interrupted", "fresh", 2000).unwrap() }
                else { remove_reviewed(&mut connection, "interrupted", Some(2000)).unwrap() };
            assert_eq!(apply(&mut connection, &[], &[request]).unwrap_err(), "QUEUE_ID_RETIRED");
            assert_eq!(read(&connection).unwrap(), expected);
        }
    }

    #[test]
    fn a_reviewed_retry_cannot_reuse_an_identity_retired_by_another_request() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let completed = item("completed", "one");
        apply(&mut connection, &[], std::slice::from_ref(&completed)).unwrap();
        apply(&mut connection, &[completed], &[]).unwrap();
        let mut interrupted = item("interrupted", "one");
        interrupted["delivery"] = json!({ "status": "uncertain", "attemptedAt": 2000 });
        apply(&mut connection, &[], std::slice::from_ref(&interrupted)).unwrap();
        assert_eq!(retry_reviewed(&mut connection, "interrupted", "completed", 2000).unwrap_err(), "QUEUE_ID_RETIRED");
        assert_eq!(read(&connection).unwrap(), vec![interrupted]);
    }

    /// A reload can show a stored sending attempt as uncertain; review must create a fresh identity.
    #[test]
    fn a_reviewed_plain_retry_replaces_the_attempt_identity_and_preserves_its_original_request() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let mut interrupted = item("old-attempt", "one");
        interrupted["delivery"] = json!({ "status": "sending", "attemptedAt": 2000 });
        let other = item("other", "two");
        crate::persistence::db::kv_set(&connection, "queue.items", &serde_json::to_string(&vec![interrupted.clone(), other.clone()]).unwrap()).unwrap();
        let retried = retry_reviewed(&mut connection, "old-attempt", "new-attempt", 2000).unwrap();
        let mut expected = interrupted;
        expected["id"] = json!("new-attempt");
        expected.as_object_mut().unwrap().remove("delivery");
        assert_eq!(retried, vec![expected, other]);
        assert_eq!(read(&connection).unwrap(), retried);
    }

    #[test]
    fn an_unsafe_or_outdated_plain_retry_keeps_the_persisted_queue_unchanged() {
        for case in ["pending", "changed-attempt", "linked-task", "wrong-head", "same-id", "duplicate-id"] {
            let mut connection = rusqlite::Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
            let mut interrupted = item("old-attempt", "one");
            interrupted["delivery"] = json!({ "status": "uncertain", "attemptedAt": 2000 });
            if case == "pending" { interrupted.as_object_mut().unwrap().remove("delivery"); }
            if case == "changed-attempt" { interrupted["delivery"]["attemptedAt"] = json!(3000); }
            if case == "linked-task" { interrupted["taskId"] = json!("managed-work"); }
            let mut items = vec![interrupted];
            if case == "wrong-head" { items.insert(0, item("another-head", "one")); }
            if case == "duplicate-id" { items.push(item("new-attempt", "two")); }
            let raw = serde_json::to_string(&items).unwrap();
            crate::persistence::db::kv_set(&connection, "queue.items", &raw).unwrap();
            let new_id = if case == "same-id" { "old-attempt" } else { "new-attempt" };
            assert!(retry_reviewed(&mut connection, "old-attempt", new_id, 2000).is_err(), "{case}");
            assert_eq!(crate::persistence::db::kv_get(&connection, "queue.items"), Some(raw), "{case}");
        }
    }

    #[test]
    fn removing_a_reviewed_interrupted_attempt_preserves_unrelated_queued_requests() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let mut interrupted = item("interrupted", "one");
        interrupted["delivery"] = json!({ "status": "sending", "attemptedAt": 2000 });
        let other = item("other", "two");
        crate::persistence::db::kv_set(&connection, "queue.items", &serde_json::to_string(&vec![interrupted, other.clone()]).unwrap()).unwrap();
        assert_eq!(remove_reviewed(&mut connection, "interrupted", Some(2000)).unwrap(), vec![other.clone()]);
        assert_eq!(read(&connection).unwrap(), vec![other]);
    }

    #[test]
    fn an_unreviewed_or_stale_removal_cannot_discard_a_changed_delivery_attempt() {
        for (status, actual_at, reviewed_at) in [("sending", 2000, None), ("uncertain", 2000, None),
            ("sending", 3000, Some(2000)), ("pending", 0, Some(2000))] {
            let mut connection = rusqlite::Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
            let mut request = item("request", "one");
            if status != "pending" { request["delivery"] = json!({ "status": status, "attemptedAt": actual_at }); }
            let raw = serde_json::to_string(&vec![request]).unwrap();
            crate::persistence::db::kv_set(&connection, "queue.items", &raw).unwrap();
            assert_eq!(remove_reviewed(&mut connection, "request", reviewed_at).unwrap_err(), "QUEUE_ITEM_CHANGED");
            assert_eq!(crate::persistence::db::kv_get(&connection, "queue.items"), Some(raw));
        }
    }

    #[test]
    fn removing_a_managed_prompt_requires_its_task_cancellation_to_be_acknowledged_first() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE terminals(id TEXT PRIMARY KEY, kind TEXT NOT NULL);
            INSERT INTO terminals VALUES ('executor', 'agent');").unwrap();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "managed".into(), title: "Managed work".into(),
            request: "Preserve the task and its prompt".into(), criteria: Vec::new(), links: Default::default() }, 1000).unwrap();
        let queued = crate::work::enqueue(&mut connection, &task.id, task.revision, "executor", "linked", 2000).unwrap();
        assert_eq!(remove_reviewed(&mut connection, "linked", None).unwrap_err(), "LINKED_QUEUE_CANCEL_REQUIRED");
        assert_eq!(read(&connection).unwrap(), queued.items);
        assert_eq!(crate::work::get(&connection, &task.id).unwrap().status, "queued");
        crate::work::transition(&mut connection, &task.id, queued.task.revision, "cancelled", 3000).unwrap();
        assert!(remove_reviewed(&mut connection, "linked", None).unwrap().is_empty());
    }
}
