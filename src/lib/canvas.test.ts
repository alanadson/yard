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
  reconcileItems,
  reconcileNodes,
  resizeRect,
  routineDue,
  type CanvasItem,
  type CanvasNode,
  type RoutineDef,
} from "./canvas";

const MIN = 60_000;

function rotina(patch: Partial<RoutineDef> = {}): RoutineDef {
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
  it("preserva rotinas, presets e nota travada", () => {
    const bruto = {
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
      routines: [rotina()],
      rolePresets: { revisora: "revise sem escrever codigo" },
    };
    const out = normalizeCanvas(bruto)!;
    expect(out.routines).toHaveLength(1);
    expect(out.rolePresets).toEqual({ revisora: "revise sem escrever codigo" });
    expect(out.roles).toEqual({ t1: "revisora" });
    const nota = out.items[0] as { locked?: boolean; name?: string };
    expect(nota.locked).toBe(true);
    expect(nota.name).toBe("regras");
  });

  it("preserva cor e fonte da carta, e limita a fonte a faixa util", () => {
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

  it("descarta rotina torta sem derrubar o resto", () => {
    const out = normalizeCanvas({
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
      items: [],
      routines: [rotina(), { id: "x", terminalId: "t1", text: "a", everyMin: 0, enabled: true, createdAt: 0 }],
    })!;
    expect(out.routines).toHaveLength(1);
  });

  it("nao cria os campos novos quando nao ha nada neles", () => {
    const out = normalizeCanvas({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: {}, items: [] })!;
    expect(out.routines).toBeUndefined();
    expect(out.rolePresets).toBeUndefined();
  });

  it("preserva portal com motor, ua, storage e viewport", () => {
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

  it("descarta portal sem url e storage torto", () => {
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

  it("sobrevive a lixo no lugar do canvas", () => {
    expect(normalizeCanvas(null)).toBeUndefined();
    expect(normalizeCanvas("nao sou um canvas")).toBeUndefined();
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

  it("devolve o proprio array quando nada mudou", () => {
    const prev = [stroke(), note()];
    const next = [stroke(), note()]; // same data, new objects (post-parse)
    expect(reconcileItems(prev, next)).toBe(prev);
  });

  it("preserva a identidade dos itens intactos quando um muda", () => {
    const prev = [stroke(), note()];
    const next = [stroke(), note("editada")];
    const out = reconcileItems(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]); // the stroke did not change: same reference
    expect(out[1]).toBe(next[1]); // the note changed: new reference
  });

  it("nao confunde tracos com pontos diferentes", () => {
    const a = stroke();
    const b = stroke() as Extract<CanvasItem, { type: "stroke" }>;
    b.points = [0, 0, 10, 10, 20, 6];
    const out = reconcileItems([a], [b]);
    expect(out[0]).toBe(b);
  });

  it("item novo e removido nao herdam identidade de ninguem", () => {
    const prev = [stroke()];
    const next = [note()];
    const out = reconcileItems(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(next[0]);
  });

  it("reordenar devolve array novo com as referencias antigas", () => {
    const a = stroke();
    const b = note();
    const out = reconcileItems([a, b], [note(), stroke()]);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });
});

describe("reconcileNodes", () => {
  it("devolve o proprio mapa quando nada mudou", () => {
    const prev = { t1: { x: 0, y: 0, w: 600, h: 400 } };
    const next = { t1: { x: 0, y: 0, w: 600, h: 400 } };
    expect(reconcileNodes(prev, next)).toBe(prev);
  });

  it("preserva os retangulos que nao se moveram", () => {
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

  it("no removido invalida o reuso do mapa inteiro", () => {
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

  it("sai pela borda que encara o outro no", () => {
    const a = card(0, 0);
    const g = connectionGeometry(a, card(900, 0));
    expect(g.cubic[0]).toBeCloseTo(520); // right edge
    expect(g.cubic[1]).toBeCloseTo(180); // mid-height
  });

  it("empilhado na vertical sai por baixo", () => {
    const g = connectionGeometry(card(0, 0), card(0, 800));
    expect(g.cubic[0]).toBeCloseTo(260);
    expect(g.cubic[1]).toBeCloseTo(360);
  });

  /** Largest exit displacement when b orbits a in steps of `passoDeg`. */
  const maiorSalto = (passoDeg: number) => {
    const a = card(0, 0);
    let prev: { x: number; y: number } | null = null;
    let pior = 0;
    for (let deg = 0; deg <= 360; deg += passoDeg) {
      const rad = (deg * Math.PI) / 180;
      const p = start(a, card(700 * Math.cos(rad), 700 * Math.sin(rad)));
      if (prev) pior = Math.max(pior, Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    return pior;
  };

  it("varre a diagonal sem saltar de lado", () => {
    // The old `if (|dx| >= |dy|)` swapped the exit edge in one shot: the
    // anchor jumped ~300 units in a 1-degree step. Now it slides.
    expect(maiorSalto(1)).toBeLessThan(40);
  });

  it("e continua: refinar o passo encolhe o maior salto na mesma proporcao", () => {
    // The signature of a discontinuity is a jump that does NOT shrink when
    // the step shrinks. Here the step drops 10x and the jump must drop with it.
    const grosso = maiorSalto(1);
    const fino = maiorSalto(0.1);
    expect(fino).toBeLessThan(grosso / 5);
  });

  it("a ponta aponta para dentro do no de destino", () => {
    const b = card(900, 0);
    const g = connectionGeometry(card(0, 0), b);
    const [, , , , , , ex, ey] = g.cubic;
    expect(ex).toBeCloseTo(900); // left edge of b
    const [tipX, tipY] = g.head.split(" ")[0].split(",").map(Number);
    expect(tipX).toBeCloseTo(ex);
    expect(tipY).toBeCloseTo(ey);
  });

  it("nos sobrepostos ainda geram uma curva finita", () => {
    const g = connectionGeometry(card(0, 0), card(40, 20));
    for (const n of g.cubic) expect(Number.isFinite(n)).toBe(true);
    expect(g.d).not.toContain("NaN");
  });

  it("nos concentricos nao explodem", () => {
    const g = connectionGeometry(card(0, 0), card(0, 0));
    for (const n of g.cubic) expect(Number.isFinite(n)).toBe(true);
  });
});

describe("reconcileNodes e fonte da carta", () => {
  it("nao reaproveita a referencia quando so a fonte muda", () => {
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
  it("nao vence antes do intervalo", () => {
    expect(routineDue(rotina({ createdAt: 0, everyMin: 30 }), 29 * MIN)).toBe(false);
    expect(routineDue(rotina({ createdAt: 0, everyMin: 30 }), 30 * MIN)).toBe(true);
  });

  it("conta a partir do ultimo disparo, nao da criacao", () => {
    const r = rotina({ createdAt: 0, everyMin: 10, lastRunAt: 100 * MIN });
    expect(routineDue(r, 105 * MIN)).toBe(false);
    expect(routineDue(r, 110 * MIN)).toBe(true);
  });

  it("pausada nunca vence", () => {
    expect(routineDue(rotina({ enabled: false, createdAt: 0 }), 999 * MIN)).toBe(false);
  });
});
