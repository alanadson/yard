/**
 * A trigger is "when X happens to a terminal, do Y" — the event-driven twin
 * of a routine (which fires by the clock). Everything that decides whether
 * it fires lives here, pure, because a trigger that fires twice re-sends a
 * prompt into a live agent, and one that never fires is a silent promise
 * broken: neither shows up on screen, only in these tests.
 */
import { describe, expect, it } from "vitest";

import type { TriggerDef } from "./canvas";
import {
  afterFire,
  dueTriggers,
  parseTriggerCreate,
  renderText,
  SELF_ASK_MIN_COOLDOWN_SEC,
  TRIGGER_EVENT_OPTIONS,
  transitions,
  triggerSummary,
} from "./triggers";
import type { TerminalRuntime } from "../stores/terminalsStore";

function rt(patch: Partial<TerminalRuntime> = {}): TerminalRuntime {
  return {
    state: "running",
    pid: 42,
    exit: null,
    error: null,
    unread: false,
    finished: false,
    finishedAt: 0,
    blocked: false,
    blockedAsk: null,
    permission: false,
    rssMb: 0,
    cpu: 0,
    ...patch,
  };
}

function def(patch: Partial<TriggerDef> = {}): TriggerDef {
  return {
    id: "g1",
    sourceId: "a",
    event: "finished",
    action: { kind: "ask", targetId: "b", text: "revise" },
    enabled: true,
    createdAt: 1_000,
    ...patch,
  };
}

describe("transitions", () => {
  it("sees nothing on the first snapshot — a runtime with no past has no edge", () => {
    expect(transitions(undefined, rt({ finished: true, finishedAt: 5 }))).toEqual([]);
  });

  it("fires `finished` on the false→true edge, and not again while it stays true", () => {
    const before = rt();
    const after = rt({ finished: true, finishedAt: 10 });
    expect(transitions(before, after)).toEqual([{ event: "finished", terminalId: "" }]);
    expect(transitions(after, after)).toEqual([]);
  });

  it("a second idle without the flag ever dropping is a new finish — `finishedAt` moved", () => {
    const first = rt({ finished: true, finishedAt: 10 });
    const second = rt({ finished: true, finishedAt: 20 });
    expect(transitions(first, second)).toEqual([{ event: "finished", terminalId: "" }]);
  });

  it("a stop at a question is `blocked`, never `finished` — the two are opposites", () => {
    const before = rt();
    const after = rt({ finished: true, finishedAt: 10, blocked: true, blockedAsk: "Proceed? (y/n)" });
    expect(transitions(before, after)).toEqual([
      { event: "blocked", terminalId: "", ask: "Proceed? (y/n)" },
    ]);
  });

  it("the question clearing on its own is not a finish", () => {
    const blocked = rt({ finished: true, finishedAt: 10, blocked: true, blockedAsk: "y/n" });
    const cleared = rt({ finished: true, finishedAt: 10 });
    expect(transitions(blocked, cleared)).toEqual([]);
  });

  it("fires `exited` only when a process that was live goes down", () => {
    expect(transitions(rt(), rt({ state: "exited", pid: null }))).toEqual([
      { event: "exited", terminalId: "" },
    ]);
    expect(transitions(rt({ state: "starting" }), rt({ state: "error", pid: null }))).toEqual([
      { event: "exited", terminalId: "" },
    ]);
    // A dead terminal found at boot (`gone`) was never live in this session.
    expect(transitions(rt({ state: "idle", pid: null }), rt({ state: "exited", pid: null }))).toEqual([]);
    expect(transitions(rt({ state: "exited", pid: null }), rt({ state: "exited", pid: null }))).toEqual([]);
  });
});

