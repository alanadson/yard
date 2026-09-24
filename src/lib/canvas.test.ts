/**
 * `normalizeCanvas` is the front door of everything that was persisted: a
 * field it does not copy is a field wiped on the next autosave. These tests
 * exist exactly to catch that kind of silent loss.
 */
import { describe, expect, it } from "vitest";

import { GROUP_DEFAULT_NAME, GROUP_HEAD } from "./canvasGroups";
import { setActiveLang } from "./i18n";
import {
  canonicalCanvas,
  connectionGeometry,
  normalizeParsedCanvas,
  hitItem,
  itemBounds,
  translateItem,
  NODE_FONT_MAX,
  normalizeCanvas,
  withBackground,
  NOTE_FONT_MAX,
  reconcileItems,
  reconcileNodes,
  reconcileRoles,
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

it.each(["rope", "circuit"] as const)("selects a %s cable at its clamp outside the direct route", (style) => {
  const nodes = { a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 400, y: 0, w: 100, h: 100 } };
  const wire: CanvasItem = { id: "wire", type: "connection", from: "a", to: "b", color: "#fff", style, clamp: { id: "bundle", x: 250, y: 300 } };
  const nodeOf = (id: string) => nodes[id as keyof typeof nodes];
  expect(hitItem(wire, 250, 300, 1, nodeOf)).toBe(true);
  const bounds = itemBounds(wire, nodeOf)!;
  expect(bounds.y + bounds.h).toBeGreaterThanOrEqual(300);
});

it("bounds a vertical circuit by its actual top and bottom ports", () => {
  const nodes = { a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 80, y: 400, w: 100, h: 100 } };
  const wire: CanvasItem = { id: "wire", type: "connection", from: "a", to: "b", color: "#fff", style: "circuit" };
  expect(itemBounds(wire, (id) => nodes[id as keyof typeof nodes])).toEqual({ x: 50, y: 100, w: 80, h: 300 });
});

it("restores the selected Android device and reconciles a changed target", () => {
  const old = { id: "phone", type: "portal" as const, x: 0, y: 0, w: 390, h: 844, url: "about:blank", color: "#fff", deviceSerial: "phone-1" };
  const saved = normalizeCanvas({ nodes: {}, items: [{ ...old, deviceSerial: " emulator-5554 " }] })!;
  expect(saved.items[0]).toMatchObject({ deviceSerial: "emulator-5554" });
  expect(reconcileItems([old], saved.items)[0]).toMatchObject({ deviceSerial: "emulator-5554" });
});

it("keeps a changed wire style when reconciling an autosaved canvas", () => {
  const wire: CanvasItem = { id: "wire", type: "connection", from: "a", to: "b", color: "#fff" };
  const changed = { ...wire, style: "circuit" as const };
  expect(reconcileItems([wire], [changed])).toEqual([changed]);
});

it("selects a circuit wire along its straight segment instead of the old curve", () => {
  const nodes = { a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 400, y: 100, w: 100, h: 100 } };
  const wire: CanvasItem = { id: "wire", type: "connection", from: "a", to: "b", color: "#fff", style: "circuit" };
  const nodeOf = (id: string) => nodes[id as keyof typeof nodes];
  expect(hitItem(wire, 250, 70, 1, nodeOf)).toBe(true);
  expect(hitItem(wire, 170, 70, 1, nodeOf)).toBe(false);
});

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
 * A card's role reaches its memoized terminal card as an object, and every
 * layout write re-parses the canvas into fresh role objects. Without this,
 * a pan settling or a note being typed re-renders every card with a role.
 */
