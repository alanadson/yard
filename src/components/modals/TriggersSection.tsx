/**
 * The "Gatilhos" half of the routines sheet: the group's event-driven
 * automations, listed and created here. Same model the CLI (`yard trigger`)
 * writes — `layoutJson.canvas.triggers` — so what an agent armed shows up
 * here and vice versa. The rules (which edge fires what, the loop guard, the
 * summary line) live in `lib/triggers.ts`; this file only draws them.
 */
import { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { ask } from "@tauri-apps/plugin-dialog";
import { Pause, Play, Plus, Trash2, Zap } from "lucide-react";

import { NumberField } from "../NumberField";
import { Select } from "../Select";
import { useT } from "../../hooks/useT";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import { flowsOf } from "../../lib/flow";
import { locale } from "../../lib/i18n";
import { baseName } from "../../lib/terminals";
import {
  TRIGGER_EVENT_OPTIONS,
  triggerSummary,
} from "../../lib/triggers";
import type { TriggerAction, TriggerDef, TriggerEvent } from "../../lib/canvas";
import { useProjects } from "../../stores/projectsStore";

type Kind = TriggerAction["kind"];

// i18n-scan: tables — rendered through `t()` in the pickers below.
const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "ask", label: "mandar um prompt a uma CLI" },
  { value: "notify", label: "notificar você" },
  { value: "flow", label: "rodar um fluxo nesta CLI" },
];

const PLACEHOLDER: Record<Kind, string> = {
  ask: "ex.: {name} terminou — revise o diff dela e aponte só o que quebrou",
  notify: "ex.: {name} parou numa pergunta: {ask}",
  flow: "a tarefa que abre a esteira (ex.: revise o que acabou de mudar)",
};

