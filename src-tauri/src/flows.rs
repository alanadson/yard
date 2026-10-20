//! Flow definitions are frozen when their durable execution request is accepted.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn run_key(group: &str, flow: &str) -> String {
    format!(
        "native.flow.run.{:x}",
        Sha256::digest(json!([group, flow]).to_string().as_bytes())
    )
}

pub fn legacy_executors(
    connection: &Connection,
) -> Result<std::collections::HashSet<String>, String> {
    let raw: Option<String> = connection
        .query_row("SELECT value FROM kv WHERE key = 'flow.runs'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    let runs: Vec<Value> =
        serde_json::from_str(raw.as_deref().unwrap_or("[]")).map_err(|error| error.to_string())?;
    Ok(runs
        .iter()
        .filter(|run| {
            run["owner"] != "native"
                && run.get("finishedAt").is_some_and(Value::is_null)
                && run["flowId"].as_str().is_some()
                && run["groupId"].as_str().is_some()
                && run["stages"].as_array().is_some()
        })
        .filter_map(|run| {
            run["terminalId"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string)
        })
        .collect())
}

pub fn snapshot(connection: &Connection) -> Result<Vec<Value>, String> {
    crate::persistence::db::kv_prefix_values(connection, "native.flow.run.")
        .map_err(|error| error.to_string())?
        .iter()
        .map(|raw| serde_json::from_str(raw).map_err(|error| error.to_string()))
        .collect()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub group_id: String,
    pub flow_id: String,
    pub terminal_id: String,
    pub task: String,
    #[serde(default)]
    pub typed: bool,
    pub caller_id: Option<String>,
    pub task_id: Option<String>,
    pub task_revision: Option<i64>,
}

pub fn start(
    connection: &mut Connection,
    group: &str,
    flow_id: &str,
    terminal: &str,
    task: &str,
    now: i64,
) -> Result<Value, String> {
    start_input(
        connection,
        &StartInput {
            group_id: group.into(),
            flow_id: flow_id.into(),
            terminal_id: terminal.into(),
            task: task.into(),
            typed: false,
            caller_id: None,
            task_id: None,
            task_revision: None,
        },
        now,
    )
}

pub fn start_input(
    connection: &mut Connection,
    input: &StartInput,
    now: i64,
) -> Result<Value, String> {
    let (group, flow_id, terminal, task) = (
        input.group_id.as_str(),
        input.flow_id.as_str(),
        input.terminal_id.as_str(),
        input.task.as_str(),
    );
    if task.trim().is_empty() || task.trim_start().starts_with("[Yard") {
        return Err("FLOW_INPUT_INVALID".into());
    }
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let previous = snapshot(&transaction)?;
    if legacy_executors(&transaction)?.contains(terminal)
        || crate::work::active_executors(&transaction).map_err(|error| error.to_string())?.contains(terminal) {
        return Err("FLOW_ALREADY_RUNNING".into());
    }
    if previous.iter().any(|run| {
        (run["finishedAt"].is_null() || run["phase"] == "interrupted")
            && (run["terminalId"] == terminal
                || (run["groupId"] == group && run["flowId"] == flow_id))
    }) {
        return Err("FLOW_ALREADY_RUNNING".into());
    }
    let attempt = previous
        .iter()
        .find(|run| run["groupId"] == group && run["flowId"] == flow_id)
        .and_then(|run| run["attempt"].as_u64())
        .unwrap_or(0)
        + 1;
    let raw: String = transaction
        .query_row(
            "SELECT layout_json FROM groups WHERE id = ?1",
            [group],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let layout: Value = serde_json::from_str(&raw).map_err(|_| "FLOW_LAYOUT_INVALID")?;
    let definition = layout["canvas"]["items"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["type"] == "flow" && item["id"] == flow_id)
        })
        .ok_or("FLOW_NOT_FOUND")?;
    let agent: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM terminals WHERE id = ?1 AND group_id = ?2 AND kind = 'agent')", [terminal, group], |row| row.get(0)).map_err(|error| error.to_string())?;
    let wired = layout["canvas"]["items"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item["type"] == "connection"
                && ((item["from"] == flow_id && item["to"] == terminal)
                    || (item["from"] == terminal && item["to"] == flow_id))
        })
    });
    if !agent || !wired {
        return Err("FLOW_EXECUTOR_NOT_CONNECTED".into());
    }
    let stages: Vec<_> = definition["stages"]
        .as_array()
        .ok_or("FLOW_STAGES_INVALID")?
        .iter()
        .filter(|stage| {
            stage["prompt"]
                .as_str()
                .is_some_and(|prompt| !prompt.trim().is_empty())
        })
        .cloned()
        .collect();
    if stages.is_empty() {
        return Err("FLOW_INPUT_INVALID".into());
    }
    let states: Vec<_> = stages
        .iter()
        .enumerate()
        .map(|(index, stage)| {
            let label = stage["label"]
                .as_str()
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("Etapa {}", index + 1));
            json!({"label":label,"status":"pending"})
        })
        .collect();
    let execution = format!("{}:{attempt}", run_key(group, flow_id));
    if let Some(id) = input.task_id.as_deref() {
        let linked = crate::work::get(&transaction, id).map_err(|error| error.to_string())?;
        if linked.request != task { return Err("FLOW_TASK_REQUEST_CHANGED".into()); }
        crate::work::start_flow_in(&transaction, id, input.task_revision, terminal, &execution,
            crate::work::TaskResource { kind: "flow".into(), id: flow_id.into(), root: Some(group.into()), label: definition["name"].as_str().unwrap_or(flow_id).into() }, now).map_err(|error| error.to_string())?;
    }
    let run = json!({"owner":"native","flowId":flow_id,"groupId":group,"name":definition["name"],"task":task,"terminalId":terminal,"taskId":input.task_id,"taskExecution":execution,"taskExecutionBase":execution,"taskResumeCount":0,
        "stages":states,"definition":stages,"current":0,"brief":"","carry":"","startedAt":now,"stageStartedAt":now,
        "finishedAt":null,"error":null,"cancelRequested":false,"cancelled":false,"phase":"waiting","attempt":attempt,"typed":input.typed,"callerId":input.caller_id});
    crate::persistence::db::kv_set(&transaction, &run_key(group, flow_id), &run.to_string())
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(run)
}

pub struct Observation {
    pub alive: bool,
    pub pid: u32,
    pub started_at: i64,
    pub bytes: u64,
    pub ready: bool,
    pub blocked: bool,
    pub output: String,
}

pub struct Delivery {
    pub text: String,
    pub group: String,
    pub flow: String,
    pub attempt: u64,
}

