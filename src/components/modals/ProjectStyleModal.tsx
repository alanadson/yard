/**
 * "Customize project": changes icon and color of an already created project.
 * Opens from the sidebar context menu; state is only written on "Save".
 */
import { useState } from "react";

import { Modal } from "./Modal";
import { ProjectStylePicker } from "./ProjectStylePicker";
import { useT } from "../../hooks/useT";
import { DEFAULT_PROJECT_ICON } from "../../lib/projectStyle";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export function ProjectStyleModal({ projectId }: { projectId: string }) {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const setProjectStyle = useProjects((s) => s.setProjectStyle);
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === projectId),
  );

  const [icon, setIcon] = useState(project?.icon ?? DEFAULT_PROJECT_ICON);
  const [color, setColor] = useState<string | null>(project?.color ?? null);

  if (!project) return null;

  const save = () => {
    setProjectStyle(projectId, { icon, color });
    closeModal();
  };

  return (
    <Modal
      title={t("Personalizar “{name}”", { name: project.name })}
      onClose={closeModal}
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            {t("Cancelar")}
          </button>
          <button className="btn btn--primary" onClick={save}>
            {t("Salvar")}
          </button>
        </div>
      }
    >
      <div className="form">
        <ProjectStylePicker
          icon={icon}
          color={color}
          onIcon={setIcon}
          onColor={setColor}
        />
      </div>
    </Modal>
  );
}
