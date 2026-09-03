/**
 * Is a portal's page covered by a full-window surface right now?
 *
 * The answer comes from `lib/layers`, the same registry that decides who owns
 * `Esc`: a modal, the Busca, the composer, the editor, the diff, Ao Vivo.
 * Each of them puts a backdrop over the whole window, and a portal's page,
 * an OS window no z-index reaches, has to be blanked under it or it paints
 * on top of the dialog. The pane browser and the canvas card both read this
 * one hook; the list used to be typed out in each, and each forgot one.
 */
import { useSyncExternalStore } from "react";

import { anyLayerOpen, subscribeLayers } from "../lib/layers";

export function usePortalsCovered(): boolean {
  return useSyncExternalStore(subscribeLayers, anyLayerOpen, anyLayerOpen);
}
