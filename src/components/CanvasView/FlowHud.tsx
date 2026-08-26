/**
 * Modo Fluxo — the HUD: the runs in progress, legible at a glance, floating
 * bottom-center. Every stage as a chip, the baton visibly on one of them,
 * blocked in yellow, the finished run dismissible. Clicking the run's name
 * brings the camera to the executing CLI.
 *
 * The idle list is deliberately quiet: the flow cards already live on the
 * board. Here they get only a play button (run without going through a CLI)
 * — the primary way to fire a flow is typing the task in a wired CLI.
 */
import { useRef, useState } from "react";
// The run strip also shows up outside the canvas (see `FlowRunsBar`), and
// there `CanvasView` — the one that loads this stylesheet — is never mounted.
import "./canvas.css";
import { Check, Play, Plus, Workflow, X } from "lucide-react";

import { useOccluder } from "../../hooks/useOccluder";
import { goToTerminalId } from "../../lib/navigate";
import { useNow } from "../../hooks/useNow";
import { flowAgents, type FlowItem } from "../../lib/flow";
import { cancelFlow, startFlow } from "../../lib/flowRun";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useFlows, type FlowRun } from "../../stores/flowStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

interface Props {
  groupId: string;
  flows: FlowItem[];
  /** Takes the camera (and focus) to a card. */
  onReveal: (id: string) => void;
  /** Arms the create-flow tool (F key). */
  onDraw: () => void;
}

function elapsedLabel(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}min` : ""}`;
}

export function RunRow({
  run,
  onReveal,
}: {
  run: FlowRun;
  onReveal: (id: string) => void;
}) {
  const t = useT();
  const now = useNow(1_000);
  const live = !run.finishedAt;
  const state = run.error
    ? t("falhou")
    : run.cancelled
      ? t("cancelado")
      : live
        ? elapsedLabel(run.startedAt, now)
        : t("concluído");

  return (
    <div className={`cv-flowrun ${run.error ? "is-error" : ""}`}>
      <button
        className="cv-flowrun-name"
        data-tip-wrap=""
        data-tip={t("{task}\n\n(clique para ver a CLI executora)", { task: run.task })}
        onClick={() => onReveal(run.terminalId)}
      >
        <Workflow size={12} aria-hidden="true" />
        {run.name}
        <small>{state}</small>
      </button>
      <div className="cv-flowrun-stages">
        {run.stages.map((s, i) => (
          <span
            key={i}
            className={`cv-flowchip is-${s.status}`}
            data-tip-wrap=""
            data-tip={t("{label} — etapa {n}/{total}", { label: s.label, n: i + 1, total: run.stages.length })}
          >
            <span className="cv-flowchip-dot" aria-hidden="true" />
            {i + 1} {s.label}
          </span>
        ))}
      </div>
      {live ? (
        <button
          className="icon-btn"
          data-tip={t("Cancelar o fluxo")}
          aria-label={t("Cancelar o fluxo")}
          onClick={() => cancelFlow(run.flowId)}
        >
          <X size={12} />
        </button>
      ) : (
        <button
          className="icon-btn"
          data-tip={t("Dispensar")}
          aria-label={t("Dispensar este resultado")}
          onClick={() => useFlows.getState().clear(run.flowId)}
        >
          {run.error || run.cancelled ? <X size={12} /> : <Check size={12} />}
        </button>
      )}
    </div>
  );
}