fn save(connection: &Connection, key: &str, run: &Value) -> Result<(), String> {
    if run["phase"] == "cancelled" {
        if let (Some(id), Some(execution)) = (run["taskId"].as_str(), run["taskExecution"].as_str()) {
            crate::work::cancel_flow_in(connection, id, execution, run["finishedAt"].as_i64().unwrap_or(0)).map_err(|error| error.to_string())?;
        }
    }
    if run["phase"] == "done" {
        if let (Some(id), Some(execution)) = (run["taskId"].as_str(), run["taskExecution"].as_str()) {
            let task = crate::work::get(connection, id).map_err(|error| error.to_string())?;
            if task.status == "running" && task.links.execution_id.as_deref() == Some(execution) {
                crate::work::submit_in(connection, id, task.revision, crate::work::Submission { attempt_id: Some(execution.into()),
                    delivery: crate::work::Delivery { summary: run["carry"].as_str().filter(|text| !text.trim().is_empty()).unwrap_or("Pipeline finished without a stage summary").into(), artifacts: vec![], checks: vec![] }, evidence: Default::default() },
                    run["finishedAt"].as_i64().unwrap_or(0)).map_err(|error| error.to_string())?;
            }
        }
    }
    if run["phase"] == "interrupted" {
        if let (Some(id), Some(execution)) = (run["taskId"].as_str(), run["taskExecution"].as_str()) {
            crate::work::interrupt_flow_in(connection, id, execution, run["error"].as_str().unwrap_or("FLOW_PROCESS_INTERRUPTED"), run["finishedAt"].as_i64().unwrap_or(0)).map_err(|error| error.to_string())?;
        }
    }
    crate::persistence::db::kv_set(connection, key, &run.to_string())
        .map_err(|error| error.to_string())
}

pub fn acknowledge(
    connection: &mut Connection,
    delivery: &Delivery,
    outcome: Result<(), String>,
    now: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let key = run_key(&delivery.group, &delivery.flow);
    let raw = crate::persistence::db::kv_get(&transaction, &key).ok_or("FLOW_RUN_NOT_FOUND")?;
    let mut run: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if run["phase"] != "sending" || run["attempt"].as_u64() != Some(delivery.attempt) {
        return Err("FLOW_ATTEMPT_CHANGED".into());
    }
    let index = run["current"].as_u64().unwrap_or(0) as usize;
    if outcome.is_err() {
        interrupt(&mut run, "FLOW_DELIVERY_UNCERTAIN", now);
    } else {
        run["phase"] = json!("working");
        run["stages"][index]["status"] = json!("working");
        run["lastBytes"] = run["baseline"].clone();
        run["growthAt"] = json!(now);
    }
    save(&transaction, &key, &run)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn interrupt(run: &mut Value, error: &str, now: i64) {
    let index = run["current"].as_u64().unwrap_or(0) as usize;
    run["phase"] = json!("interrupted");
    run["error"] = json!(error);
    run["finishedAt"] = json!(now);
    run["stages"][index]["status"] = json!("error");
}

pub fn recover_on_boot(connection: &mut Connection, now: i64) -> Result<usize, String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut count = 0;
    for mut run in snapshot(&transaction)? {
        if !run["finishedAt"].is_null() {
            continue;
        }
        interrupt(&mut run, "FLOW_PROCESS_INTERRUPTED", now);
        save(
            &transaction,
            &run_key(
                run["groupId"].as_str().ok_or("FLOW_RUN_INVALID")?,
                run["flowId"].as_str().ok_or("FLOW_RUN_INVALID")?,
            ),
            &run,
        )?;
        count += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(count)
}

pub fn resume(
    connection: &mut Connection,
    group: &str,
    flow: &str,
    attempt: u64,
    confirmed: bool,
    now: i64,
) -> Result<Value, String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let key = run_key(group, flow);
    let raw = crate::persistence::db::kv_get(&transaction, &key).ok_or("FLOW_RUN_NOT_FOUND")?;
    let mut run: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if !confirmed || run["phase"] != "interrupted" || run["attempt"].as_u64() != Some(attempt) {
        return Err("FLOW_REVIEW_REQUIRED".into());
    }
    if let (Some(id), Some(previous)) = (run["taskId"].as_str(), run["taskExecution"].as_str()) {
        let count = run["taskResumeCount"].as_u64().unwrap_or(0) + 1;
        let base = run["taskExecutionBase"].as_str().unwrap_or(previous);
        let execution = format!("{base}:resume:{count}");
        crate::work::resume_flow_in(&transaction, id, previous, &execution, now).map_err(|error| error.to_string())?;
        run["taskExecution"] = json!(execution);
        run["taskResumeCount"] = json!(count);
    }
    let index = run["current"].as_u64().unwrap_or(0) as usize;
    run["phase"] = json!("waiting");
    run["typed"] = json!(false);
    run["error"] = Value::Null;
    run["finishedAt"] = Value::Null;
    run["stageStartedAt"] = json!(now);
    run["stages"][index]["status"] = json!("waiting");
    save(&transaction, &key, &run)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(run)
}

pub fn cancel(
    connection: &mut Connection,
    group: &str,
    flow: &str,
    attempt: u64,
    now: i64,
) -> Result<Value, String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let key = run_key(group, flow);
    let raw = crate::persistence::db::kv_get(&transaction, &key).ok_or("FLOW_RUN_NOT_FOUND")?;
    let mut run: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if run["attempt"].as_u64() != Some(attempt) {
        return Err("FLOW_ATTEMPT_CHANGED".into());
    }
    run["phase"] = json!("cancelled");
    run["cancelRequested"] = json!(true);
    run["cancelled"] = json!(true);
    run["finishedAt"] = json!(now);
    run["error"] = Value::Null;
    save(&transaction, &key, &run)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(run)
}

