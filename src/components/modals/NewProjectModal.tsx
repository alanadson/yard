import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";

import { Modal } from "./Modal";
import { ProjectStylePicker } from "./ProjectStylePicker";
import { ipc } from "../../lib/ipc";
import { DEFAULT_PROJECT_ICON } from "../../lib/projectStyle";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export function NewProjectModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const addProject = useProjects((s) => s.addProject);

  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_PROJECT_ICON);
  const [color, setColor] = useState<string | null>(null);

  const pick = async () => {
    const chosen = await open({ directory: true, multiple: false });
    if (typeof chosen === "string") {
      setPath(chosen);
      if (!name) setName(chosen.split(/[\\/]/).filter(Boolean).pop() ?? chosen);
    }
  };

  const submit = async () => {
    if (!path.trim()) {
      showToast("Escolha uma pasta.", "error");
      return;
    }
    if (!(await ipc.isDirectory(path))) {
      showToast("Esse caminho não existe ou não é uma pasta.", "error");
      return;
    }
    addProject(name.trim() || path.split(/[\\/]/).filter(Boolean).pop() || path, path, {
      icon,
      color,
    });
    closeModal();
  };

  return (
    <Modal
      title="Novo projeto"
      onClose={closeModal}
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={() => void submit()}>
            Adicionar
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          Pasta raiz
          <div className="input-row">
            <input
              value={path}
              placeholder="C:\Workspace\meu-projeto"
              onChange={(e) => setPath(e.target.value)}
            />
            <button className="btn" onClick={() => void pick()}>
              <FolderOpen size={13} /> Procurar
            </button>
          </div>
        </label>
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
