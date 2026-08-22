/**
 * Modo Fluxo — the pure rules the run engine trusts blindly: what travels
 * between stage turns, which wire binds a CLI to a flow card (and in which
 * direction), what a crooked persisted card is allowed to become, and who
 * counts as wired to the pipeline.
 */
import { describe, expect, it } from "vitest";

import {
  buildStagePrompt,
  buildStageStamp,
  CARRY_MARK,
  extractCarry,
  feedTyped,
  findFlow,
  flowAgents,
  flowsOf,
  FLOW_MSG_TAG,
  stageLabelOf,
  wireOfPair,
  type FlowItem,
} from "./flow";
import { connection } from "./canvasOps";
import {
  EMPTY_CANVAS,
  normalizeCanvas,
  type CanvasData,
  type CanvasItem,
} from "./canvas";

function flowItem(id: string, name: string, labels: string[]): FlowItem {
  return {
    id,
    type: "flow",
    x: 0,
    y: 0,
    w: 270,
    h: 160,
    name,
    stages: labels.map((label) => ({ prompt: `faça ${label}`, label })),
    color: "#fff",
  };
}

function canvas(items: CanvasItem[] = []): CanvasData {
  return { ...EMPTY_CANVAS, viewport: { ...EMPTY_CANVAS.viewport }, items };
}

describe("extractCarry", () => {
  it("hands over the final summary when the agent wrote one", () => {
    const out = `muita saída\n${CARRY_MARK}\nfiz X e Y\npronto`;
    expect(extractCarry(out)).toBe(`${CARRY_MARK}\nfiz X e Y\npronto`);
  });

  it("uses the LAST summary — a block from an earlier turn must not win", () => {
    const out = `${CARRY_MARK}\nvelho\n...\n${CARRY_MARK}\nnovo`;
    expect(extractCarry(out)).toBe(`${CARRY_MARK}\nnovo`);
  });

  it("falls back to the tail of the output without a summary", () => {
    expect(extractCarry("  só isso  ")).toBe("só isso");
    const long = "x".repeat(20_000);
    // The cut uses bridgeCore's `tail`, which announces the cut in a short prefix.
    expect(extractCarry(long).length).toBeLessThanOrEqual(8_000 + "…(cortado)…\n".length);
    expect(extractCarry(long)).toContain("cortado");
  });
});

describe("buildStagePrompt", () => {
  const base = {
    flowName: "Entrega",
    index: 1,
    total: 3,
    stageLabel: "TDD",
    stagePrompt: "Escreva os testes.",
    task: "Implementar login",
    carry: "qa: 1. revisado",
    prevLabel: "QA",
    nextLabel: "Confirmador",
  };

  it("carries flow, stage, task, handoff and the summary contract", () => {
    const p = buildStagePrompt(base);
    expect(p).toContain('Fluxo "Entrega" — etapa 2/3: TDD');
    expect(p).toContain("Escreva os testes.");
    expect(p).toContain("## Tarefa\nImplementar login");
    expect(p).toContain("(QA)");
    expect(p).toContain("qa: 1. revisado");
    expect(p).toContain(CARRY_MARK);
    expect(p).toContain("Confirmador");
  });

  it("first stage has no carry section; last stage closes for the user", () => {
    const firstOne = buildStagePrompt({
      ...base,
      index: 0,
      carry: "",
      prevLabel: undefined,
    });
    expect(firstOne).not.toContain("etapa anterior");
    const lastOne = buildStagePrompt({ ...base, index: 2, nextLabel: undefined });
    expect(lastOne).toContain("última etapa");
  });

  it("every stage message opens with the flow tag", () => {
    expect(buildStagePrompt(base).startsWith(FLOW_MSG_TAG)).toBe(true);
  });

  it("stageLabelOf falls back to the position", () => {
    expect(stageLabelOf({ prompt: "p", label: " QA " }, 0)).toBe("QA");
    expect(stageLabelOf({ prompt: "p" }, 2)).toBe("Etapa 3");
  });
});

describe("buildStageStamp", () => {
  const base = { flowName: "Entrega", index: 1, total: 3, stageLabel: "TDD" };

  it("is ONE line pointing at `yard flow stage` — never the letter", () => {
    const s = buildStageStamp(base);
    expect(s.startsWith(FLOW_MSG_TAG)).toBe(true); // startFlow's anti-loop
    expect(s).toContain('"Entrega"');
    expect(s).toContain("etapa 2/3: TDD");
    expect(s).toContain("yard flow stage");
    expect(s).not.toContain("\n");
    expect(s).not.toContain(CARRY_MARK); // the contract lives in the briefing
  });

  it("the typed splice names the request sitting above it", () => {
    const typed = buildStageStamp({ ...base, index: 0, typed: true });
    expect(typed).toContain("pedido acima");
    expect(typed).not.toContain("\n");
    expect(buildStageStamp(base)).not.toContain("pedido acima");
  });
});

