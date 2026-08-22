/**
 * `normalizeCanvas` is the front door of everything that was persisted: a
 * field it does not copy is a field wiped on the next autosave. These tests
 * exist exactly to catch that kind of silent loss.
 */
import { describe, expect, it } from "vitest";

import {
  connectionGeometry,
  NODE_FONT_MAX,
  normalizeCanvas,
  NOTE_FONT_MAX,
  reconcileItems,
  reconcileNodes,
  resizeRect,
  routineDue,
  routineNextAt,
  stepFont,
  TEXT_FONT_DEFAULT,
  TEXT_FONT_MAX,
  type CanvasItem,
  type CanvasNode,
  type RoutineDef,
} from "./canvas";

const MIN = 60_000;

function routine(patch: Partial<RoutineDef> = {}): RoutineDef {
  return {
    id: "r1",
    terminalId: "t1",
    text: "rode os testes",
    everyMin: 30,
    enabled: true,
    createdAt: 0,
    ...patch,
  };
}

describe("normalizeCanvas", () => {
  it("preserves routines, presets and a locked note", () => {
    const raw = {
      viewport: { x: 1, y: 2, zoom: 1 },
      nodes: { t1: { x: 0, y: 0, w: 600, h: 400 } },
      items: [
        {
          id: "n1",
          type: "note",
          x: 0,
          y: 0,
          w: 200,
          h: 150,
          text: "briefing",
          color: "#fff",
          locked: true,
          name: "regras",
        },
      ],
      roles: { t1: "revisora" },
      routines: [routine()],
      rolePresets: { revisora: "revise sem escrever codigo" },
    };
    const out = normalizeCanvas(raw)!;
    expect(out.routines).toHaveLength(1);
    // Both fields keep accepting the string form every earlier save wrote.
    expect(out.rolePresets).toEqual({ revisora: { text: "revise sem escrever codigo" } });
    expect(out.roles).toEqual({ t1: { name: "revisora" } });
    const note = out.items[0] as { locked?: boolean; name?: string };
    expect(note.locked).toBe(true);
    expect(note.name).toBe("regras");
  });

  it("preserves the card's color and font, and clamps the font to the useful range", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      items: [],
      nodes: {
        t1: { x: 0, y: 0, w: 600, h: 400, color: "#8fc57d", fontSize: 22 },
        t2: { x: 0, y: 0, w: 600, h: 400, fontSize: 999 },
        t3: { x: 0, y: 0, w: 600, h: 400 },
      },
    })!;
    expect(out.nodes.t1).toMatchObject({ color: "#8fc57d", fontSize: 22 });
    expect(out.nodes.t2.fontSize).toBe(NODE_FONT_MAX);
    // Without an override the card does not carry the key — the preference rules.
    expect("fontSize" in out.nodes.t3).toBe(false);
  });

  it("drops a malformed routine without taking the rest down", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [],
      routines: [routine(), { id: "x", terminalId: "t1", text: "a", everyMin: 0, enabled: true, createdAt: 0 }],
    })!;
    expect(out.routines).toHaveLength(1);
  });

  it("does not create the new fields when there is nothing in them", () => {
    const out = normalizeCanvas({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [] })!;
    expect(out.routines).toBeUndefined();
    expect(out.rolePresets).toBeUndefined();
  });

  it("preserves a portal with engine, ua, storage and viewport", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [
        {
          id: "p1",
          type: "portal",
          x: 10,
          y: 20,
          w: 800,
          h: 500,
          url: "https://localhost:5173",
          color: "#fff",
          name: "App",
          engine: "firefox",
          ua: "ios",
          muted: true,
          storage: "workspace",
          viewport: { w: 390, h: 844 },
        },
      ],
    })!;
    const p = out.items[0] as Extract<CanvasItem, { type: "portal" }>;
    expect(p.type).toBe("portal");
    expect(p.url).toBe("https://localhost:5173");
    expect(p.name).toBe("App");
    expect(p.engine).toBe("firefox");
    expect(p.ua).toBe("ios");
    expect(p.muted).toBe(true);
    expect(p.storage).toBe("workspace");
    expect(p.viewport).toEqual({ w: 390, h: 844 });
  });

  it("drops a portal without a url and a malformed storage", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [
        { id: "bad", type: "portal", x: 0, y: 0, w: 400, h: 300, color: "#fff" },
        {
          id: "ok",
          type: "portal",
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          url: "https://example.com",
          color: "#fff",
          storage: "nao-existe",
        },
      ],
    })!;
    expect(out.items).toHaveLength(1);
    const p = out.items[0] as Extract<CanvasItem, { type: "portal" }>;
    expect(p.id).toBe("ok");
    expect(p.storage).toBeUndefined();
  });

  it("preserves the note's font and clamps it to the useful range", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [
        { id: "n1", type: "note", x: 0, y: 0, w: 200, h: 150, text: "a", color: "#fff", fontSize: 20 },
        { id: "n2", type: "note", x: 0, y: 0, w: 200, h: 150, text: "b", color: "#fff", fontSize: 900 },
        { id: "n3", type: "note", x: 0, y: 0, w: 200, h: 150, text: "c", color: "#fff", fontSize: "grande" },
        { id: "n4", type: "note", x: 0, y: 0, w: 200, h: 150, text: "d", color: "#fff" },
      ],
    })!;
    const notes = out.items as Extract<CanvasItem, { type: "note" }>[];
    expect(notes[0].fontSize).toBe(20);
    expect(notes[1].fontSize).toBe(NOTE_FONT_MAX);
    // Junk does not become a size: the note goes back to the default.
    expect(notes[2].fontSize).toBeUndefined();
    expect(notes[3].fontSize).toBeUndefined();
  });

  it("never lets the text font become NaN", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [
        { id: "t1", type: "text", x: 0, y: 0, text: "oi", color: "#fff", fontSize: 44 },
        { id: "t2", type: "text", x: 0, y: 0, text: "oi", color: "#fff", fontSize: "18" },
        { id: "t3", type: "text", x: 0, y: 0, text: "oi", color: "#fff", fontSize: 5000 },
      ],
    })!;
    const texts = out.items as Extract<CanvasItem, { type: "text" }>[];
    expect(texts[0].fontSize).toBe(44);
    // Required field: it cannot be dropped, so it falls back to the default —
    // `textBox` divides by it and a NaN would take hit-testing down.
    expect(texts[1].fontSize).toBe(TEXT_FONT_DEFAULT);
    expect(texts[2].fontSize).toBe(TEXT_FONT_MAX);
  });

  it("survives junk in place of the canvas", () => {
    expect(normalizeCanvas(null)).toBeUndefined();
    expect(normalizeCanvas("nao sou um canvas")).toBeUndefined();
  });
});

