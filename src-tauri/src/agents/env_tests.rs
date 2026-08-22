//! Probes against the machine's real environment.
//!
//! They do not claim that an agent is installed — that varies by machine and is
//! not a property of the code. What they guarantee is that detection and the
//! parsers **do not break** on real data, and `--nocapture` shows what was found.

use super::{resolver, sessions, tail};

#[test]
#[ignore = "probe of the local machine; run explicitly with cargo test -- --ignored"]
fn agent_detection_does_not_break_and_reports_what_it_found() {
    let found = resolver::detect_all();
    assert!(!found.is_empty(), "the catalog cannot be empty");

    println!("\n--- agent CLIs on this machine ---");
    for a in &found {
        println!(
            "  {:<14} {:<10} {}",
            a.id,
            if a.installed { "OK" } else { "missing" },
            a.version
                .as_deref()
                .unwrap_or(a.bin.as_deref().unwrap_or("-"))
        );
        // Consistency: installed implies a known path.
        assert_eq!(a.installed, a.bin.is_some(), "{} is inconsistent", a.id);
    }
}

#[test]
#[ignore = "probe of the local machine; run explicitly with cargo test -- --ignored"]
fn session_listing_does_not_break_on_real_data() {
    for agent in ["claude", "codex", "opencode"] {
        let all = sessions::list(agent, "");
        println!("\n--- {agent}: {} sessions ---", all.len());
        for s in all.iter().take(3) {
            println!(
                "  {} | {} | {}",
                &s.external_id[..s.external_id.len().min(8)],
                s.title.as_deref().unwrap_or("(untitled)"),
                s.project_path
            );
            assert!(!s.external_id.is_empty(), "session without a resume id");
        }
        // Ordering: newest first.
        for pair in all.windows(2) {
            assert!(
                pair[0].updated_at >= pair[1].updated_at,
                "{agent}: sessions out of order"
            );
        }
    }
}

#[test]
#[ignore = "probe of the local machine; the parsers have deterministic fixtures in tail::tests"]
fn tail_parses_a_whole_real_session() {
    use std::io::BufRead;

    let Some(s) = sessions::list("claude", "")
        .into_iter()
        .find(|s| s.size_bytes > 64 * 1024)
    else {
        println!("no large Claude Code session on this machine — probe skipped");
        return;
    };

    let f = std::fs::File::open(&s.file).expect("a listed session must open");
    let mut cur = tail::Cursor::default();
    let mut events = Vec::new();
    let mut lines = 0usize;
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        lines += 1;
        tail::parse_line(&line, &mut cur, &mut events);
    }

    let count = |k: &str| events.iter().filter(|e| e.kind == k).count();
    let tools = count("tool");
    let usages = count("usage");
    println!(
        "\n--- tail on {} ({} KB) ---\n  {} lines -> {} events | say {} | think {} | tool {} | result {} | usage {} | prompt {}",
        s.external_id,
        s.size_bytes / 1024,
        lines,
        events.len(),
        count("say"),
        count("think"),
        tools,
        count("result"),
        usages,
        count("prompt"),
    );

    assert!(!events.is_empty(), "a real session produces events");
    assert!(tools > 0, "a real working session has tool_use");
    assert!(usages > 0, "a real session has usage");
    // Every tool carries a classification and a correlation id.
    for e in events.iter().filter(|e| e.kind == "tool") {
        assert!(e.op.is_some(), "tool without a classification: {:?}", e.tool);
    }
}

#[test]
#[ignore = "probe of the local machine; run explicitly with cargo test -- --ignored"]
fn usage_of_a_real_session_adds_up_tokens() {
    let Some(s) = sessions::list("claude", "")
        .into_iter()
        .find(|s| s.size_bytes > 4096)
    else {
        println!("no Claude Code session on this machine — probe skipped");
        return;
    };
    let u = sessions::usage(&s.file);
    println!(
        "\n--- usage of {} ---\n  {} events | input {} | output {} | models {:?} | cost {:?}",
        s.external_id, u.messages, u.input_tokens, u.output_tokens, u.models, u.cost_usd
    );
    assert!(u.messages > 0, "a .jsonl over 4 KB has events");
}
