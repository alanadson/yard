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
import { localDay } from "./costs";
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
 * terminal that fired it waits at least this long between laps: ten minutes,
 * because every lap is a paid turn.
 */
export const SELF_ASK_MIN_COOLDOWN_SEC = 600;

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

/**
 * The floor under a trigger that sits in a loop of asks: "A finished → ask
 * B" plus "B finished → ask A" is a ping-pong that bills one turn per lap.
 */
export const CYCLE_MIN_COOLDOWN_SEC = 300;

/** Fires of one `ask` trigger in one local day. Past this it waits for tomorrow. */
export const ASK_DAILY_CAP = 50;

/**
 * The cooldown the "Gatilhos" form offers for a new trigger: a prompt typed
 * into a CLI is a paid turn, so an `ask` starts at five minutes.
 */
export function defaultCooldownSec(kind: TriggerAction["kind"]): number {
  return kind === "ask" ? CYCLE_MIN_COOLDOWN_SEC : 0;
}

function targetsItself(def: TriggerDef): boolean {
  return def.action.kind === "ask" && def.action.targetId === def.sourceId;
}

/** An `ask` that can still fire on a terminal's edge: an arrow of the loop graph. */
function liveAsk(def: TriggerDef): def is TriggerDef & { action: { kind: "ask"; targetId: string } } {
  return def.enabled && def.event !== "budget" && def.action.kind === "ask" && !(def.once && def.lastRunAt);
}

/**
 * The ids of the group's `ask` triggers that belong to a loop. Each one is an
 * arrow source → target, and `"*"` is an arrow from every other terminal; a
 * trigger is in a loop when its target can walk back, through other asks, to
 * a terminal its arrow leaves from.
 */
export function cyclicTriggerIds(defs: readonly TriggerDef[]): Set<string> {
  const asks = defs.filter(liveAsk);
  const nodes = new Set<string>();
  for (const d of asks) {
    nodes.add(d.action.targetId);
    if (d.sourceId !== "*") nodes.add(d.sourceId);
  }
  const next = (from: string) =>
    asks
      .filter((d) => d.sourceId === from || (d.sourceId === "*" && d.action.targetId !== from))
      .map((d) => d.action.targetId);
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    if (from === to) return true;
    while (queue.length) {
      for (const step of next(queue.shift()!)) {
        if (step === to) return true;
        if (!seen.has(step)) {
          seen.add(step);
          queue.push(step);
        }
      }
    }
    return false;
  };
  const out = new Set<string>();
  for (const d of asks) {
    const target = d.action.targetId;
    const looped =
      d.sourceId === "*"
        ? [...nodes].some((node) => node !== target && reaches(target, node))
        : reaches(target, d.sourceId);
    if (looped) out.add(d.id);
  }
  return out;
}

function spentForToday(def: TriggerDef, now: number): boolean {
  if (def.action.kind !== "ask") return false;
  return def.firedDay === localDay(new Date(now)) && (Number(def.firedToday) || 0) >= ASK_DAILY_CAP;
}

/**
 * A wildcard `ask` never hears its own target: "when any CLI finishes, ask
 * Codex to review" would otherwise also fire on Codex's own finish, and Codex
 * would review its own review forever.
 */
function feedsItself(def: TriggerDef, fire: TriggerFire): boolean {
  return def.sourceId === "*" && def.action.kind === "ask" && def.action.targetId === fire.terminalId;
}

/** Which of the group's triggers fire on this edge, right now. */
export function dueTriggers(defs: readonly TriggerDef[], fire: TriggerFire, now: number): TriggerDef[] {
  const looped = cyclicTriggerIds(defs);
  return defs.filter((def) => {
    if (!def.enabled) return false;
    if (def.event !== fire.event) return false;
    if (def.sourceId !== "*" && def.sourceId !== fire.terminalId) return false;
    if (feedsItself(def, fire)) return false;
    if (def.once && def.lastRunAt) return false;
    if (spentForToday(def, now)) return false;
    if (def.lastRunAt) {
      const floor = Math.max(
        targetsItself(def) ? SELF_ASK_MIN_COOLDOWN_SEC : 0,
        looped.has(def.id) ? CYCLE_MIN_COOLDOWN_SEC : 0,
      );
      const cooldown = Math.max(def.cooldownSec ?? 0, floor) * 1000;
      if (now - def.lastRunAt < cooldown) return false;
    }
    return true;
  });
}