/**
 * The step has to keep moving at both ends of the range: 12% of 9px rounds to
 * 1 and 12% of 200px is 24, and a fixed pixel would be either invisible at the
 * top or the only usable notch at the bottom.
 */
describe("stepFont", () => {
  it("grows proportionally and never gets stuck at the floor", () => {
    expect(stepFont(9, 1, 9, 200)).toBe(10);
    expect(stepFont(50, 1, 9, 200)).toBe(56);
    expect(stepFont(50, -1, 9, 200)).toBe(44);
  });

  it("respects the bounds", () => {
    expect(stepFont(9, -1, 9, 200)).toBe(9);
    expect(stepFont(199, 1, 9, 200)).toBe(200);
  });
});

/**
 * Reconciliation is what keeps a keystroke in a note from re-rendering the
 * whole canvas: the persisted JSON returns new objects on every commit, and
 * these functions return the old references when the content did not change.
 */
describe("reconcileItems", () => {
  const stroke = (): CanvasItem => ({
    id: "s1",
    type: "stroke",
    points: [0, 0, 10, 10, 20, 5],
    size: "m",
    color: "#fff",
  });
  const note = (text = "oi"): CanvasItem => ({
    id: "n1",
    type: "note",
    x: 5,
    y: 5,
    w: 200,
    h: 150,
    text,
    color: "#fff",
  });

  it("returns the same array when nothing changed", () => {
    const prev = [stroke(), note()];
    const next = [stroke(), note()]; // same data, new objects (post-parse)
    expect(reconcileItems(prev, next)).toBe(prev);
  });

  it("preserves the identity of untouched items when one changes", () => {
    const prev = [stroke(), note()];
    const next = [stroke(), note("editada")];
    const out = reconcileItems(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]); // the stroke did not change: same reference
    expect(out[1]).toBe(next[1]); // the note changed: new reference
  });

  it("does not confuse strokes with different points", () => {
    const a = stroke();
    const b = stroke() as Extract<CanvasItem, { type: "stroke" }>;
    b.points = [0, 0, 10, 10, 20, 6];
    const out = reconcileItems([a], [b]);
    expect(out[0]).toBe(b);
  });

  it("a new item and a removed one inherit nobody's identity", () => {
    const prev = [stroke()];
    const next = [note()];
    const out = reconcileItems(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(next[0]);
  });

  it("sees the note's font changing", () => {
    const prev = [note()];
    const next = [{ ...note(), fontSize: 18 }];
    // Without this field in `sameItem`, the memoized note would keep the old
    // reference and never repaint at the new size.
    expect(reconcileItems(prev, next)[0]).toBe(next[0]);
  });

  it("reordering returns a new array with the old references", () => {
    const a = stroke();
    const b = note();
    const out = reconcileItems([a, b], [note(), stroke()]);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });
});

