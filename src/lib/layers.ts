/**
 * Who is on top — the order of the surfaces that cover the window.
 *
 * They all listen for `Escape` on the window, and a window listener fires in
 * the order it was **registered**, not in the order the surfaces stack. With
 * the diff open and the editor above it, an `Esc` closed the diff (which
 * mounted first) and left the editor standing; with a modal, it closed both
 * at once.
 *
 * Each surface asks here whether it is the top one before handling the key.
 * The order below tracks the `z-index` of the respective overlays in
 * `styles.css` — touching one without the other brings the bug back.
 */
import { useChanges } from "../stores/changesStore";
import { useEditor } from "../stores/editorStore";
import { useLive } from "../stores/liveStore";
import { notesOverlayVisible } from "../stores/notesStore";
import { useUI } from "../stores/uiStore";

export type Layer =
  | "busca"
  | "modal"
  | "compositor"
  | "editor"
  | "anotacoes"
  | "viewer"
  | "live";

/** Highest to lowest. */
const ORDER: Layer[] = [
  "busca",
  "modal",
  "compositor",
  "editor",
  "anotacoes",
  "viewer",
  "live",
];

const IS_OPEN: Record<Layer, () => boolean> = {
  // The Busca paints above everything else: it is the surface that *takes you
  // somewhere*, so while it is up it owns `Esc` no matter what is underneath.
  busca: () => useUI.getState().paletteOpen,
  modal: () => useUI.getState().modal !== null,
  // The composer stopped being a box in the corner and became a dialog in the
  // middle of the window, so it belongs in this list — under a modal, which
  // paints above it, and over the editor, which it can be opened on top of.
  compositor: () => useUI.getState().composerOpen,
  editor: () => useEditor.getState().open,
  // Only the overlay covers the window — docked or central, the notebook is
  // part of the workspace and must not swallow anyone's Esc.
  anotacoes: () => notesOverlayVisible(),
  viewer: () => useChanges.getState().viewer !== null,
  live: () => useLive.getState().phase !== "closed",
};

/** The current top surface, or `null` when the window is clear. */
export function topLayer(): Layer | null {
  return ORDER.find((layer) => IS_OPEN[layer]()) ?? null;
}

/** Is this surface the top one? If not, it lets the key through. */
export function isTopLayer(layer: Layer): boolean {
  return topLayer() === layer;
}

/** Is any surface covering the window? */
export function anyLayerOpen(): boolean {
  return topLayer() !== null;
}
