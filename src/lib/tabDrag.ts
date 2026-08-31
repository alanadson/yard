/**
 * Dragging tabs around the pane grid.
 *
 * Pointer events, not HTML5 drag-and-drop — with `dragDropEnabled` on (which
 * the window needs for its own drop handling) WRY swallows the OLE session on
 * Windows and `dragstart` never fires inside the WebView2. Driving the drag
 * by hand also buys the part the native ghost cannot do: a clone of the tab
 * glued to the pointer, instead of the washed-out OS snapshot.
 *
 * A tab in the bar can be one of three things — a CLI, an open file, a
 * browser — each living in its own store, each with its own move action.
 * The drop targets are read from the DOM (`data-pane-*` on the panes,
 * `data-tab-*` on the slots): the drag crosses pane components, and hit
 * testing with `elementFromPoint` is what lets one controller serve them all
 * without a shared React state. Nothing is written until the pointer is
 * released, so no re-render disturbs the drag mid-flight.
 *
 * `moveTab` then dispatches to the right store and repairs what the move
 * left behind: the pane a tab leaves may still point at it as its active
 * tab. Terminals self-heal (the pane falls back to its first CLI), but a
 * pane left holding only files or browsers has no fallback and would draw an
 * empty body until the next click. None of the stores can do it — fixing the
 * source pane needs all three, and the stores cannot import each other
 * without a cycle. A lib module can.
 */
import type { PointerEvent as ReactPointerEvent } from "react";

import { placeInBar, stepInBar, type TabKind } from "./paneBar";
import { paneTabs, saveBar } from "./paneTabs";

import { useBrowsers } from "../stores/browsersStore";
import { useEditor } from "../stores/editorStore";
import { NOTES_TAB_ID, useNotes } from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";

export type { TabKind };

/** Movement (px) that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD = 5;
/** `.pane-tabs` gap, part of the room a tab takes up in the bar. */
const BAR_GAP = 2;
/** How near the strip's edge the pointer drags it along, and by how much. */
const SCROLL_EDGE = 40;
const SCROLL_STEP = 16;

/** One slot of a bar, measured with nothing shifted out of place. */
interface SlotBase {
  el: HTMLElement;
  left: number;
  right: number;
  top: number;
}

/**
 * Grabs a tab. Wire it to the slot's `onPointerDown`; a plain click stays a
 * click — the drag only starts once the pointer travels past the threshold.
 */
