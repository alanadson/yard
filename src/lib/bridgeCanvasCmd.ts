/**
 * `yard canvas`: the board's layout, from the agent's side.
 *
 * Everything else the CLI offers is about *talking*; this is about *where
 * things are*. An agent that recruited three helpers and wrote two notes has
 * a corner of the board that only it knows the shape of, and until now the
 * user tidied it by hand. The verbs are the ones the user has: move, resize,
 * arrange, align, frame, pin, plus two for the camera.
 *
 * Same gate as `ask`: the caller reaches itself, whatever is wired to it, and
 * the notes and portals a chain of notes leads to. Listing is open (the
 * layout is not a secret; the conversation is), acting is not.
 *
 * Pure: the elements and the canvas come in, a new canvas and a message come
 * out. `bridge.ts` commits and moves the camera.
 */
import { nanoid } from "nanoid";

import { alignBoxes, tidyBoxes, type AlignKind, type Moves, type TidyLayout } from "./arrange";
import { BINDER_MIN_H, BINDER_MIN_W, filedNoteIds } from "./binder";
import { parseFlags, type Ctx } from "./bridgeCore";
import {
  autoNodeRect,
  FLOW_MIN_H,
  FLOW_MIN_W,
  itemBounds,
  NODE_MIN_H,
  NODE_MIN_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  noteName,
  PORTAL_MIN_H,
  PORTAL_MIN_W,
  portalName,
  translateItem,
  type Box,
  type CanvasData,
  type CanvasItem,
} from "./canvas";
import { addFrame, frameAround, frameItem, GROUP_MIN_H, GROUP_MIN_W } from "./canvasGroups";
import { setPinned } from "./cardChrome";
import { DOC_MIN_H, DOC_MIN_W, docNodeName } from "./docNode";
import { MEDIA_MIN_H, MEDIA_MIN_W, mediaNodeName } from "./mediaNode";
import { TREE_MIN_H, TREE_MIN_W, treeNodeName } from "./treeNode";

/** Window event: the CLI asked the camera to go somewhere. */
export const CANVAS_CAMERA_EVENT = "yard:canvas-camera";

export interface CameraRequest {
  /** Id of the element to bring to the middle of the screen. */
  center?: string;
  /** An absolute zoom, or "fit" for the whole board. */
  zoom?: number | "fit";
}

export type ElementKind =
  | "terminal"
  | "note"
  | "portal"
  | "media"
  | "doc"
  | "tree"
  | "binder"
  | "flow"
  | "group"
  | "text"
  | "draw";

export interface BoardElement {
  id: string;
  kind: ElementKind;
  name: string;
  box: Box;
  /** In the caller's reach (the caller itself counts). */
  wired: boolean;
  pinned: boolean;
}

type CtxSlice = Pick<
  Ctx,
  "caller" | "canvas" | "terminals" | "nameOf" | "noteNameOf" | "portalNameOf" | "edges"
>;

/**
 * Who the caller reaches: its direct neighbours, and past them only through
 * notes and portals (the same walk `bridgeCore` does for `note read`).
 */