/**
 * The sheet's pause/resume button. Switching on is also the user's approval
 * of a trigger an agent created, so `awaitingApproval` goes with it.
 */
export function toggledTrigger(def: TriggerDef): TriggerDef {
  if (def.enabled) return { ...def, enabled: false };
  const { awaitingApproval: _pending, ...approved } = def;
  return { ...approved, enabled: true };
}

/**
 * A trigger whose action is a paid turn (a prompt into a CLI, a flow). These
 * are held while automation is paused; a notification costs nothing and goes.
 */
export function spendsTokens(def: TriggerDef): boolean {
  return def.action.kind !== "notify";
}

/** `{name}` and `{ask}` in a trigger's text — nothing else is interpolated. */
export function renderText(text: string, ctx: { name: string; ask?: string | null }): string {
  return text.replace(/\{name\}/g, ctx.name).replace(/\{ask\}/g, ctx.ask ?? "");
}

/**
 * The trigger after it fired: stamped, switched off when it was a one-shot,
 * and, for an `ask`, one more fire counted against the local day's cap.
 */
export function afterFire(def: TriggerDef, now: number): TriggerDef {
  const stamped = { ...def, lastRunAt: now, enabled: def.once ? false : def.enabled };
  if (def.action.kind !== "ask") return stamped;
  const today = localDay(new Date(now));
  const before = def.firedDay === today ? Number(def.firedToday) || 0 : 0;
  return { ...stamped, firedDay: today, firedToday: before + 1 };
}

// i18n-scan: tables — the labels below are wrapped with t() where they are rendered
// (triggerSummary here, the picker in TriggersSection).
export const TRIGGER_EVENT_LABELS: Record<TriggerEvent, string> = {
  finished: "terminar",
  blocked: "travar numa pergunta",
  exited: "sair",
  budget: "estourar o orçamento",
};

export const TRIGGER_EVENT_OPTIONS: { value: TriggerEvent; label: string }[] = [
  { value: "finished", label: "terminar um turno" },
  { value: "blocked", label: "travar numa pergunta" },
  { value: "exited", label: "sair (processo encerrado)" },
  // Not an edge of any one CLI: the day's spend crossing the ceiling set in
  // Configurações → Custos. Only a trigger armed for "qualquer CLI" hears it.
  { value: "budget", label: "estourar o orçamento do dia" },
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
  'uso: yard trigger create --when finished|blocked|exited|budget --on "Agente"|any \\\n' + // i18n-ok, CLI output
  '       --ask "Alvo" "prompt" | --notify "texto" | --flow "Fluxo" "tarefa" [--once] [--cooldown 60]\n' + // i18n-ok
  "     ({name} e {ask} no texto viram o nome de quem disparou e a pergunta em que parou;\n" + // i18n-ok
  "      --file/--stdin para um texto longo)\n"; // i18n-ok

const EVENTS: readonly TriggerEvent[] = ["finished", "blocked", "exited", "budget"];

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
  // `budget` has no source to name: it is the workspace's day, not a CLI's
  // edge. Demanding `--on any` there would be asking for a word that can only
  // have one value.
  const isBudget = when === "budget";
  if (!on && !isBudget) return fail;
  const source =
    isBudget || !on || on.toLowerCase() === "any" || on === "*" ? "*" : on;
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
    // A flow runs *on the CLI that fired*, and the budget edge fires on
    // nobody. There is no terminal to start the pipeline in.
    if (isBudget) return fail;
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
