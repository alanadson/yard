/**
 * `yard canvas`: an agent laying out its own corner of the board. The gate
 * is the same as `ask`: it may move itself and what is wired to it, and
 * nothing else, because a card being dragged around by a stranger is the
 * one thing that would make the user stop trusting the board.
 */
import { describe, expect, it } from "vitest";

import { makeCtx } from "./bridgeCore";
import { EMPTY_CANVAS, NODE_MIN_W, type CanvasData } from "./canvas";
import type { TerminalRow } from "./ipc";
import { boardElements, runCanvasCommand } from "./bridgeCanvasCmd";

const row = (id: string, title: string): TerminalRow =>
  ({
    id,
    groupId: "g",
    title,
    program: "claude",
    args: [],
    cwd: "C:\\p",
    kind: "agent",
    agentId: "claude-code",
    slot: 0,
    sort: 0,
    alive: true,
    createdAt: 1,
    surface: "canvas",
  }) as unknown as TerminalRow;

const terminals = [row("me", "Lead"), row("dev", "Dev"), row("far", "Stranger")];

const canvas = (): CanvasData => ({
  ...EMPTY_CANVAS,
  nodes: {
    me: { x: 0, y: 0, w: 640, h: 400 },
    dev: { x: 800, y: 0, w: 640, h: 400 },
    far: { x: 3000, y: 3000, w: 640, h: 400 },
  },
  items: [
    { id: "n1", type: "note", x: 0, y: 500, w: 230, h: 170, text: "Plano", color: "#fff" },
    { id: "w1", type: "connection", from: "me", to: "dev", color: "#fff" },
    { id: "w2", type: "connection", from: "me", to: "n1", color: "#fff" },
  ],
});

const ctxOf = (c = canvas()) => makeCtx(terminals[0], "g", c, terminals);

const run = (argv: string[], c = canvas()) => {
  const ctx = ctxOf(c);
  return runCanvasCommand({ argv, canvas: c, elements: boardElements(ctx), callerId: "me" });
};

describe("boardElements", () => {
  it("lists every card and boxed item with its name, box and reach", () => {
    const els = boardElements(ctxOf());
    const byId = Object.fromEntries(els.map((e) => [e.id, e]));
    expect(byId.me.name).toBe("Lead");
    expect(byId.me.box).toEqual({ x: 0, y: 0, w: 640, h: 400 });
    expect(byId.dev.wired).toBe(true);
    expect(byId.far.wired).toBe(false);
    expect(byId.n1.kind).toBe("note");
    expect(byId.n1.name).toBe("Plano");
    expect(byId.n1.wired).toBe(true);
    expect(els.some((e) => e.id === "w1")).toBe(false);
  });
});

describe("yard canvas list", () => {
  it("prints each element with its position, marking who is in reach", () => {
    const r = run(["list"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Lead");
    expect(r.output).toContain("Stranger");
    expect(r.output).toContain("800");
  });

  it("--json is machine readable", () => {
    const r = run(["list", "--json"]);
    const parsed = JSON.parse(r.output) as { name: string; box: { x: number } }[];
    expect(parsed.find((e) => e.name === "Dev")?.box.x).toBe(800);
  });
});

describe("yard canvas move / resize", () => {
  it("moves a wired card to absolute coordinates", () => {
    const r = run(["move", "Dev", "100", "200"]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.canvas?.nodes.dev).toMatchObject({ x: 100, y: 200 });
  });

  it("moves by a delta with --by", () => {
    const r = run(["move", "Plano", "--by", "10", "-20"]);
    expect(r.ok).toBe(true);
    const note = r.ok && r.canvas?.items.find((i) => i.id === "n1");
    expect(note).toMatchObject({ x: 10, y: 480 });
  });

  it("refuses a card that is not wired to the caller", () => {
    const r = run(["move", "Stranger", "0", "0"]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("conectado");
  });

  it("refuses an unknown name and says so", () => {
    const r = run(["move", "Ghost", "0", "0"]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Ghost");
  });

  it("resizes with the card's minimum enforced", () => {
    const r = run(["resize", "Dev", "10", "10"]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.canvas?.nodes.dev.w).toBe(NODE_MIN_W);
  });

  it("refuses to move a pinned card", () => {
    const c = canvas();
    c.nodes.dev = { ...c.nodes.dev, pinned: true };
    const r = run(["move", "Dev", "1", "1"], c);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("fixado");
  });
});

describe("yard canvas arrange / align", () => {
  it("arranges the caller and its reach into a grid by default", () => {
    const r = run(["arrange"]);
    expect(r.ok).toBe(true);
    const c = r.ok ? r.canvas! : canvas();
    // The stranger did not move; the reach did.
    expect(c.nodes.far).toEqual({ x: 3000, y: 3000, w: 640, h: 400 });
    const boxes = [c.nodes.me, c.nodes.dev, c.items.find((i) => i.id === "n1") as { x: number; y: number; w: number; h: number }];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("aligns the named elements", () => {
    const r = run(["align", "top", "Dev", "Plano"]);
    expect(r.ok).toBe(true);
    const c = r.ok ? r.canvas! : canvas();
    const note = c.items.find((i) => i.id === "n1") as { y: number };
    expect(note.y).toBe(c.nodes.dev.y);
  });

  it("refuses an arrangement that names a stranger", () => {
    const r = run(["arrange", "Dev", "Stranger"]);
    expect(r.ok).toBe(false);
  });
});

describe("yard canvas frame / pin / focus / zoom", () => {
  it("frames the reach in a named group that contains every member", () => {
    const r = run(["frame", "Time A"]);
    expect(r.ok).toBe(true);
    const c = r.ok ? r.canvas! : canvas();
    const g = c.items.find((i) => i.type === "group") as { x: number; y: number; w: number; h: number; name: string };
    expect(g.name).toBe("Time A");
    for (const b of [c.nodes.me, c.nodes.dev]) {
      expect(b.x).toBeGreaterThanOrEqual(g.x);
      expect(b.x + b.w).toBeLessThanOrEqual(g.x + g.w);
    }
  });

  it("pins and unpins", () => {
    const r = run(["pin", "Dev"]);
    expect(r.ok && r.canvas?.nodes.dev.pinned).toBe(true);
    const r2 = run(["unpin", "Dev"], r.ok ? r.canvas! : canvas());
    expect(r2.ok && "pinned" in r2.canvas!.nodes.dev).toBe(false);
  });

  it("focus and zoom ask for the camera instead of writing the board", () => {
    const f = run(["focus", "Dev"]);
    expect(f.ok && f.camera).toEqual({ center: "dev" });
    expect(f.ok && f.canvas).toBeUndefined();
    const z = run(["zoom", "fit"]);
    expect(z.ok && z.camera).toEqual({ zoom: "fit" });
    const z2 = run(["zoom", "150%"]);
    expect(z2.ok && z2.camera).toEqual({ zoom: 1.5 });
  });

  it("an unknown verb gets the usage", () => {
    const r = run(["dance"]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("uso");
  });
});
