import { useRef } from "react";
import { ask } from "../lib/confirmation";
import { exitWithDraft } from "../lib/draftExit";
import { useT } from "./useT";

/** The header, backdrop, Escape and Cancel share the same discard decision. */
export function useDraftExit(dirty: boolean, close: () => void) {
  const pending = useRef(false);
  const t = useT();
  return () => {
    if (pending.current) return;
    pending.current = true;
    void exitWithDraft(
      dirty,
      () =>
        ask(t("Há alterações não salvas. Descartar o rascunho?"), {
          title: t("Descartar rascunho"),
          kind: "warning",
          okLabel: t("Descartar"),
          cancelLabel: t("Continuar editando"),
        }),
      close,
    ).finally(() => {
      pending.current = false;
    });
  };
}
