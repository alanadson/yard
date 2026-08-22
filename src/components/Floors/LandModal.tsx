/**
 * Preview + confirm landing one floor onto the ground.
 *
 * The merge is refused (not half-applied) when the preview already sees
 * conflicts or a dirty tree. After a clean merge the user chooses whether
 * to close this floor and the other floors of the same task.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, GitCompare, GitMerge, RotateCw } from "lucide-react";

import { Modal } from "../modals/Modal";
import {
  landFloor,
  previewFloor,
  settleAfterLand,
  siblingFloors,
} from "../../lib/floorLand";
import { isIsolatedFloor } from "../../lib/floors";
import type { GroupRow, LandPreview, ProjectRow } from "../../lib/ipc";
import { useChanges } from "../../stores/changesStore";
import { parseLayout, useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export interface LandPayload {
  project: ProjectRow;
  group: GroupRow;
}

export function LandModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as LandPayload | null;
  const [preview, setPreview] = useState<LandPreview | null>(null);
  const [err, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * What used to be two native `ask` dialogs *after* the merge — each one
   * changing the context of the next with the preview no longer in sight.
   * Decided here, as checkboxes beside the preview, before anything runs.
   */
  const [closeThis, setCloseThis] = useState(true);
  const [closeOthers, setCloseOthers] = useState(false);

  const project = payload?.project;
  const group = payload?.group;
  const floor = group ? parseLayout(group.layoutJson).floor : undefined;

  /** Redoes the comparison — the floor changes while this dialog is open. */
  const [comparing, setComparing] = useState(false);
  const compare = useCallback(async () => {
    if (!project || !group) return;
    setComparing(true);
    setError(null);
    try {
      setPreview(await previewFloor(project, group));
    } catch (e) {
      setError(String(e));
    } finally {
      setComparing(false);
    }
  }, [project, group]);

  useEffect(() => {
    if (!project || !group) return;
    let cancel = false;
    void previewFloor(project, group)
      .then((p) => {
        if (!cancel) setPreview(p);
      })
      .catch((e) => {
        if (!cancel) setError(String(e));
      });
    return () => {
      cancel = true;
    };
  }, [project, group]);

  if (!project || !group) return null;

  const blocked =
    !isIsolatedFloor(floor) ||
    !preview ||
    preview.groundDirty ||
    preview.floorDirty ||
    (!preview.alreadyMerged && !preview.clean);

  const siblings = siblingFloors(project.id, group.id, floor?.task?.id);

  const land = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await landFloor(project, group);
      if (!result.ok) {
        showToast(
          result.conflicted
            ? `Conflito — o chão não foi alterado. ${result.conflictPaths.join(", ")}`
            : result.message,
          "error",
        );
        return;
      }
      const warnings = await settleAfterLand({
        project,
        winner: group,
        closeWinner: closeThis,
        closeSiblings: closeThis && closeOthers && siblings.length > 0,
      });
      showToast(
        warnings.length
          ? `${result.message} — ${warnings.join(" · ")}`
          : result.message,
        warnings.length ? "error" : "info",
      );
      closeModal();
    } catch (e) {
      showToast(`Não consegui aterrissar: ${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Aterrissar “${group.name}”`}
      onClose={closeModal}
      wide
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            O merge entra no chão. Conflito previsto recusa — o chão não é tocado.
          </span>
          {/* Refused is not a dead end: whoever has uncommitted work goes to
              see what it is, and comes back here to compare again without
              closing anything. */}
          {preview && blocked && (
            <>
              <button
                className="btn"
                onClick={() => {
                  useProjects.getState().setActiveGroup(group.id);
                  const changes = useChanges.getState();
                  if (!changes.open) changes.toggle();
                  changes.setTab("review");
                  closeModal();
                }}
              >
                <GitCompare size={13} aria-hidden="true" /> Ver as alterações
              </button>
              <button className="btn" disabled={comparing} onClick={() => void compare()}>
                <RotateCw size={13} aria-hidden="true" />
                {comparing ? "Comparando…" : "Comparar de novo"}
              </button>
            </>
          )}
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || blocked}
            onClick={() => void land()}
          >
            <GitMerge size={13} aria-hidden="true" />
            {busy ? "Aterrissando…" : preview?.alreadyMerged ? "Já está no chão" : "Aterrissar no chão"}
          </button>
        </div>
      }
    >
      {err && <p className="floors-warn">{err}</p>}
      {!err && !preview && <p className="hint">Comparando com o chão…</p>}
      {preview && (
        <LandPreviewBody preview={preview} />
      )}
      {preview && !blocked && (
        <div className="floors-after">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={closeThis}
              onChange={(e) => {
                setCloseThis(e.target.checked);
                // The siblings only fall with the winner; unticking the
                // winner untucks them too.
                if (!e.target.checked) setCloseOthers(false);
              }}
            />
            Encerrar o andar depois de aterrissar (apaga o worktree e a branch)
          </label>
          {siblings.length > 0 && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={closeOthers}
                disabled={!closeThis}
                onChange={(e) => setCloseOthers(e.target.checked)}
              />
              Descartar também {siblings.length} outro(s) andar(es) desta tarefa
              (apaga as branches deles)
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}

export function LandPreviewBody({ preview }: { preview: LandPreview }) {
  const blockers: string[] = [];
  if (preview.groundDirty) blockers.push("O chão tem trabalho não commitado.");
  if (preview.floorDirty) blockers.push("O andar tem trabalho não commitado.");
  if (!preview.alreadyMerged && !preview.clean) {
    blockers.push(
      `Isso geraria ${preview.conflictPaths.length} conflito(s): ${preview.conflictPaths.join(", ")}`,
    );
  }

  const dirty = preview.groundDirty || preview.floorDirty;
  return (
    <div className="floors-preview">
      <p className="hint">
        <code>{preview.floorBranch}</code> → chão <code>{preview.groundBranch}</code>
        {preview.alreadyMerged
          ? " — já está mesclado."
          : ` — ${preview.files.length} arquivo(s), +${preview.additions} −${preview.deletions}.`}
      </p>
      {blockers.map((b) => (
        <p key={b} className="floors-warn">
          <AlertTriangle size={12} aria-hidden="true" /> {b}
        </p>
      ))}
      {/* Saying what is wrong without saying what to do is only halfway. */}
      {dirty && (
        <p className="hint">
          Um merge só entra com as duas árvores limpas: faça commit (ou stash)
          do que está pendente e volte aqui — “Comparar de novo” refaz a
          previsão sem fechar esta janela.
        </p>
      )}
      {preview.files.length > 0 && (
        <ul className="floors-diff">
          {preview.files.map((f) => (
            <li key={f.path} className={`floors-diff-row is-${f.status}`}>
              <span className="floors-diff-mark">{mark(f.status)}</span>
              <span className="floors-diff-path" data-tip={f.path}>
                {f.path}
              </span>
              <span className="floors-diff-stat">
                {f.additions != null && <em className="add">+{f.additions}</em>}
                {f.deletions != null && <em className="del">−{f.deletions}</em>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function mark(status: string): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "conflicted") return "!";
  return "M";
}