describe("reconcileRoles", () => {
  it("returns the same map when a re-parse brings the same roles", () => {
    const prev = { t1: { name: "revisora" }, t2: { name: "R", text: "faça x" } };
    const next = { t1: { name: "revisora" }, t2: { name: "R", text: "faça x" } };
    expect(reconcileRoles(prev, next)).toBe(prev);
  });

  it("keeps the untouched roles and hands over the one whose text changed", () => {
    const prev = { t1: { name: "revisora" }, t2: { name: "R", text: "faça x" } };
    const next = { t1: { name: "revisora" }, t2: { name: "R", text: "faça y" } };
    const out = reconcileRoles(prev, next);
    expect(out).not.toBe(prev);
    expect(out?.t1).toBe(prev.t1);
    expect(out?.t2).toBe(next.t2);
  });

  it("hands over a role whose name changed", () => {
    const prev = { t1: { name: "revisora" } };
    const next = { t1: { name: "autora" } };
    expect(reconcileRoles(prev, next)?.t1).toBe(next.t1);
  });

  it("does not take a one-line role for the same role once it gains instructions", () => {
    const prev = { t1: { name: "R" } };
    const next = { t1: { name: "R", text: "faça x" } };
    expect(reconcileRoles(prev, next)?.t1).toBe(next.t1);
  });

  it("a removed role invalidates reuse of the whole map", () => {
    const prev = { t1: { name: "revisora" }, t2: { name: "R" } };
    const next = { t1: { name: "revisora" } };
    const out = reconcileRoles(prev, next);
    expect(out).not.toBe(prev);
    expect(Object.keys(out ?? {})).toEqual(["t1"]);
    expect(out?.t1).toBe(prev.t1);
  });

  it("no roles left is no roles, whatever there was before", () => {
    expect(reconcileRoles({ t1: { name: "revisora" } }, undefined)).toBeUndefined();
    const next = { t1: { name: "revisora" } };
    expect(reconcileRoles(undefined, next)).toBe(next);
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

/**
 * The frame item (§5.4). It is the one item whose body must **not** take a
 * click — the whole point is to select the cards standing inside it — so the
 * hit test is the part worth locking down.
 */
describe("the group item", () => {
  const group: CanvasItem = {
    id: "g1",
    type: "group",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    name: "Frontend",
    color: "#5fa8ff",
  };

  it("survives a round trip through normalizeCanvas", () => {
    const out = normalizeCanvas({ nodes: {}, items: [group] });
    expect(out?.items).toEqual([group]);
  });

  it("falls back to a name when the persisted one is junk", () => {
    const out = normalizeCanvas({
      nodes: {},
      items: [{ ...group, name: "   " }],
    });
    expect((out?.items[0] as { name: string }).name).toBe(GROUP_DEFAULT_NAME);
  });

  it("is hit on its title band", () => {
    expect(hitItem(group, 20, GROUP_HEAD / 2, 0, () => undefined)).toBe(true);
  });

  it("is hit on its border", () => {
    expect(hitItem(group, 0, 200, 2, () => undefined)).toBe(true);
  });

  it("is NOT hit in the middle of its body", () => {
    // A frame that swallowed clicks in its body would make every card inside
    // it unselectable — the exact thing §5.4 forbids.
    expect(hitItem(group, 200, 200, 0, () => undefined)).toBe(false);
  });

  it("reports its whole rectangle as bounds", () => {
    expect(itemBounds(group, () => undefined)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("moves as a rectangle", () => {
    expect(translateItem(group, 10, -5)).toMatchObject({ x: 10, y: -5 });
  });
})

/**
 * The media item (§52). The field that matters is `path`: an item that loses
 * it on a round trip is a card pointing at nothing, and the loss is silent —
 * it only shows on the next reload.
 */
describe("the media item", () => {
  const media: CanvasItem = {
    id: "m1",
    type: "media",
    x: 10,
    y: 20,
    w: 400,
    h: 300,
    path: "docs/shot.png",
    color: "#f5f5f5",
  };

  it("survives a round trip through normalizeCanvas", () => {
    const out = normalizeCanvas({ nodes: {}, items: [media] });
    expect(out?.items[0]).toMatchObject({ path: "docs/shot.png", w: 400, h: 300 });
  });

  it("keeps a root of its own when the file lives outside the project", () => {
    const out = normalizeCanvas({
      nodes: {},
      items: [{ ...media, root: "D:/fotos" }],
    });
    expect(out?.items[0]).toMatchObject({ root: "D:/fotos" });
  });

  it("is dropped when it carries no path — there is nothing to show", () => {
    const out = normalizeCanvas({ nodes: {}, items: [{ ...media, path: "  " }] });
    expect(out?.items).toEqual([]);
  });

  it("is hit anywhere on its body, like every other card", () => {
    expect(hitItem(media, 200, 150, 0, () => undefined)).toBe(true);
  });

  it("moves as a rectangle", () => {
    expect(translateItem(media, 5, 5)).toMatchObject({ x: 15, y: 25 });
  });
})

/**
 * The binder item (§13). `notes` is a list of *references*, and a reference
 * that outlives what it points at is the classic way a persisted graph rots:
 * `yard note delete` can take a filed note out from under its binder at any
 * moment.
 */
describe("the binder item", () => {
  const binder: CanvasItem = {
    id: "b1",
    type: "binder",
    x: 0,
    y: 0,
    w: 380,
    h: 300,
    notes: ["n1", "n2"],
    active: 1,
    color: "#f5f5f5",
  };
  const note = (id: string): CanvasItem => ({
    id,
    type: "note",
    x: 0,
    y: 0,
    w: 200,
    h: 140,
    text: id,
    color: "#fff",
  });

  it("survives a round trip through normalizeCanvas", () => {
    const out = normalizeCanvas({ nodes: {}, items: [note("n1"), note("n2"), binder] });
    expect(out?.items[2]).toMatchObject({ notes: ["n1", "n2"], active: 1 });
  });

  it("drops a tab whose note is not on the board any more", () => {
    const out = normalizeCanvas({ nodes: {}, items: [note("n1"), binder] });
    expect((out?.items[1] as { notes: string[] }).notes).toEqual(["n1"]);
  });

  it("pulls `active` back when pruning left it past the end", () => {
    // It pointed at `n2`, which is gone. Left alone it would index nothing
    // and the binder would open blank on a board that has the note.
    const out = normalizeCanvas({ nodes: {}, items: [note("n1"), binder] });
    expect((out?.items[1] as { active?: number }).active).toBe(0);
  });

  it("survives with no notes at all — an empty binder is legal", () => {
    const out = normalizeCanvas({ nodes: {}, items: [{ ...binder, notes: [] }] });
    expect(out?.items[0]).toMatchObject({ type: "binder", notes: [] });
  });
})

/**
 * The file-tree item (§14). §14.1 is explicit that more than one may sit on
 * the same board and that **each instance keeps its own** root, open folders,
 * mode and selection — so all four travel on the item, and a crooked `mode`
 * from an older save must land on something that renders.
 */
describe("the tree item", () => {
  const tree: CanvasItem = {
    id: "t1",
    type: "tree",
    x: 0,
    y: 0,
    w: 320,
    h: 400,
    path: "src",
    mode: "grid",
    expanded: ["src", "src/lib"],
    selected: "src/lib/canvas.ts",
    color: "#f5f5f5",
  };

  it("survives a round trip through normalizeCanvas", () => {
    const out = normalizeCanvas({ nodes: {}, items: [tree] });
    expect(out?.items[0]).toMatchObject({
      path: "src",
      mode: "grid",
      expanded: ["src", "src/lib"],
      selected: "src/lib/canvas.ts",
    });
  });

  it("falls back to the list mode when the saved one is not one of ours", () => {
    const out = normalizeCanvas({ nodes: {}, items: [{ ...tree, mode: "hologram" }] });
    expect((out?.items[0] as { mode: string }).mode).toBe("list");
  });

  it("keeps a tree rooted at the project root, where `path` is empty", () => {
    // `""` is the project root and the most common case of all — it must not
    // be mistaken for a missing field and dropped.
    const out = normalizeCanvas({ nodes: {}, items: [{ ...tree, path: "" }] });
    expect(out?.items).toHaveLength(1);
  });

  it("drops junk out of the open-folder list", () => {
    const out = normalizeCanvas({
      nodes: {},
      items: [{ ...tree, expanded: ["src", 7, null, "lib"] }],
    });
    expect((out?.items[0] as { expanded: string[] }).expanded).toEqual(["src", "lib"]);
  });
})

/**
 * Triggers live in the same layout blob as routines: a crooked entry written
 * by an older build (or by an agent through the CLI) must be dropped on load,
 * never crash the boot — and the good ones must survive it.
 */
describe("normalizeCanvas — triggers", () => {
  it("preserves valid triggers and drops the malformed ones", () => {
    const good = {
      id: "g1",
      sourceId: "t1",
      event: "finished",
      action: { kind: "ask", targetId: "t2", text: "revise" },
      enabled: true,
      once: true,
      cooldownSec: 30,
      createdAt: 1,
      lastRunAt: 2,
    };
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [],
      triggers: [
        good,
        { id: "x", sourceId: "t1", event: "someday", action: { kind: "notify", text: "a" }, enabled: true, createdAt: 0 },
        { id: "y", sourceId: "t1", event: "finished", action: { kind: "ask", targetId: "", text: "a" }, enabled: true, createdAt: 0 },
        { id: "z", sourceId: "t1", event: "finished", action: { kind: "flow", flowId: "f", text: "t" }, enabled: "yes", createdAt: 0 },
      ],
    })!;
    expect(out.triggers).toEqual([good]);
  });

  it("does not create the field when nothing valid is in it", () => {
    const out = normalizeCanvas({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [], triggers: [] })!;
    expect(out.triggers).toBeUndefined();
  });
});

describe("the board's background", () => {
  it("keeps the grid style, the colour and the image with its opacity", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [],
      background: { grid: "lines", color: "#1a2b3c", image: "C:/wall/hills.jpg", opacity: 0.35 },
    })!;
    expect(out.background).toEqual({
      grid: "lines",
      color: "#1a2b3c",
      image: "C:/wall/hills.jpg",
      opacity: 0.35,
    });
  });

  it("drops junk field by field and the whole thing when nothing is left", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [],
      background: { grid: "plaid", color: "blue", image: 7, opacity: "x" },
    })!;
    expect(out.background).toBeUndefined();
    const half = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [],
      background: { grid: "none", opacity: 9 },
    })!;
    expect(half.background).toEqual({ grid: "none", opacity: 1 });
  });

  it("withBackground merges a patch, removes what is undefined and drops an empty result", () => {
    const base = normalizeCanvas({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [] })!;
    const lined = withBackground(base, { grid: "lines" });
    expect(lined.background).toEqual({ grid: "lines" });
    const coloured = withBackground(lined, { color: "#112233" });
    expect(coloured.background).toEqual({ grid: "lines", color: "#112233" });
    const cleared = withBackground(coloured, { grid: undefined, color: undefined });
    expect("background" in cleared).toBe(false);
  });
});

