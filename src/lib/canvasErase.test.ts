/**
 * The eraser tests its points once per frame instead of once per pointer
 * event. That batching is only allowed to be cheaper: what ends up erased
 * must be exactly what testing every point on its own would have erased, or
 * a sweep leaves a stroke behind (or takes one it never touched) and nothing
 * on screen says why. The points also have to keep the camera they were
 * taken under, because the frame that tests them can come after a pan.
 */
import { describe, expect, it } from "vitest";

import { hitItem, type CanvasItem, type CanvasNode } from "./canvas";
import {
  ERASER_TOL_PX,
  erasedBy,
  erasePoints,
  pointerSamples,
  type ErasePoint,
  type PointerSample,
} from "./canvasErase";

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

const NODES: Record<string, CanvasNode> = {
  a: { x: 0, y: 0, w: 300, h: 200 },
  b: { x: 700, y: 400, w: 300, h: 200 },
  c: { x: 100, y: 900, w: 200, h: 150 },
};
const nodeOf = (id: string) => NODES[id];

/** One of every kind the eraser can meet, plus the awkward cases. */
function board(rand: () => number): CanvasItem[] {
  const items: CanvasItem[] = [];
  const at = () => rand() * 1200;
  for (let i = 0; i < 12; i++) {
    const points: number[] = [];
    let x = at();
    let y = at();
    for (let k = 0; k < 40; k++) {
      points.push(x, y);
      x += (rand() - 0.5) * 30;
      y += (rand() - 0.5) * 30;
    }
    items.push({ id: `stroke${i}`, type: "stroke", points, size: "m", color: "#fff" });
  }
  items.push({ id: "dot", type: "stroke", points: [400, 400], size: "l", color: "#fff" });
  for (let i = 0; i < 4; i++) {
    const base = { x: at(), y: at(), w: 20 + rand() * 200, h: 20 + rand() * 200, size: "s" as const, seed: 1, color: "#fff" };
    items.push({ ...base, id: `rect${i}`, type: "rect" });
    items.push({ ...base, id: `ellipse${i}`, type: "ellipse" });
  }
  // A flat ellipse: its normalized test reaches far along the long axis.
  items.push({ id: "flat", type: "ellipse", x: 500, y: 600, w: 240, h: 2, size: "m", seed: 1, color: "#fff" });
  items.push({ id: "line", type: "line", x1: at(), y1: at(), x2: at(), y2: at(), size: "l", seed: 1, color: "#fff" });
  items.push({ id: "arrow", type: "arrow", x1: at(), y1: at(), x2: at(), y2: at(), size: "s", seed: 1, color: "#fff" });
  items.push({ id: "text", type: "text", x: at(), y: at(), text: "hello\nworld", fontSize: 22, color: "#fff" });
  items.push({ id: "note", type: "note", x: at(), y: at(), w: 230, h: 170, text: "", color: "#fff" });
  items.push({ id: "group", type: "group", x: 50, y: 50, w: 900, h: 700, name: "G", color: "#fff" });
  items.push({ id: "rope", type: "connection", from: "a", to: "b", color: "#fff" });
  items.push({ id: "circuit", type: "connection", from: "b", to: "c", color: "#fff", style: "circuit" });
  items.push({ id: "clamped", type: "connection", from: "a", to: "c", color: "#fff", clamp: { id: "k", x: 600, y: 1000 } });
  items.push({ id: "orphan", type: "connection", from: "a", to: "gone", color: "#fff" });
  // Two items sharing an id: either one being hit erases the id.
  items.push({ id: "twin", type: "note", x: 1500, y: 1500, w: 100, h: 100, text: "", color: "#fff" });
  items.push({ id: "twin", type: "note", x: 200, y: 1100, w: 100, h: 100, text: "", color: "#fff" });
  return items;
}

/** A sweep of the eraser: a wandering path, sampled like a fast mouse. */
function sweep(rand: () => number, n: number, tol: () => number): ErasePoint[] {
  const out: ErasePoint[] = [];
  let x = rand() * 1200;
  let y = rand() * 1200;
  for (let i = 0; i < n; i++) {
    out.push({ x, y, tol: tol() });
    x += (rand() - 0.5) * 60;
    y += (rand() - 0.5) * 60;
  }
  return out;
}

/** What the eraser used to do: every event on its own, skipping what it already took. */
function oneEventAtATime(
  items: readonly CanvasItem[],
  points: readonly ErasePoint[],
  start: ReadonlySet<string>,
): Set<string> {
  const pending = new Set(start);
  for (const p of points) {
    const hits = items.filter((it) => !pending.has(it.id) && hitItem(it, p.x, p.y, p.tol, nodeOf));
    for (const h of hits) pending.add(h.id);
  }
  return pending;
}

function inOnePass(
  items: readonly CanvasItem[],
  points: readonly ErasePoint[],
  start: ReadonlySet<string>,
): Set<string> {
  return new Set([...start, ...erasedBy(items, points, nodeOf, start)]);
}

