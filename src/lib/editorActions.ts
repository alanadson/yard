import { ask } from "@tauri-apps/plugin-dialog";

import { copyText } from "./clipboard";
import { editorTabMenu } from "./editorTabMenu";
import { paneTabs } from "./paneTabs";
import { moveTabBy } from "./tabDrag";
import { closesWith } from "./tabRules";
import { useBench } from "../stores/benchStore";
import { ipc } from "./ipc";
import { fileName } from "./paths";
import type { MenuEntry } from "../components/ContextMenu";
import { isDirty, isReadOnly, useEditor, type OpenDoc } from "../stores/editorStore";
import { useUI } from "../stores/uiStore";
import { t } from "./i18n";

/** Closes an editor tab, preserving the same unsaved-draft guard in every host. */
export async function closeDocTab(id: string): Promise<void> {
  const doc = useEditor.getState().docs.find((candidate) => candidate.id === id);
  if (doc && isDirty(doc) && !isReadOnly(doc)) {
    const sure = await ask(
      t("“{name}” tem alterações não salvas. Fechar a aba descarta o que você escreveu.", {
        name: fileName(doc.path),
      }),
      { title: t("Fechar sem salvar?"), kind: "warning" },
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
      pinned: doc.pinned === true,
      comparison: !!doc.diff,
    },
    docs.map((d) => ({ id: d.id, path: d.path })),
    {
      close: (id) => void closeDocTab(id),
      closeMany: (ids) => {
        void (async () => {
          for (const id of ids) await closeDocTab(id);
        })();
      },
      // The store decides *which* tabs a scope names, because only it knows
      // about pins; the closing itself still goes one at a time through
      // `closeDocTab`, so a tab with a draft asks before it vanishes.
      closeScoped: (id, scope) => {
        const ids = closesWith(
          useEditor.getState().docs.map((d) => ({
            id: d.id,
            groupId: d.groupId,
            slot: d.slot,
            pinned: d.pinned === true,
            dirty: isDirty(d) && !isReadOnly(d),
          })),
          id,
          scope,
        );
        void (async () => {
          for (const victim of ids) await closeDocTab(victim);
        })();
      },
      togglePin: (id) => useEditor.getState().togglePin(id),
      // One step along the pane's whole bar, which may put the file past a
      // CLI or a page — the kinds share one bar (`lib/paneBar.ts`).
      moveBy: (id, dir) => {
        if (doc.groupId) moveTabBy("doc", id, doc.groupId, doc.slot, dir);
      },
      revealInTree: (path) => {
        // The tree opens the lineage on its own when the file is opened; this
        // is the same door, for a file that is already open.
        void useEditor.getState().openFile(path);
        useBench.getState().revealTab("files");
      },
      rename: (path) => useEditor.getState().askRename(path),
      remove: (path) => {
        void (async () => {
          const name = path.split("/").pop() ?? path;
          const sure = await ask(
            t("Excluir “{name}”? Não dá para desfazer.", { name }),
            { title: t("Excluir do disco"), kind: "warning" },
          );
          if (!sure) return;
          try {
            await useEditor.getState().deleteEntry(path);
          } catch (e) {
            toast(t("Não consegui excluir: {e}", { e: String(e) }), "error");
          }
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
          toast(ok ? t("Caminho copiado.") : t("Não consegui copiar."), ok ? "info" : "error"),
        );
      },
      reveal: (osPath) => {
        void ipc.revealPath(osPath).catch((e) => toast(String(e), "error"));
      },
    },
    doc.groupId ? paneTabs(doc.groupId, doc.slot) : null,
  );
}
