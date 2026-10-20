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
  ASK_DAILY_CAP,
  defaultCooldownSec,
  dueTriggers,
  parseTriggerCreate,
  renderText,
  SELF_ASK_MIN_COOLDOWN_SEC,
  TRIGGER_EVENT_OPTIONS,
  transitions,
  toggledTrigger,
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

  /** One lap of "ask myself" is one paid turn: ten minutes is the floor between two. */
  it("a trigger that asks its own source waits ten minutes between laps", () => {
    const selfAsk = def({ action: { kind: "ask", targetId: "a", text: "go on" }, lastRunAt: 10_000 });
    expect(dueTriggers([selfAsk], fire, 10_000 + 599_000)).toEqual([]);
    expect(dueTriggers([selfAsk], fire, 10_000 + 600_000)).toEqual([selfAsk]);
  });

  /**
   * The regression: "when any CLI finishes, ask Codex to review" also heard
   * Codex's own finish, so Codex reviewed its own review, forever. A wildcard
   * never feeds a target the edge that target fired.
   */
  it("a wildcard ask ignores the edge fired by its own target", () => {
    const review = def({ sourceId: "*", action: { kind: "ask", targetId: "a", text: "revise" } });
    expect(dueTriggers([review], { event: "finished", terminalId: "a" }, 2_000)).toEqual([]);
    expect(dueTriggers([review], { event: "finished", terminalId: "b" }, 2_000)).toEqual([review]);
  });
});

/**
 * The loops nobody drew on purpose. "A finished → ask B" and "B finished →
 * ask A" are each a sensible nudge, and together a ping-pong that bills one
 * turn per lap until someone notices. A trigger that sits in such a loop
 * waits at least five minutes between fires, whatever cooldown it was given.
 */
describe("trigger loops", () => {
  const ask = (id: string, sourceId: string, targetId: string, patch: Partial<TriggerDef> = {}) =>
    def({ id, sourceId, action: { kind: "ask", targetId, text: "x" }, ...patch });

  it("two CLIs asking each other on finish fire at most every five minutes", () => {
    const aToB = ask("g1", "a", "b", { lastRunAt: 10_000 });
    const bToA = ask("g2", "b", "a");
    const fromA = { event: "finished" as const, terminalId: "a" };
    expect(dueTriggers([aToB, bToA], fromA, 10_000 + 299_000)).toEqual([]);
    expect(dueTriggers([aToB, bToA], fromA, 10_000 + 300_000)).toEqual([aToB]);
  });

  it("a wildcard that closes the loop counts as part of it", () => {
    const anyToA = ask("g1", "*", "a");
    const aToC = ask("g2", "a", "c", { lastRunAt: 10_000 });
    const fromA = { event: "finished" as const, terminalId: "a" };
    expect(dueTriggers([anyToA, aToC], fromA, 10_000 + 60_000)).toEqual([]);
  });

  it("a chain with no way back keeps the cooldown it was given", () => {
    const aToB = ask("g1", "a", "b", { lastRunAt: 10_000 });
    const bToC = ask("g2", "b", "c");
    const fromA = { event: "finished" as const, terminalId: "a" };
    expect(dueTriggers([aToB, bToC], fromA, 10_000 + 1_000)).toEqual([aToB]);
  });

  it("a paused trigger does not close a loop: it cannot fire", () => {
    const aToB = ask("g1", "a", "b", { lastRunAt: 10_000 });
    const bToA = ask("g2", "b", "a", { enabled: false });
    const fromA = { event: "finished" as const, terminalId: "a" };
    expect(dueTriggers([aToB, bToA], fromA, 10_000 + 1_000)).toEqual([aToB]);
  });
});

/**
 * A per-day ceiling on what one `ask` trigger may spend: even a well-spaced
 * nudge is fifty paid turns by the end of the day, and that is where it
 * stops until the next local day.
 */
describe("the cooldown the form starts with", () => {
  /** A prompt into a CLI is a paid turn; a notification and a flow start from zero as before. */
  it("is five minutes for an ask and nothing for the other actions", () => {
    expect(defaultCooldownSec("ask")).toBe(300);
    expect(defaultCooldownSec("notify")).toBe(0);
    expect(defaultCooldownSec("flow")).toBe(0);
  });
});

describe("the daily cap of an ask trigger", () => {
  const morning = new Date(2026, 9, 19, 9, 0).getTime();
  const evening = new Date(2026, 9, 19, 21, 0).getTime();
  const nextDay = new Date(2026, 9, 20, 9, 0).getTime();
  const fire = { event: "finished" as const, terminalId: "a" };

  it("stops firing after fifty fires in the same local day", () => {
    const spent = def({ lastRunAt: morning, firedDay: "2026-10-19", firedToday: ASK_DAILY_CAP });
    const almost = def({ lastRunAt: morning, firedDay: "2026-10-19", firedToday: ASK_DAILY_CAP - 1 });
    expect(ASK_DAILY_CAP).toBe(50);
    expect(dueTriggers([spent], fire, evening)).toEqual([]);
    expect(dueTriggers([almost], fire, evening)).toEqual([almost]);
  });

  it("starts over on the next local day", () => {
    const spent = def({ lastRunAt: evening, firedDay: "2026-10-19", firedToday: ASK_DAILY_CAP });
    expect(dueTriggers([spent], fire, nextDay)).toEqual([spent]);
  });

  it("afterFire counts the fires of the day and restarts the count on a new day", () => {
    const first = afterFire(def(), morning);
    expect(first).toMatchObject({ firedDay: "2026-10-19", firedToday: 1 });
    expect(afterFire(first, evening)).toMatchObject({ firedDay: "2026-10-19", firedToday: 2 });
    expect(afterFire(afterFire(first, evening), nextDay)).toMatchObject({ firedDay: "2026-10-20", firedToday: 1 });
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

/**
 * A trigger an agent created waits switched off until the user turns it on
 * (`awaitingApproval`). Turning it on in the sheet *is* the approval, so the
 * flag goes with it; turning it off again does not bring the flag back.
 */
describe("toggledTrigger", () => {
  it("switching on approves a trigger an agent created", () => {
    const pending = def({ enabled: false, awaitingApproval: true });
    const on = toggledTrigger(pending);
    expect(on.enabled).toBe(true);
    expect(on.awaitingApproval).toBeUndefined();
    expect(toggledTrigger(on)).toMatchObject({ enabled: false });
    expect(toggledTrigger(on).awaitingApproval).toBeUndefined();
  });
});
