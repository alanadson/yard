/**
 * Scores: save the group's arrangement and reapply it elsewhere.
 *
 * "Arrangement" is everything that repeats across projects — which CLIs,
 * where they sit, who talks to whom, roles, notes, drawings and routines.
 * What belongs to the project (the working folder) comes from the destination,
 * never from the saved file.
 */
import { useEffect, useState } from "react";
import "./scores.css";
import { ask } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, Save, Trash2 } from "lucide-react";

import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { LOADING, load, isEmpty, type LoadState } from "../../lib/loading";
import { kb } from "../../lib/format";
import { locale } from "../../lib/i18n";
import { ipc, type ScoreMeta } from "../../lib/ipc";
import { applyScore, readScore, saveScore, scoreAlreadyExists } from "../../lib/scores";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  /** Source group (to save) and default destination (to apply). */
  groupId?: string;
  /** Project where "Apply in a new group" should create the group. */
  projectId?: string;
}

export function ScoresModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const groups = useProjects((s) => s.groups);
  const addGroup = useProjects((s) => s.addGroup);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);

  const groupId = payload?.groupId ?? "";
  const group = groups.find((g) => g.id === groupId);
  const projectId = payload?.projectId ?? group?.projectId ?? "";

  const [items, setList] = useState<LoadState<ScoreMeta[]>>(LOADING);
  const [itemName, setName] = useState(group?.name ?? "");
  const [occupied, setBusy] = useState(false);

  const reload = () => {
    setList(LOADING);
    void load(ipc.scoreList()).then(setList);
  };
  useEffect(reload, []);

  const saveIt = async () => {
    const stripped = itemName.trim();
    if (!stripped || !groupId) return;
    setBusy(true);
    try {
      await persist(stripped, false);
    } catch (e) {
      // The name is already on disk. It is the one destructive outcome of this
      // dialog and the list right below shows what would be lost, so the user
      // decides — this used to overwrite in silence and report "salva".
      if (!scoreAlreadyExists(e)) {
        showToast(t("Falha ao salvar: {e}", { e: String(e) }), "error");
        setBusy(false);
        return;
      }
      const replace = await ask(
        t("Já existe uma partitura chamada “{name}”. Substituir o arranjo salvo nela?", {
          name: stripped,
        }),
        { title: t("Substituir partitura"), kind: "warning" },
      );
      if (replace) {
        try {
          await persist(stripped, true);
        } catch (e2) {
          showToast(t("Falha ao salvar: {e}", { e: String(e2) }), "error");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const persist = async (stripped: string, overwrite: boolean) => {
    await saveScore(groupId, stripped, overwrite);
    showToast(
      overwrite
        ? t("Partitura “{name}” substituída.", { name: stripped })
        : t("Partitura “{name}” salva.", { name: stripped }),
    );
    reload();
  };

  const applyIt = async (score: ScoreMeta, inNewGroup: boolean) => {
    setBusy(true);
    try {
      const data = await readScore(score.name);
      let target = groupId;
      if (inNewGroup || !target) {
        if (!projectId) {
          showToast(t("Escolha um projeto antes de aplicar a partitura."), "error");
          return;
        }
        target = addGroup(projectId, score.name);
      }
      const r = applyScore(data, target);
      setActiveGroup(target);
      showToast(
        t("“{name}” aplicada: {n} CLI(s) criadas paradas — inicie quando quiser.", {
          name: score.name,
          n: r.terminals,
        }),
      );
      closeModal();
    } catch (e) {
      showToast(t("Falha ao aplicar: {e}", { e: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (score: ScoreMeta) => {
    const ok = await ask(t("Excluir a partitura “{name}”?", { name: score.name }), {
      title: t("Excluir partitura"),
      kind: "warning",
    });
    if (!ok) return;
    try {
      await ipc.scoreDelete(score.name);
    } catch (e) {
      // Without this, a backend failure left the row on screen and nothing
      // explaining why the delete "did nothing".
      showToast(t("Não consegui excluir a partitura: {e}", { e: String(e) }), "error");
    }
    reload();
  };

  return (
    <Modal title={t("Partituras")} onClose={closeModal} wide>
      {group && (
        <div className="score-save">
          <label className="grow">
            {t("Salvar “{name}” como", { name: group.name })}
            <input
              value={itemName}
              placeholder={t("nome da partitura")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveIt();
              }}
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={!itemName.trim() || occupied}
            onClick={() => void saveIt()}
          >
            <Save size={13} /> {t("Salvar arranjo")}
          </button>
        </div>
      )}

      <p className="hint">
        {t(
          "O arranjo guarda as CLIs (programa, argumentos, título), posições, papéis, notas, conexões, desenhos e rotinas. A pasta de trabalho ",
        )}
        <strong>{t("não vai junto")}</strong>
        {t(": ao aplicar, ela vem do projeto de destino.")}
      </p>

      <div className="score-list">
        {items.state === "carregando" &&
          [0, 1].map((i) => <div key={i} className="option--skeleton" />)}
        {/* A read that failed must not become "no scores": the user would
            recreate on top of files that are there. */}
        {items.state === "falhou" && (
          <p className="hint hint--error" role="alert">
            {t("Não consegui ler as partituras: {reason}.", { reason: items.reason })}{" "}
            <button className="linkish" onClick={reload}>
              {t("Tentar de novo")}
            </button>
          </p>
        )}
        {isEmpty(items) && <p className="hint">{t("Nenhuma partitura salva ainda.")}</p>}
        {(items.state === "pronto" ? items.data : []).map((s) => (
          <div key={s.path} className="score">
            <div className="score-body">
              <strong>{s.name}</strong>
              <small data-tip={s.path}>
                {new Date(s.updatedAt).toLocaleString(locale())} · {kb(s.sizeBytes, 1)}
              </small>
            </div>
            {group && (
              <button
                className="btn"
                disabled={occupied}
                data-tip-wrap=""
                data-tip={t(
                  "Acrescentar o arranjo ao grupo “{name}” — as CLIs e notas entram ao lado do que já existe. Não dá para desfazer com Ctrl+Z: para tirar, exclua os cartões.",
                  { name: group.name },
                )}
                onClick={() => void applyIt(s, false)}
              >
                <Download size={13} /> {t("Aplicar aqui")}
              </button>
            )}
            <button
              className="btn"
              disabled={occupied || !projectId}
              data-tip={t("Criar um grupo novo com este arranjo")}
              onClick={() => void applyIt(s, true)}
            >
              <FolderOpen size={13} /> {t("Grupo novo")}
            </button>
            <button
              className="icon-btn icon-btn--danger"
              data-tip={t("Excluir partitura")}
              aria-label={t("Excluir a partitura {name}", { name: s.name })}
              onClick={() => void remove(s)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
