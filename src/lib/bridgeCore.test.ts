/**
 * The rules the `yard` CLI promises to agents. They are a contract, not
 * a detail: changing name dedup or note reach breaks agent scripts that
 * are already written, and that has to show up here before it shows up in
 * production.
 */
import { describe, expect, it } from "vitest";

import {
  connectedAgents,
  connectedNotes,
  connectedPortals,
  decodeEscapes,
  findAgent,
  findAny,
  findMentions,
  findPortal,
  makeCtx,
  stripAnsi,
  uniqueNames,
} from "./bridgeCore";
import { EMPTY_CANVAS, noteName, type CanvasData, type CanvasItem } from "./canvas";
import { hostnameOf, normalizePortalUrl, uniquePortalNames } from "./portals";
import type { TerminalRow } from "./ipc";

let relogio = 1_000;

function term(id: string, title: string | null, program = "claude.cmd"): TerminalRow {
  return {
    id,
    groupId: "g1",
    slot: 0,
    title,
    kind: "agent",
    agentId: "claude",
    program,
    args: [],
    cwd: "C:/proj",
    resume: null,
    sort: 0,
    alive: true,
    createdAt: relogio++,
  };
}

function note(id: string, text: string, extra: Partial<Extract<CanvasItem, { type: "note" }>> = {}) {
  return {
    id,
    type: "note" as const,
    x: 0,
    y: 0,
    w: 200,
    h: 150,
    text,
    color: "#f5f5f5",
    ...extra,
  };
}

function portal(
  id: string,
  url: string,
  extra: Partial<Extract<CanvasItem, { type: "portal" }>> = {},
): Extract<CanvasItem, { type: "portal" }> {
  return {
    id,
    type: "portal",
    x: 0,
    y: 0,
    w: 720,
    h: 480,
    url,
    color: "#f5f5f5",
    ...extra,
  };
}

function conn(from: string, to: string): CanvasItem {
  return { id: `c-${from}-${to}`, type: "connection", from, to, color: "#6b6b6b" };
}

function canvasWith(items: CanvasItem[]): CanvasData {
  return { ...EMPTY_CANVAS, viewport: { ...EMPTY_CANVAS.viewport }, items };
}

describe("nomes de enderecamento", () => {
  it("desempata duplicatas na ordem de criacao", () => {
    const a = term("t1", "claude");
    const b = term("t2", "claude");
    const c = term("t3", "claude");
    const names = uniqueNames([c, a, b]); // out of order on purpose
    expect(names.get("t1")).toBe("claude");
    expect(names.get("t2")).toBe("claude (2)");
    expect(names.get("t3")).toBe("claude (3)");
  });

  it("cai para o executavel quando o terminal nao tem titulo", () => {
    const names = uniqueNames([term("t1", null, "C:/tools/codex.cmd")]);
    expect(names.get("t1")).toBe("codex.cmd");
  });

  it("ignora caixa ao comparar", () => {
    const names = uniqueNames([term("t1", "Claude"), term("t2", "claude")]);
    expect(names.get("t2")).toBe("claude (2)");
  });
});

describe("portao das conexoes", () => {
  it("so enxerga agentes com conexao direta", () => {
    const [a, b, c] = [term("t1", "a"), term("t2", "b"), term("t3", "c")];
    // a—b, b—c: for "a", "c" is two hops away and does not count.
    const ctx = makeCtx(a, "g1", canvasWith([conn("t1", "t2"), conn("t2", "t3")]), [a, b, c]);
    expect(connectedAgents(ctx).map((t) => t.id)).toEqual(["t2"]);
    expect(findAgent(ctx, "c")).toBeNull();
    expect(findAgent(ctx, "b")?.id).toBe("t2");
  });

  it("sem conexao nenhuma, ninguem e alcancavel", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const ctx = makeCtx(a, "g1", canvasWith([]), [a, b]);
    expect(connectedAgents(ctx)).toHaveLength(0);
    expect(findAgent(ctx, "b")).toBeNull();
  });

  it("`connect` acha qualquer um do grupo, mesmo desconectado", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const ctx = makeCtx(a, "g1", canvasWith([]), [a, b]);
    expect(findAny(ctx, "b")).toEqual({ kind: "terminal", id: "t2" });
  });
});

