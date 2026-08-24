/**
 * Frames ("grupos"): naming a region of the board, and carrying what stands
 * in it (§5.4).
 *
 * A frame is organizational and nothing else. It does not own its members, it
 * does not gate their wiring, and deleting it does not delete them — the spec
 * is explicit that the group "não deve impedir comunicação ou seleção dos
 * elementos internos".
 *
 * That is why membership here is **geometric**, not a stored `members: []`.
 * A list of ids is a second source of truth about where things are, and this
 * board has four writers (the user, `yard`, a routine, a score being applied)
 * — any of them can delete a card, paste a copy or drag something out, and
 * every one of those would have to remember to fix the list. Containment can
 * never disagree with the screen: what the user sees inside the frame *is*
 * what the frame holds.
 *
 * The cost of that choice is that a member has to be **fully** inside. A card
 * parked half across the border belongs to nobody, which is both easy to
 * explain and easy to fix by nudging it.
 */
import type { Box, CanvasData, CanvasItem } from "./canvas";

/** Air left between the members and the frame drawn around them, in world px. */
export const GROUP_PAD = 28;

/**
 * The title band at the top of the frame, in world px.
 *
 * It is the only part of the frame that takes a pointer: the body has to stay
 * transparent to clicks or selecting a card inside it would be impossible.
 * `frameAround` reserves it *above* the content for the same reason — a band
 * drawn over the first card would steal that card's own drag.
 */
export const GROUP_HEAD = 34;

export const GROUP_MIN_W = 120;
export const GROUP_MIN_H = GROUP_HEAD + 60;

/** Longest frame name that still reads on the band at a normal zoom. */
export const GROUP_NAME_MAX = 48;

/** What a frame is called when the user has not named it yet. */
export const GROUP_DEFAULT_NAME = "Grupo";

/** Is `inner` entirely within `outer`? The definition of membership. */
export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * Ids of everything the frame holds.
 *
 * `selfId` is the frame's own id when it is present in `boxes`: a box is
 * trivially inside itself, and a frame that counted as its own member would be
 * moved twice by the same drag — once as the grabbed item, once as a member.
 */
export function membersOf(
  frame: Box,
  boxes: Record<string, Box>,
  selfId?: string,
): string[] {
  const out: string[] = [];
  for (const [id, b] of Object.entries(boxes)) {
    if (id === selfId) continue;
    if (contains(frame, b)) out.push(id);
  }
  return out;
}

/** A frame on the board: its id and the rectangle it occupies. */
export interface FrameRef {
  id: string;
  box: Box;
}

/**
 * The set a drag really moves: whatever was grabbed, plus what any grabbed
 * frame holds — including through a frame that a frame holds.
 *
 * The loop is a worklist rather than one pass because "held by" is only
 * transitive while every frame is fully inside its parent. Two frames that
 * merely overlap are a shape the user can draw in a second, and a single pass
 * there would move the inner frame and leave its cards behind.
 */
export function withGroupMembers(
  ids: ReadonlySet<string>,
  frames: readonly FrameRef[],
  boxes: Record<string, Box>,
): Set<string> {
  const out = new Set(ids);
  const queue = [...ids];
  const byId = new Map(frames.map((f) => [f.id, f] as const));
  while (queue.length) {
    const current = queue.pop()!;
    const frame = byId.get(current);
    if (!frame) continue;
    for (const member of membersOf(frame.box, boxes, frame.id)) {
      if (out.has(member)) continue;
      out.add(member);
      queue.push(member);
    }
  }
  return out;
}

/**
 * The frame that wraps these boxes: their union, padded, with the title band
 * reserved on top. `null` for an empty selection — there is no frame around
 * nothing, and the caller should not create an item.
 */
export function frameAround(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return {
    x: x - GROUP_PAD,
    y: y - GROUP_PAD - GROUP_HEAD,
    w: right - x + GROUP_PAD * 2,
    h: bottom - y + GROUP_PAD * 2 + GROUP_HEAD,
  };
}

/** Default ink of a frame: the quietest neutral, so it frames without shouting. */
export const GROUP_COLOR = "#6b6b6b";

/** The frame item for a rectangle. */
export function frameItem(
  id: string,
  box: Box,
  name: string = GROUP_DEFAULT_NAME,
  color: string = GROUP_COLOR,
): CanvasItem {
  return {
    id,
    type: "group",
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    name: name.trim().slice(0, GROUP_NAME_MAX) || GROUP_DEFAULT_NAME,
    color,
  };
}

/**
 * Adds a frame **behind** everything else.
 *
 * Paint order on this board is array order, so a frame appended the usual way
 * would land on top of the very cards it wraps — its border cutting across
 * them, its band covering the first one. A frame is background by nature; it
 * goes in at the head of the list.
 */
export function addFrame(c: CanvasData, frame: CanvasItem): CanvasData {
  return { ...c, items: [frame, ...c.items] };
}