function reachSet(ctx: CtxSlice): Set<string> {
  const hops = new Set<string>(
    ctx.canvas.items
      .filter((i) => i.type === "note" || i.type === "portal")
      .map((i) => i.id),
  );
  const out = new Set<string>([ctx.caller.id]);
  const queue = [...(ctx.edges.get(ctx.caller.id) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    if (!hops.has(id)) continue;
    for (const next of ctx.edges.get(id) ?? []) queue.push(next);
  }
  return out;
}

function kindOf(it: CanvasItem): ElementKind {
  switch (it.type) {
    case "note":
    case "portal":
    case "media":
    case "doc":
    case "tree":
    case "binder":
    case "flow":
    case "group":
    case "text":
      return it.type;
    default:
      return "draw";
  }
}

function itemLabel(ctx: CtxSlice, it: CanvasItem): string {
  switch (it.type) {
    case "note":
      return ctx.noteNameOf.get(it.id) ?? noteName(it);
    case "portal":
      return ctx.portalNameOf.get(it.id) ?? portalName(it);
    case "media":
      return mediaNodeName(it);
    case "doc":
      return docNodeName(it);
    case "tree":
      return treeNodeName(it);
    case "binder":
      return it.name?.trim() || "Fichário";
    case "flow":
    case "group":
      return it.name;
    case "text":
      return it.text.trim().split("\n")[0].slice(0, 32) || "Texto";
    default:
      return "Desenho";
  }
}

/** Every card and boxed item of the board, named the way `yard list` names them. */
export function boardElements(ctx: CtxSlice): BoardElement[] {
  const reach = reachSet(ctx);
  const out: BoardElement[] = [];
  ctx.terminals.forEach((t, i) => {
    const n = ctx.canvas.nodes[t.id] ?? autoNodeRect(i);
    out.push({
      id: t.id,
      kind: "terminal",
      name: ctx.nameOf.get(t.id) ?? t.title ?? t.program,
      box: { x: n.x, y: n.y, w: n.w, h: n.h },
      wired: reach.has(t.id),
      pinned: !!n.pinned,
    });
  });
  const filed = filedNoteIds(ctx.canvas.items);
  for (const it of ctx.canvas.items) {
    if (it.type === "connection") continue;
    if (it.type === "note" && filed.has(it.id)) continue;
    const b = itemBounds(it, () => undefined);
    if (!b) continue;
    out.push({
      id: it.id,
      kind: kindOf(it),
      name: itemLabel(ctx, it),
      box: b,
      wired: reach.has(it.id),
      pinned: !!it.pinned,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

export interface CanvasCommandInput {
  argv: string[];
  canvas: CanvasData;
  elements: BoardElement[];
  callerId: string;
}

export type CanvasCommandResult =
  | { ok: true; output: string; canvas?: CanvasData; camera?: CameraRequest }
  | { ok: false; output: string };

const USAGE =
  "uso: yard canvas list [--json]\n" +
  '     yard canvas move "Nome" X Y | move "Nome" --by DX DY\n' +
  '     yard canvas resize "Nome" W H\n' +
  '     yard canvas arrange [--layout grid|row|column] ["Nome"...]\n' +
  '     yard canvas align left|hcenter|right|top|vcenter|bottom "A" "B" [...]\n' +
  '     yard canvas frame "Nome do grupo" ["Membro"...]\n' +
  '     yard canvas pin|unpin "Nome"\n' +
  '     yard canvas focus "Nome" | zoom fit|N%\n' +
  "     (sem nomes, arrange e frame usam você e o que está conectado a você)\n";

const fail = (output: string): CanvasCommandResult => ({ ok: false, output });

function minSize(c: CanvasData, el: BoardElement): { w: number; h: number } {
  const it = c.items.find((i) => i.id === el.id);
  switch (it?.type) {
    case "note":
      return { w: NOTE_MIN_W, h: NOTE_MIN_H };
    case "portal":
      return { w: PORTAL_MIN_W, h: PORTAL_MIN_H };
    case "flow":
      return { w: FLOW_MIN_W, h: FLOW_MIN_H };
    case "media":
      return { w: MEDIA_MIN_W, h: MEDIA_MIN_H };
    case "doc":
      return { w: DOC_MIN_W, h: DOC_MIN_H };
    case "tree":
      return { w: TREE_MIN_W, h: TREE_MIN_H };
    case "binder":
      return { w: BINDER_MIN_W, h: BINDER_MIN_H };
    case "group":
      return { w: GROUP_MIN_W, h: GROUP_MIN_H };
    case undefined:
      return { w: NODE_MIN_W, h: NODE_MIN_H };
    default:
      return { w: 24, h: 24 };
  }
}

/** Writes a batch of destinations, cards and items alike (see `applyMoves` in the view). */
function applyMoves(c: CanvasData, elements: BoardElement[], moves: Moves): CanvasData {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const nodes = { ...c.nodes };
  for (const [id, p] of Object.entries(moves)) {
    const el = byId.get(id);
    if (el?.kind === "terminal") nodes[id] = { ...(c.nodes[id] ?? el.box), x: p.x, y: p.y };
  }
  return {
    ...c,
    nodes,
    items: c.items.map((it) => {
      const p = moves[it.id];
      const el = byId.get(it.id);
      if (!p || !el) return it;
      return translateItem(it, p.x - el.box.x, p.y - el.box.y);
    }),
  };
}

function resized(c: CanvasData, el: BoardElement, w: number, h: number): CanvasData {
  if (el.kind === "terminal") {
    return { ...c, nodes: { ...c.nodes, [el.id]: { ...(c.nodes[el.id] ?? el.box), w, h } } };
  }
  return {
    ...c,
    items: c.items.map((it) =>
      it.id === el.id && "w" in it && "h" in it ? ({ ...it, w, h } as CanvasItem) : it,
    ),
  };
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export function runCanvasCommand(input: CanvasCommandInput): CanvasCommandResult {
  const { canvas, elements, callerId } = input;
  const sub = (input.argv[0] ?? "").toLowerCase();
  const rest = input.argv.slice(1);

  const find = (name: string): BoardElement | null => {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    return (
      elements.find((e) => e.name.toLowerCase() === q) ??
      elements.find((e) => e.name.toLowerCase().startsWith(q)) ??
      null
    );
  };
  /** The element, or the reason it cannot be touched. */
  const resolve = (name: string): BoardElement | string => {
    const el = find(name);
    if (!el) return `yard: "${name}" não está no canvas. Rode \`yard canvas list\`.\n`;
    if (!el.wired) return `yard: "${el.name}" não está conectado a você.\n`;
    return el;
  };
  const resolveAll = (names: string[]): BoardElement[] | string => {
    const out: BoardElement[] = [];
    for (const n of names) {
      const r = resolve(n);
      if (typeof r === "string") return r;
      out.push(r);
    }
    return out;
  };
  const reach = () => elements.filter((e) => e.wired);
  const label = (e: BoardElement) => `${e.kind} "${e.name}"`;

  switch (sub) {
    case "list": {
      const p = parseFlags(rest, { "--json": "bool" });
      if (p.bool.json) return { ok: true, output: JSON.stringify(elements) + "\n" };
      const lines = elements.map((e) => {
        const flags = [
          e.id === callerId ? "você" : e.wired ? "conectado" : "",
          e.pinned ? "fixado" : "",
        ]
          .filter(Boolean)
          .join(", ");
        return `${label(e)}  x=${Math.round(e.box.x)} y=${Math.round(e.box.y)}  ${Math.round(e.box.w)}×${Math.round(e.box.h)}${flags ? `  [${flags}]` : ""}`;
      });
      return { ok: true, output: (lines.join("\n") || "Canvas vazio.") + "\n" };
    }

    case "move": {
      const p = parseFlags(rest, { "--by": "bool" });
      const [name, a, b] = p.positional;
      const x = num(a);
      const y = num(b);
      if (!name || x === null || y === null) return fail(USAGE);
      const el = resolve(name);
      if (typeof el === "string") return fail(el);
      if (el.pinned) return fail(`yard: "${el.name}" está fixado no lugar; \`yard canvas unpin\` primeiro.\n`);
      const to = p.bool.by ? { x: el.box.x + x, y: el.box.y + y } : { x, y };
      return {
        ok: true,
        canvas: applyMoves(canvas, elements, { [el.id]: to }),
        output: `${label(el)} agora em x=${Math.round(to.x)} y=${Math.round(to.y)}.\n`,
      };
    }

    case "resize": {
      const [name, a, b] = rest;
      const w = num(a);
      const h = num(b);
      if (!name || w === null || h === null) return fail(USAGE);
      const el = resolve(name);
      if (typeof el === "string") return fail(el);
      if (el.pinned) return fail(`yard: "${el.name}" está fixado no lugar; \`yard canvas unpin\` primeiro.\n`);
      const min = minSize(canvas, el);
      const fw = Math.max(min.w, Math.round(w));
      const fh = Math.max(min.h, Math.round(h));
      return {
        ok: true,
        canvas: resized(canvas, el, fw, fh),
        output: `${label(el)} agora com ${fw}×${fh}.\n`,
      };
    }

    case "arrange": {
      const p = parseFlags(rest, { "--layout": "string" });
      const layoutRaw = (p.string.layout ?? "grid").toLowerCase();
      if (layoutRaw !== "grid" && layoutRaw !== "row" && layoutRaw !== "column") return fail(USAGE);
      const layout = layoutRaw as TidyLayout;
      const chosen = p.positional.length ? resolveAll(p.positional) : reach();
      if (typeof chosen === "string") return fail(chosen);
      const movable = chosen.filter((e) => !e.pinned);
      if (movable.length < 2) return fail("yard: preciso de pelo menos dois elementos soltos para organizar.\n");
      const boxes = Object.fromEntries(movable.map((e) => [e.id, e.box]));
      const moves = tidyBoxes(boxes, layout);
      return {
        ok: true,
        canvas: applyMoves(canvas, elements, moves),
        output: `${movable.length} elementos organizados em ${layout === "grid" ? "grade" : layout === "row" ? "linha" : "coluna"}.\n`,
      };
    }

    case "align": {
      const [kindRaw, ...names] = rest;
      const kinds: AlignKind[] = ["left", "hcenter", "right", "top", "vcenter", "bottom"];
      const kind = kinds.find((k) => k === (kindRaw ?? "").toLowerCase());
      if (!kind || names.length < 2) return fail(USAGE);
      const chosen = resolveAll(names);
      if (typeof chosen === "string") return fail(chosen);
      const movable = chosen.filter((e) => !e.pinned);
      const boxes = Object.fromEntries(movable.map((e) => [e.id, e.box]));
      const moves = alignBoxes(boxes, kind);
      return {
        ok: true,
        canvas: applyMoves(canvas, elements, moves),
        output: `${chosen.length} elementos alinhados (${kind}).\n`,
      };
    }

    case "frame": {
      const [name, ...names] = rest;
      if (!name) return fail(USAGE);
      const chosen = names.length ? resolveAll(names) : reach();
      if (typeof chosen === "string") return fail(chosen);
      const box = frameAround(chosen.map((e) => e.box));
      if (!box) return fail("yard: nada para emoldurar.\n");
      return {
        ok: true,
        canvas: addFrame(canvas, frameItem(nanoid(8), box, name)),
        output: `Grupo "${name}" criado em volta de ${chosen.length} elemento(s).\n`,
      };
    }

    case "pin":
    case "unpin": {
      const [name] = rest;
      if (!name) return fail(USAGE);
      const el = resolve(name);
      if (typeof el === "string") return fail(el);
      const pin = sub === "pin";
      return {
        ok: true,
        canvas: setPinned(canvas, el.id, pin),
        output: pin ? `${label(el)} fixado no lugar.\n` : `${label(el)} solto.\n`,
      };
    }

    case "focus": {
      const [name] = rest;
      if (!name) return fail(USAGE);
      const el = find(name);
      if (!el) return fail(`yard: "${name}" não está no canvas. Rode \`yard canvas list\`.\n`);
      return { ok: true, camera: { center: el.id }, output: `Câmera em ${label(el)}.\n` };
    }

    case "zoom": {
      const raw = (rest[0] ?? "").toLowerCase();
      if (raw === "fit") return { ok: true, camera: { zoom: "fit" }, output: "Enquadrando tudo.\n" };
      const pct = num(raw.replace(/%$/, ""));
      if (pct === null || pct <= 0) return fail(USAGE);
      const zoom = raw.endsWith("%") || pct > 5 ? pct / 100 : pct;
      return { ok: true, camera: { zoom }, output: `Zoom em ${Math.round(zoom * 100)}%.\n` };
    }

    default:
      return fail(USAGE);
  }
}
