/**
 * Restart-into-backup and cancel-restore, shared by the persistent bar in
 * App and the Dados section of Preferences — one wording, one behaviour,
 * wherever the warning is answered.
 */
import { ask } from "@tauri-apps/plugin-dialog";

import { useUI } from "../stores/uiStore";
import { ipc } from "./ipc";

export async function restartIntoBackup(): Promise<void> {
  const proceed = await ask(
    "O Yard vai fechar e abrir de novo para carregar o backup. " +
      "Os terminais em execução são encerrados e o que você fez desde a " +
      "importação é descartado junto com o workspace atual.",
    { title: "Reiniciar o Yard?", kind: "warning" },
  );
  if (!proceed) return;
  try {
    await ipc.restartApp();
  } catch (e) {
    useUI
      .getState()
      .showToast(`Não consegui reiniciar: ${e}. Feche e abra o Yard.`, "error");
  }
}

export async function cancelBackupRestore(): Promise<void> {
  const proceed = await ask(
    "Descartar o backup preparado? O workspace atual continua valendo e o " +
      "arquivo .zip original não é apagado — dá para importar de novo.",
    { title: "Cancelar restauração?", kind: "warning" },
  );
  if (!proceed) return;
  try {
    await ipc.cancelBackup();
    useUI.getState().setBackupPending(false);
    useUI.getState().showToast("Restauração cancelada — o workspace atual continua.");
  } catch (e) {
    useUI.getState().showToast(`Não consegui cancelar a restauração: ${e}`, "error");
  }
}
