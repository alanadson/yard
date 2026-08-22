import { ask } from "@tauri-apps/plugin-dialog";

import { copyText } from "./clipboard";
import { editorTabMenu } from "./editorTabMenu";
import { ipc } from "./ipc";
import { fileName } from "./paths";
import type { MenuEntry } from "../components/ContextMenu";
import { isDirty, isReadOnly, useEditor, type OpenDoc } from "../stores/editorStore";
import { useUI } from "../stores/uiStore";

/** Closes an editor tab, preserving the same unsaved-draft guard in every host. */
export async function closeDocTab(id: string): Promise<void> {
  const doc = useEditor.getState().docs.find((candidate) => candidate.id === id);
  if (doc && isDirty(doc) && !isReadOnly(doc)) {
    const sure = await ask(
      `“${fileName(doc.path)}” tem alterações não salvas. Fechar a aba descarta o que você escreveu.`,
      { title: "Fechar sem salvar?", kind: "warning" },
    );
    if (!sure) return;
  }
  useEditor.getState().closeDoc(id);
}

/**
 * The context menu of a file tab, already wired to the stores.
 *
 * File tabs show up in two places — the pane's tab bar, next to the CLIs, and
 * the overlay editor's header. Both show exactly this menu: diverging here is
 * how one of them ends up without "close the others" on the next change.
 *
 * `closeMany` closes one at a time through `closeDocTab`, so every tab with a
 * draft still asks before vanishing — "close the others" cannot be a way to
 * discard work without anyone being told.
 */
export function docTabMenu(doc: OpenDoc, docs: readonly OpenDoc[]): MenuEntry[] {
  const toast = (text: string, kind?: "info" | "error") =>
    useUI.getState().showToast(text, kind);
  return editorTabMenu(
    {
      id: doc.id,
      path: doc.path,
      root: doc.root,
      dirty: isDirty(doc),
      readOnly: isReadOnly(doc),
      missing: doc.missing,
    },
    docs.map((d) => ({ id: d.id, path: d.path })),
    {
      close: (id) => void closeDocTab(id),
      closeMany: (ids) => {
        void (async () => {
          for (const id of ids) await closeDocTab(id);
        })();
      },
      save: (id) => {
        void useEditor
          .getState()
          .save(id)
          .catch((e) => toast(String(e), "error"));
      },
      reload: (id) => {
        void useEditor
          .getState()
          .reload(id)
          .catch((e) => toast(String(e), "error"));
      },
      copyPath: (theText) => {
        void copyText(theText).then((ok) =>
          toast(ok ? "Caminho copiado." : "Não consegui copiar.", ok ? "info" : "error"),
        );
      },
      reveal: (osPath) => {
        void ipc.revealPath(osPath).catch((e) => toast(String(e), "error"));
      },
    },
  );
}
