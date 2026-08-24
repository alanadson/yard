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

import { useBrowsers } from "../stores/browsersStore";
import { useEditor } from "../stores/editorStore";
import { NOTES_TAB_ID, useNotes } from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";

export type TabKind = "terminal" | "doc" | "browser" | "notes";

/** Movement (px) that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD = 5;

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

  let dragging = false;
  let ghost: HTMLElement | null = null;
  /** Slot currently wearing the insertion caret. */
  let marked: HTMLElement | null = null;
  /** Pane currently highlighted as the drop target. */
  let markedPane: HTMLElement | null = null;

  /** What the pointer is over: a same-kind tab (and which half), or a pane. */
  const targetAt = (x: number, y: number) => {
    // The ghost is `pointer-events: none`, so it never shadows the hit test.
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const paneEl = el?.closest<HTMLElement>("[data-pane-slot]") ?? null;
    const slotEl = el?.closest<HTMLElement>("[data-tab-id]") ?? null;
    if (
      slotEl &&
      paneEl &&
      slotEl.dataset.tabKind === kind &&
      slotEl.dataset.tabId !== id
    ) {
      const r = slotEl.getBoundingClientRect();
      return { slotEl, paneEl, after: x > r.left + r.width / 2 };
    }
    return { slotEl: null, paneEl, after: false };
  };

  const clearMarks = () => {
    marked?.classList.remove("drop-before", "drop-after");
    marked = null;
    markedPane?.classList.remove("pane--dragover");
    markedPane = null;
  };

  const endDrag = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    clearMarks();
    ghost?.remove();
    ghost = null;
    sourceEl.classList.remove("is-drag-source");
    document.body.classList.remove("is-tab-drag");
    try {
      sourceEl.releasePointerCapture(pointerId);
    } catch {
      /* the tab may have unmounted mid-drag */
    }
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
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) {
        return;
      }
      dragging = true;
      ghost = createGhost(sourceEl, rect.width);
      sourceEl.classList.add("is-drag-source");
      document.body.classList.add("is-tab-drag");
      // OS-level capture: the drag keeps working over the native browser
      // panes (separate HWNDs) and outside the window.
      try {
        sourceEl.setPointerCapture(pointerId);
      } catch {
        /* gone mid-press */
      }
    }
    if (ghost) {
      ghost.style.transform = `translate(${ev.clientX - grabX}px, ${ev.clientY - grabY}px)`;
    }

    const { slotEl, paneEl, after } = targetAt(ev.clientX, ev.clientY);
    if (marked && marked !== slotEl) {
      marked.classList.remove("drop-before", "drop-after");
      marked = null;
    }
    if (slotEl) {
      marked = slotEl;
      marked.classList.toggle("drop-after", after);
      marked.classList.toggle("drop-before", !after);
    }
    // The pane glow only when not aiming between two tabs — one signal at a
    // time, or the border reads as "somewhere in here" while the caret says
    // "exactly here".
    const wantsPane = slotEl ? null : paneEl;
    if (markedPane && markedPane !== wantsPane) {
      markedPane.classList.remove("pane--dragover");
      markedPane = null;
    }
    if (wantsPane && markedPane !== wantsPane) {
      markedPane = wantsPane;
      wantsPane.classList.add("pane--dragover");
    }
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const wasDrag = dragging;
    const { slotEl, paneEl, after } = targetAt(ev.clientX, ev.clientY);
    endDrag();
    if (!wasDrag || !paneEl) return;
    swallowClick();
    const groupId = paneEl.dataset.paneGroup!;
    const slot = Number(paneEl.dataset.paneSlot);
    if (slotEl) {
      // Right half = right after the target: before the target's next
      // sibling of the same kind, or the end of the section when the target
      // closes it. (The next sibling can be the dragged tab itself — that is
      // the same position, and `moveTab` treats it as the no-op it is.)
      const following = slotEl.nextElementSibling as HTMLElement | null;
      const beforeId = after
        ? following?.dataset.tabKind === kind
          ? (following.dataset.tabId ?? null)
          : null
        : (slotEl.dataset.tabId ?? null);
      moveTab(kind, id, groupId, slot, beforeId);
    } else {
      moveTab(kind, id, groupId, slot, null);
    }
  };

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) endDrag();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    // Cancelling the drag must not also close whatever Esc closes.
    ev.stopPropagation();
    endDrag();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

/** The tab's double that rides along under the pointer. */
function createGhost(sourceEl: HTMLElement, width: number): HTMLElement {
  const g = sourceEl.cloneNode(true) as HTMLElement;
  g.classList.remove("is-active", "drop-before", "drop-after");
  g.classList.add("tab-drag-ghost");
  g.style.width = `${width}px`;
  document.body.appendChild(g);
  return g;
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

/**
 * Moves a tab of any kind to `slot`, right before the tab `beforeId` (of the
 * same kind, in the target pane) — or to the end of its kind's section when
 * `beforeId` is null. Then points the source pane's bar at a surviving
 * neighbour, if it was pointing at the tab that just left.
 */
export function moveTab(
  kind: TabKind,
  id: string,
  groupId: string,
  slot: number,
  beforeId: string | null,
): void {
  const before = origin(kind, id);

  if (kind === "terminal") useProjects.getState().moveTerminal(id, slot, beforeId);
  else if (kind === "doc") useEditor.getState().moveDoc(id, groupId, slot, beforeId);
  // The notebook is a single tab — `beforeId` has no section to order.
  else if (kind === "notes") useNotes.getState().dockTo(groupId, slot);
  else useBrowsers.getState().move(id, groupId, slot, beforeId);

  // Same pane = a reorder; there is no pane left behind to repair.
  if (!before || (before.groupId === groupId && before.slot === slot)) return;
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
