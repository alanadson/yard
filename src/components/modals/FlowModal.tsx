/**
 * Flow editor (Flow mode): the whole pipeline visible at once — a vertical
 * timeline of numbered stages joined by a wire. Each stage is a title (the
 * user's) and a prompt; the classic suggestions (Planejador, QA, TDD…) are
 * optional chips, never auto-fill.
 *
 * No CLI is chosen here, on purpose: the flow is a card on the canvas, and
 * **connecting a terminal to it** (tool C) is what arms it — any task sent to
 * that CLI goes through the pipeline, in that same CLI, and the result comes
 * back there. The editor configures the stages; the terminal gives the order.
 */
import { useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Cable, ChevronDown, Plus, Trash2 } from "lucide-react";

import { Modal } from "./Modal";
import { TerminalMark } from "../BrandIcon";
import { useT } from "../../hooks/useT";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import { patchItemOfType, removeItemAndEdges } from "../../lib/canvasOps";
import { flowAgents, FLOW_PRESETS, type FlowItem } from "../../lib/flow";
import { cancelRunsOf, liveRunsOf } from "../../lib/flowRun";
import { baseName } from "../../lib/terminals";
import {
  flowCardHeight,
  FLOW_NAME_MAX,
  type FlowStage,
} from "../../lib/canvas";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  groupId: string;
  /** Id of the `flow` item on the canvas. */
  itemId: string;
}

/** The name a flow card carries until the user writes one — data, not UI. */
const DEFAULT_FLOW_NAME = "Fluxo"; // i18n-ok

