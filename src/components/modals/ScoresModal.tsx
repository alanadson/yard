/**
 * Scores: save the group's arrangement and reapply it elsewhere.
 *
 * "Arrangement" is everything that repeats across projects — which CLIs,
 * where they sit, who talks to whom, roles, notes, drawings and routines.
 * What belongs to the project (the working folder) comes from the destination,
 * never from the saved file.
 */
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, Save, Trash2 } from "lucide-react";

import { Modal } from "./Modal";
import { kb } from "../../lib/format";
import { ipc, type ScoreMeta } from "../../lib/ipc";
import { applyScore, readScore, saveScore } from "../../lib/scores";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  /** Source group (to save) and default destination (to apply). */
  groupId?: string;
  /** Project where "Apply in a new group" should create the group. */
  projectId?: string;
}

export function ScoresModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const groups = useProjects((s) => s.groups);
  const addGroup = useProjects((s) => s.addGroup);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);

  const groupId = payload?.groupId ?? "";
  const group = groups.find((g) => g.id === groupId);
  const projectId = payload?.projectId ?? group?.projectId ?? "";

  const [lista, setLista] = useState<ScoreMeta[] | null>(null);
  const [nome, setNome] = useState(group?.name ?? "");
  const [ocupado, setOcupado] = useState(false);

  const recarregar = () => void ipc.scoreList().then(setLista).catch(() => setLista([]));
  useEffect(recarregar, []);

  const salvar = async () => {
    const limpo = nome.trim();
    if (!limpo || !groupId) return;
    setOcupado(true);
    try {
      await saveScore(groupId, limpo);
      showToast(`Partitura “${limpo}” salva.`);
      recarregar();
    } catch (e) {
      showToast(`Falha ao salvar: ${e}`, "error");
    } finally {
      setOcupado(false);
    }
  };

  const aplicar = async (score: ScoreMeta, emGrupoNovo: boolean) => {
    setOcupado(true);
    try {
      const dados = await readScore(score.name);
      let alvo = groupId;
      if (emGrupoNovo || !alvo) {
        if (!projectId) {
          showToast("Escolha um projeto antes de aplicar a partitura.", "error");
          return;
        }
        alvo = addGroup(projectId, score.name);
      }
      const r = applyScore(dados, alvo);
      setActiveGroup(alvo);
      showToast(
        `“${score.name}” aplicada: ${r.terminals} CLI(s) criadas paradas — inicie quando quiser.`,
      );
      closeModal();
    } catch (e) {
      showToast(`Falha ao aplicar: ${e}`, "error");
    } finally {
      setOcupado(false);
    }
  };

  const remover = async (score: ScoreMeta) => {
    const ok = await ask(`Excluir a partitura “${score.name}”?`, {
      title: "Excluir partitura",
      kind: "warning",
    });
    if (!ok) return;
    await ipc.scoreDelete(score.name);
    recarregar();
  };

  return (
    <Modal title="Partituras" onClose={closeModal} wide>
      {group && (
        <div className="score-save">
          <label className="grow">
            Salvar “{group.name}” como
            <input
              value={nome}
              placeholder="nome da partitura"
              onChange={(e) => setNome(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void salvar();
              }}
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={!nome.trim() || ocupado}
            onClick={() => void salvar()}
          >
            <Save size={13} /> Salvar arranjo
          </button>
        </div>
      )}

      <p className="hint">
        O arranjo guarda as CLIs (programa, argumentos, título), posições, papéis,
        notas, conexões, desenhos e rotinas. A pasta de trabalho <strong>não</strong>{" "}
        vai junto: ao aplicar, ela vem do projeto de destino.
      </p>

      <div className="score-list">
        {lista === null && [0, 1].map((i) => <div key={i} className="option--skeleton" />)}
        {lista?.length === 0 && (
          <p className="hint">Nenhuma partitura salva ainda.</p>
        )}
        {(lista ?? []).map((s) => (
          <div key={s.path} className="score">
            <div className="score-body">
              <strong>{s.name}</strong>
              <small data-tip={s.path}>
                {new Date(s.updatedAt).toLocaleString()} · {kb(s.sizeBytes, 1)}
              </small>
            </div>
            {group && (
              <button
                className="btn"
                disabled={ocupado}
                data-tip={`Acrescentar o arranjo ao grupo “${group.name}”`}
                onClick={() => void aplicar(s, false)}
              >
                <Download size={13} /> Aplicar aqui
              </button>
            )}
            <button
              className="btn"
              disabled={ocupado || !projectId}
              data-tip="Criar um grupo novo com este arranjo"
              onClick={() => void aplicar(s, true)}
            >
              <FolderOpen size={13} /> Grupo novo
            </button>
            <button
              className="icon-btn"
              data-tip="Excluir partitura"
              aria-label={`Excluir a partitura ${s.name}`}
              onClick={() => void remover(s)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