describe("corrente de notas", () => {
  it("alcanca notas ligadas a outras notas", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "primeira"),
      note("n2", "segunda"),
      note("n3", "terceira"),
      conn("t1", "n1"),
      conn("n1", "n2"),
      conn("n2", "n3"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(connectedNotes(ctx).map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("nao atravessa um agente para chegar nas notas dele", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const canvas = canvasWith([
      note("n1", "minha"),
      note("n2", "dele"),
      conn("t1", "n1"),
      conn("t1", "t2"),
      conn("t2", "n2"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a, b]);
    expect(connectedNotes(ctx).map((n) => n.id)).toEqual(["n1"]);
  });

  it("nao entra em laco quando as notas se ligam em ciclo", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "um"),
      note("n2", "dois"),
      conn("t1", "n1"),
      conn("n1", "n2"),
      conn("n2", "n1"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(connectedNotes(ctx)).toHaveLength(2);
  });
});

describe("nome da nota", () => {
  it("deriva da primeira linha e ignora o # do titulo", () => {
    expect(noteName(note("n1", "# Plano de ataque\nlinha 2"))).toBe("Plano de ataque");
  });

  it("o nome fixado vence a primeira linha", () => {
    expect(noteName(note("n1", "# Plano", { name: "briefing" }))).toBe("briefing");
  });

  it("renomeia sozinha quando a primeira linha muda", () => {
    const antes = note("n1", "rascunho");
    const depois = { ...antes, text: "# Resultado final\ndetalhes" };
    expect(noteName(antes)).not.toBe(noteName(depois));
    expect(noteName(depois)).toBe("Resultado final");
  });

  it("duas notas com o mesmo titulo ganham sufixo", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "tarefas"),
      note("n2", "tarefas"),
      conn("t1", "n1"),
      conn("t1", "n2"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(ctx.noteNameOf.get("n2")).toBe("tarefas (2)");
  });
});

describe("portais no canvas", () => {
  it("nome padrao e o hostname; --name vence", () => {
    expect(hostnameOf("https://www.example.com/app")).toBe("example.com");
    expect(uniquePortalNames([portal("p1", "https://localhost:5173", { name: "App" })]).get("p1")).toBe(
      "App",
    );
  });

  it("desempata dois portais no mesmo host", () => {
    const names = uniquePortalNames([
      portal("p1", "https://example.com/a"),
      portal("p2", "https://example.com/b"),
    ]);
    expect(names.get("p1")).toBe("example.com");
    expect(names.get("p2")).toBe("example.com (2)");
  });

  it("alcanca portal ligado direto e atraves de nota", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "brief"),
      portal("p1", "https://app.local"),
      portal("p2", "https://other.local"),
      conn("t1", "n1"),
      conn("n1", "p1"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(connectedPortals(ctx).map((p) => p.id)).toEqual(["p1"]);
    expect(findPortal(ctx, "app.local")?.id).toBe("p1");
    expect(findPortal(ctx, "other.local")).toBeNull();
  });

  it("nao atravessa outro agente para chegar no portal dele", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const canvas = canvasWith([
      portal("p1", "https://a.local"),
      portal("p2", "https://b.local"),
      conn("t1", "p1"),
      conn("t1", "t2"),
      conn("t2", "p2"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a, b]);
    expect(connectedPortals(ctx).map((p) => p.id)).toEqual(["p1"]);
  });

  it("`connect` acha portal pelo hostname", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([portal("p1", "https://docs.dev")]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(findAny(ctx, "docs.dev")).toEqual({ kind: "portal", id: "p1" });
  });

  it("normaliza URL sem esquema", () => {
    expect(normalizePortalUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizePortalUrl("example.com")).toBe("https://example.com");
  });
});

describe("saida de terminal", () => {
  it("limpa escapes ANSI e OSC", () => {
    const bruto = "\x1b]0;titulo\x07\x1b[32mok\x1b[0m\r\nfim";
    expect(stripAnsi(bruto)).toBe("ok\nfim");
  });

  it("colapsa linhas em branco em excesso", () => {
    expect(stripAnsi("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("decodifica escapes do --raw", () => {
    expect(decodeEscapes("2\\n")).toBe("2\r");
    expect(decodeEscapes("\\e[A")).toBe("\x1b[A");
    expect(decodeEscapes("\\x41")).toBe("A");
  });
});

describe("mencoes @", () => {
  it("casa o nome mais longo primeiro", () => {
    expect(findMentions("pergunte ao @claude (2) agora", ["claude", "claude (2)"])).toEqual([
      "claude (2)",
    ]);
  });

  it("ignora @ no meio de palavra (e-mail)", () => {
    expect(findMentions("mande para alan@claude.com", ["claude"])).toEqual([]);
  });

  it("acha varias mencoes", () => {
    expect(findMentions("@ana e @beto revisem", ["ana", "beto"]).sort()).toEqual([
      "ana",
      "beto",
    ]);
  });
});
