//! Assigned task requests remain available through the authenticated CLI without a page.
use serde_json::{json, Value};

fn reply(code: i32, output: String) -> Value { json!({"code":code,"output":output}) }

pub fn handle(connection: &mut rusqlite::Connection, request: &Value, now: i64) -> Option<Value> {
    let args = request["argv"].as_array()?;
    if args.first()?.as_str()? != "task" { return None; }
    let usage = || reply(1, "Usage: yard task show ID | yard task history ID | yard task link ID --stdin | yard task submit ID --attempt ATTEMPT_ID --stdin | --file FILE\n".into());
    let verb = args.get(1).and_then(Value::as_str).unwrap_or("");
    if !matches!(verb, "show" | "history" | "submit" | "link") { return Some(usage()); }
    let Some(id) = args.get(2).and_then(Value::as_str) else { return Some(usage()); };
    let task = match crate::work::get(connection, id) {
        Ok(task) => task,
        Err(error) => return Some(reply(1, format!("yard task: {}\n", error.message))),
    };
    if !request["terminal"].as_str().is_some_and(|terminal| task.links.terminal_ids.iter().any(|assigned| assigned == terminal)) {
        return Some(reply(1, "This task is not assigned to this terminal.\n".into()));
    }
    if verb == "history" {
        return Some(match crate::work::deliveries(connection, id) {
            Ok(records) => reply(0, format!("{}\n", serde_json::to_string_pretty(&records).unwrap())),
            Err(error) => reply(1, format!("yard task: {}\n", error.message)),
        });
    }
    if verb == "link" {
        if task.links.executor_terminal_id.as_deref() != request["terminal"].as_str() { return Some(reply(1, "Only the current executor can link task evidence.\n".into())); }
        if !args.iter().any(|arg| arg == "--stdin" || arg == "--file") { return Some(usage()); }
        let resource = request["stdin"].as_str().ok_or_else(|| "A resource JSON document is required".to_string())
            .and_then(|body| serde_json::from_str::<crate::work::TaskResource>(body).map_err(|error| error.to_string()));
        return Some(match resource.and_then(|resource| crate::work::link(connection, id, task.revision, resource, now).map_err(|error| error.to_string())) {
            Ok(linked) => reply(0, format!("{}\n", serde_json::to_string_pretty(&linked).unwrap())),
            Err(error) => reply(1, format!("yard task: {error}\n")),
        });
    }
    if verb == "submit" {
        let terminal = request["terminal"].as_str().unwrap();
        if task.links.executor_terminal_id.as_deref().is_some_and(|executor| executor != terminal) {
            return Some(reply(1, "Only the current executor can submit a delivery for this task.\n".into()));
        }
        let (mut from_stdin, mut attempt) = (false, None);
        let mut index = 3;
        while index < args.len() {
            match args[index].as_str().unwrap_or("") {
                "--" => break,
                "--stdin" | "--file" => from_stdin = true,
                "--attempt" => {
                    if let Some(value) = args.get(index + 1).and_then(Value::as_str).filter(|value| !matches!(*value, "--stdin" | "--file" | "--attempt" | "--")) {
                        attempt = Some(value.to_string());
                        index += 1;
                    }
                }
                _ => {},
            }
            index += 1;
        }
        let body = request["stdin"].as_str().filter(|body| !body.trim().is_empty());
        if !from_stdin || body.is_none() {
            return Some(reply(1, "A delivery JSON document is required through --stdin or --file.\n".into()));
        }
        let mut submission: crate::work::Submission = match serde_json::from_str(body.unwrap()) {
            Ok(document) => document,
            Err(error) => return Some(reply(1, format!("yard task: {error}\n"))),
        };
        if attempt.is_some() { submission.attempt_id = attempt; }
        return Some(match crate::work::submit(connection, &task.id, task.revision, submission, now) {
            Ok(submitted) => reply(0, format!("{}\n", serde_json::to_string_pretty(&submitted).unwrap())),
            Err(error) => reply(1, format!("yard task: {}\n", error.message)),
        });
    }
    Some(reply(0, format!("{}\n", serde_json::to_string_pretty(&task).unwrap())))
}

#[cfg(test)]
mod tests {
    // Native task commands must retain assignment boundaries when no page is available.
    use super::*;
    use serde_json::json;

