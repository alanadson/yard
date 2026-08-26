/**
 * Triggers — "when X happens to a terminal, do Y".
 *
 * Routines fire by the clock (`routineDue`); `yard wait` blocks on the
 * agent's side. This is the app-side rule for the third shape: an *edge* in
 * the runtime mirror (a CLI finished, stopped at a question, went down)
 * becomes an action (type a prompt into another CLI, notify the user, run a
 * flow). Everything that decides is here and pure; the hook that watches the
 * store and delivers is `hooks/useTriggers.ts`.
 *
 * Edges, not states: the mirror repeats `finished: true` for as long as
 * nobody reads the terminal, and a trigger that fired on every snapshot would
 * re-send the same prompt on every re-render. So a fire needs the flag to go
 * up (or `finishedAt` to move — a second idle without the flag ever dropping
 * is a second finish), and `exited` needs a process that was actually live in
 * this session: a dead terminal found at boot never "went down" now.
 */
import type { TriggerAction, TriggerDef, TriggerEvent } from "./canvas";
import { parseFlags } from "./bridgeCore";
import type { TerminalRuntime } from "../stores/terminalsStore";
import { t } from "./i18n";

export interface TriggerFire {
  event: TriggerEvent;
  terminalId: string;
  /** The question the terminal stopped at, on a `blocked` fire. */
  ask?: string | null;
}

/**
 * The loop guard. "When I finish, ask me to go on" is a legitimate nudge —
 * and, with no floor, a treadmill: the answer finishes, fires again, one
 * turn of tokens per lap, forever. A trigger whose `ask` lands on the very
 * terminal that fired it waits at least this long between laps.
 */
export const SELF_ASK_MIN_COOLDOWN_SEC = 60;

function live(rt: TerminalRuntime | undefined): boolean {
  return rt?.state === "running" || rt?.state === "starting";
}

function down(rt: TerminalRuntime): boolean {
  return rt.state === "exited" || rt.state === "error";
}

/**
 * The edges between two snapshots of one terminal's runtime. `terminalId` is
 * left empty: the caller knows which key it is diffing and stamps it.
 */
export function transitions(
  prev: TerminalRuntime | undefined,
  next: TerminalRuntime,
): TriggerFire[] {
  if (!prev || prev === next) return [];
  const out: TriggerFire[] = [];
  const stopped = next.finished && (!prev.finished || next.finishedAt > prev.finishedAt);
  if (stopped && next.blocked && (!prev.blocked || next.finishedAt > prev.finishedAt)) {
    out.push({ event: "blocked", terminalId: "", ask: next.blockedAsk ?? null });
  } else if (stopped && !next.blocked) {
    out.push({ event: "finished", terminalId: "" });
  }
  if (live(prev) && down(next)) out.push({ event: "exited", terminalId: "" });
  return out;
}

function targetsItself(def: TriggerDef, fire: TriggerFire): boolean {
  if (def.action.kind !== "ask") return false;
  const source = def.sourceId === "*" ? fire.terminalId : def.sourceId;
  return def.action.targetId === source;
}

/** Which of the group's triggers fire on this edge, right now. */
export function dueTriggers(defs: readonly TriggerDef[], fire: TriggerFire, now: number): TriggerDef[] {
  return defs.filter((def) => {
    if (!def.enabled) return false;
    if (def.event !== fire.event) return false;
    if (def.sourceId !== "*" && def.sourceId !== fire.terminalId) return false;
    if (def.once && def.lastRunAt) return false;
    if (def.lastRunAt) {
      const floor = targetsItself(def, fire) ? SELF_ASK_MIN_COOLDOWN_SEC : 0;
      const cooldown = Math.max(def.cooldownSec ?? 0, floor) * 1000;
      if (now - def.lastRunAt < cooldown) return false;
    }
    return true;
  });
}

/** `{name}` and `{ask}` in a trigger's text — nothing else is interpolated. */
export function renderText(text: string, ctx: { name: string; ask?: string | null }): string {
  return text.replace(/\{name\}/g, ctx.name).replace(/\{ask\}/g, ctx.ask ?? "");
}

/** The trigger after it fired: stamped, and switched off when it was a one-shot. */
export function afterFire(def: TriggerDef, now: number): TriggerDef {
  return { ...def, lastRunAt: now, enabled: def.once ? false : def.enabled };
}

// i18n-scan: tables — the labels below are wrapped with t() where they are rendered
// (triggerSummary here, the picker in TriggersSection).
export const TRIGGER_EVENT_LABELS: Record<TriggerEvent, string> = {
  finished: "terminar",
  blocked: "travar numa pergunta",
  exited: "sair",
};