export function TriggersSection({
  groupId,
  terminalId,
}: {
  groupId: string;
  terminalId: string;
}) {
  const t = useT();
  const groups = useProjects((s) => s.groups);
  const terminal = useProjects((s) => s.terminal);
  const terminalsOf = useProjects((s) => s.terminalsOf);

  // `groups` in the deps: it is layoutJson that changes when someone writes.
  const canvas = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return g ? useProjects.getState().layoutOf(groupId).canvas : undefined;
  }, [groups, groupId]);
  const all = useMemo(() => canvas?.triggers ?? [], [canvas]);
  const mine = useMemo(
    () => all.filter((def) => def.sourceId === terminalId || def.sourceId === "*"),
    [all, terminalId],
  );
  const others = useMemo(
    () => all.filter((def) => def.sourceId !== terminalId && def.sourceId !== "*"),
    [all, terminalId],
  );
  const flows = useMemo(() => flowsOf(canvas), [canvas]);
  const peers = useMemo(() => terminalsOf(groupId), [terminalsOf, groupId, groups]);

  const nameOf = (id: string) => {
    const row = terminal(id);
    return row ? baseName(row) : t("(CLI removida)");
  };
  const flowNameOf = (id: string) => flows.find((f) => f.id === id)?.name;

  const [event, setEvent] = useState<TriggerEvent>("finished");
  const [anySource, setAnySource] = useState(false);
  const [kind, setKind] = useState<Kind>("ask");
  const [targetId, setTargetId] = useState("");
  const [flowId, setFlowId] = useState("");
  const [text, setText] = useState("");
  const [once, setOnce] = useState(false);
  const [cooldownSec, setCooldownSec] = useState(0);

  const content = text.trim();
  const valid =
    !!content &&
    (kind === "notify" || (kind === "ask" && !!targetId) || (kind === "flow" && !!flowId));

  const create = () => {
    if (!valid || !groupId || !terminalId) return;
    const action: TriggerAction =
      kind === "ask"
        ? { kind, targetId, text: content }
        : kind === "flow"
          ? { kind, flowId, text: content }
          : { kind, text: content };
    const fresh: TriggerDef = {
      id: nanoid(6),
      sourceId: anySource ? "*" : terminalId,
      event,
      action,
      enabled: true,
      once,
      ...(cooldownSec > 0 ? { cooldownSec: Math.round(cooldownSec) } : {}),
      createdAt: Date.now(),
    };
    commitCanvasExternal(groupId, (c) => ({ ...c, triggers: [...(c.triggers ?? []), fresh] }));
    setText("");
  };

  const toggle = (id: string) =>
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      triggers: (c.triggers ?? []).map((def) =>
        def.id === id ? { ...def, enabled: !def.enabled } : def,
      ),
    }));

  const remove = async (def: TriggerDef) => {
    const ok = await ask(
      t("Remover este gatilho?") + "\n\n" + triggerSummary(def, nameOf, flowNameOf),
      {
        title: t("Remover gatilho"),
        kind: "warning",
      },
    );
    if (!ok) return;
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      triggers: (c.triggers ?? []).filter((x) => x.id !== def.id),
    }));
  };

  // The tables keep their Portuguese; the labels are translated where drawn.
  const eventOptions = TRIGGER_EVENT_OPTIONS.map((o) => ({ ...o, label: t(o.label) }));
  const kindOptions = KIND_OPTIONS.map((o) => ({ ...o, label: t(o.label) }));

  return (
    <>
      <h4 className="routine-sub">{t("Gatilhos — quando algo acontecer, faça")}</h4>
      <p className="hint">
        {t("Um gatilho dispara na ")}
        <strong>{t("mudança")}</strong>
        {t(
          ": a CLI terminou um turno, parou numa pergunta ou saiu. Um prompt disparado passa pela mesma regra da rotina — só chega com o alvo rodando e ocioso. ",
        )}
        <code>{"{name}"}</code> {t("e")} <code>{"{ask}"}</code>{" "}
        {t("no texto viram quem disparou e a pergunta em que parou.")}
      </p>

      <div className="routine-form trigger-form">
        <div className="routine-form-row">
          <Select
            className="set-picker"
            label={t("Quando")}
            value={event}
            options={eventOptions}
            onChange={(v) => setEvent(v as TriggerEvent)}
          />
          <label className="routine-check">
            <input
              type="checkbox"
              checked={anySource}
              onChange={(e) => setAnySource(e.target.checked)}
            />
            {t("Qualquer CLI do grupo (não só esta)")}
          </label>
        </div>
        <div className="routine-form-row">
          <Select
            className="set-picker"
            label={t("Então")}
            value={kind}
            options={kindOptions}
            onChange={(v) => setKind(v as Kind)}
          />
          {kind === "ask" && (
            <Select
              className="set-picker"
              label={t("Alvo do prompt")}
              value={targetId}
              placeholder={t("escolha a CLI")}
              options={peers.map((p) => ({
                value: p.id,
                label:
                  p.id === terminalId
                    ? t("{name} (esta CLI)", { name: baseName(p) })
                    : baseName(p),
              }))}
              onChange={setTargetId}
            />
          )}
          {kind === "flow" && (
            <Select
              className="set-picker"
              label={t("Fluxo")}
              value={flowId}
              placeholder={flows.length ? t("escolha o fluxo") : t("nenhum fluxo no grupo")}
              disabled={!flows.length}
              options={flows.map((f) => ({ value: f.id, label: f.name }))}
              onChange={setFlowId}
            />
          )}
        </div>
        <label className="grow">
          {kind === "notify"
            ? t("Texto da notificação")
            : kind === "flow"
              ? t("Tarefa")
              : t("Prompt")}
          <textarea
            rows={2}
            value={text}
            placeholder={t(PLACEHOLDER[kind])}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="routine-form-row">
          <NumberField
            label={t("Intervalo mínimo (s)")}
            value={cooldownSec}
            min={0}
            max={86_400}
            clamp={(n) => (Number.isFinite(n) ? Math.min(86_400, Math.max(0, Math.round(n))) : 0)}
            onChange={setCooldownSec}
          />
          <label className="routine-check">
            <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} />
            {t("Só uma vez")}
          </label>
          <button className="btn btn--primary" disabled={!valid} onClick={create}>
            <Plus size={13} /> {t("Criar gatilho")}
          </button>
        </div>
      </div>

      <div className="routine-list">
        {mine.length === 0 && <p className="hint">{t("Nenhum gatilho nesta CLI ainda.")}</p>}
        {mine.map((def) => (
          <TriggerRow
            key={def.id}
            def={def}
            summary={triggerSummary(def, nameOf, flowNameOf)}
            onToggle={() => toggle(def.id)}
            onRemove={() => void remove(def)}
          />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <h4 className="routine-sub">{t("Outros gatilhos deste grupo")}</h4>
          <div className="routine-list">
            {others.map((def) => (
              <TriggerRow
                key={def.id}
                def={def}
                summary={triggerSummary(def, nameOf, flowNameOf)}
                onToggle={() => toggle(def.id)}
                onRemove={() => void remove(def)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function TriggerRow({
  def,
  summary,
  onToggle,
  onRemove,
}: {
  def: TriggerDef;
  summary: string;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const extras = [
    def.enabled ? "" : t("pausado — não dispara"),
    def.once ? (def.lastRunAt ? t("uma vez · já disparou") : t("uma vez")) : "",
    def.cooldownSec ? t("mín. {s} s entre disparos", { s: def.cooldownSec }) : "",
    def.lastRunAt
      ? t("último: {when}", { when: new Date(def.lastRunAt).toLocaleString(locale()) })
      : "",
  ].filter(Boolean);
  return (
    <div className={`routine ${def.enabled ? "" : "is-paused"}`}>
      <Zap size={13} />
      <div className="routine-body">
        <strong>{summary}</strong>
        <small>{def.action.text}</small>
        {extras.length > 0 && <small className="routine-when">{extras.join(" · ")}</small>}
      </div>
      <button
        className="icon-btn"
        data-tip={def.enabled ? t("Pausar") : t("Retomar")}
        aria-label={def.enabled ? t("Pausar gatilho") : t("Retomar gatilho")}
        onClick={onToggle}
      >
        {def.enabled ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button
        className="icon-btn icon-btn--danger"
        data-tip={t("Remover")}
        aria-label={t("Remover gatilho")}
        onClick={onRemove}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
