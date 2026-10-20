/** The backend retains notices until the page has shown their recovery limitation. */
import { ipc } from "./ipc";
import { t } from "./i18n";
import { useUI } from "../stores/uiStore";

export interface CheckpointNotice { id: string; terminalId: string; root: string; reason: string; at: number }
const shown = new Set<string>();

export function checkpointFailureText(root: string, reason: string): string {
  return t("A captura em {root} falhou. O trabalho pode continuar sem checkpoint: {reason}.", { root, reason });
}

export async function refreshCheckpointNotices(): Promise<void> {
  const notices = await ipc.checkpointNotices();
  for (const notice of notices) {
    const key = `${notice.id}:${notice.at}`;
    if (shown.has(key)) continue;
    shown.add(key);
    useUI.getState().showToast(checkpointFailureText(notice.root, notice.reason), "error");
  }
  if (notices.length) await ipc.checkpointAcknowledgeNotices(notices);
  for (const notice of notices) shown.delete(`${notice.id}:${notice.at}`);
}