describe("erasedBy", () => {
  it("erasing a frame's points in one pass leaves the same set as erasing them one event at a time", () => {
    const rand = seeded(42);
    const items = board(rand);
    let erasedSomething = 0;
    for (let s = 0; s < 60; s++) {
      // Some frames under one zoom, some with the zoom changing mid-frame.
      const tol = s % 3 === 0 ? () => 6 / (0.2 + rand() * 3) : () => 6;
      const points = sweep(rand, 1 + Math.floor(rand() * 24), tol);
      const start = new Set(s % 4 === 0 ? ["stroke0", "note", "twin"] : []);
      const expected = oneEventAtATime(items, points, start);
      expect(inOnePass(items, points, start)).toEqual(expected);
      if (expected.size > start.size) erasedSomething++;
    }
    // Not a vacuous pass: most sweeps do erase something.
    expect(erasedSomething).toBeGreaterThan(20);
  });

  it("a whole gesture split into frames erases what the gesture erased event by event", () => {
    const items = board(seeded(9));
    // Scrubbing back and forth across the board, a sample every 9 px.
    const gesture: ErasePoint[] = [];
    for (let row = 0, y = 0; y <= 1200; row++, y += 90) {
      for (let i = 0; i <= 133; i++) {
        gesture.push({ x: row % 2 ? 1200 - i * 9 : i * 9, y, tol: 6 });
      }
    }
    let pending: ReadonlySet<string> = new Set();
    for (let i = 0; i < gesture.length; i += 7) {
      pending = inOnePass(items, gesture.slice(i, i + 7), pending);
    }
    expect(pending).toEqual(oneEventAtATime(items, gesture, new Set()));
    expect(pending.size).toBeGreaterThan(3);
  });

  it("never reports what is already erased", () => {
    const items = board(seeded(3));
    const everywhere: ErasePoint[] = [];
    for (let x = 0; x <= 1200; x += 40) {
      for (let y = 0; y <= 1200; y += 40) everywhere.push({ x, y, tol: 6 });
    }
    const already = new Set(["group", "rope", "stroke3"]);
    const out = erasedBy(items, everywhere, nodeOf, already);
    expect(out.length).toBeGreaterThan(0);
    for (const id of already) expect(out).not.toContain(id);
  });

  it("a flat ellipse is taken from as far along its axis as the full test reaches", () => {
    const flat: CanvasItem = { id: "f", type: "ellipse", x: 0, y: 0, w: 200, h: 2, size: "m", seed: 1, color: "#fff" };
    // rx 100, ry 1: the band is (6 + 3.5) / 1 in normalized units, so a
    // point nine radii out along the long axis still hits. Whatever the
    // shortcut is, it must not stop short of that.
    const far = { x: 1000, y: 1, tol: 6 };
    expect(hitItem(flat, far.x, far.y, far.tol, nodeOf)).toBe(true);
    expect(erasedBy([flat], [far], nodeOf, new Set())).toEqual(["f"]);
  });

  it("no points erase nothing", () => {
    expect(erasedBy(board(seeded(5)), [], nodeOf, new Set())).toEqual([]);
  });
});

describe("erasePoints", () => {
  it("turns client px into world px with the same arithmetic as the pointer's own conversion", () => {
    const camera = { x: 100, y: -40, zoom: 2 };
    const [p] = erasePoints([{ clientX: 350, clientY: 260, camera }], { left: 50, top: 60 });
    expect(p).toEqual({ x: (350 - 50) / 2 + 100, y: (260 - 60) / 2 - 40, tol: ERASER_TOL_PX / 2 });
  });

  it("a point queued before the camera moved keeps the camera it was taken under", () => {
    const before = { x: 0, y: 0, zoom: 1 };
    const after = { x: 500, y: 0, zoom: 0.5 };
    const out = erasePoints(
      [
        { clientX: 100, clientY: 100, camera: before },
        { clientX: 100, clientY: 100, camera: after },
      ],
      { left: 0, top: 0 },
    );
    expect(out).toEqual([
      { x: 100, y: 100, tol: 6 },
      { x: 700, y: 200, tol: 12 },
    ]);
  });

  it("the tolerance is six screen px, whatever the zoom", () => {
    expect(ERASER_TOL_PX).toBe(6);
    const [p] = erasePoints([{ clientX: 0, clientY: 0, camera: { x: 0, y: 0, zoom: 3 } }], { left: 0, top: 0 });
    expect(p.tol).toBe(2);
  });
});

describe("pointerSamples", () => {
  it("a move contributes every coalesced sample, in order", () => {
    const a = { clientX: 1, clientY: 1 };
    const b = { clientX: 2, clientY: 3 };
    const c = { clientX: 5, clientY: 8 };
    expect(pointerSamples({ ...c, getCoalescedEvents: () => [a, b, c] })).toEqual([a, b, c]);
  });

  it("an event without coalesced samples stands for itself", () => {
    const bare = { clientX: 4, clientY: 4 };
    expect(pointerSamples(bare)).toEqual([bare]);
    const empty = { clientX: 7, clientY: 7, getCoalescedEvents: (): PointerSample[] => [] };
    expect(pointerSamples(empty)).toEqual([empty]);
  });
});
