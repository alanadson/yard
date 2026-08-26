/**
 * "Salvar saída…" — the effect side of `termExport.ts`.
 *
 * One native save dialog, one IPC call, one toast. Works for a dead terminal
 * too: the scrollback is on disk, and the moment someone wants the output of
 * a CLI is usually right after it died.
 */
import { save } from "@tauri-apps/plugin-dialog";

import { t } from "./i18n";
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { exportFileName, exportModeFor } from "./termExport";
import { baseName } from "./terminals";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

export async function exportTerminalOutput(id: string): Promise<void> {
  const row = useProjects.getState().terminal(id);
  const title = row ? baseName(row) : "terminal";
  const dest = await save({
    title: t("Salvar saída do terminal"),
    defaultPath: exportFileName(title, new Date()),
    filters: [
      { name: t("Texto"), extensions: ["txt"] },
      { name: t("Registro ANSI (com cores)"), extensions: ["ansi"] },
    ],
  });
  if (!dest) return;
  const { showToast } = useUI.getState();
  try {
    const bytes = await ipc.ptyExport(id, dest, exportModeFor(dest) === "plain");
    showToast(t("Saída salva ({kb} KB).", { kb: Math.max(1, Math.round(bytes / 1024)) }));
  } catch (e) {
    uiLog.warn(`falha ao salvar a saída de ${id}: ${e}`);
    showToast(t("Não consegui salvar a saída: {e}", { e: String(e) }), "error");
  }
}