pub fn cancel_task_in(connection: &Connection, task_id: &str, execution: &str, now: i64) -> Result<(), String> {
    for mut run in snapshot(connection)? {
        if run["taskId"] != task_id || run["taskExecution"] != execution || (!run["finishedAt"].is_null() && run["phase"] != "interrupted") { continue; }
        run["phase"] = json!("cancelled");
        run["cancelRequested"] = json!(true);
        run["cancelled"] = json!(true);
        run["finishedAt"] = json!(now);
        run["error"] = Value::Null;
        let key = run_key(run["groupId"].as_str().ok_or("FLOW_RUN_INVALID")?, run["flowId"].as_str().ok_or("FLOW_RUN_INVALID")?);
        crate::persistence::db::kv_set(connection, &key, &run.to_string()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn dismiss(
    connection: &mut Connection,
    group: &str,
    flow: &str,
    attempt: u64,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let key = run_key(group, flow);
    let raw = crate::persistence::db::kv_get(&transaction, &key).ok_or("FLOW_RUN_NOT_FOUND")?;
    let mut run: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if run["attempt"].as_u64() != Some(attempt)
        || run["finishedAt"].is_null()
        || run["phase"] == "interrupted"
    {
        return Err("FLOW_REVIEW_REQUIRED".into());
    }
    run["hidden"] = json!(true);
    save(&transaction, &key, &run)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn advance(
    connection: &mut Connection,
    group: &str,
    flow: &str,
    observation: &Observation,
    now: i64,
) -> Result<Option<Delivery>, String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let key = run_key(group, flow);
    let raw = crate::persistence::db::kv_get(&transaction, &key).ok_or("FLOW_RUN_NOT_FOUND")?;
    let mut run: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if !run["finishedAt"].is_null() {
        return Ok(None);
    }
    if !observation.alive
        || (run["phase"] != "waiting"
            && (run["pid"].as_u64() != Some(observation.pid as u64)
                || run["processStartedAt"].as_i64() != Some(observation.started_at)))
    {
        interrupt(&mut run, "FLOW_PROCESS_INTERRUPTED", now);
        save(&transaction, &key, &run)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let index = run["current"].as_u64().unwrap_or(0) as usize;
    let total = run["definition"]
        .as_array()
        .ok_or("FLOW_STAGES_INVALID")?
        .len();
    if run["phase"] == "sending" {
        interrupt(&mut run, "FLOW_DELIVERY_UNCERTAIN", now);
        save(&transaction, &key, &run)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    if observation.blocked {
        run["stages"][index]["status"] = json!("blocked");
        run["growthAt"] = json!(now);
        save(&transaction, &key, &run)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    if run["phase"] == "working" {
        run["stages"][index]["status"] = json!("working");
        let previous = run["lastBytes"].as_u64().unwrap_or(0);
        if observation.bytes > previous {
            run["lastBytes"] = json!(observation.bytes);
            run["growthAt"] = json!(now);
        } else if observation.bytes > run["baseline"].as_u64().unwrap_or(0)
            && observation.ready
            && now.saturating_sub(run["growthAt"].as_i64().unwrap_or(now)) >= 10000
        {
            let clean = String::from_utf8_lossy(&crate::pty_export::strip_ansi(
                observation.output.as_bytes(),
            ))
            .trim()
            .to_string();
            let summary = clean
                .rfind("### RESUMO DA ETAPA")
                .map(|index| &clean[index..])
                .unwrap_or(&clean);
            run["carry"] = json!(carry_tail(summary.trim()));
            run["stages"][index]["status"] = json!("done");
            run["current"] = json!(index + 1);
            run["phase"] = json!(if index + 1 == total {
                "done"
            } else {
                "waiting"
            });
            if index + 1 == total {
                run["finishedAt"] = json!(now);
            }
        } else if now.saturating_sub(run["growthAt"].as_i64().unwrap_or(now)) > 60 * 60 * 1000 {
            interrupt(&mut run, "FLOW_STAGE_STALLED", now);
        }
        save(&transaction, &key, &run)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    if run["phase"] != "waiting" || (!observation.ready && run["typed"] != true) {
        return Ok(None);
    }
    let label = run["stages"][index]["label"].as_str().unwrap_or("");
    let name = run["name"].as_str().unwrap_or("");
    let prefix = if run["typed"] == true { "\n\n" } else { "" };
    let text = format!("{prefix}[Yard · Fluxo \"{name}\": etapa {}/{total}: {label}] Rode `yard flow stage` e siga o briefing que ele devolver antes de qualquer outra coisa.", index + 1);
    run["typed"] = json!(false);
    run["brief"] = json!(format!("{}\n\n## Tarefa\n{}\n\n## Etapa anterior\n{}\n\nAo terminar, escreva um bloco final começando com a linha \"### RESUMO DA ETAPA\".", run["definition"][index]["prompt"].as_str().unwrap_or(""), run["task"].as_str().unwrap_or(""), run["carry"].as_str().unwrap_or("")));
    if let Some(id) = run["taskId"].as_str() {
        let execution = run["taskExecution"].as_str().unwrap_or("");
        let contract = format!("\n\nInspect the original request and acceptance criteria with `yard task show {id}`. On the final stage, submit a structured delivery before ending the turn with `yard task submit {id} --attempt {execution} --stdin`. The JSON has delivery {{summary, artifacts, checks: [{{name, passed, evidence}}]}} and evidence mapping criterion ids to evidence references. Do not report checks that were not run.");
        run["brief"] = json!(format!("{}{contract}", run["brief"].as_str().unwrap_or("")));
    }
    run["phase"] = json!("sending");
    run["baseline"] = json!(observation.bytes);
    run["pid"] = json!(observation.pid);
    run["processStartedAt"] = json!(observation.started_at);
    run["stageStartedAt"] = json!(now);
    let attempt = run["attempt"].as_u64().unwrap_or(0) + 1;
    run["attempt"] = json!(attempt);
    save(&transaction, &key, &run)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(Some(Delivery {
        text,
        group: group.into(),
        flow: flow.into(),
        attempt,
    }))
}

/// The most a stage hands to the next one, in characters: the same cap the
/// page's engine used (`CARRY_FALLBACK_CAP` in `src/lib/flow.ts`).
const CARRY_CAP: usize = 8_000;

/// The end of `text`, at most `CARRY_CAP` characters, cut on a character
/// boundary: a summary is written last, so its end is what matters.
fn carry_tail(text: &str) -> &str {
    match text.char_indices().rev().nth(CARRY_CAP - 1) {
        Some((start, _)) => &text[start..],
        None => text,
    }
}

pub fn active_executors(
    connection: &Connection,
) -> Result<std::collections::HashSet<String>, String> {
    Ok(snapshot(connection)?
        .iter()
        .filter(|run| run["finishedAt"].is_null() || run["phase"] == "interrupted")
        .filter_map(|run| run["terminalId"].as_str().map(str::to_owned))
        .collect())
}

/// The active runs a pass drives, in order. A run in the middle of a stage
/// (sending, working) is always observed. A run waiting to start its next
/// stage is driven only while automation is not paused, and only the first
/// `budget` of them (the free automation slots).
pub fn runs_to_drive(runs: &[Value], paused: bool, budget: usize) -> Vec<&Value> {
    let mut left = if paused { 0 } else { budget };
    runs.iter().filter(|run| run["finishedAt"].is_null()).filter(|run| {
        if run["phase"] != "waiting" { return true; }
        if left == 0 { return false; }
        left -= 1;
        true
    }).collect()
}

/// Hands every run this pass drives (`runs_to_drive`) to its executor's lane.
/// A waiting run starts its next stage only while automation is not paused
/// and `automationMaxAgents` leaves a slot (`scheduler::flow_budget`).
/// Returns whether any run is still active, which keeps the scheduler's
/// two-second cadence.
pub fn schedule(app: &tauri::AppHandle, state: &std::sync::Arc<crate::state::AppState>, paused: bool, now: i64) -> bool {
    let runs = match snapshot(&state.db.lock()) {
        Ok(runs) => { state.scheduler.warn("flows", None, ""); runs }
        Err(error) => {
            state.scheduler.warn("flows", Some(&error), "native flow snapshot unavailable");
            return false;
        }
    };
    let waiting: std::collections::HashSet<&str> = runs.iter()
        .filter(|run| run["finishedAt"].is_null() && run["phase"] == "waiting")
        .filter_map(|run| run["terminalId"].as_str()).collect();
    let budget = if paused || waiting.is_empty() { 0 } else { crate::scheduler::flow_budget(state, &waiting, now) };
    for run in runs_to_drive(&runs, paused, budget) {
        let (Some(group), Some(flow), Some(terminal)) = (
            run["groupId"].as_str(),
            run["flowId"].as_str(),
            run["terminalId"].as_str(),
        ) else {
            continue;
        };
        let (group, flow, terminal) = (group.to_string(), flow.to_string(), terminal.to_string());
        let job_id = format!("flow:{}", run_key(&group, &flow));
        if !state.scheduler.schedule(&job_id) {
            continue;
        }
        let state = state.clone();
        let app = app.clone();
        crate::lanes::lanes().submit(&format!("pty:{terminal}"), move || {
            let result = drive(&state, &group, &flow, &terminal);
            state.scheduler.unschedule(&job_id);
            state.scheduler.warn(&job_id, result.as_ref().err().map(String::as_str), "native flow requires reconciliation");
            crate::events::publish_kv_changes(&app);
        });
    }
    runs.iter().any(|run| run["finishedAt"].is_null())
}

pub fn drive(
    state: &crate::state::AppState,
    group: &str,
    flow: &str,
    terminal: &str,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let run = snapshot(&state.db.lock())?
        .into_iter()
        .find(|run| run["groupId"] == group && run["flowId"] == flow)
        .ok_or("FLOW_RUN_NOT_FOUND")?;
    if run["terminalId"] != terminal {
        return Ok(());
    }
    let handle = state.ptys.lock().get(terminal).cloned();
    let now = crate::pty::reader::now_ms();
    let (alive, pid, started_at, bytes, tail) = match handle {
        Some(handle) => {
            let (pid, started_at, shared, scrollback) = {
                let handle = handle.lock();
                (
                    handle.pid.unwrap_or(0),
                    handle.started_at,
                    handle.shared.clone(),
                    handle.scrollback.clone(),
                )
            };
            let tail = scrollback.lock().tail(16 * 1024);
            (
                shared.reading.load(Ordering::Acquire) && !shared.stopping.load(Ordering::Acquire),
                pid,
                started_at,
                shared.total_bytes.load(Ordering::Acquire),
                tail,
            )
        }
        None => (false, 0, 0, 0, String::new()),
    };
    let blocked = state.scheduler.phase(terminal) == crate::scheduler::HookPhase::Permission
        || crate::scheduler::permission_prompt(&tail);
    let observation = Observation {
        alive,
        pid,
        started_at,
        bytes,
        blocked,
        ready: crate::scheduler::ready_terminal(state, terminal, now),
        output: crate::pty::read_since(
            state,
            terminal,
            run["baseline"].as_u64().unwrap_or(bytes),
            64 * 1024,
        )
        .data,
    };
    let delivery = advance(&mut state.db.lock(), group, flow, &observation, now)?;
    if let Some(delivery) = delivery {
        crate::scheduler::prepare_checkpoint(state, terminal, &json!({"id":format!("{}:{}",run["taskExecution"].as_str().unwrap_or(group),delivery.attempt),"taskId":run["taskId"],"text":run["task"],"source":"user"}), now);
        let outcome = crate::pty::inject_for_process(
            state,
            terminal,
            crate::pty::ProcessIdentity {
                pid: observation.pid,
                started_at: observation.started_at,
            },
            &delivery.text,
            true,
        );
        acknowledge(
            &mut state.db.lock(),
            &delivery,
            outcome,
            crate::pty::reader::now_ms(),
        )?;
    }
    Ok(())
}

pub fn handle_stage(connection: &Connection, request: &Value) -> Option<Value> {
    if request["argv"][0] != "flow" || request["argv"][1] != "stage" {
        return None;
    }
    let terminal = request["terminal"].as_str()?;
    let response = match snapshot(connection) {
        Ok(runs) => match runs
            .iter()
            .find(|run| run["terminalId"] == terminal && run["finishedAt"].is_null())
        {
            Some(run) if run["brief"].as_str().is_some_and(|brief| !brief.is_empty()) => {
                json!({"code":0,"output":format!("{}\n",run["brief"].as_str().unwrap())})
            }
            _ => return None,
        },
        Err(error) => json!({"code":1,"output":format!("yard flow: {error}\n")}),
    };
    Some(response)
}

pub fn handle_cli(connection: &mut Connection, request: &Value, now: i64) -> Option<Value> {
    let args = request["argv"].as_array()?;
    if args.first()?.as_str()? != "flow" {
        return None;
    }
    if args.get(1).and_then(Value::as_str) == Some("cancel") {
        let result = (|| {
            let terminal = request["terminal"].as_str().ok_or("FLOW_CALLER_MISSING")?;
            let group: String = connection
                .query_row(
                    "SELECT group_id FROM terminals WHERE id = ?1",
                    [terminal],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            let name = args
                .get(2)
                .and_then(Value::as_str)
                .ok_or("FLOW_NAME_REQUIRED")?;
            let run = snapshot(connection)?
                .into_iter()
                .find(|run| {
                    run["groupId"] == group
                        && (run["flowId"] == name
                            || run["name"].as_str().is_some_and(|label| {
                                label.to_lowercase() == name.trim().to_lowercase()
                            }))
                })
                .ok_or("FLOW_RUN_NOT_FOUND")?;
            let raw: String = connection
                .query_row(
                    "SELECT layout_json FROM groups WHERE id = ?1",
                    [&group],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            let layout: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            let wired = layout["canvas"]["items"].as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["type"] == "connection"
                        && ((item["from"] == terminal && item["to"] == run["flowId"])
                            || (item["to"] == terminal && item["from"] == run["flowId"]))
                })
            });
            if run["terminalId"] != terminal && !wired {
                return Err("FLOW_EXECUTOR_NOT_CONNECTED".into());
            }
            cancel(
                connection,
                &group,
                run["flowId"].as_str().ok_or("FLOW_RUN_INVALID")?,
                run["attempt"].as_u64().ok_or("FLOW_RUN_INVALID")?,
                now,
            )
        })();
        return Some(match result {
            Ok(_) => json!({"code":0,"output":"Cancelamento registrado.\n"}),
            Err(error) => json!({"code":1,"output":format!("yard flow: {error}\n")}),
        });
    }
    if args.get(1).and_then(Value::as_str) == Some("status") {
        let terminal = request["terminal"].as_str()?;
        let group: String = connection
            .query_row(
                "SELECT group_id FROM terminals WHERE id = ?1",
                [terminal],
                |row| row.get(0),
            )
            .ok()?;
        let runs = match snapshot(connection) {
            Ok(runs) => runs,
            Err(error) => return Some(json!({"code":1,"output":format!("yard flow: {error}\n")})),
        };
        let name = args.get(2).and_then(Value::as_str);
        let chosen: Vec<_> = runs
            .iter()
            .filter(|run| {
                run["groupId"] == group
                    && name.is_none_or(|name| {
                        run["flowId"] == name
                            || run["name"].as_str().is_some_and(|label| {
                                label.to_lowercase() == name.trim().to_lowercase()
                            })
                    })
            })
            .collect();
        if chosen.is_empty()
            && legacy_executors(connection)
                .ok()
                .is_some_and(|owners| owners.contains(terminal))
        {
            return None;
        }
        let mut output = String::new();
        for run in chosen {
            let state = if run["error"].is_string() {
                format!("falhou: {}", run["error"].as_str().unwrap())
            } else if run["cancelled"] == true {
                "cancelado".into()
            } else if !run["finishedAt"].is_null() {
                "concluído".into()
            } else {
                format!(
                    "em execução (etapa {})",
                    run["current"].as_u64().unwrap_or(0) + 1
                )
            };
            output.push_str(&format!(
                "\"{}\": {state}\n",
                run["name"].as_str().unwrap_or("")
            ));
            for (index, stage) in run["stages"].as_array().into_iter().flatten().enumerate() {
                output.push_str(&format!(
                    "  {}. \"{}\" ({})\n",
                    index + 1,
                    stage["label"].as_str().unwrap_or(""),
                    stage["status"].as_str().unwrap_or("")
                ));
            }
        }
        if output.is_empty() {
            output.push_str("Nenhum fluxo executado nesta sessão.\n");
        }
        return Some(json!({"code":0,"output":output}));
    }
    if args.get(1).and_then(Value::as_str) != Some("run") {
        return handle_stage(connection, request);
    }
    let result = (|| {
        let terminal = request["terminal"].as_str().ok_or("FLOW_CALLER_MISSING")?;
        let group: String = connection
            .query_row(
                "SELECT group_id FROM terminals WHERE id = ?1 AND kind = 'agent'",
                [terminal],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let raw: String = connection
            .query_row(
                "SELECT layout_json FROM groups WHERE id = ?1",
                [&group],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let layout: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let name = args
            .get(2)
            .and_then(Value::as_str)
            .ok_or("FLOW_NAME_REQUIRED")?;
        let definition = layout["canvas"]["items"]
            .as_array()
            .and_then(|items| {
                items.iter().find(|item| {
                    item["type"] == "flow"
                        && (item["id"] == name
                            || item["name"].as_str().is_some_and(|label| {
                                label.trim().eq_ignore_ascii_case(name.trim())
                            }))
                })
            })
            .ok_or("FLOW_NOT_FOUND")?;
        let from_stdin = args.iter().any(|arg| arg == "--stdin" || arg == "--file");
        let task = if from_stdin {
            request["stdin"].as_str()
        } else {
            args.get(3).and_then(Value::as_str)
        }
        .ok_or("FLOW_TASK_REQUIRED")?;
        start_input(
            connection,
            &StartInput {
                group_id: group,
                flow_id: definition["id"].as_str().ok_or("FLOW_NOT_FOUND")?.into(),
                terminal_id: terminal.into(),
                task: task.into(),
                typed: false,
                caller_id: Some(terminal.into()),
                task_id: None,
                task_revision: None,
            },
            now,
        )
    })();
    Some(match result {
        Ok(run) => {
            json!({"code":0,"output":format!("Fluxo \"{}\" iniciado, {} etapa(s). Rode `yard flow stage` ao receber cada carimbo.\n", run["name"].as_str().unwrap_or(""), run["stages"].as_array().map(Vec::len).unwrap_or(0))})
        }
        Err(error) => json!({"code":1,"output":format!("yard flow: {error}\n")}),
    })
}

#[cfg(test)]
mod tests {
    // An active pipeline must retain the user's request and stages across renderer reloads and canvas edits.
    use serde_json::json;

    fn fixture() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE groups(id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, suspended INTEGER NOT NULL);
            CREATE TABLE terminals(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, kind TEXT NOT NULL);").unwrap();
        let layout = json!({"canvas":{"items":[
            {"id":"pipeline","type":"flow","name":"Review pipeline","stages":[{"label":"Plan","prompt":"Plan the requested change"},{"label":"Verify","prompt":"Verify the change"}]},
            {"id":"wire","type":"connection","from":"pipeline","to":"agent"}
        ]}});
        connection
            .execute(
                "INSERT INTO groups VALUES ('group', ?1, 0)",
                [layout.to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO terminals VALUES ('agent', 'group', 'agent')",
                [],
            )
            .unwrap();
        connection
    }

    #[test]
    fn a_task_started_as_a_pipeline_keeps_its_acceptance_criteria_and_executor_identity() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(),
            criteria: vec!["Preserve callers".into()], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":"Original work request","taskId":task.id,"taskRevision":task.revision})).unwrap();
        let run = super::start_input(&mut connection, &input, 2000).unwrap();
        assert_eq!(run["taskId"], "work");
        let running = crate::work::get(&connection, "work").unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.criteria, task.criteria);
        assert_eq!(running.links.executor_terminal_id.as_deref(), Some("agent"));
    }

    #[test]
    fn an_interrupted_task_pipeline_appears_in_attention_without_requeueing() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(), criteria: vec![], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":task.request,"taskId":task.id,"taskRevision":task.revision})).unwrap();
        super::start_input(&mut connection, &input, 2000).unwrap();
        super::recover_on_boot(&mut connection, 3000).unwrap();
        assert_eq!(crate::work::get(&connection, "work").unwrap().status, "blocked");
        assert_eq!(crate::work::list_attention(&connection, None, 200).unwrap().total, 1);
        assert!(crate::queue::read(&connection).unwrap().is_empty());
        let run = super::snapshot(&connection).unwrap().remove(0);
        super::resume(&mut connection, "group", "pipeline", run["attempt"].as_u64().unwrap(), true, 4000).unwrap();
        assert_eq!(crate::work::get(&connection, "work").unwrap().status, "running");
    }

    #[test]
    fn a_finished_task_pipeline_records_its_summary_for_review_without_claiming_test_success() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(), criteria: vec!["Preserve callers".into()], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":task.request,"taskId":task.id,"taskRevision":task.revision})).unwrap();
        super::start_input(&mut connection, &input, 2000).unwrap();
        let mut observation = super::Observation { alive: true, pid: 42, started_at: 1000, bytes: 100, ready: true, blocked: false, output: String::new() };
        for index in 0..2 {
            let at = 10000 + index * 30000;
            let delivery = super::advance(&mut connection, "group", "pipeline", &observation, at).unwrap().unwrap();
            super::acknowledge(&mut connection, &delivery, Ok(()), at + 100).unwrap();
            observation.bytes += 100;
            observation.output = "### RESUMO DA ETAPA\nReview evidence".into();
            super::advance(&mut connection, "group", "pipeline", &observation, at + 1000).unwrap();
            super::advance(&mut connection, "group", "pipeline", &observation, at + 20000).unwrap();
        }
        let review = crate::work::get(&connection, "work").unwrap();
        assert_eq!(review.status, "in_review");
        assert!(review.delivery.as_ref().unwrap().summary.contains("Review evidence"));
        assert!(review.delivery.as_ref().unwrap().checks.is_empty());
        assert_eq!(crate::work::approve(&mut connection, "work", review.revision, "Reviewed", 90000).unwrap_err().code, "acceptance_missing");
    }

    #[test]
    fn cancelling_an_interrupted_task_also_releases_its_pipeline_reservation() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(), criteria: vec![], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":task.request,"taskId":task.id,"taskRevision":task.revision})).unwrap();
        super::start_input(&mut connection, &input, 2000).unwrap();
        super::recover_on_boot(&mut connection, 3000).unwrap();
        let blocked = crate::work::get(&connection, "work").unwrap();
        crate::work::transition(&mut connection, "work", blocked.revision, "cancelled", 4000).unwrap();
        assert_eq!(super::snapshot(&connection).unwrap()[0]["phase"], "cancelled");
        assert!(super::active_executors(&connection).unwrap().is_empty());
    }

    #[test]
    fn cancelling_a_pipeline_also_cancels_the_work_task_it_owns() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(), criteria: vec![], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":task.request,"taskId":task.id,"taskRevision":task.revision})).unwrap();
        let run = super::start_input(&mut connection, &input, 2000).unwrap();
        super::cancel(&mut connection, "group", "pipeline", run["attempt"].as_u64().unwrap(), 3000).unwrap();
        assert_eq!(crate::work::get(&connection, "work").unwrap().status, "cancelled");
        assert!(crate::work::active_executors(&connection).unwrap().is_empty());
    }

    #[test]
    fn an_interrupted_pipeline_task_cannot_bypass_review_through_the_queue_api() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(), criteria: vec![], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":task.request,"taskId":task.id,"taskRevision":task.revision})).unwrap();
        super::start_input(&mut connection, &input, 2000).unwrap();
        super::recover_on_boot(&mut connection, 3000).unwrap();
        let blocked = crate::work::get(&connection, "work").unwrap();
        assert_eq!(crate::work::enqueue(&mut connection, "work", blocked.revision, "agent", "replacement", 4000).unwrap_err().code, "invalid_transition");
    }

    #[test]
    fn a_pipeline_cannot_take_an_executor_owned_by_a_running_work_task() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Running work".into(), request: "Keep this request".into(), criteria: vec![],
            links: crate::work::TaskLinks { terminal_ids: vec!["agent".into()], executor_terminal_id: Some("agent".into()), ..Default::default() } }, 1000).unwrap();
        let queued = crate::work::transition(&mut connection, &task.id, task.revision, "queued", 2000).unwrap();
        crate::work::transition(&mut connection, &task.id, queued.revision, "running", 2100).unwrap();
        assert_eq!(super::start(&mut connection, "group", "pipeline", "agent", "Different request", 3000).unwrap_err(), "FLOW_ALREADY_RUNNING");
        assert_eq!(crate::work::get(&connection, "work").unwrap().request, "Keep this request");
    }

    #[test]
    fn repeated_reviewed_resumes_before_delivery_never_reuse_a_task_execution_identity() {
        let mut connection = fixture();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "work".into(), title: "Review API".into(), request: "Original work request".into(), criteria: vec![], links: Default::default() }, 1000).unwrap();
        let input = serde_json::from_value(json!({"groupId":"group","flowId":"pipeline","terminalId":"agent","task":task.request,"taskId":task.id,"taskRevision":task.revision})).unwrap();
        let run = super::start_input(&mut connection, &input, 2000).unwrap();
        let attempt = run["attempt"].as_u64().unwrap();
        super::recover_on_boot(&mut connection, 3000).unwrap();
        super::resume(&mut connection, "group", "pipeline", attempt, true, 4000).unwrap();
        let first = crate::work::get(&connection, "work").unwrap().links.execution_id;
        super::recover_on_boot(&mut connection, 5000).unwrap();
        super::resume(&mut connection, "group", "pipeline", attempt, true, 6000).unwrap();
        assert_ne!(crate::work::get(&connection, "work").unwrap().links.execution_id, first);
    }

    /// The regression: a stage that skipped its summary handed up to 64 KB of
    /// raw terminal output to the next stage's briefing (and its tokens). The
    /// carry keeps the last 8000 characters, as the page's engine did.
    #[test]
    fn a_stage_carry_keeps_only_its_last_eight_thousand_characters() {
        let mut connection = fixture();
        super::start(&mut connection, "group", "pipeline", "agent", "Original request", 1000).unwrap();
        let mut observation = super::Observation { alive: true, pid: 42, started_at: 1000, bytes: 100, ready: true, blocked: false, output: String::new() };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000).unwrap().unwrap();
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        observation.bytes = 200;
        observation.output = format!("{}{}END", "é".repeat(5000), "x".repeat(5000));
        super::advance(&mut connection, "group", "pipeline", &observation, 8000).unwrap();
        super::advance(&mut connection, "group", "pipeline", &observation, 20000).unwrap();
        let saved = super::snapshot(&connection).unwrap().remove(0);
        assert_eq!(saved["current"], 1);
        let carry = saved["carry"].as_str().unwrap();
        assert_eq!(carry.chars().count(), 8000);
        assert!(carry.starts_with('é'));
        assert!(carry.ends_with("xEND"));
    }

    /// A pause or a full automation cap must not start a new stage, but a
    /// stage already running is still observed, or its end would never be
    /// recorded.
    #[test]
    fn a_paused_or_full_automation_starts_no_new_stage_but_keeps_observing_running_ones() {
        let run = |flow: &str, phase: &str| json!({"groupId":"group","flowId":flow,"terminalId":flow,"phase":phase,"finishedAt":null});
        let mut finished = run("finished", "done");
        finished["finishedAt"] = json!(5000);
        let runs = vec![run("working", "working"), run("first", "waiting"), run("sending", "sending"), run("second", "waiting"), finished];
        let driven = |paused: bool, budget: usize| super::runs_to_drive(&runs, paused, budget).iter().map(|run| run["flowId"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(driven(false, 5), ["working", "first", "sending", "second"]);
        assert_eq!(driven(false, 1), ["working", "first", "sending"]);
        assert_eq!(driven(false, 0), ["working", "sending"]);
        assert_eq!(driven(true, 5), ["working", "sending"]);
    }

    /// The page refetches flows on `flow://changed`: every write of a run
    /// (start, stage change, finish, cancel) is announced, and an observation
    /// that changed nothing is not (it used to be rewritten every tick).
    #[test]
    fn every_native_flow_run_write_is_announced_and_an_unchanged_observation_is_not() {
        let changes = || crate::events::take_kv_changes().topics();
        let flow = vec![crate::events::FLOW_CHANGED];
        let mut connection = fixture();
        let _ = changes();
        super::start(&mut connection, "group", "pipeline", "agent", "Original request", 1000).unwrap();
        assert_eq!(changes(), flow, "start");
        let mut observation = super::Observation { alive: true, pid: 42, started_at: 1000, bytes: 100, ready: false, blocked: false, output: String::new() };
        assert!(super::advance(&mut connection, "group", "pipeline", &observation, 6000).unwrap().is_none());
        assert!(changes().is_empty(), "an executor that is not ready yet");
        observation.ready = true;
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000).unwrap().unwrap();
        assert_eq!(changes(), flow, "stage reserved");
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        assert_eq!(changes(), flow, "stage started");
        super::advance(&mut connection, "group", "pipeline", &observation, 8000).unwrap();
        assert!(changes().is_empty(), "a working stage with no new output");
        super::cancel(&mut connection, "group", "pipeline", delivery.attempt, 9000).unwrap();
        assert_eq!(changes(), flow, "cancel");
    }

    #[test]
    fn a_ready_native_flow_records_its_delivery_before_any_terminal_input() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        assert!(delivery.text.contains("yard flow stage"));
        let saved = super::snapshot(&connection).unwrap();
        assert_eq!(saved[0]["phase"], "sending");
        assert_eq!(saved[0]["baseline"], 100);
        assert!(saved[0]["brief"]
            .as_str()
            .unwrap()
            .contains("Original request"));
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 8000)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_reloaded_observer_advances_only_after_new_output_and_passes_the_last_summary_forward() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let mut observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 20000)
                .unwrap()
                .is_none()
        );
        assert_eq!(super::snapshot(&connection).unwrap()[0]["current"], 0);
        observation.bytes = 200;
        observation.output =
            "Old output\n### RESUMO DA ETAPA\nfirst\n### RESUMO DA ETAPA\nPreserved evidence"
                .into();
        observation.ready = false;
        super::advance(&mut connection, "group", "pipeline", &observation, 21000).unwrap();
        observation.ready = true;
        super::advance(&mut connection, "group", "pipeline", &observation, 32000).unwrap();
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["stages"][0]["status"],
            "done"
        );
        let next = super::advance(&mut connection, "group", "pipeline", &observation, 34000)
            .unwrap()
            .unwrap();
        assert!(next.text.contains("etapa 2/2"));
        let saved = super::snapshot(&connection).unwrap();
        assert!(saved[0]["brief"]
            .as_str()
            .unwrap()
            .contains("Preserved evidence"));
        assert!(!saved[0]["brief"].as_str().unwrap().contains("first"));
    }

    #[test]
    fn an_uncertain_stage_requires_review_and_resumes_without_repeating_completed_stages() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let mut observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let first = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &first, Ok(()), 7100).unwrap();
        observation.bytes = 200;
        observation.output = "### RESUMO DA ETAPA\nCompleted plan".into();
        super::advance(&mut connection, "group", "pipeline", &observation, 8000).unwrap();
        super::advance(&mut connection, "group", "pipeline", &observation, 20000).unwrap();
        let second = super::advance(&mut connection, "group", "pipeline", &observation, 22000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &second, Err("partial write".into()), 23000).unwrap();
        let interrupted = super::snapshot(&connection).unwrap().remove(0);
        assert_eq!(interrupted["error"], "FLOW_DELIVERY_UNCERTAIN");
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 40000)
                .unwrap()
                .is_none()
        );
        assert!(super::resume(
            &mut connection,
            "group",
            "pipeline",
            second.attempt,
            false,
            41000
        )
        .is_err());
        super::resume(
            &mut connection,
            "group",
            "pipeline",
            second.attempt,
            true,
            42000,
        )
        .unwrap();
        assert!(super::acknowledge(&mut connection, &second, Ok(()), 43000).is_err());
        let retry = super::advance(&mut connection, "group", "pipeline", &observation, 44000)
            .unwrap()
            .unwrap();
        assert!(retry.text.contains("etapa 2/2"));
        let saved = super::snapshot(&connection).unwrap().remove(0);
        assert_eq!(saved["stages"][0]["status"], "done");
        assert!(saved["brief"].as_str().unwrap().contains("Completed plan"));
    }

    #[test]
    fn restarting_the_backend_preserves_stage_progress_for_review_without_replaying_input() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        super::advance(&mut connection, "group", "pipeline", &observation, 7000).unwrap();
        assert_eq!(super::recover_on_boot(&mut connection, 8000).unwrap(), 1);
        assert_eq!(super::recover_on_boot(&mut connection, 9000).unwrap(), 0);
        let saved = super::snapshot(&connection).unwrap().remove(0);
        assert_eq!(saved["error"], "FLOW_PROCESS_INTERRUPTED");
        assert_eq!(saved["task"], "Original request");
        assert_eq!(saved["current"], 0);
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 20000)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn replacing_the_executor_process_cannot_continue_an_earlier_stage() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let mut observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        observation.pid = 43;
        observation.bytes = 500;
        super::advance(&mut connection, "group", "pipeline", &observation, 20000).unwrap();
        let saved = super::snapshot(&connection).unwrap().remove(0);
        assert_eq!(saved["phase"], "interrupted");
        assert_eq!(saved["current"], 0);
    }

    #[test]
    fn a_permission_question_pauses_a_native_stage_even_after_a_long_silence() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let mut observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        observation.bytes = 200;
        observation.ready = false;
        observation.blocked = true;
        super::advance(&mut connection, "group", "pipeline", &observation, 8000).unwrap();
        super::advance(&mut connection, "group", "pipeline", &observation, 4000000).unwrap();
        let saved = super::snapshot(&connection).unwrap().remove(0);
        assert!(saved["finishedAt"].is_null());
        assert_eq!(saved["stages"][0]["status"], "blocked");
        assert_eq!(saved["current"], 0);
    }

    #[test]
    fn a_second_start_cannot_replace_an_active_flows_original_request() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        assert!(super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Replacement request",
            2000
        )
        .is_err());
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["task"],
            "Original request"
        );
    }

    #[test]
    fn cancelling_a_reserved_stage_prevents_its_delayed_acknowledgment_from_reopening_work() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        let cancelled =
            super::cancel(&mut connection, "group", "pipeline", delivery.attempt, 8000).unwrap();
        assert_eq!(cancelled["cancelled"], true);
        assert!(super::acknowledge(&mut connection, &delivery, Ok(()), 9000).is_err());
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 20000)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_finished_delivery_without_an_acknowledgment_becomes_uncertain_instead_of_being_sent_again()
    {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 9000)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["error"],
            "FLOW_DELIVERY_UNCERTAIN"
        );
    }

    #[test]
    fn the_authenticated_flow_cli_starts_a_pipeline_without_a_renderer_dispatcher() {
        let mut connection = fixture();
        let request = serde_json::json!({"terminal":"agent","argv":["flow","run","Review pipeline","Original CLI request"]});
        let response = super::handle_cli(&mut connection, &request, 1000).unwrap();
        assert_eq!(response["code"], 0);
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["task"],
            "Original CLI request"
        );
    }

    #[test]
    fn resuming_an_interrupted_typed_request_waits_for_a_new_input_window() {
        let mut connection = fixture();
        let input = super::StartInput {
            group_id: "group".into(),
            flow_id: "pipeline".into(),
            terminal_id: "agent".into(),
            task: "Original request".into(),
            typed: true,
            caller_id: None,
            task_id: None,
            task_revision: None,
        };
        let accepted = super::start_input(&mut connection, &input, 1000).unwrap();
        super::recover_on_boot(&mut connection, 2000).unwrap();
        super::resume(
            &mut connection,
            "group",
            "pipeline",
            accepted["attempt"].as_u64().unwrap(),
            true,
            3000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: false,
            blocked: false,
            output: String::new(),
        };
        assert!(
            super::advance(&mut connection, "group", "pipeline", &observation, 4000)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_cancel_from_an_earlier_execution_cannot_stop_a_new_request_before_its_first_delivery() {
        let mut connection = fixture();
        let first = super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "First request",
            1000,
        )
        .unwrap();
        let observed = first["attempt"].as_u64().unwrap();
        super::cancel(&mut connection, "group", "pipeline", observed, 2000).unwrap();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "New request",
            3000,
        )
        .unwrap();
        assert!(super::cancel(&mut connection, "group", "pipeline", observed, 4000).is_err());
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["task"],
            "New request"
        );
        assert!(super::snapshot(&connection).unwrap()[0]["finishedAt"].is_null());
    }

    #[test]
    fn dismissing_a_finished_result_keeps_its_execution_identity_for_later_stale_actions() {
        let mut connection = fixture();
        let first = super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "First request",
            1000,
        )
        .unwrap();
        let attempt = first["attempt"].as_u64().unwrap();
        super::cancel(&mut connection, "group", "pipeline", attempt, 2000).unwrap();
        super::dismiss(&mut connection, "group", "pipeline", attempt).unwrap();
        assert_eq!(super::snapshot(&connection).unwrap()[0]["hidden"], true);
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "New request",
            3000,
        )
        .unwrap();
        assert!(super::cancel(&mut connection, "group", "pipeline", attempt, 4000).is_err());
    }

    #[test]
    fn an_uncertain_stage_keeps_its_executor_reserved_until_explicit_review() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(
            &mut connection,
            &delivery,
            Err("partial write".into()),
            8000,
        )
        .unwrap();
        assert!(super::active_executors(&connection)
            .unwrap()
            .contains("agent"));
        assert!(super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Another request",
            9000
        )
        .is_err());
        super::cancel(
            &mut connection,
            "group",
            "pipeline",
            delivery.attempt,
            10000,
        )
        .unwrap();
        assert!(!super::active_executors(&connection)
            .unwrap()
            .contains("agent"));
    }

    #[test]
    fn invalid_flow_requests_never_create_an_execution_that_cannot_deliver_a_stage() {
        for (task, stages) in [
            ("", serde_json::json!([{"prompt":"Plan"}])),
            (
                "[Yard configuration]",
                serde_json::json!([{"prompt":"Plan"}]),
            ),
            ("Original request", serde_json::json!([])),
            ("Original request", serde_json::json!([{"prompt":"   "}])),
        ] {
            let mut connection = fixture();
            let raw: String = connection
                .query_row(
                    "SELECT layout_json FROM groups WHERE id = 'group'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let mut layout: serde_json::Value = serde_json::from_str(&raw).unwrap();
            layout["canvas"]["items"][0]["stages"] = stages;
            connection
                .execute("UPDATE groups SET layout_json = ?1", [layout.to_string()])
                .unwrap();
            assert!(
                super::start(&mut connection, "group", "pipeline", "agent", task, 1000).is_err()
            );
            assert!(super::snapshot(&connection).unwrap().is_empty());
        }
    }

    #[test]
    fn native_flow_status_remains_available_after_the_canvas_definition_is_removed() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        connection
            .execute("UPDATE groups SET layout_json = '{}'", [])
            .unwrap();
        let request =
            serde_json::json!({"terminal":"agent","argv":["flow","status","Review pipeline"]});
        let response = super::handle_cli(&mut connection, &request, 2000);
        assert!(
            response.is_some(),
            "The native ledger must answer without a renderer"
        );
        let response = response.unwrap();
        assert_eq!(response["code"], 0);
        assert!(response["output"]
            .as_str()
            .unwrap()
            .contains("Review pipeline"));
        assert!(response["output"].as_str().unwrap().contains("Plan"));
    }

    #[test]
    fn native_flow_cancellation_requires_the_executor_or_a_current_canvas_connection() {
        let mut connection = fixture();
        connection
            .execute(
                "INSERT INTO terminals VALUES ('unconnected', 'group', 'agent')",
                [],
            )
            .unwrap();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let denied = super::handle_cli(
            &mut connection,
            &serde_json::json!({"terminal":"unconnected","argv":["flow","cancel","Review pipeline"]}),
            2000,
        );
        assert!(
            denied.is_some(),
            "Cancellation must be decided by the native owner"
        );
        assert_eq!(denied.unwrap()["code"], 1);
        assert!(super::snapshot(&connection).unwrap()[0]["finishedAt"].is_null());
        let cancelled = super::handle_cli(
            &mut connection,
            &serde_json::json!({"terminal":"agent","argv":["flow","cancel","Review pipeline"]}),
            3000,
        )
        .unwrap();
        assert_eq!(cancelled["code"], 0);
        assert_eq!(super::snapshot(&connection).unwrap()[0]["cancelled"], true);
    }

    #[test]
    fn a_native_flow_cannot_take_an_executor_still_owned_by_a_legacy_pipeline() {
        let mut connection = fixture();
        crate::persistence::db::kv_set(&connection, "flow.runs", &serde_json::json!([{"flowId":"legacy","groupId":"group","terminalId":"agent","finishedAt":null,"stages":[{"label":"Plan","status":"working"}]}]).to_string()).unwrap();
        assert!(super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000
        )
        .is_err());
        assert!(super::snapshot(&connection).unwrap().is_empty());
    }

    #[test]
    fn reusing_a_process_id_does_not_continue_work_from_an_earlier_process_lifetime() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let mut observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        observation.started_at = 2000;
        observation.bytes = 500;
        super::advance(&mut connection, "group", "pipeline", &observation, 20000).unwrap();
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["phase"],
            "interrupted"
        );
        assert_eq!(super::snapshot(&connection).unwrap()[0]["current"], 0);
    }

    #[test]
    fn a_silent_stage_requires_review_before_its_executor_can_receive_other_work() {
        let mut connection = fixture();
        super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Original request",
            1000,
        )
        .unwrap();
        let observation = super::Observation {
            alive: true,
            pid: 42,
            started_at: 1000,
            bytes: 100,
            ready: true,
            blocked: false,
            output: String::new(),
        };
        let delivery = super::advance(&mut connection, "group", "pipeline", &observation, 7000)
            .unwrap()
            .unwrap();
        super::acknowledge(&mut connection, &delivery, Ok(()), 7100).unwrap();
        super::advance(&mut connection, "group", "pipeline", &observation, 4000000).unwrap();
        assert_eq!(
            super::snapshot(&connection).unwrap()[0]["error"],
            "FLOW_STAGE_STALLED"
        );
        assert_eq!(super::snapshot(&connection).unwrap()[0]["current"], 0);
        assert!(super::active_executors(&connection)
            .unwrap()
            .contains("agent"));
    }

    #[test]
    fn an_accepted_flow_preserves_the_original_request_and_stage_labels_after_the_canvas_changes() {
        let mut connection = fixture();
        let accepted = super::start(
            &mut connection,
            "group",
            "pipeline",
            "agent",
            "Implement the requested feature",
            1000,
        )
        .unwrap();
        assert_eq!(accepted["task"], "Implement the requested feature");
        connection
            .execute("UPDATE groups SET layout_json = '{}'", [])
            .unwrap();
        let saved = super::snapshot(&connection).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["task"], "Implement the requested feature");
        assert_eq!(saved[0]["stages"][0]["label"], "Plan");
        assert_eq!(saved[0]["stages"][1]["label"], "Verify");
        assert!(saved[0]["finishedAt"].is_null());
    }

    #[test]
    fn a_flow_refuses_an_executor_without_a_cable_and_leaves_no_execution_record() {
        let mut connection = fixture();
        connection
            .execute(
                "INSERT INTO terminals VALUES ('unconnected', 'group', 'agent')",
                [],
            )
            .unwrap();
        assert_eq!(
            super::start(
                &mut connection,
                "group",
                "pipeline",
                "unconnected",
                "User request",
                1000
            ),
            Err("FLOW_EXECUTOR_NOT_CONNECTED".into())
        );
        assert!(super::snapshot(&connection).unwrap().is_empty());
    }

    #[test]
    fn only_live_legacy_flow_owners_reserve_their_executor_while_native_mirrors_are_ignored() {
        let connection = fixture();
        let legacy = json!({"flowId":"legacy","groupId":"group","terminalId":"legacy-agent","finishedAt":null,"stages":[{"label":"Plan","status":"working"}]});
        let mut finished = legacy.clone();
        finished["terminalId"] = json!("finished-agent");
        finished["finishedAt"] = json!(2000);
        let mut mirror = legacy.clone();
        mirror["terminalId"] = json!("native-agent");
        mirror["owner"] = json!("native");
        crate::persistence::db::kv_set(
            &connection,
            "flow.runs",
            &json!([legacy, finished, mirror]).to_string(),
        )
        .unwrap();
        assert_eq!(
            super::legacy_executors(&connection).unwrap(),
            std::collections::HashSet::from(["legacy-agent".to_string()])
        );
    }
}