export const TRIGGER_EVENT_OPTIONS: { value: TriggerEvent; label: string }[] = [
  { value: "finished", label: "terminar um turno" },
  { value: "blocked", label: "travar numa pergunta" },
  { value: "exited", label: "sair (processo encerrado)" },
];

/** One sentence per trigger: "Quando <origem> <evento> → <ação>". */
export function triggerSummary(
  def: TriggerDef,
  nameOf: (id: string) => string,
  flowNameOf: (id: string) => string | undefined,
): string {
  const who = def.sourceId === "*" ? t("qualquer CLI") : nameOf(def.sourceId);
  return t("Quando {who} {event} → {action}", {
    who,
    event: t(TRIGGER_EVENT_LABELS[def.event]),
    action: actionSummary(def.action, nameOf, flowNameOf),
  });
}

export function actionSummary(
  action: TriggerAction,
  nameOf: (id: string) => string,
  flowNameOf: (id: string) => string | undefined,
): string {
  switch (action.kind) {
    case "ask":
      return t("mandar prompt a {name}", { name: nameOf(action.targetId) });
    case "notify":
      return t("notificar você");
    case "flow":
      return t("rodar o fluxo {name}", { name: flowNameOf(action.flowId) ?? t("(removido)") });
  }
}

// ---------------------------------------------------------------------------
// `yard trigger create` — the line, parsed; names are resolved by the bridge
// ---------------------------------------------------------------------------

export type TriggerActionSpec =
  | { kind: "ask"; target: string; text: string }
  | { kind: "notify"; text: string }
  | { kind: "flow"; flow: string; text: string };

export interface TriggerCreateSpec {
  event: TriggerEvent;
  /** A terminal name, or `"*"`. */
  source: string;
  action: TriggerActionSpec;
  once: boolean;
  cooldownSec: number | undefined;
}

export const TRIGGER_CREATE_USAGE =
  'uso: yard trigger create --when finished|blocked|exited --on "Agente"|any \\\n' + // i18n-ok — CLI output
  '       --ask "Alvo" "prompt" | --notify "texto" | --flow "Fluxo" "tarefa" [--once] [--cooldown 60]\n' + // i18n-ok
  "     ({name} e {ask} no texto viram o nome de quem disparou e a pergunta em que parou;\n" + // i18n-ok
  "      --file/--stdin para um texto longo)\n"; // i18n-ok

const EVENTS: readonly TriggerEvent[] = ["finished", "blocked", "exited"];

export function parseTriggerCreate(
  args: string[],
  stdinText: string | undefined,
): { ok: true; spec: TriggerCreateSpec } | { ok: false; usage: string } {
  const p = parseFlags(args, {
    "--when": "string",
    "--on": "string",
    "--ask": "string",
    "--notify": "bool",
    "--flow": "string",
    "--once": "bool",
    "--cooldown": "number",
    "--stdin": "stdin",
    "--file": "stdin",
  });
  const fail = { ok: false as const, usage: TRIGGER_CREATE_USAGE };
  const when = p.string.when?.trim().toLowerCase();
  if (!when || !EVENTS.includes(when as TriggerEvent)) return fail;
  const on = p.string.on?.trim();
  if (!on) return fail;
  const source = on.toLowerCase() === "any" || on === "*" ? "*" : on;
  const text = p.fromStdin ? (stdinText ?? "") : (p.positional[0] ?? "");

  const kinds = [p.string.ask !== undefined, !!p.bool.notify, p.string.flow !== undefined].filter(
    Boolean,
  ).length;
  if (kinds !== 1) return fail;

  let action: TriggerActionSpec;
  if (p.string.ask !== undefined) {
    if (!p.string.ask.trim() || !text.trim()) return fail;
    action = { kind: "ask", target: p.string.ask.trim(), text };
  } else if (p.bool.notify) {
    if (!text.trim()) return fail;
    action = { kind: "notify", text };
  } else {
    if (!p.string.flow?.trim() || !text.trim()) return fail;
    action = { kind: "flow", flow: p.string.flow.trim(), text };
  }

  const cooldown = p.number.cooldown;
  return {
    ok: true,
    spec: {
      event: when as TriggerEvent,
      source,
      action,
      once: !!p.bool.once,
      cooldownSec:
        cooldown !== undefined && Number.isFinite(cooldown) && cooldown > 0
          ? Math.round(cooldown)
          : undefined,
    },
  };
}
