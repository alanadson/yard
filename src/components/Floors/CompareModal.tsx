/**
 * Side-by-side diffstat of every isolated floor. Pick a winner, land it,
 * discard the others of the same task.
 */
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Columns2, GitMerge, RefreshCw } from "lucide-react";

import { Modal } from "../modals/Modal";
import { LandPreviewBody } from "./LandModal";
import { isIsolatedFloor } from "../../lib/floors";
import {
  landFloor,
  previewFloor,
  settleAfterLand,
  siblingFloors,
} from "../../lib/floorLand";
import type { GroupRow, LandPreview } from "../../lib/ipc";
import { parseLayout, useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

export function CompareModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as { projectId?: string } | null;
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const project =
    projects.find((p) => p.id === payload?.projectId) ??
    projects.find((p) => p.id === useProjects.getState().activeProjectId);

  const floors = (project
    ? groups.filter((g) => g.projectId === project.id)
    : []
  ).filter((g) => isIsolatedFloor(parseLayout(g.layoutJson).floor));

  const [choice, setChoice] = useState<string | null>(floors[0]?.id ?? null);
  const [previews, setPreviews] = useState<Record<string, LandPreview | string>>({});
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!project) return;
    let cancel = false;
    void Promise.all(
      floors.map(async (g) => {
        try {
          const p = await previewFloor(project, g);
          return [g.id, p] as const;
        } catch (e) {
          return [g.id, String(e)] as const;
        }
      }),
    ).then((pairs) => {
      if (cancel) return;
      setPreviews(Object.fromEntries(pairs));
    });
    return () => {
      cancel = true;
    };
    // `tick` is the refresh button; the group list is read on each run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, tick, floors.map((g) => g.id).join(",")]);

  if (!project) return null;

  const chosen = floors.find((g) => g.id === choice) ?? null;
  const preview = chosen ? previews[chosen.id] : undefined;
  const blocked =
    !chosen ||
    !preview ||
    typeof preview === "string" ||
    preview.groundDirty ||
    preview.floorDirty ||
    (!preview.alreadyMerged && !preview.clean);

  const keepChosen = async () => {
    if (!chosen || !preview || typeof preview === "string") return;
    const floor = parseLayout(chosen.layoutJson).floor;
    const siblings = siblingFloors(project.id, chosen.id, floor?.task?.id);
    const ok = await ask(
      t("Aterrissar “{name}” no chão", { name: chosen.name }) +
        (siblings.length
          ? t(" e encerrar os {n} outro(s) andar(es) desta tarefa", { n: siblings.length })
          : "") +
        t("? O merge entra na branch do chão; as branches dos perdedores são apagadas."),
      { title: t("Ficar com este"), kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const result = await landFloor(project, chosen);
      if (!result.ok) {
        showToast(
          result.conflicted
            ? t("Conflito — o chão não foi alterado. {paths}", { paths: result.conflictPaths.join(", ") })
            : result.message,
          "error",
        );
        return;
      }
      const warnings = await settleAfterLand({
        project,
        winner: chosen,
        closeWinner: true,
        closeSiblings: siblings.length > 0,
      });
      showToast(
        warnings.length ? `${result.message} — ${warnings.join(" · ")}` : result.message,
        warnings.length ? "error" : "info",
      );
      closeModal();
    } catch (e) {
      showToast(t("Não consegui aterrissar: {e}", { e: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Comparar andares — {name}", { name: project.name })}
      onClose={closeModal}
      wide
      headerExtra={
        <button
          className="icon-btn"
          data-tip={t("Atualizar os diffs")}
          aria-label={t("Atualizar os diffs")}
          onClick={() => setTick((n) => n + 1)}
        >
          <RefreshCw size={13} />
        </button>
      }
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            {floors.length === 0
              ? t("Nenhum andar isolado neste projeto.")
              : t("Escolha o vencedor. Os outros da mesma tarefa são encerrados.")}
          </span>
          <button className="btn" onClick={closeModal}>
            {t("Fechar")}
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || blocked}
            onClick={() => void keepChosen()}
          >
            <GitMerge size={13} aria-hidden="true" />
            {busy ? t("Aterrissando…") : t("Ficar com este")}
          </button>
        </div>
      }
    >
      {floors.length === 0 ? (
        <p className="hint">{t("Crie um andar (ou uma tarefa com vários agentes) para comparar.")}</p>
      ) : (
        <div className="floors-compare">
          <ul className="floors-compare-list" role="listbox" aria-label={t("Andares")}>
            {floors.map((g) => (
              <CompareRow
                key={g.id}
                group={g}
                preview={previews[g.id]}
                selected={g.id === choice}
                onSelect={() => setChoice(g.id)}
              />
            ))}
          </ul>
          <div className="floors-compare-detail">
            {chosen && typeof preview === "string" && (
              <p className="floors-warn">{preview}</p>
            )}
            {chosen && preview && typeof preview !== "string" && (
              <LandPreviewBody preview={preview} />
            )}
            {chosen && !preview && <p className="hint">{t("Lendo o diff…")}</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function CompareRow({
  group,
  preview,
  selected,
  onSelect,
}: {
  group: GroupRow;
  preview: LandPreview | string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const floor = parseLayout(group.layoutJson).floor;
  const aliveCount = useProjects
    .getState()
    .terminalsOf(group.id)
    .filter((t) => isLive(useTerminals.getState().byId[t.id])).length;
  const stat =
    !preview
      ? "…"
      : typeof preview === "string"
        ? t("erro")
        : preview.alreadyMerged
          ? t("já no chão")
          : !preview.clean
            ? t("{n} conflito(s)", { n: preview.conflictPaths.length })
            : `+${preview.additions} −${preview.deletions}`;

  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className={`floors-compare-row ${selected ? "is-active" : ""}`}
        onClick={onSelect}
      >
        <Columns2 size={12} aria-hidden="true" />
        <span className="floors-name">{group.name}</span>
        {floor?.branch && (
          <span className="floors-badge floors-badge--branch">{floor.branch}</span>
        )}
        <span className="floors-compare-stat">{stat}</span>
        {aliveCount > 0 && <span className="floors-alive">{aliveCount}</span>}
      </button>
    </li>
  );
}
