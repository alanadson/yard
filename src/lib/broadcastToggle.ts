/**
 * The one gesture that arms or disarms the keyboard broadcast — shared by the
 * `Ctrl+Shift+U` keybinding and the palette action, so the two cannot drift.
 * The rules (who receives, what the toast says) are in `lib/broadcast.ts`.
 */
import { broadcastTargets, toggleMessage } from "./broadcast";
import { t } from "./i18n";
import { useBroadcast } from "../stores/broadcastStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

/** Arms the given group (the active one by default), or disarms it when it is the armed one. */
export function toggleBroadcast(groupId = useProjects.getState().activeGroupId): void {
  const ui = useUI.getState();
  if (!groupId) {
    ui.showToast(t("Nenhum grupo ativo para transmitir."));
    return;
  }
  const store = useBroadcast.getState();
  store.toggle(groupId);
  const on = useBroadcast.getState().isOn(groupId);
  // "Other than the source" has no source yet — the count is every live CLI of
  // the group, which is what the user is about to type into.
  const count = on
    ? broadcastTargets(
        useProjects.getState().terminals,
        useTerminals.getState().byId,
        "",
        groupId,
      ).length
    : 0;
  ui.showToast(toggleMessage(on, count));
}
