/**
 * Putting a closed tab back (`lib/reopen.ts` decides what is remembered,
 * `stores/reopenStore.ts` holds the stack).
 *
 * Effects only, which is why there is no test file beside this one: the two
 * calls below are the app's ordinary "open a file" and "open a browser tab",
 * reached with the coordinates the tab had when it was closed.
 *
 * The pane matters as much as the path. Reopening a file into whatever pane
 * happens to be focused would, in a four-pane layout, put the tab somewhere
 * the eye is not — so the group and the slot travel with the entry, and the
 * open is aimed at them.
 */
import { useBrowsers } from "../stores/browsersStore";
import { useEditor } from "../stores/editorStore";
import { useProjects } from "../stores/projectsStore";
import { useReopen } from "../stores/reopenStore";
import { useUI } from "../stores/uiStore";
import { t } from "./i18n";

export async function reopenLastTab(): Promise<void> {
  const tab = useReopen.getState().take();
  if (!tab) {
    useUI.getState().showToast(t("Nenhuma aba fechada para reabrir."));
    return;
  }
  // The pane it came from, when it still exists: a group closed in the
  // meantime leaves the tab to land wherever the workspace is now.
  if (tab.groupId && useProjects.getState().groups.some((g) => g.id === tab.groupId)) {
    useProjects.getState().setActiveGroup(tab.groupId);
    // Aiming the pane, not a terminal: `focusTerminal(null, slot)` is how the
    // app says "this pane is the one" without claiming a CLI has the cursor.
    useUI.getState().focusTerminal(null, tab.slot);
  }
  if (tab.kind === "doc") {
    await useEditor.getState().openFile(tab.path);
    return;
  }
  if (!tab.groupId) {
    useUI.getState().showToast(t("O painel dessa aba de navegador não existe mais."));
    return;
  }
  useBrowsers.getState().open({ groupId: tab.groupId, slot: tab.slot, url: tab.url });
}
