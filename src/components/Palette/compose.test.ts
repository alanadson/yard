/**
 * The Busca keeps each domain's rows until one of the inputs that domain
 * reads moves. Getting this wrong fails in two quiet ways: a cell that
 * rebuilds too eagerly throws away the whole point (six thousand file rows
 * per feed tick), and a cell that keeps too long shows a row that no longer
 * matches the workspace, with nothing on screen saying it is stale.
 */
import { describe, expect, it } from "vitest";

import { createComposer, Reuse } from "./compose";

interface World {
  a: string[];
  b: string[];
  tick: number;
}

describe("createComposer", () => {
  it("hands back a domain's rows while its inputs are the same objects, and rebuilds it when one moves", () => {
    let builtA = 0;
    let builtB = 0;
    const compose = createComposer<World, string>([
      { inputs: (w) => [w.a], rows: (w) => (builtA++, w.a.map((x) => `a:${x}`)) },
      { inputs: (w) => [w.b], rows: (w) => (builtB++, w.b.map((x) => `b:${x}`)) },
    ]);
    const a = ["1"];
    const b = ["2"];

    expect(compose({ a, b, tick: 0 })).toEqual(["a:1", "b:2"]);
    expect(compose({ a, b: ["3"], tick: 1 })).toEqual(["a:1", "b:3"]);

    expect(builtA).toBe(1);
    expect(builtB).toBe(2);
  });

  it("rebuilds a domain with no inputs on every compose: its rows read something the world does not carry", () => {
    let outside = "x";
    const compose = createComposer<World, string>([
      { inputs: (w) => [w.a], rows: (w) => w.a },
      { inputs: null, rows: () => [outside] },
    ]);
    const a = ["1"];

    expect(compose({ a, b: [], tick: 0 })).toEqual(["1", "x"]);
    outside = "y";
    expect(compose({ a, b: [], tick: 1 })).toEqual(["1", "y"]);
  });
});

describe("Reuse", () => {
  it("hands back the row the last build kept under a key, and lets go of the ones it was not asked for", () => {
    const rows = new Reuse<{ key: string }>();
    const build = (keys: string[]) => {
      const out = keys.map((key) => rows.take(key) ?? rows.keep(key, { key }));
      rows.settle();
      return out;
    };

    const [a1, b1] = build(["a", "b"]);
    const [a2] = build(["a"]);
    const [a3, b3] = build(["a", "b"]);

    expect(a2).toBe(a1);
    expect(a3).toBe(a1);
    // "b" sat out one build: it was let go, so the memory held is only ever
    // what the last list showed.
    expect(b3).not.toBe(b1);
    expect(b3).toEqual({ key: "b" });
  });
});
