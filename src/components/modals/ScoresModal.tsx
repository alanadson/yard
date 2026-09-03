/**
 * Scores: save the group's arrangement and reapply it elsewhere.
 *
 * "Arrangement" is everything that repeats across boards — which CLIs,
 * where they sit, who talks to whom, roles, notes, drawings and routines.
 * It is an arrangement of the canvas, and the canvas is the boards
 * (`lib/surface.ts`): a score is saved from a board and lands on a board,
 * here or a new one. The working folder is not in the file: the cards run
 * where the board's last card ran (`lib/scores.ts`).
 */
import { useEffect, useState } from "react";
import "./scores.css";
import { ask } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, Save, Trash2 } from "lucide-react";

import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { busyState, isBusy, refusesClick } from "../../lib/busy";
import { LOADING, load, isEmpty, type LoadState } from "../../lib/loading";
import { kb } from "../../lib/format";
import { locale } from "../../lib/i18n";
import { ipc, type ScoreMeta } from "../../lib/ipc";
import { applyScore, readScore, saveScore, scoreAlreadyExists } from "../../lib/scores";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  /** Source board (to save) and default destination (to apply). */
  groupId?: string;
}

export function ScoresModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const groups = useProjects((s) => s.groups);
  const addBoard = useProjects((s) => s.addBoard);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);

  const groupId = payload?.groupId ?? "";
  const group = groups.find((g) => g.id === groupId);
  // Only a board has an arrangement to save or to add to: opened from a
  // project's group (or from the palette), the dialog is the list alone.
  const board = group && group.projectId === null ? group : undefined;

  const [items, setList] = useState<LoadState<ScoreMeta[]>>(LOADING);
  const [itemName, setName] = useState(board?.name ?? "");
  /**
   * The id of the action in flight (`lib/busy.ts`), not a flat boolean: the
   * button that fired it says so, the others only refuse the click. Saving
   * and applying both touch the disk and used to look like a freeze.
   */
  const [occupied, setBusy] = useState<string | null>(null);
  /**
   * Why the press did not go through. The button stays pressable on purpose:
   * disabling it used to swallow the sentence this dialog already knew how to
   * say (see `components/feedback.test.ts`).
   */
  const [err, setErr] = useState<string | null>(null);
  const saving = busyState(occupied, "salvar");

  const reload = () => {
    setList(LOADING);
    void load(ipc.scoreList()).then(setList);
  };
  useEffect(reload, []);

  const saveIt = async () => {
    const stripped = itemName.trim();
    if (!stripped) {
      setErr(t("Dê um nome à partitura antes de salvar."));
      return;
    }
    if (!board) {
      setErr(t("Abra um quadro para salvar o arranjo dele."));
      return;
    }
    setErr(null);
    setBusy("salvar");
    try {
      await persist(stripped, false);
    } catch (e) {
      // The name is already on disk. It is the one destructive outcome of this
      // dialog and the list right below shows what would be lost, so the user
      // decides — this used to overwrite in silence and report "salva".
      if (!scoreAlreadyExists(e)) {
        showToast(t("Falha ao salvar: {e}", { e: String(e) }), "error");
        setBusy(null);
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
      setBusy(null);
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

  const applyIt = async (score: ScoreMeta, inNewBoard: boolean) => {
    setBusy(`aplicar:${score.name}:${inNewBoard ? "novo" : "aqui"}`);
    try {
      const data = await readScore(score.name);
      // "Here" is the board this dialog was opened from; anywhere else is a
      // new board named after the score. Never a project's group: it has no
      // canvas for the arrangement to land on.
      const target = inNewBoard || !board ? addBoard(score.name) : board.id;
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
      setBusy(null);
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
      {board && (
        <div className="score-save">
          <label className="grow">
            {t("Salvar “{name}” como", { name: board.name })}
            <input
              value={itemName}
              placeholder={t("nome da partitura")}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? "partitura-erro" : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveIt();
              }}
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={refusesClick(saving)}
            aria-busy={isBusy(saving)}
            onClick={() => void saveIt()}
          >
            <Save size={13} /> {isBusy(saving) ? t("Salvando…") : t("Salvar arranjo")}
          </button>
        </div>
      )}
      {err && (
        <p className="hint hint--error" id="partitura-erro" role="alert">
          {err}
        </p>
      )}

      <p className="hint">
        {t(
          "O arranjo guarda as CLIs (programa, argumentos, título), posições, papéis, notas, conexões, desenhos e rotinas. A pasta de trabalho ",
        )}
        <strong>{t("não vai junto")}</strong>
        {t(": ao aplicar, as CLIs nascem paradas na pasta do último cartão do quadro.")}
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
        {(items.state === "pronto" ? items.data : []).map((s) => {
          const here = busyState(occupied, `aplicar:${s.name}:aqui`);
          const fresh = busyState(occupied, `aplicar:${s.name}:novo`);
          return (
          <div key={s.path} className="score">
            <div className="score-body">
              <strong>{s.name}</strong>
              <small data-tip={s.path}>
                {new Date(s.updatedAt).toLocaleString(locale())} · {kb(s.sizeBytes, 1)}
              </small>
            </div>
            {board && (
              <button
                className="btn"
                disabled={refusesClick(here)}
                aria-busy={isBusy(here)}
                data-tip-wrap=""
                data-tip={t(
                  "Acrescentar o arranjo ao quadro “{name}”: as CLIs e notas entram ao lado do que já existe. Não dá para desfazer com Ctrl+Z: para tirar, exclua os cartões.",
                  { name: board.name },
                )}
                onClick={() => void applyIt(s, false)}
              >
                <Download size={13} />{" "}
                {isBusy(here) ? t("Aplicando…") : t("Aplicar aqui")}
              </button>
            )}
            <button
              className="btn"
              disabled={refusesClick(fresh)}
              aria-busy={isBusy(fresh)}
              data-tip={t("Criar um quadro novo com este arranjo")}
              onClick={() => void applyIt(s, true)}
            >
              <FolderOpen size={13} />{" "}
              {isBusy(fresh) ? t("Aplicando…") : t("Quadro novo")}
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
          );
        })}
      </div>
    </Modal>
  );
}
