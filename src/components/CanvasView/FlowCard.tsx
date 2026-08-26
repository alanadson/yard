/**
 * The flow card on the canvas: the prompt pipeline as a first-class object —
 * draggable, connectable and legible from afar. Each row is a stage; during
 * a run the rows light up one by one (pending → working → done), so the card
 * is its own progress panel.
 *
 * A still click opens the editor (same gesture as the note); dragging moves.
 * Connecting a CLI to the card (tool C) is what arms the flow.
 */
import { memo, useRef } from "react";
import { Pencil, Workflow, X } from "lucide-react";

import { ResizeHandles } from "./ResizeHandles";
import { cancelFlow } from "../../lib/flowRun";
import { stageLabelOf, type FlowItem } from "../../lib/flow";
import type { CanvasItem, ResizeDir } from "../../lib/canvas";
import { useFlows } from "../../stores/flowStore";
import { useT } from "../../hooks/useT";

/** Same displacement the note tolerates between "click" and "drag". */
const CLICK_SLOP = 4;

interface Props {
  it: FlowItem;
  dx: number;
  dy: number;
  /** Live size during a resize (the same channel the note uses). */
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  /** Connect-tool highlight (source/target), like the note and the portal. */
  connectClass: string;
  /** How many agent CLIs are connected to this card. */
  wired: number;
  selectTool: boolean;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  onEdit: (id: string) => void;
  onResizeStart: (
    e: React.PointerEvent,
    it: Extract<CanvasItem, { type: "note" | "flow" }>,
    dir: ResizeDir,
  ) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}

function FlowCardImpl({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  connectClass,
  wired,
  selectTool,
  onItemDown,
  onItemMove,
  onItemUp,
  onEdit,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: Props) {
  const t = useT();
  const run = useFlows((s) => s.runs[it.id]);
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const live = run && !run.finishedAt;

  return (
    <div
      className={`cv-flowcard ${selected ? "is-selected" : ""} ${connectClass} ${
        live ? "is-running" : ""
      }`}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        width: w,
        height: h,
        opacity: faded ? 0.22 : 1,
      }}
      // The same pact as the note: the whole card drags, and a click with no
      // displacement opens the editor — see the long comment on `.cv-note-read`.
      onPointerDown={(e) => {
        if (!selectTool || e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        press.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        onItemDown(e, it.id);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={onItemMove}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        onItemUp(e);
        if (!p || p.id !== e.pointerId) return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= CLICK_SLOP) onEdit(it.id);
      }}
      onPointerCancel={(e) => {
        press.current = null;
        onItemUp(e);
      }}
    >
      <div className="cv-flowcard-head">
        <Workflow size={12} aria-hidden="true" />
        <span className="cv-flowcard-name">{it.name}</span>
        {live ? (
          <button
            className="icon-btn icon-btn--danger"
            data-tip={t("Cancelar a execução")}
            aria-label={t("Cancelar a execução do fluxo {name}", { name: it.name })}
            onClick={(e) => {
              e.stopPropagation();
              cancelFlow(it.id);
            }}
          >
            <X size={11} />
          </button>
        ) : (
          <button
            className="icon-btn"
            data-tip={t("Editar etapas")}
            aria-label={t("Editar o fluxo {name}", { name: it.name })}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(it.id);
            }}
          >
            <Pencil size={11} />
          </button>
        )}
      </div>

      <div className="cv-flowcard-stages">
        {it.stages.length === 0 && (
          <span className="cv-flowcard-hint">{t("Sem etapas — clique para editar.")}</span>
        )}
        {it.stages.map((s, i) => {
          const status = run?.stages[i]?.status;
          return (
            <div key={i} className={`cv-flowcard-stage ${status ? `is-${status}` : ""}`}>
              <span className="cv-flowcard-num">{i + 1}</span>
              <span className="cv-flowcard-label">{stageLabelOf(s, i)}</span>
              {status && <span className="cv-flowcard-dot" aria-hidden="true" />}
            </div>
          );
        })}
      </div>

      <div className="cv-flowcard-foot">
        {live
          ? t("rodando — etapa {step}/{total}", {
              step: Math.min((run?.current ?? 0) + 1, it.stages.length),
              total: it.stages.length,
            })
          : run?.error
            ? t("última execução falhou")
            : wired === 0
              ? t("conecte uma CLI (tecla C) para armar")
              : t("{n} CLI(s) conectada(s) — mande a tarefa lá", { n: wired })}
      </div>

      <ResizeHandles
        onDown={(e, dir) => onResizeStart(e, it, dir)}
        onMove={onResizeMove}
        onUp={onResizeEnd}
      />
    </div>
  );
}

export const FlowCard = memo(FlowCardImpl);