describe("reconcileNodes", () => {
  it("returns the same map when nothing changed", () => {
    const prev = { t1: { x: 0, y: 0, w: 600, h: 400 } };
    const next = { t1: { x: 0, y: 0, w: 600, h: 400 } };
    expect(reconcileNodes(prev, next)).toBe(prev);
  });

  it("preserves the rectangles that did not move", () => {
    const prev = {
      t1: { x: 0, y: 0, w: 600, h: 400 },
      t2: { x: 700, y: 0, w: 600, h: 400 },
    };
    const next = {
      t1: { x: 0, y: 0, w: 600, h: 400 },
      t2: { x: 800, y: 40, w: 600, h: 400 },
    };
    const out = reconcileNodes(prev, next);
    expect(out).not.toBe(prev);
    expect(out.t1).toBe(prev.t1);
    expect(out.t2).toBe(next.t2);
  });

  it("a removed node invalidates reuse of the whole map", () => {
    const prev = {
      t1: { x: 0, y: 0, w: 600, h: 400 },
      t2: { x: 700, y: 0, w: 600, h: 400 },
    };
    const next = { t1: { x: 0, y: 0, w: 600, h: 400 } };
    const out = reconcileNodes(prev, next);
    expect(out).not.toBe(prev);
    expect(Object.keys(out)).toEqual(["t1"]);
    expect(out.t1).toBe(prev.t1);
  });
});

/**
 * Wiring smoothness is a mathematical property, not a visual one: the
 * geometry must be continuous in both boxes. While the exit was chosen by
 * a dominant-axis `if`, the arrow *jumped* sides the instant the drag
 * crossed the diagonal. These tests pin down continuity.
 */
