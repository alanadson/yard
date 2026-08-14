import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, Keyboard, Upload } from "lucide-react";

import { Modal } from "./Modal";
import { ipc, type AppPaths } from "../../lib/ipc";
import { useUI } from "../../stores/uiStore";

/** Monospaced fonts that usually exist on Windows, for the datalist. */
const FONTES = [
  '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  "Consolas, monospace",
  '"JetBrains Mono", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  '"Lucida Console", monospace',
];

/** CSS stack → readable text for the field (without the quote noise). */
const legivel = (stack: string) => stack.replace(/["']/g, "");

/** Field text → valid CSS stack (quotes back on families with spaces,
    which is what xterm needs to measure the right font). */
const paraStack = (texto: string) =>
  texto
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => (/\s/.test(f) ? `"${f}"` : f))
    .join(", ");

export function PreferencesModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const openModal = useUI((s) => s.openModal);
  const prefs = useUI((s) => s.prefs);
  const setPref = useUI((s) => s.setPref);
  const [paths, setPaths] = useState<AppPaths | null>(null);

  useEffect(() => {
    void ipc.appPaths().then(setPaths);
  }, []);

  const exportBackup = async () => {
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

  const importBackup = async () => {
    const src = await open({
      multiple: false,
      filters: [{ name: "Backup do Yard", extensions: ["zip"] }],
    });
    if (typeof src !== "string") return;
    try {
      await ipc.importBackup(src);
      showToast("Backup importado. Reinicie o Yard para carregar o estado.");
    } catch (e) {
      showToast(`Falha ao importar: ${e}`, "error");
    }
  };

  return (
    <Modal title="Preferências" onClose={closeModal} wide>
      <div className="pref-section">
        <h4>Terminal</h4>
        <div className="form form--grid">
          <label>
            Fonte
            <input
              list="yard-fontes"
              value={legivel(prefs.fontFamily)}
              onChange={(e) => setPref("fontFamily", paraStack(e.target.value))}
            />
            <datalist id="yard-fontes">
              {FONTES.map((f) => (
                <option key={f} value={legivel(f)} />
              ))}
            </datalist>
          </label>
          <label>
            Tamanho da fonte
            <input
              type="number"
              min={8}
              max={28}
              value={prefs.fontSize}
              onChange={(e) => setPref("fontSize", Number(e.target.value))}
            />
          </label>
          <label>
            Renderizador
            <select
              value={prefs.renderer}
              onChange={(e) =>
                setPref("renderer", e.target.value as "canvas" | "webgl")
              }
            >
              <option value="canvas">Canvas (estável)</option>
              <option value="webgl">WebGL (experimental)</option>
            </select>
          </label>
          <label>
            Linhas de histórico
            <input
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={prefs.scrollback}
              onChange={(e) => setPref("scrollback", Number(e.target.value))}
            />
          </label>
        </div>
        <p className="hint">
          O renderizador WebGL é mais rápido em telas grandes, mas depende do
          driver de vídeo; se o terminal piscar ou ficar em branco, volte para
          canvas.
        </p>
      </div>

      <hr className="sep" />

      <div className="pref-section">
        <h4>Comportamento</h4>
        <div className="form">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={prefs.notifyOnFinish}
              onChange={(e) => setPref("notifyOnFinish", e.target.checked)}
            />
            Notificar quando um agente terminar
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={prefs.confirmOnExit}
              onChange={(e) => setPref("confirmOnExit", e.target.checked)}
            />
            Confirmar ao sair com terminais vivos
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={prefs.cursorBlink}
              onChange={(e) => setPref("cursorBlink", e.target.checked)}
            />
            Cursor piscante
          </label>
        </div>
        <div className="input-row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => openModal("shortcuts")}>
            <Keyboard size={13} /> Atalhos de teclado
          </button>
        </div>
      </div>

      <hr className="sep" />

      <div className="pref-section">
        <h4>Dados</h4>
        <div className="input-row">
          <button className="btn" onClick={() => void exportBackup()}>
            <Download size={13} /> Exportar backup
          </button>
          <button className="btn" onClick={() => void importBackup()}>
            <Upload size={13} /> Importar backup
          </button>
          {paths && (
            <button className="btn" onClick={() => void ipc.revealPath(paths.appDir)}>
              <FolderOpen size={13} /> Abrir pasta de dados
            </button>
          )}
        </div>
        {paths && (
          <ul className="paths">
            <li>
              <span>Banco</span>
              <code>{paths.dbPath}</code>
            </li>
            <li>
              <span>Logs</span>
              <code>{paths.logsDir}</code>
            </li>
          </ul>
        )}
      </div>
    </Modal>
  );
}
