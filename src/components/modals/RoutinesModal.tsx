/**
 * Routines of a terminal: lists, creates, pauses and removes scheduled prompts.
 *
 * The modal is the face of the same model the CLI (`yard routine`) touches —
 * both write to `layoutJson.canvas.routines`, so a routine the agent created
 * shows up here and vice versa.
 */
import { useMemo, useState } from "react";
import "./routines.css";
import { nanoid } from "nanoid";
import { ask } from "@tauri-apps/plugin-dialog";
import { Clock, Pause, Play, Plus, Trash2 } from "lucide-react";

import { Modal } from "./Modal";
import { NumberField } from "../NumberField";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import {
  clampRoutineInterval,
  routineNextAt,
  ROUTINE_MAX_MIN,
  ROUTINE_MIN_MIN,
  type RoutineDef,
} from "../../lib/canvas";
import { baseName } from "../../lib/terminals";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  groupId: string;
  terminalId: string;
}

export function RoutinesModal() {
  const closeModal = useUI((s) => s.closeModal);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const groups = useProjects((s) => s.groups);
  const terminal = useProjects((s) => s.terminal);

  const groupId = payload?.groupId ?? "";
  const terminalId = payload?.terminalId ?? "";
  const target = terminal(terminalId);
  const label = target ? baseName(target) : "terminal";

  // `groups` in the deps: it is layoutJson that changes when someone writes.
  const all = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return [] as RoutineDef[];
    return useProjects.getState().layoutOf(groupId).canvas?.routines ?? [];
  }, [groups, groupId]);
  const routines = useMemo(
    () => all.filter((r) => r.terminalId === terminalId),
    [all, terminalId],
  );
  /**
   * The routines of this group's other CLIs.
   *
   * They write into the terminals on their own and were only visible through
   * each card's menu — to know what was armed you had to open them one by one
   * (the CLI has `yard routine list`; the UI had nothing). Here they appear
   * together, with the name of who receives them.
   */
  const others = useMemo(
    () => all.filter((r) => r.terminalId !== terminalId),
    [all, terminalId],
  );

  const [text, setText] = useState("");
  const [everyMin, setEveryMin] = useState(30);
  const [once, setOnce] = useState(false);

  const create = () => {
    const content = text.trim();
    if (!content || !groupId || !terminalId) return;
    const fresh: RoutineDef = {
      id: nanoid(6),
      terminalId,
      text: content,
      everyMin: clampRoutineInterval(everyMin),
      enabled: true,
      once,
      createdAt: Date.now(),
    };
    commitCanvasExternal(groupId, (c) => ({ ...c, routines: [...(c.routines ?? []), fresh] }));
    setText("");
  };

  const toggle = (id: string) =>
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      routines: (c.routines ?? []).map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    }));

  // Asked, like every other delete in the app: the prompt of a routine is
  // written once and fires for weeks, and this button sits right next to the
  // pause one.
  const remove = async (r: RoutineDef) => {
    const ok = await ask(
      `Remover esta rotina de "${label}"?\n\n` +
        r.text.slice(0, 160) +
        (r.text.length > 160 ? "…" : ""),
      { title: "Remover rotina", kind: "warning" },
    );
    if (!ok) return;
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      routines: (c.routines ?? []).filter((x) => x.id !== r.id),
    }));
  };

  return (
    <Modal title={`Rotinas — ${label}`} onClose={closeModal} wide>
      <p className="hint">
        Um prompt agendado só é entregue com o terminal <strong>rodando e
        ocioso</strong>: uma rotina nunca interrompe trabalho em andamento — ela
        espera o próximo intervalo.
      </p>

      <div className="routine-form">
        <label className="grow">
          Prompt
          <textarea
            rows={3}
            value={text}
            placeholder="ex.: rode os testes e me diga só o que quebrou"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="routine-form-row">
          {/* The same field as Preferences. The previous one was hand-written
              and would not let you clear the content: `Number("") || 1` put
              `1` in the field mid-typing and the next digit piled on top. */}
          <NumberField
            label="A cada (min)"
            value={everyMin}
            min={ROUTINE_MIN_MIN}
            max={ROUTINE_MAX_MIN}
            clamp={clampRoutineInterval}
            onChange={setEveryMin}
          />
          <label className="routine-check">
            <input
              type="checkbox"
              checked={once}
              onChange={(e) => setOnce(e.target.checked)}
            />
            Só uma vez (lembrete)
          </label>
          <button className="btn btn--primary" disabled={!text.trim()} onClick={create}>
            <Plus size={13} /> Criar rotina
          </button>
        </div>
      </div>

      <div className="routine-list">
        {routines.length === 0 && (
          <p className="hint">Nenhuma rotina neste terminal ainda.</p>
        )}
        {routines.map((r) => (
          <RoutineRow
            key={r.id}
            r={r}
            onToggle={() => toggle(r.id)}
            onRemove={() => void remove(r)}
          />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <h4 className="routine-sub">Outras rotinas deste grupo</h4>
          <div className="routine-list">
            {others.map((r) => (
              <RoutineRow
                key={r.id}
                r={r}
                owner={(() => {
                  const t = terminal(r.terminalId);
                  return t ? baseName(t) : "(CLI removida)";
                })()}
                onToggle={() => toggle(r.id)}
                onRemove={() => void remove(r)}
              />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/** One routine in the list: when it fires again, and the two actions. */
function RoutineRow({
  r,
  owner: who,
  onToggle,
  onRemove,
}: {
  r: RoutineDef;
  /** Name of the CLI, when the row is not the focused terminal's. */
  owner?: string;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const following = routineNextAt(r);
  const overdue = following <= Date.now();
  return (
    <div className={`routine ${r.enabled ? "" : "is-paused"}`}>
      <Clock size={13} />
      <div className="routine-body">
        <strong>
          {who ? `${who} · ` : ""}
          {r.once ? `uma vez em ${r.everyMin} min` : `a cada ${r.everyMin} min`}
          {r.enabled ? "" : " · pausada"}
        </strong>
        <small>{r.text}</small>
        <small className="routine-when">
          {!r.enabled
            ? "pausada — não dispara"
            : overdue
              ? // The scheduler's rule: never interrupts work in progress.
                "dispara no próximo momento em que a CLI estiver livre"
              : `próximo disparo: ${new Date(following).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`}
          {r.lastRunAt
            ? ` · último: ${new Date(r.lastRunAt).toLocaleString("pt-BR")}`
            : ""}
        </small>
      </div>
      <button
        className="icon-btn"
        data-tip={r.enabled ? "Pausar" : "Retomar"}
        aria-label={r.enabled ? "Pausar rotina" : "Retomar rotina"}
        onClick={onToggle}
      >
        {r.enabled ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button
        className="icon-btn icon-btn--danger"
        data-tip="Remover"
        aria-label="Remover rotina"
        onClick={onRemove}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