describe("connectionGeometry", () => {
  const card = (x: number, y: number): CanvasNode => ({ x, y, w: 520, h: 360 });
  const start = (a: CanvasNode, b: CanvasNode) => {
    const [sx, sy] = connectionGeometry(a, b).cubic;
    return { x: sx, y: sy };
  };

  it("exits through the edge facing the other node", () => {
    const a = card(0, 0);
    const g = connectionGeometry(a, card(900, 0));
    expect(g.cubic[0]).toBeCloseTo(520); // right edge
    expect(g.cubic[1]).toBeCloseTo(180); // mid-height
  });

  it("stacked vertically it exits through the bottom", () => {
    const g = connectionGeometry(card(0, 0), card(0, 800));
    expect(g.cubic[0]).toBeCloseTo(260);
    expect(g.cubic[1]).toBeCloseTo(360);
  });

  /** Largest exit displacement when b orbits a in steps of `passoDeg`. */
  const largestJump = (stepDeg: number) => {
    const a = card(0, 0);
    let prev: { x: number; y: number } | null = null;
    let worst = 0;
    for (let deg = 0; deg <= 360; deg += stepDeg) {
      const rad = (deg * Math.PI) / 180;
      const p = start(a, card(700 * Math.cos(rad), 700 * Math.sin(rad)));
      if (prev) worst = Math.max(worst, Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    return worst;
  };

  it("sweeps across the diagonal without jumping sides", () => {
    // The old `if (|dx| >= |dy|)` swapped the exit edge in one shot: the
    // anchor jumped ~300 units in a 1-degree step. Now it slides.
    expect(largestJump(1)).toBeLessThan(40);
  });

  it("is continuous: refining the step shrinks the largest jump in the same proportion", () => {
    // The signature of a discontinuity is a jump that does NOT shrink when
    // the step shrinks. Here the step drops 10x and the jump must drop with it.
    const coarse = largestJump(1);
    const fine = largestJump(0.1);
    expect(fine).toBeLessThan(coarse / 5);
  });

  it("the wire ends at the target node's edge, with no arrowhead", () => {
    const b = card(900, 0);
    const g = connectionGeometry(card(0, 0), b);
    const [, , , , , , ex, ey] = g.cubic;
    expect(ex).toBeCloseTo(900); // left edge of b
    expect(ey).toBeCloseTo(180); // mid-height
    // The path is a single cubic: no triangle glued to the arrival.
    expect(g.d.endsWith(`${ex} ${ey}`)).toBe(true);
  });

  it("overlapping nodes still produce a finite curve", () => {
    const g = connectionGeometry(card(0, 0), card(40, 20));
    for (const n of g.cubic) expect(Number.isFinite(n)).toBe(true);
    expect(g.d).not.toContain("NaN");
  });

  it("concentric nodes do not blow up", () => {
    const g = connectionGeometry(card(0, 0), card(0, 0));
    for (const n of g.cubic) expect(Number.isFinite(n)).toBe(true);
  });
});

describe("reconcileNodes and the card font", () => {
  it("does not reuse the reference when only the font changes", () => {
    const prev = { t1: { x: 0, y: 0, w: 600, h: 400, fontSize: 13 } };
    const next = { t1: { x: 0, y: 0, w: 600, h: 400, fontSize: 20 } };
    const out = reconcileNodes(prev, next);
    expect(out.t1).not.toBe(prev.t1);
    expect(out.t1.fontSize).toBe(20);
  });
});

describe("resizeRect", () => {
  const start = { x: 100, y: 100, w: 200, h: 200 };

  it("grows to the southeast without moving the origin", () => {
    expect(resizeRect(start, "se", 40, 30, 50, 50)).toEqual({
      x: 100,
      y: 100,
      w: 240,
      h: 230,
    });
  });

  it("pulls the northwest side keeping the opposite corner still", () => {
    const r = resizeRect(start, "nw", -40, -30, 50, 50);
    expect(r).toEqual({ x: 60, y: 70, w: 240, h: 230 });
    // The corner that was not dragged stays where it was.
    expect(r.x + r.w).toBe(start.x + start.w);
    expect(r.y + r.h).toBe(start.y + start.h);
  });

  it("touches only the dragged axis on an edge", () => {
    expect(resizeRect(start, "e", 40, 999, 50, 50)).toEqual({
      x: 100,
      y: 100,
      w: 240,
      h: 200,
    });
    expect(resizeRect(start, "n", 999, 40, 50, 50)).toEqual({
      x: 100,
      y: 140,
      w: 200,
      h: 160,
    });
  });

  it("stops at the minimum instead of dragging the box past it", () => {
    // Pulling the west side way past the minimum width: the box must stop
    // shrinking AND stop sliding, with its east edge intact.
    const r = resizeRect(start, "w", 400, 0, 50, 50);
    expect(r.w).toBe(50);
    expect(r.x).toBe(250);
    expect(r.x + r.w).toBe(start.x + start.w);

    const b = resizeRect(start, "n", 0, 400, 50, 50);
    expect(b.h).toBe(50);
    expect(b.y + b.h).toBe(start.y + start.h);
  });
});

describe("routineDue", () => {
  it("is not due before the interval", () => {
    expect(routineDue(routine({ createdAt: 0, everyMin: 30 }), 29 * MIN)).toBe(false);
    expect(routineDue(routine({ createdAt: 0, everyMin: 30 }), 30 * MIN)).toBe(true);
  });

  it("counts from the last run, not from creation", () => {
    const r = routine({ createdAt: 0, everyMin: 10, lastRunAt: 100 * MIN });
    expect(routineDue(r, 105 * MIN)).toBe(false);
    expect(routineDue(r, 110 * MIN)).toBe(true);
  });

  it("a paused routine is never due", () => {
    expect(routineDue(routine({ enabled: false, createdAt: 0 }), 999 * MIN)).toBe(false);
  });

  // The list only showed "last run": the obvious question — "and the next?" —
  // had no answer anywhere in the interface.
  it("says when it fires again, counting from the last run (or from creation)", () => {
    expect(routineNextAt(routine({ createdAt: 0, everyMin: 30 }))).toBe(30 * MIN);
    expect(
      routineNextAt(routine({ createdAt: 0, everyMin: 10, lastRunAt: 100 * MIN })),
    ).toBe(110 * MIN);
  });
});