describe("dueTriggers", () => {
  const fire = { event: "finished" as const, terminalId: "a" };

  it("matches the event and the source — or any source with `*`", () => {
    const mine = def();
    const any = def({ id: "g2", sourceId: "*" });
    const other = def({ id: "g3", sourceId: "z" });
    const wrongEvent = def({ id: "g4", event: "blocked" });
    expect(dueTriggers([mine, any, other, wrongEvent], fire, 2_000).map((d) => d.id)).toEqual([
      "g1",
      "g2",
    ]);
  });

  it("skips a paused trigger", () => {
    expect(dueTriggers([def({ enabled: false })], fire, 2_000)).toEqual([]);
  });

  it("respects the cooldown since the last fire", () => {
    const d = def({ cooldownSec: 60, lastRunAt: 10_000 });
    expect(dueTriggers([d], fire, 10_000 + 59_000)).toEqual([]);
    expect(dueTriggers([d], fire, 10_000 + 60_000)).toEqual([d]);
  });

  it("a one-shot that already fired never fires again, even if someone re-enabled it", () => {
    expect(dueTriggers([def({ once: true, lastRunAt: 5 })], fire, 9_000)).toEqual([]);
  });

  /**
   * The loop guard: "when I finish, ask myself" fires, the answer finishes,
   * fires again — forever, one turn of tokens per lap. A floor under the
   * cooldown for that shape keeps it a nudge, not a treadmill.
   */
  it("a trigger that asks its own source cannot fire again within the minimum cooldown", () => {
    const selfAsk = def({ action: { kind: "ask", targetId: "a", text: "go on" }, lastRunAt: 10_000 });
    const tooSoon = 10_000 + (SELF_ASK_MIN_COOLDOWN_SEC - 1) * 1000;
    expect(dueTriggers([selfAsk], fire, tooSoon)).toEqual([]);
    expect(dueTriggers([selfAsk], fire, 10_000 + SELF_ASK_MIN_COOLDOWN_SEC * 1000)).toEqual([selfAsk]);
    // `*` reaches the target too, when the target is the one that fired.
    const anySelf = def({ sourceId: "*", action: { kind: "ask", targetId: "a", text: "x" }, lastRunAt: 10_000 });
    expect(dueTriggers([anySelf], fire, tooSoon)).toEqual([]);
  });
});

describe("renderText", () => {
  it("fills {name} and {ask}, and leaves an absent question empty", () => {
    expect(renderText("{name} parou: {ask}", { name: "Claude", ask: "Proceed? (y/n)" })).toBe(
      "Claude parou: Proceed? (y/n)",
    );
    expect(renderText("{name} terminou {ask}", { name: "Codex" })).toBe("Codex terminou ");
  });
});

describe("afterFire", () => {
  it("stamps the fire and turns a one-shot off", () => {
    expect(afterFire(def(), 7_000)).toMatchObject({ lastRunAt: 7_000, enabled: true });
    expect(afterFire(def({ once: true }), 7_000)).toMatchObject({ lastRunAt: 7_000, enabled: false });
  });
});

describe("triggerSummary", () => {
  const names = (id: string) => ({ a: "Claude", b: "Codex" })[id] ?? "(removida)";
  const flowName = (id: string) => ({ f1: "QA" })[id];

  it("reads as one sentence: when → then", () => {
    expect(triggerSummary(def(), names, flowName)).toBe(
      "Quando Claude terminar → mandar prompt a Codex",
    );
    expect(
      triggerSummary(def({ sourceId: "*", event: "blocked", action: { kind: "notify", text: "x" } }), names, flowName),
    ).toBe("Quando qualquer CLI travar numa pergunta → notificar você");
    expect(
      triggerSummary(def({ event: "exited", action: { kind: "flow", flowId: "f1", text: "t" } }), names, flowName),
    ).toBe("Quando Claude sair → rodar o fluxo QA");
    expect(
      triggerSummary(def({ action: { kind: "flow", flowId: "gone", text: "t" } }), names, flowName),
    ).toBe("Quando Claude terminar → rodar o fluxo (removido)");
  });
});

