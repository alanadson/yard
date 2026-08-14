//! Probes against the machine's real environment.
//!
//! They do not claim that an agent is installed — that varies by machine and is
//! not a property of the code. What they guarantee is that detection and the
//! parsers **do not break** on real data, and `--nocapture` shows what was found.

use super::{resolver, sessions, tail};

#[test]
fn deteccao_de_agentes_nao_quebra_e_reporta_o_que_achou() {
    let found = resolver::detect_all();
    assert!(!found.is_empty(), "o catalogo nao pode estar vazio");

    println!("\n--- CLIs de agente nesta maquina ---");
    for a in &found {
        println!(
            "  {:<14} {:<10} {}",
            a.id,
            if a.installed { "OK" } else { "ausente" },
            a.version.as_deref().unwrap_or(a.bin.as_deref().unwrap_or("-"))
        );
        // Consistency: installed implies a known path.
        assert_eq!(a.installed, a.bin.is_some(), "{} inconsistente", a.id);
    }
}

#[test]
fn listagem_de_sessoes_nao_quebra_com_dados_reais() {
    for agent in ["claude", "codex", "opencode"] {
        let todas = sessions::list(agent, "");
        println!("\n--- {agent}: {} sessoes ---", todas.len());
        for s in todas.iter().take(3) {
            println!(
                "  {} | {} | {}",
                &s.external_id[..s.external_id.len().min(8)],
                s.title.as_deref().unwrap_or("(sem titulo)"),
                s.project_path
            );
            assert!(!s.external_id.is_empty(), "sessao sem id de retomada");
        }
        // Ordering: newest first.
        for par in todas.windows(2) {
            assert!(
                par[0].updated_at >= par[1].updated_at,
                "{agent}: sessoes fora de ordem"
            );
        }
    }
}

#[test]
fn grampo_parseia_uma_sessao_real_inteira() {
    use std::io::BufRead;

    let Some(s) = sessions::list("claude", "")
        .into_iter()
        .find(|s| s.size_bytes > 64 * 1024)
    else {
        println!("nenhuma sessao grande do Claude Code nesta maquina — sonda pulada");
        return;
    };

    let f = std::fs::File::open(&s.file).expect("sessao listada precisa abrir");
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
        "\n--- grampo em {} ({} KB) ---\n  {} linhas -> {} eventos | say {} | think {} | tool {} | result {} | usage {} | prompt {}",
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

    assert!(!events.is_empty(), "uma sessao real gera eventos");
    assert!(tools > 0, "uma sessao real de trabalho tem tool_use");
    assert!(usages > 0, "uma sessao real tem usage");
    // Todo tool carrega classificacao e id de correlacao.
    for e in events.iter().filter(|e| e.kind == "tool") {
        assert!(e.op.is_some(), "tool sem classificacao: {:?}", e.tool);
    }
}

#[test]
fn uso_de_uma_sessao_real_soma_tokens() {
    let Some(s) = sessions::list("claude", "").into_iter().find(|s| s.size_bytes > 4096)
    else {
        println!("nenhuma sessao do Claude Code nesta maquina — sonda pulada");
        return;
    };
    let u = sessions::usage(&s.file);
    println!(
        "\n--- uso de {} ---\n  {} eventos | entrada {} | saida {} | modelos {:?} | custo {:?}",
        s.external_id, u.messages, u.input_tokens, u.output_tokens, u.models, u.cost_usd
    );
    assert!(u.messages > 0, "um .jsonl com mais de 4 KB tem eventos");
}
