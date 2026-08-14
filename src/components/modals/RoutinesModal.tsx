/**
 * Routines of a terminal: lists, creates, pauses and removes scheduled prompts.
 *
 * The modal is the face of the same model the CLI (`yard routine`) touches —
 * both write to `layoutJson.canvas.routines`, so a routine the agent created
 * shows up here and vice versa.
 */
import { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { Clock, Pause, Play, Plus, Trash2 } from "lucide-react";

import { Modal } from "./Modal";
import { commitCanvasExternal } from "../../lib/bridge";
import type { RoutineDef } from "../../lib/canvas";
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
  const alvo = terminal(terminalId);
  const label = alvo ? baseName(alvo) : "terminal";

  // `groups` in the deps: it is layoutJson that changes when someone writes.
  const routines = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return [] as RoutineDef[];
    return (useProjects.getState().layoutOf(groupId).canvas?.routines ?? []).filter(
      (r) => r.terminalId === terminalId,
    );
  }, [groups, groupId, terminalId]);

  const [text, setText] = useState("");
  const [everyMin, setEveryMin] = useState(30);
  const [once, setOnce] = useState(false);

  const criar = () => {
    const conteudo = text.trim();
    if (!conteudo || !groupId || !terminalId) return;
    const nova: RoutineDef = {
      id: nanoid(6),
      terminalId,
      text: conteudo,
      everyMin: Math.max(1, Math.round(everyMin)),
      enabled: true,
      once,
      createdAt: Date.now(),
    };
    commitCanvasExternal(groupId, (c) => ({ ...c, routines: [...(c.routines ?? []), nova] }));
    setText("");
  };

  const alternar = (id: string) =>
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      routines: (c.routines ?? []).map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    }));

  const remover = (id: string) =>
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      routines: (c.routines ?? []).filter((r) => r.id !== id),
    }));

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
          <label>
            A cada (min)
            <input
              type="number"
              min={1}
              value={everyMin}
              onChange={(e) => setEveryMin(Number(e.target.value) || 1)}
            />
          </label>
          <label className="routine-check">
            <input
              type="checkbox"
              checked={once}
              onChange={(e) => setOnce(e.target.checked)}
            />
            Só uma vez (lembrete)
          </label>
          <button className="btn btn--primary" disabled={!text.trim()} onClick={criar}>
            <Plus size={13} /> Criar rotina
          </button>
        </div>
      </div>

      <div className="routine-list">
        {routines.length === 0 && (
          <p className="hint">Nenhuma rotina neste terminal ainda.</p>
        )}
        {routines.map((r) => (
          <div key={r.id} className={`routine ${r.enabled ? "" : "is-paused"}`}>
            <Clock size={13} />
            <div className="routine-body">
              <strong>
                {r.once ? `uma vez em ${r.everyMin} min` : `a cada ${r.everyMin} min`}
                {r.enabled ? "" : " · pausada"}
              </strong>
              <small>{r.text}</small>
              {r.lastRunAt && (
                <small className="routine-when">
                  último disparo: {new Date(r.lastRunAt).toLocaleString()}
                </small>
              )}
            </div>
            <button
              className="icon-btn"
              data-tip={r.enabled ? "Pausar" : "Retomar"}
              aria-label={r.enabled ? "Pausar rotina" : "Retomar rotina"}
              onClick={() => alternar(r.id)}
            >
              {r.enabled ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button
              className="icon-btn"
              data-tip="Remover"
              aria-label="Remover rotina"
              onClick={() => remover(r.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
