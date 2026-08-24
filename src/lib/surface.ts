/**
 * The two surfaces of a group — the pane grid and the canvas — and the rules
 * that keep them apart.
 *
 * They used to be the same place with two skins. `layoutJson.mode` held four
 * values (`auto | grid | spotlight | canvas`) and every terminal of the group
 * was drawn by whichever of the two was on screen: a CLI opened in a pane
 * showed up as a card on the board, and a card recruited on the board came
 * back as a tab the moment the group left canvas mode. Two consequences, both
 * bad: the canvas could never hold a board of its own, and picking Canvas
 * erased the Grade/Holofote the user had pinned, because it was the same
 * field.
 *
 * So the axis is split in two:
 *
 * - `mode` keeps only the grid shapes (`auto | grid | spotlight`);
 * - `surface` says which of the two the group is **showing**.
 *
 * And the same word marks the terminal: a CLI belongs to one surface and is
 * only ever drawn there.
 */

/** Where a terminal lives, and which of the two the group is showing. */
export type Surface = "grid" | "canvas";

/**
 * What a terminal with nothing written on it is. Everything that existed
 * before the split was born in a pane, and reading it as anything else would
 * empty the grid of workspaces that never opened the canvas.
 */
export const DEFAULT_SURFACE: Surface = "grid";

export function normalizeSurface(raw: unknown): Surface {
  return raw === "canvas" ? "canvas" : DEFAULT_SURFACE;
}

/** The grid shapes — what is left of the old `LayoutMode` once Canvas leaves. */
export type GridMode = "auto" | "grid" | "spotlight";

const GRID_MODES: GridMode[] = ["auto", "grid", "spotlight"];

/**
 * Reads the old four-valued `mode` into the pair that replaced it.
 *
 * `"canvas"` carried no grid shape with it, so there is nothing to restore:
 * the group comes back on the automatic grid, still showing the canvas —
 * which is what the user had on screen. From here on the two are remembered
 * separately and the round trip is lossless.
 */
export function splitLegacyMode(raw: unknown): { mode: GridMode; surface: Surface } {
  if (raw === "canvas") return { mode: "auto", surface: "canvas" };
  const mode = GRID_MODES.find((m) => m === raw) ?? "auto";
  return { mode, surface: "grid" };
}

/**
 * The terminals of one surface.
 *
 * Returns the very same array when nothing was filtered out: the grid and the
 * canvas re-render on the identity of this list, and a fresh array per call
 * would repaint every pane on every unrelated store write.
 */
export function onSurface<T extends { surface?: Surface | null }>(
  list: T[],
  surface: Surface,
): T[] {
  const kept = list.filter((t) => normalizeSurface(t.surface) === surface);
  return kept.length === list.length ? list : kept;
}