export function beginTabDrag(
  e: ReactPointerEvent<HTMLElement>,
  kind: TabKind,
  id: string,
): void {
  if (e.button !== 0) return;
  const initialTarget = e.target as HTMLElement;
  // A press on the close button or inside a rename input is not a grab.
  if (initialTarget.closest(".pane-tab-close") || initialTarget.closest("input")) return;

  const sourceEl = e.currentTarget;
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  const rect = sourceEl.getBoundingClientRect();
  // Keep the grab point: the ghost holds the same spot under the finger the
  // real tab had, instead of snapping its corner to the pointer.
  const grabX = startX - rect.left;
  const grabY = startY - rect.top;
  /** The room the bar opens up: the tab's own width, gap included. */
  const roomW = rect.width + BAR_GAP;

  let dragging = false;
  let ghost: HTMLElement | null = null;
  /** Pane currently highlighted as the drop target. */
  let markedPane: HTMLElement | null = null;
  /** Slots currently pushed aside to make the hole. */
  const shifted = new Set<HTMLElement>();
  /** The strip currently holding the hole open, and paying for the room. */
  let padded: HTMLElement | null = null;
  /** Latest pointer position; the frame loop is what draws it. */
  let px = startX;
  let py = startY;
  let frame = 0;
  /** Where a release right now would put the tab. Refreshed every frame. */
  let drop: {
    paneEl: HTMLElement;
    beforeId: string | null;
    /** Top-left of the hole, for the ghost to land in. */
    x: number;
    y: number;
  } | null = null;

  /**
   * Every bar's geometry as it is *without* the hole, measured the first time
   * the drag visits it — while nothing in it has been pushed aside yet.
   *
   * Measuring live would be the obvious thing and is the wrong one: the slots
   * slide into place over ~160ms, so a rect read mid-slide sits between the
   * two positions and the hole would chase itself one frame behind, flickering
   * between two answers whenever the pointer rested near an edge. Scrolling is
   * the one thing that does move a bar during a drag, and it moves all of it
   * by the same amount — cheaper to subtract than to measure again.
   */
  const bases = new Map<HTMLElement, { scrollLeft: number; slots: SlotBase[] }>();
  const baseOf = (stripEl: HTMLElement): SlotBase[] => {
    let hit = bases.get(stripEl);
    if (!hit) {
      const slots: SlotBase[] = [];
      for (const el of stripEl.querySelectorAll<HTMLElement>("[data-tab-id]")) {
        if (el === sourceEl) continue;
        const r = el.getBoundingClientRect();
        slots.push({ el, left: r.left, right: r.right, top: r.top });
      }
      hit = { scrollLeft: stripEl.scrollLeft, slots };
      bases.set(stripEl, hit);
    } else if (hit.scrollLeft !== stripEl.scrollLeft) {
      const moved = stripEl.scrollLeft - hit.scrollLeft;
      for (const s of hit.slots) {
        s.left -= moved;
        s.right -= moved;
      }
      hit.scrollLeft = stripEl.scrollLeft;
    }
    return hit.slots;
  };

  /**
   * What the pointer is over: which pane, whether it is inside that pane's
   * strip, and — when it is — where in the bar the drop would land. Any kind
   * counts as a neighbour: that is what lets a CLI go between two files.
   */
  const aim = () => {
    // The ghost is `pointer-events: none`, so it never shadows the hit test.
    const el = document.elementFromPoint(px, py) as HTMLElement | null;
    const paneEl = el?.closest<HTMLElement>("[data-pane-slot]") ?? null;
    if (!paneEl) return null;
    const stripEl = el?.closest<HTMLElement>(".pane-tabs") ?? null;
    if (!stripEl) return { paneEl, stripEl: null, slots: [] as SlotBase[], index: 0 };
    const slots = baseOf(stripEl);
    // The half of a tab the pointer is on decides which side of it the hole
    // opens: the first tab whose middle is still ahead of the pointer.
    let index = slots.findIndex((s) => px < (s.left + s.right) / 2);
    if (index < 0) index = slots.length;
    return { paneEl, stripEl, slots, index };
  };

  /**
   * Pushes the slots after the hole aside, and puts back the ones before it.
   *
   * The strip is also given the room to hold them: it is exactly as wide as
   * its tabs and it scrolls, so a tab pushed past the last one would simply
   * be clipped — the bar would look like it had swallowed the page tab rather
   * than opened a hole. The extra room is the width of the tab in hand, which
   * is precisely what the collapsed source gave up, so a reorder inside one
   * bar leaves the strip (and the `+` beside it) exactly where it was.
   */
  const openHole = (stripEl: HTMLElement | null, slots: SlotBase[], index: number | null) => {
    if (padded && padded !== stripEl) {
      padded.style.paddingRight = "";
      padded = null;
    }
    if (stripEl && index !== null && padded !== stripEl) {
      padded = stripEl;
      stripEl.style.paddingRight = `${roomW}px`;
    }
    const wanted = new Set<HTMLElement>();
    if (index !== null) for (let i = index; i < slots.length; i++) wanted.add(slots[i].el);
    for (const el of [...shifted]) {
      if (wanted.has(el)) continue;
      el.style.transform = "";
      shifted.delete(el);
    }
    for (const el of wanted) {
      if (shifted.has(el)) continue;
      el.style.transform = `translate3d(${roomW}px, 0, 0)`;
      shifted.add(el);
    }
  };

  /** A bar wider than its strip scrolls itself while the tab hovers its edge. */
  const dragScroll = (stripEl: HTMLElement | null) => {
    if (!stripEl || stripEl.scrollWidth <= stripEl.clientWidth) return;
    const r = stripEl.getBoundingClientRect();
    if (py < r.top - 40 || py > r.bottom + 40) return;
    if (px < r.left + SCROLL_EDGE) stripEl.scrollLeft -= SCROLL_STEP;
    else if (px > r.right - SCROLL_EDGE) stripEl.scrollLeft += SCROLL_STEP;
  };

  /**
   * One frame: the ghost under the pointer, the hole where the drop would go,
   * the pane lit up when the aim is at a pane rather than at a place in its
   * bar. It runs on a loop rather than per event, so the strip keeps scrolling
   * while the pointer rests at its edge and the ghost never draws twice for
   * one frame.
   */
  const paint = () => {
    if (ghost) {
      // A hair bigger than the bar's own tabs: the one in hand is the one
      // nearer the eye, and the shadow underneath already says as much.
      ghost.style.transform = `translate3d(${px - grabX}px, ${py - grabY}px, 0) scale(1.03)`;
    }
    const at = aim();
    dragScroll(at?.stripEl ?? null);
    openHole(at?.stripEl ?? null, at?.slots ?? [], at?.stripEl ? at.index : null);
    // The pane glows only when the aim is not inside its bar — one signal at a
    // time, or the border reads as "somewhere in here" while the hole says
    // "exactly here".
    const wantsPane = at && !at.stripEl ? at.paneEl : null;
    if (markedPane && markedPane !== wantsPane) {
      markedPane.classList.remove("pane--dragover");
      markedPane = null;
    }
    if (wantsPane && markedPane !== wantsPane) {
      markedPane = wantsPane;
      wantsPane.classList.add("pane--dragover");
    }
    if (!at) {
      drop = null;
      return;
    }
    // The hole starts where the slot after it used to start; past the last
    // tab, one gap after that one ends. An empty bar starts at the strip.
    const last = at.slots[at.slots.length - 1];
    const stripRect = at.stripEl?.getBoundingClientRect();
    const x = at.stripEl
      ? (at.slots[at.index]?.left ??
        (last ? last.right + BAR_GAP : (stripRect?.left ?? rect.left)))
      : rect.left;
    const y = at.slots[0]?.top ?? stripRect?.top ?? rect.top;
    drop = {
      paneEl: at.paneEl,
      beforeId: at.stripEl ? (at.slots[at.index]?.el.dataset.tabId ?? null) : null,
      x,
      y,
    };
  };

  const loop = () => {
    frame = requestAnimationFrame(loop);
    paint();
  };

  const clearMarks = () => {
    openHole(null, [], null);
    markedPane?.classList.remove("pane--dragover");
    markedPane = null;
  };

  const endDrag = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    clearMarks();
    sourceEl.classList.remove("is-drag-source");
    document.body.classList.remove("is-tab-drag");
    try {
      sourceEl.releasePointerCapture(pointerId);
    } catch {
      /* the tab may have unmounted mid-drag */
    }
  };

  /**
   * The ghost settles into the hole instead of blinking out of existence: the
   * real tab is already being painted underneath, so the double fading into
   * its place is what makes the drop read as one movement.
   */
  const settleGhost = (to: { x: number; y: number } | null) => {
    const g = ghost;
    ghost = null;
    if (!g) return;
    if (!to) {
      g.remove();
      return;
    }
    g.style.transition = "transform 130ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 130ms";
    g.style.transform = `translate3d(${to.x}px, ${to.y}px, 0) scale(1)`;
    g.style.opacity = "0";
    setTimeout(() => g.remove(), 180);
  };

  /**
   * The release also dispatches a `click` on the tab under the pointer —
   * which would select whatever tab the drop landed on. One capture-phase
   * swallow, gone by the next task.
   */
  const swallowClick = () => {
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    px = ev.clientX;
    py = ev.clientY;
    if (dragging) return;
    if (Math.hypot(px - startX, py - startY) < DRAG_THRESHOLD) return;
    dragging = true;
    ghost = createGhost(sourceEl, rect.width);
    // The tab leaves the bar the moment it is in hand: the hole that opens
    // under the pointer is exactly as wide, so reordering inside one bar
    // never changes how wide the bar is.
    sourceEl.classList.add("is-drag-source");
    document.body.classList.add("is-tab-drag");
    // OS-level capture: the drag keeps working over the native browser
    // panes (separate HWNDs) and outside the window.
    try {
      sourceEl.setPointerCapture(pointerId);
    } catch {
      /* gone mid-press */
    }
    loop();
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const wasDrag = dragging;
    px = ev.clientX;
    py = ev.clientY;
    // One last aim at the exact release point: the pointer may have moved
    // since the last frame, and a drop must land where the eye last saw it.
    if (wasDrag) paint();
    const landed = wasDrag ? drop : null;
    endDrag();
    settleGhost(landed);
    if (!landed) return;
    swallowClick();
    moveTab(
      kind,
      id,
      landed.paneEl.dataset.paneGroup!,
      Number(landed.paneEl.dataset.paneSlot),
      landed.beforeId,
    );
  };

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    endDrag();
    settleGhost(null);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    // Cancelling the drag must not also close whatever Esc closes.
    ev.stopPropagation();
    endDrag();
    settleGhost(null);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