describe("parseTriggerCreate — the `yard trigger create` line", () => {
  it("builds an ask trigger from --when/--on/--ask and the prompt", () => {
    const r = parseTriggerCreate(
      ["--when", "finished", "--on", "Claude", "--ask", "Codex", "revise o diff"],
      undefined,
    );
    expect(r).toEqual({
      ok: true,
      spec: {
        event: "finished",
        source: "Claude",
        action: { kind: "ask", target: "Codex", text: "revise o diff" },
        once: false,
        cooldownSec: undefined,
      },
    });
  });

  it("`--on any` means every CLI of the group, and the prompt may come from stdin", () => {
    const r = parseTriggerCreate(["--when", "blocked", "--on", "any", "--notify", "--stdin"], "{name}: {ask}");
    expect(r).toEqual({
      ok: true,
      spec: {
        event: "blocked",
        source: "*",
        action: { kind: "notify", text: "{name}: {ask}" },
        once: false,
        cooldownSec: undefined,
      },
    });
  });

  it("a flow action carries the flow name and the task, plus --once and --cooldown", () => {
    const r = parseTriggerCreate(
      ["--when", "exited", "--on", "Claude", "--flow", "QA", "rode a esteira", "--once", "--cooldown", "120"],
      undefined,
    );
    expect(r).toEqual({
      ok: true,
      spec: {
        event: "exited",
        source: "Claude",
        action: { kind: "flow", flow: "QA", text: "rode a esteira" },
        once: true,
        cooldownSec: 120,
      },
    });
  });

  it("refuses an unknown event, a missing source, no action, two actions, or an ask without text", () => {
    const bad = (args: string[]) => parseTriggerCreate(args, undefined);
    expect(bad(["--when", "done", "--on", "A", "--notify", "x"]).ok).toBe(false);
    expect(bad(["--when", "finished", "--notify", "x"]).ok).toBe(false);
    expect(bad(["--when", "finished", "--on", "A"]).ok).toBe(false);
    expect(bad(["--when", "finished", "--on", "A", "--notify", "x", "--ask", "B", "y"]).ok).toBe(false);
    expect(bad(["--when", "finished", "--on", "A", "--ask", "B"]).ok).toBe(false);
    const r = bad(["--when", "finished", "--on", "A"]);
    if (!r.ok) expect(r.usage).toContain("yard trigger create");
  });
});

describe("the budget edge", () => {
  /**
   * Every other edge comes from one terminal's runtime. The budget comes from
   * the day's spend, which belongs to the workspace, so it fires with no
   * source, and only a trigger armed for "qualquer CLI" can be listening.
   * A trigger pinned to one CLI must not fire on it: "quando o claude
   * estourar o orçamento" is not a thing that can happen.
   */
  const budget = (over: Partial<TriggerDef> = {}): TriggerDef => ({
    id: "t1",
    sourceId: "*",
    event: "budget",
    action: { kind: "notify", text: "estourou" },
    enabled: true,
    createdAt: 0,
    ...over,
  });

  it("fires a trigger armed for any CLI", () => {
    const due = dueTriggers([budget()], { event: "budget", terminalId: "" }, 1000);
    expect(due).toHaveLength(1);
  });

  it("does not fire one pinned to a single CLI", () => {
    const due = dueTriggers(
      [budget({ sourceId: "abc" })],
      { event: "budget", terminalId: "" },
      1000,
    );
    expect(due).toHaveLength(0);
  });

  it("is offered in the picker, so it is reachable without the CLI", () => {
    expect(TRIGGER_EVENT_OPTIONS.map((o) => o.value)).toContain("budget");
  });

  it("is accepted by `yard trigger create --when budget`, with no --on to give", () => {
    const parsed = parseTriggerCreate(["--when", "budget", "--notify", "estourou"], undefined);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.source).toBe("*");
  });

  /** A flow runs on the CLI that fired, and this edge fires on nobody. */
  it("refuses a flow action, which would have nowhere to run", () => {
    const parsed = parseTriggerCreate(
      ["--when", "budget", "--flow", "Revisão", "tarefa"],
      undefined,
    );
    expect(parsed.ok).toBe(false);
  });
});
