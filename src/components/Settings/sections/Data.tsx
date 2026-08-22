/**
 * Data and backup — where the workspace lives, and how to take it along.
 */
import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, RotateCw, Upload } from "lucide-react";

import { cancelBackupRestore, restartIntoBackup } from "../../../lib/backupFlow";
import { LOADING, load, type LoadState } from "../../../lib/loading";
import { ipc, type AppPaths } from "../../../lib/ipc";
import { useUI } from "../../../stores/uiStore";
import { Card, GroupTitle, Row } from "../rows";

export function SecData() {
  const showToast = useUI((s) => s.showToast);
  /**
   * The restored backup stands by waiting for the next boot. It lives in
   * `uiStore` (the App asks the backend at boot and shows a permanent bar) —
   * here the screen only reads it and flips it on import.
   */
  const pending = useUI((s) => s.backupPending);
  const setPending = useUI((s) => s.setBackupPending);
  const [paths, setPaths] = useState<LoadState<AppPaths>>(LOADING);

  useEffect(() => {
    setPaths(LOADING);
    void load(ipc.appPaths()).then(setPaths);
  }, []);

  const exportIt = async () => {
    const dest = await save({
      defaultPath: `yard-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "Backup do Yard", extensions: ["zip"] }],
    });
    if (!dest) return;
    try {
      await ipc.exportBackup(dest);
      showToast("Backup exportado.");
    } catch (e) {
      showToast(`Falha ao exportar: ${e}`, "error");
    }
  };

  /**
   * Importing **stages** the backup; the swap happens on the next boot,
   * because the database this session is holding cannot be replaced from
   * under it. That is why the text changed: the old notice said "restart" in
   * passing while the app kept writing, on top of the restored state, exactly
   * the state that was about to be discarded.
   */
  const importIt = async () => {
    const src = await open({
      multiple: false,
      filters: [{ name: "Backup do Yard", extensions: ["zip"] }],
    });
    if (typeof src !== "string") return;
    try {
      await ipc.importBackup(src);
      setPending(true);
      showToast("Backup preparado. Ele entra no lugar quando o Yard reabrir.");
    } catch (e) {
      showToast(`Falha ao importar: ${e}`, "error");
    }
  };

  return (
    <>
      {pending && (
        <p className="hint hint--error" role="alert">
          Há um backup restaurado esperando. Ele substitui o workspace atual
          quando o Yard reabrir — até lá, tudo o que você fizer vai para o estado
          que será descartado.
        </p>
      )}

      <Card>
        <Row
          label="Backup do workspace"
          desc="Um .zip com projetos, grupos, layout e histórico. O backup importado entra no lugar quando o Yard reabrir."
        >
          <div className="set-actions">
            <button className="btn" onClick={() => void exportIt()}>
              <Download size={13} /> Exportar
            </button>
            <button className="btn" onClick={() => void importIt()}>
              <Upload size={13} /> Importar
            </button>
          </div>
        </Row>
        {/* Shared with the App's permanent bar — one text, one
            behavior. */}
        {pending && (
          <Row
            label="Backup restaurado esperando"
            desc="O Yard reabre já com ele no lugar; cancelar descarta o que foi importado."
          >
            <div className="set-actions">
              <button className="btn btn--primary" onClick={() => void restartIntoBackup()}>
                <RotateCw size={13} /> Reiniciar agora
              </button>
              <button className="btn" onClick={() => void cancelBackupRestore()}>
                Cancelar
              </button>
            </div>
          </Row>
        )}
        <Row label="Pasta de dados" desc="Banco, scrollback e logs, com rotação diária.">
          <button
            className="btn"
            disabled={paths.state !== "pronto"}
            onClick={() => {
              if (paths.state !== "pronto") return;
              void ipc
                .revealPath(paths.data.appDir)
                .catch((e) => showToast(String(e), "error"));
            }}
          >
            <FolderOpen size={13} /> Abrir pasta
          </button>
        </Row>
      </Card>

      {/* Before, a failure here took the list **and** the button above with
          it, without a word — the whole section simply did not exist. */}
      {paths.state === "falhou" && (
        <p className="hint hint--error" role="alert">
          Não consegui descobrir onde ficam os dados do Yard: {paths.reason}.
        </p>
      )}
      {paths.state === "pronto" && (
        <>
          <GroupTitle>Caminhos</GroupTitle>
          <ul className="paths">
            <li>
              <span>Banco</span>
              <code>{paths.data.dbPath}</code>
            </li>
            <li>
              <span>Logs</span>
              <code>{paths.data.logsDir}</code>
            </li>
          </ul>
        </>
      )}
    </>
  );
}