/** The tab's double that rides along under the pointer. */
function createGhost(sourceEl: HTMLElement, width: number): HTMLElement {
  const g = sourceEl.cloneNode(true) as HTMLElement;
  g.classList.remove("is-active", "is-drag-source");
  g.classList.add("tab-drag-ghost");
  g.style.width = `${width}px`;
  const r = sourceEl.getBoundingClientRect();
  // Born exactly over the tab it copies, so the lift reads as the tab coming
  // off the bar instead of a chip appearing out of nowhere.
  g.style.transform = `translate3d(${r.left}px, ${r.top}px, 0) scale(1)`;
  document.body.appendChild(g);
  return g;
}

/**
 * One step along the bar, left or right — the menu row and Ctrl+Shift+arrow.
 *
 * It walks the bar the eye sees, so the neighbour it trades places with may
 * be of another kind. A step into a wall (either end of the bar, or the line
 * between the pinned half and the loose one) moves nothing at all.
 */
export function moveTabBy(
  kind: TabKind,
  id: string,
  groupId: string,
  slot: number,
  dir: -1 | 1,
): void {
  const step = stepInBar(paneTabs(groupId, slot), id, dir);
  if (!step) return;
  moveTab(kind, id, groupId, slot, step.beforeId);
}

/** Where the tab lives right now — needed *before* the move, for the repair. */
function origin(kind: TabKind, id: string): { groupId: string; slot: number } | null {
  if (kind === "terminal") {
    const t = useProjects.getState().terminal(id);
    return t ? { groupId: t.groupId, slot: t.slot } : null;
  }
  if (kind === "doc") {
    const d = useEditor.getState().docs.find((x) => x.id === id);
    return d?.groupId ? { groupId: d.groupId, slot: d.slot } : null;
  }
  if (kind === "notes") {
    const p = useNotes.getState().place;
    return p.kind === "tab" ? { groupId: p.groupId, slot: p.slot } : null;
  }
  const b = useBrowsers.getState().tabs.find((x) => x.id === id);
  return b ? { groupId: b.groupId, slot: b.slot } : null;
}

