/**
 * Fichários (§13): several notes in one node, behind a strip of tabs.
 *
 * The problem it solves is a board that turned into a wall of stickers. Five
 * notes about the same feature take five rectangles of a canvas whose scarcest
 * resource is room; one fichário takes one, and the four you are not reading
 * are a click away instead of a pan away.
 *
 * **A filed note is still a note.** The binder holds ids, never copies, and
 * the note itself stays exactly where it always was — an item in
 * `canvas.items`. That is what keeps `yard note read/write/edit` working on a
 * filed note, keeps the wires drawn to it alive (they anchor on the binder's
 * rectangle, see `CanvasView`), keeps it in the global search and keeps the
 * user's lock meaningful. Filing changes **where a note is drawn**, and
 * nothing else about it.
 *
 * Two invariants hold everything up, and both are enforced here rather than
 * trusted:
 *
 * 1. **A note is in at most one binder.** `fileIntoBinder` takes it out of
 *    whichever binder had it first, in the same transformation.
 * 2. **A binder never shows a tab whose note is gone.** `yard note delete` can
 *    take a filed note out from under it, so the tab list is filtered against
 *    the live items every time it is read, and `normalizeCanvas` prunes the
 *    dead ids on load.
 */
import type { CanvasData, CanvasItem } from "./canvas";

export type BinderItem = Extract<CanvasItem, { type: "binder" }>;
export type NoteItem = Extract<CanvasItem, { type: "note" }>;

export const BINDER_MIN_W = 220;
export const BINDER_MIN_H = 160;
export const BINDER_DEFAULT_W = 380;
export const BINDER_DEFAULT_H = 300;

/** Longest pinned name that still reads on the binder's header. */
export const BINDER_NAME_MAX = 48;

/** Height of the header plus the tab strip, in world px. */
export const BINDER_CHROME = 56;

/** Where a note released from a binder lands, relative to the binder. */
const RELEASE_GAP = 24;

/** Ids of every note currently drawn inside some binder. */
export function filedNoteIds(items: readonly CanvasItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    if (it.type !== "binder") continue;
    for (const id of it.notes) out.add(id);
  }
  return out;
}

/** The binder holding this note, if any. */
export function binderHolding(
  items: readonly CanvasItem[],
  noteId: string,
): BinderItem | undefined {
  return items.find(
    (i): i is BinderItem => i.type === "binder" && i.notes.includes(noteId),
  );
}

/**
 * The notes behind the tabs, in the binder's own order.
 *
 * Filtered against the live items on every read: an id whose note the CLI
 * deleted must not draw a tab onto an empty page.
 */
export function binderTabs(
  binder: BinderItem,
  items: readonly CanvasItem[],
): NoteItem[] {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const out: NoteItem[] = [];
  for (const id of binder.notes) {
    const it = byId.get(id);
    if (it?.type === "note") out.push(it);
  }
  return out;
}

/**
 * Which note is on screen. Falls back to the first tab rather than showing
 * nothing: `active` goes stale every time a tab is removed, and a blank
 * fichário full of notes is worse than the wrong one.
 */
export function activeNoteId(
  binder: BinderItem,
  items: readonly CanvasItem[],
): string | null {
  const tabs = binderTabs(binder, items);
  if (!tabs.length) return null;
  const at = binder.active ?? 0;
  return (tabs[at] ?? tabs[0]).id;
}

/** Replaces one binder in the canvas. */
function patchBinder(
  c: CanvasData,
  id: string,
  fn: (b: BinderItem) => BinderItem,
): CanvasData {
  return {
    ...c,
    items: c.items.map((i) => (i.id === id && i.type === "binder" ? fn(i) : i)),
  };
}

/**
 * Files a note into a binder, and shows it.
 *
 * Only a note: a portal has a live browser glued to its rectangle and a
 * terminal card is a process — neither survives being drawn inside a tab
 * strip, and refusing here is cheaper than explaining the wreckage later.
 */