export function FlowHud({ groupId, flows, onReveal, onDraw }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Floats over the board: without publishing the rectangle, a portal
  // underneath paints the site over the chips.
  useOccluder("cv-flowhud", ref);
  const runs = useFlows((s) => s.runs);
  const [runFor, setRunFor] = useState<string | null>(null);
  const [task, setTask] = useState("");

  const groupRuns = Object.values(runs).filter((r) => r.groupId === groupId);
  if (flows.length === 0 && groupRuns.length === 0) return null;

  const idle = flows.filter((f) => !groupRuns.some((r) => r.flowId === f.id));

  /** The CLI the ▶ uses: the first one connected and alive. */
  const executorOf = (flowId: string) => {
    const s = useProjects.getState();
    const canvas = s.layoutOf(groupId).canvas;
    if (!canvas) return undefined;
    return flowAgents(canvas, flowId, s.terminalsOn(groupId, "canvas")).find((t) =>
      isLive(useTerminals.getState().byId[t.id]),
    );
  };

  const runAction = (flow: FlowItem) => {
    const target = executorOf(flow.id);
    if (!target) {
      useUI
        .getState()
        .showToast(
          t('Conecte uma CLI de agente (viva) ao cartão de "{name}" para executá-lo.', { name: flow.name }),
          "error",
        );
      return;
    }
    const r = startFlow(groupId, flow, task, { terminalId: target.id });
    useUI.getState().showToast(r.message, r.ok ? "info" : "error");
    if (r.ok) {
      setRunFor(null);
      setTask("");
    }
  };

  return (
    <div className="cv-flowhud" ref={ref}>
      {groupRuns.map((run) => (
        <RunRow key={run.flowId} run={run} onReveal={onReveal} />
      ))}

      {idle.length > 0 && (
        <div className="cv-flowhud-idle">
          {idle.map((f) => (
            <span key={f.id} className="cv-flowpill">
              <button
                className="cv-flowpill-name"
                data-tip={t("Mostrar o cartão no canvas")}
                onClick={() => onReveal(f.id)}
              >
                <Workflow size={11} aria-hidden="true" />
                {f.name}
              </button>
              <small>{t("{n} etapas", { n: f.stages.length })}</small>
              <button
                className="icon-btn icon-btn--go"
                data-tip={t('Executar "{name}" com uma tarefa avulsa', { name: f.name })}
                aria-label={t("Executar o fluxo {name}", { name: f.name })}
                onClick={() => {
                  setRunFor(runFor === f.id ? null : f.id);
                  setTask("");
                }}
              >
                <Play size={11} />
              </button>
            </span>
          ))}
          <button
            className="icon-btn"
            data-tip={t("Novo fluxo (F)")}
            aria-label={t("Criar um fluxo novo")}
            onClick={onDraw}
          >
            <Plus size={12} />
          </button>
        </div>
      )}

      {runFor && (
        <div className="cv-flowhud-run">
          <input
            autoFocus
            type="text"
            placeholder={t("A tarefa desta execução (normalmente você a manda direto na CLI conectada)")}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              const flow = flows.find((f) => f.id === runFor);
              if (e.key === "Enter" && task.trim() && flow) runAction(flow);
              if (e.key === "Escape") setRunFor(null);
            }}
          />
          <button
            className="btn btn--primary btn--sm"
            disabled={!task.trim()}
            onClick={() => {
              const flow = flows.find((f) => f.id === runFor);
              if (flow) runAction(flow);
            }}
          >
            <Play size={12} /> {t("Executar")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The same run strip, **outside the canvas**.
 *
 * The flow engine doesn't depend on layout: an Enter in a wired CLI fires the
 * pipeline whether the group is in canvas or grid mode. Only the tracking
 * lived on the board alone — in Grid, the user saw a four-second toast and
 * then nothing: neither the stage nor how to stop it. This is the half that
 * matters when there are no cards on screen: the live runs, with cancel.
 *
 * With no run at all it doesn't exist (no empty frame); the cards and the
 * one-off-task ▶ remain the canvas's business.
 */
export function FlowRunsBar({ groupId }: { groupId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useOccluder("flowruns", ref);
  const runs = useFlows((s) => s.runs);
  const ofGroup = Object.values(runs).filter((r) => r.groupId === groupId);
  if (ofGroup.length === 0) return null;
  return (
    <div className="cv-flowhud cv-flowhud--grid" ref={ref}>
      {ofGroup.map((run) => (
        <RunRow key={run.flowId} run={run} onReveal={goToTerminalId} />
      ))}
    </div>
  );
}
