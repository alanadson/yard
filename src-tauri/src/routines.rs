//! Scheduled occurrences enter the durable queue before any terminal input.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PREFIX: &str = "routine.run.";

fn key_for(group: &str, routine: &Value) -> String {
    let identity = json!([group, routine["id"], routine["createdAt"], routine["terminalId"],
        routine["text"], routine["everyMin"], routine["once"]]);
    format!("{PREFIX}{:x}", Sha256::digest(identity.to_string().as_bytes()))
}

pub(crate) fn allows_delivery(connection: &Connection, item: &Value) -> Result<bool, String> {
    let Some(key) = item["routineKey"].as_str() else { return Ok(true); };
    let raw: Option<String> = connection.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let Some(raw) = raw else { return Ok(false); };
    let report: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if report["queueId"] != item["id"] { return Ok(false); }
    let Some(group) = report["groupId"].as_str() else { return Ok(false); };
    let layout: Option<String> = connection.query_row("SELECT layout_json FROM groups WHERE id = ?1 AND suspended = 0", [group], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let Some(layout) = layout.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else { return Ok(false); };
    Ok(layout["canvas"]["routines"].as_array().is_some_and(|routines| routines.iter()
        .any(|routine| routine["enabled"] == true && routine["terminalId"] == item["terminalId"]
            && routine["text"] == item["text"] && key_for(group, routine) == key)))
}

pub fn snapshot(connection: &Connection) -> Result<Vec<Value>, String> {
    let records: Result<Vec<Value>, String> = crate::persistence::db::kv_prefix_values(connection, PREFIX).map_err(|error| error.to_string())?
        .iter().map(|raw| serde_json::from_str(raw).map_err(|error| error.to_string())).collect();
    let queue = crate::queue::read(connection)?;
    Ok(records?.into_iter().map(|mut record| {
        if record["status"] == "queued" || record["status"] == "uncertain" {
            record["status"] = json!(match queue.iter().find(|item| item["routineKey"] == record["key"]) {
                Some(item) if item["delivery"]["status"] == "uncertain" => "uncertain",
                Some(_) => "queued",
                None => "cancelled",
            });
        }
        record
    }).collect())
}

pub(crate) fn record_outcome(connection: &Connection, item: &Value, status: &str, now: i64) -> Result<(), String> {
    let Some(key) = item["routineKey"].as_str() else { return Ok(()); };
    let raw: Option<String> = connection.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let Some(raw) = raw else { return Err("ROUTINE_OCCURRENCE_MISSING".into()); };
    let mut report: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if report["queueId"] != item["id"] { return Err("ROUTINE_OCCURRENCE_CHANGED".into()); }
    report["status"] = json!(status);
    if status == "delivered" { report["lastRunAt"] = json!(now); }
    crate::persistence::db::kv_set(connection, key, &report.to_string()).map_err(|error| error.to_string())
}

pub(crate) fn retry_occurrence(connection: &Connection, item: &Value, new_id: &str) -> Result<(), String> {
    let Some(key) = item["routineKey"].as_str() else { return Ok(()); };
    let raw: String = connection.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut report: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if report["queueId"] != item["id"] { return Err("ROUTINE_OCCURRENCE_CHANGED".into()); }
    report["queueId"] = json!(new_id);
    report["status"] = json!("queued");
    crate::persistence::db::kv_set(connection, key, &report.to_string()).map_err(|error| error.to_string())
}

/// Deletes the run records an edit superseded: a routine whose definition
/// changed has a new key (`key_for`), and its old record would otherwise stay
/// forever. One still referenced by queued work (a delivery awaiting review
/// records its outcome there) is kept.
fn forget_superseded(connection: &Connection, current: &std::collections::HashMap<(String, String), String>, queue: &[Value]) -> Result<(), String> {
    for raw in crate::persistence::db::kv_prefix_values(connection, PREFIX).map_err(|error| error.to_string())? {
        let Ok(record) = serde_json::from_str::<Value>(&raw) else { continue; };
        let (Some(group), Some(id), Some(key)) = (record["groupId"].as_str(), record["routineId"].as_str(), record["key"].as_str()) else { continue; };
        let superseded = current.get(&(group.to_string(), id.to_string())).is_some_and(|live| live != key);
        if superseded && !queue.iter().any(|item| item["routineKey"] == key) {
            crate::persistence::db::kv_delete(connection, key).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// What the scheduler remembers about routines between its passes, for the
/// life of this process only.
///
/// A repeating routine the process looks at for the first time while it is
/// overdue by more than one interval was missed while the app was closed: it
/// is re-armed from that moment instead of firing a catch-up. Later passes do
/// not re-arm, so a routine that waited for its busy terminal still fires.
#[derive(Default)]
pub struct RoutineClock {
    /// Keys looked at on the previous pass.
    seen: std::collections::HashSet<String>,
    /// The reference (epoch ms) each missed routine was re-armed with.
    armed: std::collections::HashMap<String, i64>,
    /// Whether a pass ran in this process.
    started: bool,
    /// The earliest deadline among the routines not yet due on the last pass.
    next_due: Option<i64>,
    /// Terminals whose due routines waited on the last pass (not ready, or
    /// still holding queued work).
    waiting: std::collections::HashSet<String>,
}

impl RoutineClock {
    /// When the next routine not yet due on the last pass comes due.
    pub fn next_due(&self) -> Option<i64> { self.next_due }

    /// The terminals due routines were waiting for on the last pass.
    pub fn waiting_on(&self) -> std::collections::HashSet<String> { self.waiting.clone() }

    /// Whether a routine may be due at `now`: before the first pass, while a
    /// due routine waits for its terminal, or once the next deadline passed.
    pub fn may_be_due(&self, now: i64) -> bool {
        !self.started || !self.waiting.is_empty() || self.next_due.is_some_and(|due| due <= now)
    }
}

pub fn enqueue_due(connection: &mut Connection, now: i64, ready: impl Fn(&str) -> bool, clock: &mut RoutineClock) -> Result<usize, String> {
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let groups: Vec<(String, String)> = {
        let mut query = transaction.prepare("SELECT id, layout_json FROM groups WHERE suspended = 0 ORDER BY id").map_err(|error| error.to_string())?;
        let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
    };
    let before = crate::queue::read(&transaction)?;
    let mut after = before.clone();
    let mut count = 0;
    for item in &before {
        if item.get("routineKey").is_some() && item.get("delivery").is_none() && !allows_delivery(&transaction, item)? {
            after.retain(|pending| pending["id"] != item["id"]);
            if let Err(error) = record_outcome(&transaction, item, "cancelled", now) {
                if error != "ROUTINE_OCCURRENCE_CHANGED" { return Err(error); }
            }
            count += 1;
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut current = std::collections::HashMap::new();
    let mut waiting = std::collections::HashSet::new();
    let mut next_due: Option<i64> = None;
    let mut upcoming = |deadline: Option<i64>| if let Some(deadline) = deadline {
        next_due = Some(next_due.map_or(deadline, |due: i64| due.min(deadline)));
    };
    for (group, raw) in groups {
        let Ok(layout) = serde_json::from_str::<Value>(&raw) else { continue; };
        let Some(routines) = layout["canvas"]["routines"].as_array() else { continue; };
        for routine in routines {
            let Some(id) = routine["id"].as_str().filter(|value| !value.is_empty()) else { continue; };
            let Some(terminal) = routine["terminalId"].as_str() else { continue; };
            let key = key_for(&group, routine);
            current.insert((group.clone(), id.to_string()), key.clone());
            let first = !clock.seen.contains(&key);
            seen.insert(key.clone());
            let previous: Option<String> = transaction.query_row("SELECT value FROM kv WHERE key = ?1", [&key], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
            let previous: Option<Value> = previous.map(|raw| serde_json::from_str(&raw)).transpose().map_err(|error| error.to_string())?;
            if routine["once"] == true && previous.is_some() { continue; }
            let recorded = previous.as_ref().and_then(|record| match (record["lastRunAt"].as_i64(), record["scheduledAt"].as_i64()) {
                (Some(delivered), Some(scheduled)) => Some(delivered.max(scheduled)),
                (delivered, scheduled) => delivered.or(scheduled),
            });
            let last = match (recorded, clock.armed.get(&key).copied()) {
                (Some(recorded), Some(armed)) => Some(recorded.max(armed)),
                (recorded, armed) => recorded.or(armed),
            };
            if first && routine["once"] != true && crate::scheduler::routine_missed(routine, last, now) {
                upcoming(crate::scheduler::routine_deadline(routine, Some(now)));
                clock.armed.insert(key, now);
                continue;
            }
            if !crate::scheduler::routine_due(routine, last, now) {
                upcoming(crate::scheduler::routine_deadline(routine, last));
                continue;
            }
            if !ready(terminal) || after.iter().any(|item| item["terminalId"] == terminal) {
                waiting.insert(terminal.to_string());
                continue;
            }
            let assigned: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM terminals WHERE id = ?1 AND group_id = ?2)", [terminal, &group], |row| row.get(0)).map_err(|error| error.to_string())?;
            if !assigned { continue; }
            let Some(text) = routine["text"].as_str().filter(|text| !text.trim().is_empty()) else { continue; };
            let queue_id = format!("{}-{now}", key.strip_prefix(PREFIX).unwrap());
            let item = json!({"id":queue_id,"terminalId":terminal,"text":text,"at":now,"source":"routine","by":id,"routineKey":key});
            let next = crate::queue::merge(&after, &after, &[after.clone(), vec![item]].concat())?;
            let report = json!({"key":key,"groupId":group,"routineId":id,"createdAt":routine["createdAt"],"routine":routine,
                "queueId":queue_id,"scheduledAt":now,"lastRunAt":previous.as_ref().and_then(|row| row["lastRunAt"].as_i64()),"status":"queued"});
            crate::persistence::db::kv_set(&transaction, &key, &report.to_string()).map_err(|error| error.to_string())?;
            if routine["once"] != true { upcoming(crate::scheduler::routine_deadline(routine, Some(now))); }
            after = next;
            count += 1;
        }
    }
    if count > 0 {
        crate::queue::apply_in(&transaction, &before, &after)?;
    }
    forget_superseded(&transaction, &current, &after)?;
    transaction.commit().map_err(|error| error.to_string())?;
    clock.armed.retain(|key, _| seen.contains(key));
    clock.seen = seen;
    clock.started = true;
    clock.next_due = next_due;
    clock.waiting = waiting;
    Ok(count)
}

#[cfg(test)]
mod tests {
    // A routine must survive renderer loss without creating duplicate deliveries.
    use serde_json::{json, Value};

    fn fixture() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE groups(id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, suspended INTEGER NOT NULL);
            CREATE TABLE terminals(id TEXT PRIMARY KEY, group_id TEXT NOT NULL);").unwrap();
        let layout = json!({"canvas":{"routines":[{"id":"reminder","terminalId":"agent","text":"Review the work","everyMin":5,"enabled":true,"once":true,"createdAt":1000}]}});
        connection.execute("INSERT INTO groups VALUES ('group', ?1, 0)", [layout.to_string()]).unwrap();
        connection.execute("INSERT INTO terminals VALUES ('agent', 'group')", []).unwrap();
        connection
    }

    fn repeating(connection: &rusqlite::Connection) {
        let mut layout: Value = serde_json::from_str(&connection.query_row("SELECT layout_json FROM groups WHERE id = 'group'", [], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        layout["canvas"]["routines"][0]["once"] = json!(false);
        connection.execute("UPDATE groups SET layout_json = ?1", [layout.to_string()]).unwrap();
    }

    /// The regression: a five-minute routine fired the moment the app opened
    /// after a night closed, a catch-up nobody asked for. More than one missed
    /// interval re-arms it from the first time this process looks at it.
    #[test]
    fn a_repeating_routine_missed_for_more_than_an_interval_waits_a_full_interval_after_startup() {
        let mut connection = fixture();
        repeating(&connection);
        let mut clock = super::RoutineClock::default();
        assert_eq!(super::enqueue_due(&mut connection, 901_000, |_| true, &mut clock).unwrap(), 0);
        assert!(crate::queue::read(&connection).unwrap().is_empty());
        assert_eq!(super::enqueue_due(&mut connection, 1_200_999, |_| true, &mut clock).unwrap(), 0);
        assert_eq!(super::enqueue_due(&mut connection, 1_201_000, |_| true, &mut clock).unwrap(), 1);
    }

    #[test]
    fn a_repeating_routine_overdue_by_at_most_one_interval_still_fires_at_startup() {
        let mut connection = fixture();
        repeating(&connection);
        let mut clock = super::RoutineClock::default();
        assert_eq!(super::enqueue_due(&mut connection, 601_000, |_| true, &mut clock).unwrap(), 1);
    }

    #[test]
    fn a_one_shot_reminder_missed_while_the_app_was_closed_is_still_delivered() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        assert_eq!(super::enqueue_due(&mut connection, 10_000_000, |_| true, &mut clock).unwrap(), 1);
    }

    /// Only the first look of a process re-arms: a routine that came due while
    /// the app was open and waited for its busy terminal is delivered as soon
    /// as the terminal is ready, however long that took.
    #[test]
    fn a_routine_that_waited_for_its_busy_terminal_during_the_session_is_delivered_when_ready() {
        let mut connection = fixture();
        repeating(&connection);
        let mut clock = super::RoutineClock::default();
        assert_eq!(super::enqueue_due(&mut connection, 301_000, |_| false, &mut clock).unwrap(), 0);
        assert_eq!(super::enqueue_due(&mut connection, 1_001_000, |_| true, &mut clock).unwrap(), 1);
    }

    fn edit_text(connection: &rusqlite::Connection, text: &str) {
        let mut layout: Value = serde_json::from_str(&connection.query_row("SELECT layout_json FROM groups WHERE id = 'group'", [], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        layout["canvas"]["routines"][0]["text"] = json!(text);
        connection.execute("UPDATE groups SET layout_json = ?1", [layout.to_string()]).unwrap();
    }

    fn run_texts(connection: &rusqlite::Connection) -> Vec<String> {
        crate::persistence::db::kv_prefix_values(connection, "routine.run.").unwrap().iter()
            .map(|raw| serde_json::from_str::<Value>(raw).unwrap()["routine"]["text"].as_str().unwrap().to_string()).collect()
    }

    /// The regression: every edit of a routine (its text, its interval)
    /// started a new run record and the superseded one stayed in the table
    /// forever.
    #[test]
    fn editing_a_routine_deletes_the_run_record_it_superseded() {
        let mut connection = fixture();
        repeating(&connection);
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301_000, |_| true, &mut clock).unwrap();
        let id = crate::queue::read(&connection).unwrap()[0]["id"].as_str().unwrap().to_string();
        let database = parking_lot::Mutex::new(connection);
        crate::queue::dispatch(&database, &id, "agent", 302_000, |_| Ok(())).unwrap();
        edit_text(&database.lock(), "Review the work again");
        super::enqueue_due(&mut database.lock(), 310_000, |_| true, &mut clock).unwrap();
        assert_eq!(run_texts(&database.lock()), ["Review the work again"]);
    }

    /// A delivery awaiting review records its outcome in its occurrence's
    /// record, so a superseded record it still points at is kept.
    #[test]
    fn a_superseded_routine_record_awaiting_delivery_review_is_kept() {
        let mut connection = fixture();
        repeating(&connection);
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301_000, |_| true, &mut clock).unwrap();
        let id = crate::queue::read(&connection).unwrap()[0]["id"].as_str().unwrap().to_string();
        let database = parking_lot::Mutex::new(connection);
        crate::queue::dispatch(&database, &id, "agent", 302_000, |_| Err("Write outcome unknown".into())).unwrap();
        edit_text(&database.lock(), "Review the work again");
        super::enqueue_due(&mut database.lock(), 310_000, |_| true, &mut clock).unwrap();
        assert_eq!(run_texts(&database.lock()), ["Review the work"]);
    }

    /// The scheduler sleeps until the next routine instead of polling: each
    /// pass says when the next routine is due and which terminals the due
    /// ones are waiting for.
    #[test]
    fn a_routine_pass_reports_the_next_deadline_and_the_terminals_due_routines_wait_for() {
        let mut connection = fixture();
        repeating(&connection);
        let mut clock = super::RoutineClock::default();
        assert!(clock.may_be_due(0), "nothing is known before the first pass");
        assert_eq!(super::enqueue_due(&mut connection, 100_000, |_| true, &mut clock).unwrap(), 0);
        assert_eq!(clock.next_due(), Some(301_000));
        assert!(clock.waiting_on().is_empty());
        assert!(!clock.may_be_due(300_999));
        assert!(clock.may_be_due(301_000));
        assert_eq!(super::enqueue_due(&mut connection, 301_000, |_| false, &mut clock).unwrap(), 0);
        assert_eq!(clock.waiting_on(), std::collections::HashSet::from(["agent".to_string()]));
        assert!(clock.may_be_due(301_001));
        assert_eq!(super::enqueue_due(&mut connection, 302_000, |_| true, &mut clock).unwrap(), 1);
        assert!(clock.waiting_on().is_empty());
        assert_eq!(clock.next_due(), Some(602_000));
    }

    /// The page refetches routine state on `routine://changed` and the queue on
    /// `queue://changed`; a pass that reserves nothing announces nothing.
    #[test]
    fn a_reserved_routine_occurrence_announces_its_run_state_and_the_queue() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        let _ = crate::events::take_kv_changes();
        assert_eq!(super::enqueue_due(&mut connection, 301_000, |_| true, &mut clock).unwrap(), 1);
        assert_eq!(crate::events::take_kv_changes().topics(), vec![crate::events::QUEUE_CHANGED, crate::events::ROUTINE_CHANGED]);
        assert_eq!(super::enqueue_due(&mut connection, 360_000, |_| true, &mut clock).unwrap(), 0);
        assert!(crate::events::take_kv_changes().is_empty());
    }

    #[test]
    fn a_due_native_routine_persists_one_occurrence_without_marking_it_delivered() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        assert_eq!(super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap(), 1);
        let queued = crate::queue::read(&connection).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["text"], "Review the work");
        assert_eq!(super::enqueue_due(&mut connection, 360000, |_| true, &mut clock).unwrap(), 0);
        let reports = super::snapshot(&connection).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["status"], "queued");
        assert_eq!(reports[0]["routine"]["text"], "Review the work");
        assert!(reports[0]["lastRunAt"].is_null());
    }

    #[test]
    fn a_routine_records_its_delivery_clock_only_with_the_durable_queue_acknowledgment() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        let queued = crate::queue::read(&connection).unwrap();
        let database = parking_lot::Mutex::new(connection);
        let outcome = crate::queue::dispatch(&database, queued[0]["id"].as_str().unwrap(), "agent", 302000, |_| Ok(())).unwrap();
        assert_eq!(outcome.status, "delivered");
        let reports = super::snapshot(&database.lock()).unwrap();
        assert_eq!(reports[0]["lastRunAt"], 302000);
        assert_eq!(reports[0]["status"], "delivered");
    }

    #[test]
    fn an_uncertain_routine_requires_review_and_links_its_fresh_retry_to_the_same_occurrence() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        let id = crate::queue::read(&connection).unwrap()[0]["id"].as_str().unwrap().to_string();
        let database = parking_lot::Mutex::new(connection);
        crate::queue::dispatch(&database, &id, "agent", 302000, |_| Err("Write outcome unknown".into())).unwrap();
        assert_eq!(super::enqueue_due(&mut database.lock(), 700000, |_| true, &mut clock).unwrap(), 0);
        crate::queue::retry_reviewed(&mut database.lock(), &id, "reviewed-retry", 302000).unwrap();
        let outcome = crate::queue::dispatch(&database, "reviewed-retry", "agent", 701000, |_| Ok(())).unwrap();
        assert_eq!(outcome.status, "delivered");
        let reports = super::snapshot(&database.lock()).unwrap();
        assert_eq!(reports[0]["queueId"], "reviewed-retry");
        assert_eq!(reports[0]["lastRunAt"], 701000);
        assert_eq!(super::enqueue_due(&mut database.lock(), 1500000, |_| true, &mut clock).unwrap(), 0);
    }

    #[test]
    fn pausing_a_routine_after_reservation_prevents_its_terminal_delivery() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        let item = crate::queue::read(&connection).unwrap()[0].clone();
        let mut layout: serde_json::Value = serde_json::from_str(&connection.query_row("SELECT layout_json FROM groups WHERE id = 'group'", [], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        layout["canvas"]["routines"][0]["enabled"] = json!(false);
        connection.execute("UPDATE groups SET layout_json = ?1 WHERE id = 'group'", [layout.to_string()]).unwrap();
        let database = parking_lot::Mutex::new(connection);
        let outcome = crate::queue::dispatch(&database, item["id"].as_str().unwrap(), "agent", 302000, |_| panic!("Paused routine reached the terminal input boundary")).unwrap();
        assert_eq!(outcome.status, "skipped");
    }

    #[test]
    fn a_removed_routine_releases_its_pending_queue_slot_without_claiming_a_delivery() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        connection.execute("UPDATE groups SET layout_json = '{}' WHERE id = 'group'", []).unwrap();
        super::enqueue_due(&mut connection, 302000, |_| true, &mut clock).unwrap();
        assert!(crate::queue::read(&connection).unwrap().is_empty());
        let report = &super::snapshot(&connection).unwrap()[0];
        assert_eq!(report["status"], "cancelled");
        assert!(report["lastRunAt"].is_null());
    }

    #[test]
    fn cancelling_a_repeating_occurrence_waits_for_its_next_interval_before_scheduling_again() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        let mut layout: Value = serde_json::from_str(&connection.query_row("SELECT layout_json FROM groups WHERE id = 'group'", [], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        layout["canvas"]["routines"][0]["once"] = json!(false);
        connection.execute("UPDATE groups SET layout_json = ?1", [layout.to_string()]).unwrap();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        let id = crate::queue::read(&connection).unwrap()[0]["id"].as_str().unwrap().to_string();
        let database = parking_lot::Mutex::new(connection);
        crate::queue::dispatch(&database, &id, "agent", 302000, |_| Ok(())).unwrap();
        super::enqueue_due(&mut database.lock(), 602000, |_| true, &mut clock).unwrap();
        let next_id = crate::queue::read(&database.lock()).unwrap()[0]["id"].as_str().unwrap().to_string();
        crate::queue::remove_reviewed(&mut database.lock(), &next_id, None).unwrap();
        assert_eq!(super::enqueue_due(&mut database.lock(), 603000, |_| true, &mut clock).unwrap(), 0);
        assert_eq!(super::snapshot(&database.lock()).unwrap()[0]["status"], "cancelled");
        assert_eq!(super::enqueue_due(&mut database.lock(), 902000, |_| true, &mut clock).unwrap(), 1);
    }

    #[test]
    fn a_replaced_queue_identity_cannot_deliver_using_another_routine_occurrences_record() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        let before = crate::queue::read(&connection).unwrap();
        let mut replacement = before.clone();
        replacement[0]["id"] = json!("unrelated-request");
        crate::queue::apply(&mut connection, &before, &replacement).unwrap();
        let database = parking_lot::Mutex::new(connection);
        let outcome = crate::queue::dispatch(&database, "unrelated-request", "agent", 302000, |_| panic!("An unrelated request reached the routine terminal input")).unwrap();
        assert_eq!(outcome.status, "skipped");
    }

    #[test]
    fn an_obsolete_routine_reference_is_retired_without_stalling_an_independent_schedule() {
        let mut connection = fixture();
        let mut clock = super::RoutineClock::default();
        super::enqueue_due(&mut connection, 301000, |_| true, &mut clock).unwrap();
        let before = crate::queue::read(&connection).unwrap();
        let mut replacement = before.clone();
        replacement[0]["id"] = json!("obsolete-reference");
        crate::queue::apply(&mut connection, &before, &replacement).unwrap();
        let mut layout: Value = serde_json::from_str(&connection.query_row("SELECT layout_json FROM groups", [], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        layout["canvas"]["routines"].as_array_mut().unwrap().push(json!({"id":"independent","terminalId":"other","text":"Independent work","enabled":true,"once":true,"everyMin":5,"createdAt":1000}));
        connection.execute("UPDATE groups SET layout_json = ?1", [layout.to_string()]).unwrap();
        connection.execute("INSERT INTO terminals VALUES ('other', 'group')", []).unwrap();
        assert_eq!(super::enqueue_due(&mut connection, 302000, |_| true, &mut clock).unwrap(), 2);
        let queued = crate::queue::read(&connection).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["text"], "Independent work");
        assert!(crate::queue::is_retired(&connection, "obsolete-reference").unwrap());
    }
}
