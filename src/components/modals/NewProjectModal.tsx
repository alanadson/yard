import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";

import { Modal } from "./Modal";
import { ProjectStylePicker } from "./ProjectStylePicker";
import { useT } from "../../hooks/useT";
import { createProject } from "../../lib/projectCreate";
import { DEFAULT_PROJECT_ICON } from "../../lib/projectStyle";
import { useUI } from "../../stores/uiStore";

export function NewProjectModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);

  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_PROJECT_ICON);
  const [color, setColor] = useState<string | null>(null);
  /** Locks submission while `isDirectory` is in flight (§double click). */
  const [busy, setBusy] = useState(false);
  /**
   * Field errors live under the field, not in a toast: whoever is typing is
   * looking at the input, and the notice at the window's foot died in 7 s.
   */
  const [err, setError] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);

  const fail = (msg: string) => {
    setError(msg);
    pathRef.current?.focus();
  };

  const pick = async () => {
    const chosen = await open({ directory: true, multiple: false });
    if (typeof chosen === "string") {
      setPath(chosen);
      setError(null);
      if (!name) setName(chosen.split(/[\\/]/).filter(Boolean).pop() ?? chosen);
    }
  };

  const submit = async () => {
    // `submit` has an `await` in the middle: without this lock, two clicks
    // (or two Enters) on the button created **two projects** in the same
    // folder — and each one registers its own watcher, because the backend
    // deduplicates by id, not by root.
    if (busy) return;
    setBusy(true);
    try {
      // Trim, dedupe by root, ask the disk, add — the same door the first-run
      // sheet uses (`lib/projectCreate.ts`), so the two never drift.
      const result = await createProject({ path, name, style: { icon, color } });
      if (!result.ok) {
        fail(result.error);
        return;
      }
      closeModal();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Novo projeto")}
      onClose={closeModal}
      // Icon and color count too: picking them is work the backdrop must
      // not throw away without the nudge.
      dirty={
        !!path.trim() ||
        !!name.trim() ||
        icon !== DEFAULT_PROJECT_ICON ||
        color !== null
      }
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            {t("Cancelar")}
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !path.trim()}
            onClick={() => void submit()}
          >
            {busy ? t("Adicionando…") : t("Adicionar")}
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          {t("Pasta raiz")}
          <div className="input-row">
            <input
              ref={pathRef}
              value={path}
              placeholder="C:\Workspace\meu-projeto" // i18n-ok
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? "novo-projeto-erro" : undefined}
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <button className="btn" onClick={() => void pick()}>
              <FolderOpen size={13} /> {t("Procurar")}
            </button>
          </div>
        </label>
        {err && (
          <p className="hint hint--error" id="novo-projeto-erro" role="alert">
            {err}
          </p>
        )}
        <label>
          {t("Nome")}
          <input
            value={name}
            placeholder={t("opcional — usa o nome da pasta")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
        <ProjectStylePicker
          icon={icon}
          color={color}
          onIcon={setIcon}
          onColor={setColor}
        />
        <p className="hint">
          {t(
            "O projeto vira o diretório de trabalho dos terminais e a chave para localizar as sessões que os agentes já gravaram nesta pasta.",
          )}
        </p>
      </div>
    </Modal>
  );
}
