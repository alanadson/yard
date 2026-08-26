/**
 * Keeps the language servers in step with what is open.
 *
 * The editor asks for a client when a file needs one (`CmSurface`); this is
 * the other half — letting go. A root with no file open loses its servers
 * after a grace period, and turning the preference off stops all of them,
 * so a `rust-analyzer` never sits on two gigabytes for a project the user
 * left an hour ago.
 */
import { useEffect } from "react";

import { useEditor } from "../stores/editorStore";
import { useLsp } from "../stores/lspStore";
import { useUI } from "../stores/uiStore";

/** The roots that still have a text file open. */
export function openRootsOf(docs: readonly { root: string }[]): Set<string> {
  return new Set(docs.map((d) => d.root).filter((r) => r.length > 0));
}

export function useLspLifecycle() {
  useEffect(() => {
    const unsubDocs = useEditor.subscribe((state, prev) => {
      if (state.docs === prev.docs) return;
      useLsp.getState().pruneRoots(openRootsOf(state.docs));
    });
    const unsubPref = useUI.subscribe((state, prev) => {
      if (state.prefs.lspEnabled === prev.prefs.lspEnabled) return;
      if (!state.prefs.lspEnabled) useLsp.getState().stopAll();
    });
    return () => {
      unsubDocs();
      unsubPref();
    };
  }, []);
}
