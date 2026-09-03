/**
 * What a card's chrome does to the board: paint order, pinning, maximize.
 *
 * All three are `CanvasData -> CanvasData` (or `CanvasNode -> CanvasNode`),
 * with no React and no store, because each one carries a promise that only a
 * test can hold: "to the front" is above *every* card, a pinned card is left
 * out of every moving set, and maximize gives back the exact rectangle it
 * took, whatever the camera did in between.
 */
import { NODE_MIN_H, NODE_MIN_W, type Box, type CanvasData, type CanvasNode } from "./canvas";

// ---------------------------------------------------------------------------
// paint order
// ---------------------------------------------------------------------------

/** The ids in paint order: lowest `z` first, ties in the order given. */
export function nodeOrder(
  ids: readonly string[],
  nodes: Record<string, CanvasNode>,
): string[] {
  return [...ids].sort((a, b) => (nodes[a]?.z ?? 0) - (nodes[b]?.z ?? 0));
}

function zOf(nodes: Record<string, CanvasNode>): number[] {
  return Object.values(nodes).map((n) => n.z ?? 0);
}

/** Puts the card above every other card. */
export function raiseNode(c: CanvasData, id: string): CanvasData {
  const n = c.nodes[id];
  if (!n) return c;
  const top = Math.max(0, ...zOf(c.nodes));
  return { ...c, nodes: { ...c.nodes, [id]: { ...n, z: top + 1 } } };
}

/** Puts the card below every other card. */
export function lowerNode(c: CanvasData, id: string): CanvasData {
  const n = c.nodes[id];
  if (!n) return c;
  const bottom = Math.min(0, ...zOf(c.nodes));
  return { ...c, nodes: { ...c.nodes, [id]: { ...n, z: bottom - 1 } } };
}

// ---------------------------------------------------------------------------
// pinned
// ---------------------------------------------------------------------------

/**
 * Pins or unpins a card or an item. Unpinning removes the field: a `false`
 * written into every rectangle of the workspace JSON says nothing.
 */
export function setPinned(c: CanvasData, id: string, pinned: boolean): CanvasData {
  const n = c.nodes[id];
  if (n) {
    const { pinned: _was, ...rest } = n;
    return { ...c, nodes: { ...c.nodes, [id]: pinned ? { ...rest, pinned: true } : rest } };
  }
  return {
    ...c,
    items: c.items.map((it) => {
      if (it.id !== id) return it;
      const { pinned: _was, ...rest } = it;
      return pinned ? { ...rest, pinned: true } : rest;
    }),
  };
}

/** Everything fixed in place, cards and items together. */
export function pinnedIds(c: CanvasData): Set<string> {
  const out = new Set<string>();
  for (const [id, n] of Object.entries(c.nodes)) if (n.pinned) out.add(id);
  for (const it of c.items) if (it.pinned) out.add(it.id);
  return out;
}

// ---------------------------------------------------------------------------
// maximize
// ---------------------------------------------------------------------------

/**
 * The rectangle a maximized card takes: the visible world minus a margin.
 * The margin is given in screen px and divided by the zoom, so the card
 * stops the same distance from the edge whatever the camera is doing.
 */
export function maximizedRect(view: Box, zoom: number, padPx = 20): Box {
  const pad = padPx / Math.max(zoom, 0.01);
  return {
    x: view.x + pad,
    y: view.y + pad,
    w: Math.max(NODE_MIN_W, view.w - pad * 2),
    h: Math.max(NODE_MIN_H, view.h - pad * 2),
  };
}

/**
 * Maximizes a card, or restores it when it already is.
 *
 * The old rectangle travels inside the node (`restore`), so the round trip
 * survives a reload and does not depend on where the camera went meanwhile.
 * Everything else on the node (colour, font, pin) is untouched.
 */
export function toggleMaximize(node: CanvasNode, view: Box, zoom: number): CanvasNode {
  if (node.restore) {
    const { restore, ...rest } = node;
    return { ...rest, ...restore };
  }
  return {
    ...node,
    ...maximizedRect(view, zoom),
    restore: { x: node.x, y: node.y, w: node.w, h: node.h },
  };
}