describe("card chrome fields", () => {
  it("keeps a card's paint order, pin and maximize memory across a reload", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {
        a: { x: 0, y: 0, w: 640, h: 400, z: 2, pinned: true, restore: { x: 1, y: 2, w: 300, h: 200 } },
      },
      items: [
        { id: "n", type: "note", x: 0, y: 0, w: 200, h: 100, text: "", color: "#fff", pinned: true },
      ],
    })!;
    expect(out.nodes.a.z).toBe(2);
    expect(out.nodes.a.pinned).toBe(true);
    expect(out.nodes.a.restore).toEqual({ x: 1, y: 2, w: 300, h: 200 });
    expect(out.items[0].pinned).toBe(true);
  });

  it("drops junk written into those fields instead of trusting it", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: { a: { x: 0, y: 0, w: 640, h: 400, z: "top", pinned: "yes", restore: { x: 1 } } },
      items: [
        { id: "n", type: "note", x: 0, y: 0, w: 200, h: 100, text: "", color: "#fff", pinned: "yes" },
      ],
    })!;
    expect("z" in out.nodes.a).toBe(false);
    expect("pinned" in out.nodes.a).toBe(false);
    expect("restore" in out.nodes.a).toBe(false);
    expect("pinned" in out.items[0]).toBe(false);
  });

  it("reconciliation notices a pin or a z change on an otherwise still card", () => {
    const prev = { a: { x: 0, y: 0, w: 640, h: 400 } };
    expect(reconcileNodes(prev, { a: { x: 0, y: 0, w: 640, h: 400, z: 1 } }).a).not.toBe(prev.a);
    expect(reconcileNodes(prev, { a: { x: 0, y: 0, w: 640, h: 400, pinned: true } }).a).not.toBe(prev.a);
    const note = { id: "n", type: "note" as const, x: 0, y: 0, w: 1, h: 1, text: "", color: "#fff" };
    expect(reconcileItems([note], [{ ...note, pinned: true }])[0]).not.toBe(note);
  });
});

