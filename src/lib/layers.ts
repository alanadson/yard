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
 *
 * The same registry answers a second question: **is a portal covered?** A
 * portal's page is an OS window parented to the main one, and no z-index
 * reaches it: behind a full-window backdrop it has to be blanked outright
 * (`PortalPlace.visible`), or the site paints over the dialog. That list used
 * to be written by hand in two components, and it forgot the Busca: opening
 * Search over a browser pane put the page on top of the palette. Now a
 * surface that joins this list covers the portals by the same act.
 */
import { useChanges } from "../stores/changesStore";
import { useEditor } from "../stores/editorStore";
import { useLive } from "../stores/liveStore";
import { useUI } from "../stores/uiStore";

export type Layer = "busca" | "modal" | "compositor" | "editor" | "viewer" | "live";

/** What `subscribeLayers` needs from a store: the Zustand `subscribe`. */
interface Watchable {
  subscribe: (listener: () => void) => () => void;
}

interface LayerEntry {
  layer: Layer;
  isOpen: () => boolean;
  /** The store whose change can open or close this layer. */
  store: Watchable;
}

/** Highest to lowest. */
const LAYERS: ReadonlyArray<LayerEntry> = [
  // The Busca paints above everything else: it is the surface that *takes you
  // somewhere*, so while it is up it owns `Esc` no matter what is underneath.
  { layer: "busca", isOpen: () => useUI.getState().paletteOpen, store: useUI },
  { layer: "modal", isOpen: () => useUI.getState().modal !== null, store: useUI },
  // The composer stopped being a box in the corner and became a dialog in the
  // middle of the window, so it belongs in this list — under a modal, which
  // paints above it, and over the editor, which it can be opened on top of.
  { layer: "compositor", isOpen: () => useUI.getState().composerOpen, store: useUI },
  { layer: "editor", isOpen: () => useEditor.getState().open, store: useEditor },
  // The notebook is not here on purpose: in the centre it *replaces* the grid
  // and the canvas (a view, with the panels beside it still at hand), and as
  // a tab it is part of a pane. Neither covers anything, so neither owns Esc.
  { layer: "viewer", isOpen: () => useChanges.getState().viewer !== null, store: useChanges },
  { layer: "live", isOpen: () => useLive.getState().phase !== "closed", store: useLive },
];

/** The current top surface, or `null` when the window is clear. */
export function topLayer(): Layer | null {
  return LAYERS.find((entry) => entry.isOpen())?.layer ?? null;
}

/** Is this surface the top one? If not, it lets the key through. */
export function isTopLayer(layer: Layer): boolean {
  return topLayer() === layer;
}

/**
 * Is any surface covering the window? For a portal this is the answer to
 * "blank the page": whatever is up, there is a backdrop between the user and
 * the site, and the site must not paint through it.
 */
export function anyLayerOpen(): boolean {
  return topLayer() !== null;
}

/**
 * Calls `onChange` whenever a store behind any layer changes: the
 * subscription half of `useSyncExternalStore`, with `anyLayerOpen` (or
 * `topLayer`) as the snapshot. One subscription per distinct store, however
 * many layers it backs.
 */
export function subscribeLayers(onChange: () => void): () => void {
  const stores = [...new Set(LAYERS.map((entry) => entry.store))];
  const offs = stores.map((store) => store.subscribe(onChange));
  return () => {
    for (const off of offs) off();
  };
}