/** Is this tab held at the front of its bar? The notebook never is. */
function isPinned(kind: TabKind, id: string): boolean {
  if (kind === "terminal") return useProjects.getState().terminal(id)?.pinned === true;
  if (kind === "doc") {
    return useEditor.getState().docs.find((d) => d.id === id)?.pinned === true;
  }
  if (kind === "notes") return false;
  return useBrowsers.getState().tabs.find((b) => b.id === id)?.pinned === true;
}

/**
 * Moves a tab of any kind to `slot`, right before the tab `beforeId` — of
 * **any** kind, which is what lets a CLI land between two files — or to the
 * end of the bar when `beforeId` is null.
 *
 * Two orders come out of one drop. The bar's own, interleaving the kinds, is
 * saved on the group's layout (`lib/paneBar.ts`). Each store still keeps its
 * kind in an order of its own — the sidebar tree and the Ctrl+PageUp cycle
 * read it — so the move is also handed to the store that owns the tab, with
 * the neighbour of its own kind that ends up after it in the new bar. The two
 * then say the same thing about the tabs they both can see.
 *
 * Last, it points the source pane's bar at a surviving neighbour, if it was
 * pointing at the tab that just left.
 */
export function moveTab(
  kind: TabKind,
  id: string,
  groupId: string,
  slot: number,
  beforeId: string | null,
): void {
  const before = origin(kind, id);
  const bar = placeInBar(paneTabs(groupId, slot), { id, kind, pinned: isPinned(kind, id) }, beforeId);
  const at = bar.findIndex((t) => t.id === id);
  // What the store is told: the next tab of the same kind, which is where its
  // own list has to reopen to keep the same relative order as the bar.
  const nextOfKind = bar.slice(at + 1).find((t) => t.kind === kind)?.id ?? null;

  if (kind === "terminal") useProjects.getState().moveTerminal(id, slot, nextOfKind);
  else if (kind === "doc") useEditor.getState().moveDoc(id, groupId, slot, nextOfKind);
  // The notebook is a single tab — there is no list of its own to order.
  else if (kind === "notes") useNotes.getState().dockTo(groupId, slot);
  else useBrowsers.getState().move(id, groupId, slot, nextOfKind);

  saveBar(groupId, slot, bar);
  // A drop always selects what was dropped; the stores do it for their own
  // move, but a move the store reads as a no-op (same pane, same neighbour)
  // still moved the tab in the bar.
  useProjects.getState().setActiveTab(groupId, slot, id);

  // Same pane = a reorder; there is no pane left behind to repair.
  if (!before || (before.groupId === groupId && before.slot === slot)) return;
  // The bar the tab left, minus the tab: read after the move, so the store
  // has already taken it out.
  saveBar(before.groupId, before.slot, paneTabs(before.groupId, before.slot));
  const { layoutOf, updateLayout, terminalsOn } = useProjects.getState();
  const layout = layoutOf(before.groupId);
  if (layout.activeBySlot[before.slot] !== id) return;
  const notes = useNotes.getState().place;
  const neighbor =
    terminalsOn(before.groupId, "grid").find((t) => t.slot === before.slot) ??
    useEditor
      .getState()
      .docs.find((d) => d.groupId === before.groupId && d.slot === before.slot) ??
    useBrowsers
      .getState()
      .tabs.find((b) => b.groupId === before.groupId && b.slot === before.slot) ??
    // The notebook tab counts as a neighbour too (already re-docked when it
    // is the one that moved, so it never claims the pane it just left).
    (notes.kind === "tab" && notes.groupId === before.groupId && notes.slot === before.slot
      ? { id: NOTES_TAB_ID }
      : undefined);
  const activeBySlot = { ...layout.activeBySlot };
  if (neighbor) activeBySlot[before.slot] = neighbor.id;
  else delete activeBySlot[before.slot];
  updateLayout(before.groupId, { activeBySlot });
}