    #[test]
    fn the_current_executor_can_record_a_pull_request_for_task_review() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::work::init(&connection).unwrap();
        crate::work::create(&mut connection, crate::work::NewTask { id: "task".into(), title: "Review work".into(), request: "Keep the evidence".into(), criteria: vec![],
            links: crate::work::TaskLinks { terminal_ids: vec!["executor".into()], executor_terminal_id: Some("executor".into()), ..Default::default() } }, 1000).unwrap();
        let response = handle(&mut connection, &json!({"terminal":"executor","argv":["task","link","task","--stdin"],"stdin":json!({"kind":"pull_request","id":"https://github.com/owner/repo/pull/12","root":null,"label":"Review PR"}).to_string()}), 2000).unwrap();
        assert_eq!(response["code"], 0);
        assert_eq!(crate::work::get(&connection, "task").unwrap().links.resources[0].kind, "pull_request");
    }

    #[test]
    fn only_an_assigned_terminal_can_read_a_native_task_request() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::work::init(&connection).unwrap();
        crate::work::create(&mut connection, crate::work::NewTask { id: "task".into(), title: "Native work".into(), request: "Original private request".into(),
            criteria: vec!["Keep the original request".into()], links: crate::work::TaskLinks { terminal_ids: vec!["executor".into()], ..Default::default() } }, 1000).unwrap();
        let own = handle(&mut connection, &json!({"terminal":"executor","argv":["task","show","task"]}), 2000).unwrap();
        assert_eq!(own["code"], 0);
        let shown: serde_json::Value = serde_json::from_str(own["output"].as_str().unwrap()).unwrap();
        assert_eq!(shown["request"], "Original private request");
        let denied = handle(&mut connection, &json!({"terminal":"outsider","argv":["task","show","task"]}), 2000).unwrap();
        assert_eq!(denied["code"], 1);
        assert!(!denied["output"].as_str().unwrap().contains("Original private request"));
    }

    #[test]
    fn an_assigned_terminal_can_read_immutable_reports_through_the_native_cli() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "task".into(), title: "Native work".into(), request: "Read the previous report".into(),
            criteria: vec![], links: crate::work::TaskLinks { terminal_ids: vec!["executor".into()], ..Default::default() } }, 1000).unwrap();
        let queued = crate::work::transition(&mut connection, &task.id, task.revision, "queued", 2000).unwrap();
        let running = crate::work::transition(&mut connection, &task.id, queued.revision, "running", 2100).unwrap();
        crate::work::submit(&mut connection, &task.id, running.revision, crate::work::Submission { attempt_id: None,
            delivery: crate::work::Delivery { summary: "Previous evidence".into(), artifacts: vec!["proof.txt".into()], checks: vec![] }, evidence: Default::default() }, 2200).unwrap();
        let response = handle(&mut connection, &json!({"terminal":"executor","argv":["task","history","task"]}), 3000).unwrap();
        assert_eq!(response["code"], 0);
        let records: serde_json::Value = serde_json::from_str(response["output"].as_str().unwrap()).unwrap();
        assert_eq!(records[0]["delivery"]["summary"], "Previous evidence");
        assert_eq!(crate::work::deliveries(&connection, "task").unwrap().len(), 1);
    }

    #[test]
    fn native_submission_requires_the_current_executor_and_exact_attempt_and_waits_for_review() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::work::init(&connection).unwrap();
        let task = crate::work::create(&mut connection, crate::work::NewTask { id: "task".into(), title: "Native work".into(), request: "Submit current evidence".into(),
            criteria: vec![], links: crate::work::TaskLinks { terminal_ids: vec!["former".into(), "executor".into()],
                executor_terminal_id: Some("executor".into()), queue_item_id: Some("current-attempt".into()), ..Default::default() } }, 1000).unwrap();
        let queued = crate::work::transition(&mut connection, &task.id, task.revision, "queued", 2000).unwrap();
        crate::work::transition(&mut connection, &task.id, queued.revision, "running", 2100).unwrap();
        let body = json!({"delivery":{"summary":"Current evidence","artifacts":["proof.txt"],"checks":[]},"evidence":{}}).to_string();
        let request = |terminal: &str, attempt: &str| json!({"terminal":terminal,"argv":["task","submit","task","--attempt",attempt,"--stdin"],"stdin":body});
        let former = handle(&mut connection, &request("former", "current-attempt"), 3000).unwrap();
        assert_eq!(former["code"], 1);
        let stale = handle(&mut connection, &request("executor", "old-attempt"), 3000).unwrap();
        assert_eq!(stale["code"], 1);
        assert_eq!(crate::work::get(&connection, "task").unwrap().status, "running");
        let response = handle(&mut connection, &request("executor", "current-attempt"), 3000).unwrap();
        assert_eq!(response["code"], 0);
        assert_eq!(crate::work::get(&connection, "task").unwrap().status, "in_review");
        assert_eq!(crate::work::deliveries(&connection, "task").unwrap().len(), 1);
    }
}