export function FlowModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const groupId = payload?.groupId ?? "";
  const itemId = payload?.itemId ?? "";

  // Deliberate snapshot: the form is a draft and must not be rewritten from
  // underneath if an agent touches the canvas while it is open.
  const item = useMemo<FlowItem | undefined>(() => {
    const canvas = useProjects.getState().layoutOf(groupId).canvas;
    return canvas?.items.find(
      (i): i is FlowItem => i.type === "flow" && i.id === itemId,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [name, setName] = useState(item?.name ?? DEFAULT_FLOW_NAME);
  const [stages, setStages] = useState<FlowStage[]>(
    () => item?.stages.map((s) => ({ ...s })) ?? [],
  );
  const [trigger, setTrigger] = useState(item ? item.trigger !== false : true);
  const [touched, setTouched] = useState(false);

  /** The CLIs already hooked to this card — information, not configuration. */
  const wired = useMemo(() => {
    const canvas = useProjects.getState().layoutOf(groupId).canvas;
    if (!canvas || !itemId) return [];
    return flowAgents(canvas, itemId, useProjects.getState().terminalsOn(groupId, "canvas"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchStage = (i: number, patch: Partial<FlowStage>) => {
    setTouched(true);
    setStages((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const moveStage = (i: number, dir: -1 | 1) => {
    setTouched(true);
    setStages((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const dropStage = (i: number) => {
    setTouched(true);
    setStages((cur) => cur.filter((_, j) => j !== i));
  };
  const addStage = () => {
    setTouched(true);
    setStages((cur) => [...cur, { prompt: "" }]);
  };

  const save = () => {
    if (!item) return closeModal();
    const cleanName = name.trim().slice(0, FLOW_NAME_MAX) || DEFAULT_FLOW_NAME;
    // An empty stage is not a stage: the briefing `yard flow stage` hands over
    // would carry no instruction at all, and the CLI would burn a whole turn
    // guessing. They are dropped here instead of being refused, so a row the
    // user added and left blank simply does not become part of the esteira —
    // and the count in the toast says what actually got saved.
    const cleanStages = stages
      .map((s) => ({
        prompt: s.prompt.trim(),
        ...(s.label?.trim() ? { label: s.label.trim() } : {}),
      }))
      .filter((s) => s.prompt.length > 0);
    const emptyCount = stages.length - cleanStages.length;
    commitCanvasExternal(groupId, (c) =>
      patchItemOfType(c, item.id, "flow", {
        name: cleanName,
        stages: cleanStages,
        trigger: trigger ? undefined : false,
        // The card grows to fit the pipeline, but never undoes a larger manual
        // resize — the card's size belongs to the user.
        h: Math.max(item.h, flowCardHeight(cleanStages.length)),
      }),
    );
    const discarded =
      emptyCount > 0
        ? " " + t("{n} etapa(s) sem prompt foram descartadas.", { n: emptyCount })
        : "";
    useUI
      .getState()
      .showToast(
        (cleanStages.length === 0
          ? t(
              'Fluxo "{name}" salvo sem etapas — escreva o prompt de pelo menos uma para poder rodá-lo.',
              { name: cleanName },
            )
          : wired.length
            ? t('Fluxo "{name}" salvo — digite o pedido em {targets} para disparar.', {
                name: cleanName,
                targets: wired.map((term) => `"${baseName(term)}"`).join(", "),
              })
            : t('Fluxo "{name}" salvo — conecte uma CLI ao cartão (tecla C) para armá-lo.', {
                name: cleanName,
              })) + discarded,
        cleanStages.length === 0 ? "error" : "info",
      );
    closeModal();
  };

  const remove = () => {
    if (!item) return;
    // Deleting the card while the esteira walks used to leave the engine
    // running against a copy of the stages: the next stamp still landed in the
    // CLI, from a flow that was no longer on the canvas.
    const running = liveRunsOf([item.id]);
    void ask(
      t('Excluir o fluxo "{name}"?', { name: item.name }) +
        (running.length
          ? "\n\n" + t("Ele está executando agora — a esteira é cancelada na etapa atual.")
          : ""),
      { title: t("Excluir fluxo"), kind: "warning" },
    ).then((yes) => {
      if (!yes) return;
      cancelRunsOf([item.id]);
      commitCanvasExternal(groupId, (c) => removeItemAndEdges(c, item.id));
      closeModal();
    });
  };

  if (!item) {
    return (
      <Modal title={t("Fluxo")} onClose={closeModal}>
        <p className="hint">{t("Esse fluxo não está mais no canvas deste grupo.")}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={t("Fluxo — {name}", { name: item.name })}
      onClose={closeModal}
      wide
      dirty={touched}
      initialFocus=".flow-name-input"
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn btn--danger" onClick={remove}>
            <Trash2 size={13} /> {t("Excluir")}
          </button>
          <span className="grow" />
          <button className="btn" onClick={closeModal}>
            {t("Cancelar")}
          </button>
          <button className="btn btn--primary" onClick={save}>
            {t("Salvar fluxo")}
          </button>
        </div>
      }
    >
      <label>
        {t("Nome do fluxo")}
        <input
          className="flow-name-input"
          type="text"
          value={name}
          maxLength={FLOW_NAME_MAX}
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
        />
      </label>

      <div className="flow-rail" role="list" aria-label={t("Etapas do fluxo, em ordem")}>
        {stages.map((s, i) => (
          <div key={i} className="flow-step" role="listitem">
            <div className="flow-step-spine" aria-hidden="true">
              <span className="flow-step-num">{i + 1}</span>
              {i < stages.length - 1 && (
                <>
                  <span className="flow-step-line" />
                  <ChevronDown size={12} className="flow-step-arrow" />
                </>
              )}
            </div>

            <div className="flow-step-card">
              <div className="flow-step-head">
                <input
                  className="flow-step-title"
                  type="text"
                  value={s.label ?? ""}
                  placeholder={t("Título da etapa {n} — ex.: {example}", {
                    n: i + 1,
                    example: t(FLOW_PRESETS[Math.min(i, FLOW_PRESETS.length - 1)].name),
                  })}
                  aria-label={t("Título da etapa {n}", { n: i + 1 })}
                  onChange={(e) => patchStage(i, { label: e.target.value })}
                />
                <div className="flow-step-actions">
                  <button
                    className="icon-btn"
                    data-tip={t("Subir etapa")}
                    aria-label={t("Subir a etapa {n}", { n: i + 1 })}
                    disabled={i === 0}
                    onClick={() => moveStage(i, -1)}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    className="icon-btn"
                    data-tip={t("Descer etapa")}
                    aria-label={t("Descer a etapa {n}", { n: i + 1 })}
                    disabled={i === stages.length - 1}
                    onClick={() => moveStage(i, 1)}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    data-tip={t("Remover etapa")}
                    aria-label={t("Remover a etapa {n}", { n: i + 1 })}
                    onClick={() => dropStage(i)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              <div className="flow-chips" aria-label={t("Sugestões de etapa")}>
                <span className="flow-chips-label">{t("Sugestões")}</span>
                {FLOW_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    className="flow-chip"
                    data-tip-wrap=""
                    data-tip={p.prompt}
                    onClick={() => patchStage(i, { label: p.name, prompt: p.prompt })}
                  >
                    {t(p.name)}
                  </button>
                ))}
              </div>

              <textarea
                className="flow-step-prompt"
                rows={3}
                value={s.prompt}
                placeholder={t("O que esta etapa deve fazer com a tarefa que chegar…")}
                aria-label={t("Instruções da etapa {n}", { n: i + 1 })}
                onChange={(e) => patchStage(i, { prompt: e.target.value })}
              />
            </div>
          </div>
        ))}

        <div className="flow-step flow-step--add">
          <div className="flow-step-spine" aria-hidden="true">
            <span className="flow-step-num flow-step-num--add">
              <Plus size={12} />
            </span>
          </div>
          <div className="flow-step-addbox">
            <button className="btn" onClick={addStage}>
              <Plus size={13} />
              {stages.length === 0 ? t("Primeira etapa") : t("Adicionar etapa")}
            </button>
          </div>
        </div>
      </div>

      <div className="flow-wired">
        <Cable size={13} aria-hidden="true" />
        {wired.length ? (
          <span>
            {t("Conectado a ")}
            {wired.map((term, i) => (
              <span key={term.id} className="flow-wired-term">
                {i > 0 && ", "}
                <TerminalMark term={term} size={11} /> {baseName(term)}
              </span>
            ))}
            {t(" — a tarefa mandada lá atravessa este fluxo.")}
          </span>
        ) : (
          <span>
            {t("Nenhuma CLI conectada ainda. No canvas, use a ferramenta ")}
            <kbd>C</kbd>
            {t(" para ligar um terminal de agente a este cartão — é isso que arma o fluxo.")}
          </span>
        )}
      </div>

      <label className="flow-trigger">
        <input
          type="checkbox"
          checked={trigger}
          onChange={(e) => {
            setTouched(true);
            setTrigger(e.target.checked);
          }}
        />
        <span>
          <strong>{t("Qualquer prompt digitado na CLI conectada passa pelo fluxo.")}</strong>{" "}
          {t(
            "Nada é enviado ao terminal ao conectar: o Yard intercepta o seu Enter — o pedido vira a tarefa e cada etapa chega como um carimbo de uma linha; o agente busca as instruções com ",
          )}
          <code>yard flow stage</code>
          {t(", sem encher o seu prompt. Desmarcado, o fluxo só roda quando pedido (▶ no rodapé do canvas ou ")}
          <code>yard flow run</code>).
        </span>
      </label>
    </Modal>
  );
}