/**
 * `canonicalCanvas` lets a commit skip re-reading the board it just wrote:
 * the store seeds its parse cache with it, so an item nobody touched comes
 * back as the same object and the view's reconciliation stops at `a === b`.
 * That is only safe if it is indistinguishable from the load it replaces, so
 * every test here compares it with `normalizeCanvas` over the JSON, including
 * key order and the fields a load writes as `undefined`.
 */
describe("canonicalCanvas", () => {
  /** A load of what `canvas` would persist as. */
  const load = (canvas: unknown) => normalizeCanvas(JSON.parse(JSON.stringify(canvas)));

  /** Every key in visiting order: `toStrictEqual` does not look at the order. */
  const shape = (v: unknown, path = "$"): string[] => {
    if (Array.isArray(v)) return [path, ...v.flatMap((x, i) => shape(x, `${path}[${i}]`))];
    if (v && typeof v === "object") {
      return Object.entries(v).flatMap(([k, x]) => [`${path}.${k}`, ...shape(x, `${path}.${k}`)]);
    }
    return [];
  };

  /** A board as a writer might hand it over: every kind of item, plus junk a load cleans. */
  const messy = (): Record<string, unknown> => ({
    viewport: { x: -0, y: 12.5, zoom: 99 },
    nodes: {
      t1: { x: 0, y: 0, w: 10, h: 10, pinned: false, z: 1.4, fontSize: 99 },
      t2: { x: 5, y: 5, w: 700, h: 500, dock: "left", restore: { x: 1, y: 2, w: 3, h: 4 } },
      bad: { x: "1", y: 0, w: 1, h: 1 },
    },
    items: [
      { id: "s1", type: "stroke", color: "#fff", size: "m", points: [-0, 0, 10, NaN, 20, 5] },
      { id: "s2", type: "stroke", color: "#fff", size: "m", points: [1, 2] },
      { id: "r1", type: "rect", color: "#fff", x: 0, y: 0, w: 10, h: 10, size: "s", seed: 3, pinned: false },
      { id: "l1", type: "arrow", color: "#fff", x1: 0, y1: 0, x2: 5, y2: 5, size: "l", seed: 1, dock: "left" },
      { id: "x1", type: "text", color: "#fff", x: 0, y: 0, text: "oi", fontSize: NaN },
      { id: "n1", type: "note", color: "#fff", x: 0, y: 0, w: 200, h: 150, text: "a" },
      {
        id: "n2", type: "note", color: "#fff", x: 0, y: 0, w: 200, h: 150, text: "b",
        fontSize: 100, restore: { x: 0, y: 0, w: -5, h: 10 }, dock: "right",
      },
      {
        id: "p1", type: "portal", color: "#fff", x: 0, y: 0, w: 10, h: 10, url: " https://x.dev ",
        storage: "bogus", viewport: { w: -1, h: 2 }, muted: 0, name: "  ", deviceSerial: " -evil ",
      },
      {
        id: "f1", type: "flow", color: "#fff", x: 0, y: 0, w: 10, h: 10,
        name: `${"a".repeat(47)} b`, stages: [{ prompt: "p", label: " QA " }, null], trigger: true,
      },
      {
        id: "tr", type: "tree", color: "#fff", x: 0, y: 0, w: 10, h: 10, path: " / src",
        mode: "bogus", expanded: ["", "src"], root: " C:\w ",
      },
      {
        id: "b1", type: "binder", color: "#fff", x: 0, y: 0, w: 10, h: 10,
        notes: ["n1", "gone", 7], active: 5, colorNotes: "yes",
      },
      { id: "m1", type: "media", color: "#fff", x: 0, y: 0, w: 10, h: 10, path: " a\b.png " },
      { id: "d1", type: "doc", color: "#fff", x: 0, y: 0, w: 10, h: 10, path: "README.md", root: "C:\w", name: " Leia " },
      { id: "g1", type: "group", color: "#fff", x: 0, y: 0, w: 400, h: 300, name: "Frente" },
      { id: "c1", type: "connection", color: "#fff", from: "t1", to: "n1", clamp: { id: "", x: 0, y: 0 } },
      {
        id: "u1", type: "rect", color: "#fff", x: 1, y: 1, w: 1, h: 1, size: "s", seed: 1,
        restore: undefined, extra: { keep: true },
      },
      null,
      undefined,
      { id: "zz", type: "hologram" },
    ],
    roles: { t1: "revisora", t2: { name: " Dev ", text: " Dev " } },
    routines: [{ id: "r", terminalId: "t1", text: "x", everyMin: 5, enabled: true, createdAt: 1 }, { id: 3 }],
    triggers: [
      { id: "tg", sourceId: "*", event: "finished", action: { kind: "notify", text: "ok" }, enabled: true, createdAt: 1 },
    ],
    rolePresets: { qa: "Revise", " ": "x" },
    background: { grid: "lines", color: "red", opacity: 7 },
    unknown: 1,
  });

  it("gives back exactly what a load of its JSON gives, junk and all", () => {
    const canvas = messy();
    const out = canonicalCanvas(canvas);
    const fresh = load(canvas);
    expect(out).toStrictEqual(fresh);
    expect(shape(out)).toEqual(shape(fresh));
  });

  it("a parse through normalizeParsedCanvas gives what normalizeCanvas gives", () => {
    const text = JSON.stringify(messy());
    const parsed = normalizeParsedCanvas(JSON.parse(text));
    expect(parsed).toStrictEqual(normalizeCanvas(JSON.parse(text)));
    expect(shape(parsed)).toEqual(shape(normalizeCanvas(JSON.parse(text))));
  });

  it("reuses the items already in the form a load gives them", () => {
    const loaded = load(messy())!;
    const moved = { ...loaded, viewport: { x: 40, y: -3, zoom: 1.5 } };
    const out = canonicalCanvas(moved)!;
    const byId = (id: string) => out.items.find((i) => i.id === id);
    for (const id of ["s1", "r1", "x1", "n1", "n2", "c1"]) {
      expect(byId(id)).toBe(loaded.items.find((i) => i.id === id));
    }
    expect(out).toStrictEqual(load(moved));
  });

  it("does not reuse a loaded item that a second load would still change", () => {
    // Trimming before slicing leaves a trailing space at the cut, and the next
    // load trims it: a loaded item is not always a fixed point of the loader.
    const loaded = load(messy())!;
    const out = canonicalCanvas(loaded)!;
    const flow = out.items.find((i) => i.id === "f1");
    const tree = out.items.find((i) => i.id === "tr");
    expect(flow).not.toBe(loaded.items.find((i) => i.id === "f1"));
    expect(flow).toMatchObject({ name: "a".repeat(47) });
    expect(tree).toMatchObject({ path: "src" });
    expect(out).toStrictEqual(load(loaded));
    expect(shape(out)).toEqual(shape(load(loaded)));
  });

  it("reuses what a parse kept as parsed, as long as JSON would write it back the same", () => {
    // `-0` and an overflowing literal parse fine, but JSON writes them back
    // as `0` and `null`: those items are not what the next load returns.
    const text = JSON.stringify({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [
      { id: "ok", type: "stroke", color: "#fff", size: "m", points: [1, 2, 3, 4] },
      { id: "neg", type: "stroke", color: "#fff", size: "m", points: [1, 2, 3, 4] },
      { id: "big", type: "rect", color: "#fff", x: 0, y: 0, w: 5, h: 5, size: "s", seed: 1 },
      { id: "deep", type: "connection", color: "#fff", from: "a", to: "b", clamp: { id: "c", x: 7, y: 0 } },
    ] })
      .replace('"neg","type":"stroke","color":"#fff","size":"m","points":[1', '"neg","type":"stroke","color":"#fff","size":"m","points":[-0')
      .replace('"seed":1', '"seed":1e999')
      .replace('"x":7', '"x":-0.0');
    const parsed = normalizeParsedCanvas(JSON.parse(text))!;
    expect(parsed).toStrictEqual(normalizeCanvas(JSON.parse(text)));
    const out = canonicalCanvas(parsed)!;
    expect(out.items[0]).toBe(parsed.items[0]);
    for (const i of [1, 2, 3]) expect(out.items[i]).not.toBe(parsed.items[i]);
    expect(out).toStrictEqual(load(parsed));
    expect(shape(out)).toEqual(shape(load(parsed)));
  });

  it("drops a filed note's tab when the note left the board in the same commit", () => {
    const loaded = load(messy())!;
    const without = { ...loaded, items: loaded.items.filter((i) => i.id !== "n1") };
    const out = canonicalCanvas(without)!;
    expect(out.items.find((i) => i.id === "b1")).toMatchObject({ notes: [], active: undefined });
    expect(out).toStrictEqual(load(without));
  });

  /**
   * An unnamed group is named by `t()`, so what a load gives depends on the
   * language at the moment of the load. Answering now could disagree with the
   * read it stands in for, so the board is left to the regular parse.
   */
  it("declines a board whose unnamed group a load would name", () => {
    const canvas = { ...messy(), items: [{ id: "g", type: "group", color: "#fff", x: 0, y: 0, w: 10, h: 10, name: "  " }] };
    expect(canonicalCanvas(canvas)).toBeUndefined();
    try {
      setActiveLang("en");
      expect(load(canvas)!.items[0]).toMatchObject({ name: "Group" });
    } finally {
      setActiveLang("pt-BR");
    }
  });

  it("declines a board a load would choke on, and anything that is not a plain object", () => {
    const choking = { ...messy(), items: [{ id: "g", type: "group", color: "#fff", x: 0, y: 0, w: 10, h: 10, name: 5 }] };
    expect(() => load(choking)).toThrow();
    expect(canonicalCanvas(choking)).toBeUndefined();
    expect(canonicalCanvas([])).toBeUndefined();
    expect(canonicalCanvas(null)).toBeUndefined();
  });
});

