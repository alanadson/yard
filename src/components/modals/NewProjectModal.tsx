import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";

import { Modal } from "./Modal";
import { ProjectStylePicker } from "./ProjectStylePicker";
import { ipc } from "../../lib/ipc";
import { DEFAULT_PROJECT_ICON } from "../../lib/projectStyle";
import { sameRoot } from "../../lib/roots";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export function NewProjectModal() {
  const closeModal = useUI((s) => s.closeModal);
  const addProject = useProjects((s) => s.addProject);

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

    // Really trimmed, not just for the emptiness check: a pasted path with a
    // trailing space was stored as-is, and `rootKey` normalizes separator and
    // case but not whitespace — so the root never matched the canonical one
    // again.
    const stripped = path.trim();
    if (!stripped) {
      fail("Escolha uma pasta.");
      return;
    }

    const duplicates = useProjects
      .getState()
      .projects.find((p) => sameRoot(p.path, stripped));
    if (duplicates) {
      fail(`Essa pasta já está no workspace como “${duplicates.name}”.`);
      return;
    }

    setBusy(true);
    try {
      if (!(await ipc.isDirectory(stripped))) {
        fail("Esse caminho não existe ou não é uma pasta.");
        return;
      }
      // The store checks the folder again — the `await` above is a window in
      // which the same path could have been added from elsewhere.
      const id = addProject(
        name.trim() || stripped.split(/[\\/]/).filter(Boolean).pop() || stripped,
        stripped,
        { icon, color },
      );
      if (!id) {
        fail("Essa pasta já está no workspace.");
        return;
      }
      closeModal();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Novo projeto"
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
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !path.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Adicionando…" : "Adicionar"}
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          Pasta raiz
          <div className="input-row">
            <input
              ref={pathRef}
              value={path}
              placeholder="C:\Workspace\meu-projeto"
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
              <FolderOpen size={13} /> Procurar
            </button>
          </div>
        </label>
        {err && (
          <p className="hint hint--error" id="novo-projeto-erro" role="alert">
            {err}
          </p>
        )}
        <label>
          Nome
          <input
            value={name}
            placeholder="opcional — usa o nome da pasta"
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
          O projeto vira o diretório de trabalho dos terminais e a chave para
          localizar as sessões que os agentes já gravaram nesta pasta.
        </p>
      </div>
    </Modal>
  );
}
