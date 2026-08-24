/**
 * "Is this terminal the thing the user is looking at?" — the workspace half
 * of the notification gate in `useGlobalEvents`.
 *
 * It lives apart from the hook because the other half is all browser state
 * (window focus, open modals, the editor over everything) while this half is
 * a rule about the group, and a rule that got harder after the canvas and the
 * grid stopped drawing the same terminals: a group shows **one** surface at a
 * time, so what is in front now depends on which of the two the card or the
 * tab lives on.
 */
import { normalizeSurface, type Surface } from "./surface";

interface Placed {
  id: string;
  slot: number;
  surface?: Surface | null;
}

/**
 * `gridTabs` are the group's terminals on the grid, in bar order — only used
 * to resolve the pane's default tab when nothing is pinned for that slot.
 */
export function isFrontOnScreen(
  layout: { surface: Surface; activeBySlot: Record<number, string> },
  row: Placed,
  gridTabs: Placed[],
): boolean {
  // The other surface is not behind a modal, it is simply not on screen.
  if (normalizeSurface(row.surface) !== layout.surface) return false;
  // On the board every card is visible at once — that is what a board is.
  if (layout.surface === "canvas") return true;
  const pinned = layout.activeBySlot[row.slot];
  // A pinned tab that has been closed decides nothing: the pane falls back to
  // its first, exactly like `TerminalPane` does when it paints.
  if (pinned && gridTabs.some((t) => t.id === pinned)) return pinned === row.id;
  return gridTabs.find((t) => t.slot === row.slot)?.id === row.id;
}