/**
 * The stroke hit test is what the eraser runs for every stroke on the board,
 * for every pointer sample, so it rejects far points with a cached bounding
 * box before walking the segments. That shortcut is only allowed to be
 * faster: these tests pin the answer to the plain definition (some segment
 * within half the stroke's width plus the tolerance), including right on
 * that boundary, where a box drawn one ulp too tight would leave a stroke
 * the eraser visibly crossed.
 */
describe("hitting a stroke", () => {
  /** A seeded generator: the same fixtures on every run. */
  function seeded(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The definition, walked segment by segment with no shortcut. */
  function nearPolyline(points: number[], wx: number, wy: number, t: number): boolean {
    for (let i = 0; i + 3 < points.length; i += 2) {
      const ax = points[i];
      const ay = points[i + 1];
      const dx = points[i + 2] - ax;
      const dy = points[i + 3] - ay;
      const len2 = dx * dx + dy * dy;
      const k = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((wx - ax) * dx + (wy - ay) * dy) / len2));
      if (Math.hypot(wx - (ax + k * dx), wy - (ay + k * dy)) <= t) return true;
    }
    return false;
  }

  const SIZES = ["s", "m", "l"] as const;
  const HALF = { s: 2, m: 3.5, l: 6 };

  function strokes(rand: () => number): Extract<CanvasItem, { type: "stroke" }>[] {
    const out: Extract<CanvasItem, { type: "stroke" }>[] = [];
    for (const n of [1, 2, 3, 8, 60, 400]) {
      for (const origin of [0, -3000, 1_000_000]) {
        const points: number[] = [];
        let x = origin + rand() * 500;
        let y = origin - rand() * 500;
        for (let i = 0; i < n; i++) {
          points.push(x, y);
          // Every so often the pen stands still: a zero-length segment.
          if (rand() < 0.1) continue;
          x += (rand() - 0.5) * 40;
          y += (rand() - 0.5) * 40;
        }
        out.push({ id: `s${out.length}`, type: "stroke", points, size: SIZES[out.length % 3], color: "#fff" });
      }
    }
    return out;
  }

  it("is hit exactly where some segment comes within half its width plus the tolerance", () => {
    const rand = seeded(7);
    const wrong: { id: string; tol: number; wx: number; wy: number; expected: boolean }[] = [];
    let hits = 0;
    let misses = 0;
    for (const stroke of strokes(rand)) {
      const pts = stroke.points;
      for (const tol of [0.3, 6, 24]) {
        const t = tol + HALF[stroke.size];
        for (let k = 0; k < 300; k++) {
          // Mostly right on the edge of the hit band, the rest scattered
          // near and far, so both answers get exercised.
          let wx: number;
          let wy: number;
          const seg = 2 * Math.floor(rand() * Math.max(1, pts.length / 2 - 1));
          const ax = pts[seg];
          const ay = pts[seg + 1];
          const bx = pts[seg + 2] ?? ax;
          const by = pts[seg + 3] ?? ay;
          if (k % 3 !== 2) {
            const f = rand();
            const nx = -(by - ay);
            const ny = bx - ax;
            const len = Math.hypot(nx, ny) || 1;
            const off = t * (1 + (rand() - 0.5) * 1e-12) * (rand() < 0.5 ? -1 : 1);
            wx = ax + (bx - ax) * f + (nx / len) * off;
            wy = ay + (by - ay) * f + (ny / len) * off;
          } else {
            const spread = rand() < 0.5 ? 60 : 5000;
            wx = ax + (rand() - 0.5) * spread;
            wy = ay + (rand() - 0.5) * spread;
          }
          const expected = nearPolyline(pts, wx, wy, t);
          if (hitItem(stroke, wx, wy, tol, () => undefined) !== expected) {
            wrong.push({ id: stroke.id, tol, wx, wy, expected });
          }
          if (expected) hits++;
          else misses++;
        }
      }
    }
    expect(wrong).toEqual([]);
    // Not a vacuous pass: the boundary samples land on both sides of it.
    expect(hits).toBeGreaterThan(500);
    expect(misses).toBeGreaterThan(500);
  });

  it("is hit just past its end cap and missed just beyond the band", () => {
    const stroke: CanvasItem = { id: "s", type: "stroke", points: [0, 0, 100, 0], size: "m", color: "#fff" };
    // Half width 3.5 plus tolerance 6: the band reaches 9.5 from the segment.
    expect(hitItem(stroke, 109.5, 0, 6, () => undefined)).toBe(true);
    expect(hitItem(stroke, 50, -9.5, 6, () => undefined)).toBe(true);
    expect(hitItem(stroke, 109.6, 0, 6, () => undefined)).toBe(false);
    expect(hitItem(stroke, 50, 9.6, 6, () => undefined)).toBe(false);
  });

  it("a single point is no segment and is never hit, even right on it", () => {
    const dot: CanvasItem = { id: "d", type: "stroke", points: [10, 10], size: "l", color: "#fff" };
    expect(hitItem(dot, 10, 10, 6, () => undefined)).toBe(false);
  });

  it("a stroke whose points grew after a first test is hit at its new end", () => {
    // A shortcut cached on the first test must not outlive the points it was
    // measured from.
    const points = [0, 0, 10, 0];
    const stroke: CanvasItem = { id: "g", type: "stroke", points, size: "s", color: "#fff" };
    expect(hitItem(stroke, 500, 0, 1, () => undefined)).toBe(false);
    points.push(500, 0);
    expect(hitItem(stroke, 500, 0, 1, () => undefined)).toBe(true);
  });
});