describe("feedTyped (Enter interception)", () => {
  const type = (text: string, from = "") =>
    [...text].reduce((b, ch) => feedTyped(b, ch).buf, from);

  it("mirrors plain typing and submits on Enter with text", () => {
    const buf = type("conserte o login");
    expect(buf).toBe("conserte o login");
    expect(feedTyped(buf, "\r")).toEqual({ buf, submit: true });
  });

  it("an empty Enter passes through untouched (menus, y/N)", () => {
    expect(feedTyped("", "\r").submit).toBe(false);
    expect(feedTyped("   ", "\r").submit).toBe(false);
  });

  it("backspace edits; Ctrl+C, Ctrl+U and Tab discard the line", () => {
    expect(feedTyped("abc", "\x7f").buf).toBe("ab");
    expect(feedTyped("abc", "\x03").buf).toBe("");
    expect(feedTyped("abc", "\x15").buf).toBe("");
    expect(feedTyped("abc", "\t").buf).toBe("");
  });

  it("bracketed paste lands literally, newlines included", () => {
    const { buf } = feedTyped("veja: ", "\x1b[200~linha 1\nlinha 2\x1b[201~");
    expect(buf).toBe("veja: linha 1\nlinha 2");
  });

  it("cursor travel makes the mirror unreliable — it resets, never guesses", () => {
    // Left arrow: the next Enter has to go raw to the CLI.
    expect(feedTyped("abc", "\x1b[D").buf).toBe("");
  });
});

describe("wireOfPair", () => {
  it("finds the wire in either direction and reports the reversal", () => {
    const w = connection("fluxo", "cli");
    expect(wireOfPair([w], "fluxo", "cli")).toEqual({ id: w.id, reversed: false });
    expect(wireOfPair([w], "cli", "fluxo")).toEqual({ id: w.id, reversed: true });
    expect(wireOfPair([w], "fluxo", "outra")).toBeNull();
  });
});

describe("flowsOf / findFlow / flowAgents", () => {
  const f = flowItem("abc123", "Entrega Completa", ["QA", "TDD"]);
  const c = canvas([f, connection("abc123", "t1"), connection("t2", "abc123")]);
  const terminals = [
    { id: "t1", kind: "agent" },
    { id: "t2", kind: "shell" },
    { id: "t3", kind: "agent" },
  ];

  it("lists only flow items and matches by id, then name ignoring case", () => {
    expect(flowsOf(c).map((x) => x.id)).toEqual(["abc123"]);
    expect(findFlow(c, "abc123")?.name).toBe("Entrega Completa");
    expect(findFlow(c, "entrega completa")?.id).toBe("abc123");
    expect(findFlow(c, "outra")).toBeUndefined();
    expect(findFlow(undefined, "x")).toBeUndefined();
  });

  it("flowAgents: wired AND agent — a shell on a cable is not an executor", () => {
    expect(flowAgents(c, "abc123", terminals).map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("flow item through the persisted JSON", () => {
  it("round-trips intact", () => {
    const data = canvas([flowItem("f1", "Entrega", ["QA"])]);
    const back = normalizeCanvas(JSON.parse(JSON.stringify(data)));
    expect(back?.items).toEqual(data.items);
  });

  it("sanitizes junk without poisoning the canvas", () => {
    const raw = {
      ...EMPTY_CANVAS,
      items: [
        {
          id: "ok",
          type: "flow",
          x: 0,
          y: 0,
          w: 30,
          h: 10,
          color: "#fff",
          name: "  Esteira  ",
          stages: [{ prompt: "p", label: 7 }, null, { label: "só rótulo" }],
        },
        { id: "semnome", type: "flow", x: 0, y: 0, w: 270, h: 160, color: "#fff", stages: [] },
      ],
    };
    const back = normalizeCanvas(raw);
    const flows = flowsOf(back);
    // The second fails validation (name is not a string); the first is trimmed.
    expect(flows).toHaveLength(1);
    expect(flows[0].name).toBe("Esteira");
    expect(flows[0].w).toBeGreaterThanOrEqual(220);
    expect(flows[0].stages).toEqual([
      { prompt: "p" },
      { prompt: "", label: "só rótulo" },
    ]);
  });
});