export function fileIntoBinder(
  c: CanvasData,
  binderId: string,
  noteId: string,
): CanvasData {
  if (binderId === noteId) return c;
  const target = c.items.find((i) => i.id === binderId);
  const note = c.items.find((i) => i.id === noteId);
  if (target?.type !== "binder" || note?.type !== "note") return c;
  if (target.notes.includes(noteId)) return c;

  const items = c.items.map((i) => {
    if (i.type !== "binder") return i;
    // Invariant 1, applied in the same pass: whoever had it, loses it.
    if (i.id === binderId) {
      const notes = [...i.notes, noteId];
      return { ...i, notes, active: notes.length - 1 };
    }
    if (!i.notes.includes(noteId)) return i;
    const notes = i.notes.filter((n) => n !== noteId);
    return { ...i, notes, active: clampActive(i.active, notes.length) };
  });
  return { ...c, items };
}

function clampActive(active: number | undefined, count: number): number | undefined {
  if (!count) return undefined;
  const at = active ?? 0;
  return at < count ? at : count - 1;
}

/**
 * Takes a note out of whichever binder holds it and drops it back on the
 * board, beside that binder.
 *
 * The position matters: a filed note's own `x`/`y` are stale — they are
 * wherever it sat before it was filed, which may now be under a card, off
 * screen, or in another corner entirely. Releasing it there looks exactly
 * like losing it.
 */
export function removeFromBinder(c: CanvasData, noteId: string): CanvasData {
  const binder = binderHolding(c.items, noteId);
  if (!binder) return c;
  const at = binder.notes.indexOf(noteId);
  return {
    ...c,
    items: c.items.map((i) => {
      if (i.id === binder.id && i.type === "binder") {
        const notes = i.notes.filter((n) => n !== noteId);
        return { ...i, notes, active: clampActive(i.active, notes.length) };
      }
      if (i.id !== noteId || i.type !== "note") return i;
      return {
        ...i,
        x: binder.x + binder.w + RELEASE_GAP,
        y: binder.y + at * RELEASE_GAP,
      };
    }),
  };
}

/**
 * Frees every note a binder holds — what deleting the binder has to do first.
 *
 * Deleting a fichário is deleting a container, and a container that takes its
 * contents with it is a trapdoor. The notes are laid out in a diagonal
 * cascade beside where the binder was, so a fichário of six does not come back
 * as six rectangles stacked on one pixel.
 */
export function releaseNotes(c: CanvasData, binderId: string): CanvasData {
  const binder = c.items.find((i) => i.id === binderId);
  if (binder?.type !== "binder" || !binder.notes.length) return c;
  const at = new Map(binder.notes.map((id, i) => [id, i] as const));
  return {
    ...c,
    items: c.items.map((i) => {
      const index = at.get(i.id);
      if (index == null || i.type !== "note") return i;
      return {
        ...i,
        x: binder.x + binder.w + RELEASE_GAP + index * RELEASE_GAP,
        y: binder.y + index * RELEASE_GAP,
      };
    }),
  };
}

/**
 * Moves a tab. Reordering is arranging, not navigating — the page under the
 * user's eyes has to stay put, so `active` follows the note it was on.
 */
export function reorderTab(
  c: CanvasData,
  binderId: string,
  from: number,
  to: number,
): CanvasData {
  return patchBinder(c, binderId, (b) => {
    if (from === to || from < 0 || from >= b.notes.length) return b;
    const showing = b.notes[b.active ?? 0];
    const notes = [...b.notes];
    const [moved] = notes.splice(from, 1);
    notes.splice(Math.max(0, Math.min(notes.length, to)), 0, moved);
    const active = notes.indexOf(showing);
    return { ...b, notes, active: active < 0 ? 0 : active };
  });
}

/** Brings a tab to the front by its note id. */
export function showTab(c: CanvasData, binderId: string, noteId: string): CanvasData {
  return patchBinder(c, binderId, (b) => {
    const at = b.notes.indexOf(noteId);
    return at < 0 ? b : { ...b, active: at };
  });
}
