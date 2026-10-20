/**
 * Agents asking agents is where a workspace burns money without anyone
 * typing: A asks B, B asks C to check, C asks A for context, and every hop is
 * a paid turn that starts another. Each prompt `yard ask` injects carries
 * how deep in such a chain it is, and two limits hold the chain short: three
 * hops, and six asks per pair in ten minutes. The clock is a parameter.
 */
import { describe, expect, it } from "vitest";

import { askStamp, emptyLedger, planAsk, recordAsk, type HopLedger } from "./askHops";

const MIN = 60_000;

/** Plans and records one ask, failing the test if it was refused. */
function ask(ledger: HopLedger, from: string, to: string, now: number): HopLedger {
  const plan = planAsk(ledger, from, to, now);
  if (!plan.ok) throw new Error(plan.message);
  return recordAsk(ledger, from, to, plan.hop, now);
}

describe("planAsk", () => {
  it("starts a chain at hop 1", () => {
    expect(planAsk(emptyLedger(), "A", "B", 0)).toEqual({ ok: true, hop: 1 });
  });

  it("passes the hop on: what A asked B is hop 1, what B then asks C is hop 2", () => {
    const ledger = ask(emptyLedger(), "A", "B", 0);
    expect(planAsk(ledger, "B", "C", MIN)).toEqual({ ok: true, hop: 2 });
  });

  it("starts over when the caller's last stamped prompt is older than thirty minutes", () => {
    const ledger = ask(emptyLedger(), "A", "B", 0);
    expect(planAsk(ledger, "B", "C", 31 * MIN)).toEqual({ ok: true, hop: 1 });
  });

  it("refuses a fourth hop", () => {
    let ledger = ask(emptyLedger(), "A", "B", 0);
    ledger = ask(ledger, "B", "C", MIN);
    ledger = ask(ledger, "C", "D", 2 * MIN);
    const fourth = planAsk(ledger, "D", "E", 3 * MIN);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.message).toContain("salto");
  });

  it("refuses the seventh ask between the same pair within ten minutes, in either direction", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 6; i++) ledger = ask(ledger, "A", "B", i * MIN);
    expect(planAsk(ledger, "A", "B", 6 * MIN).ok).toBe(false);
    const back = planAsk(ledger, "B", "A", 6 * MIN);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.message).toContain("10 min");
    expect(planAsk(ledger, "A", "C", 6 * MIN).ok).toBe(true);
  });

  it("lets the pair talk again once the window has moved past the old asks", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 6; i++) ledger = ask(ledger, "A", "B", i * MIN);
    expect(planAsk(ledger, "A", "B", 10 * MIN).ok).toBe(true);
  });
});

describe("askStamp", () => {
  it("names the caller and the hop on one line", () => {
    expect(askStamp("Claude", 2)).toBe('[Yard · de "Claude" · salto 2]');
  });
});
