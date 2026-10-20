/**
 * The switch that actually stops automation when the money or the quota runs
 * out.
 *
 * The budget (`lib/budget.ts`) used to be a chip and a balloon: six agents
 * kept feeding each other while the footer said "140% do orçamento". This
 * module decides when to write `automation.paused` (the kv key the native
 * scheduler reads, `{"reason","at"}`; empty means running), and when not to:
 *
 * - **budget**: the day reached "over" and `budgetPauseAutomation` is on;
 * - **quota**: a provider's five-hour window reached `quotaPausePct` (0 is off);
 * - **user resumed today**: the reason they resumed from does not pause them
 *   again until the next local day. The chip told them, they chose to go on,
 *   and the app overruling them five minutes later would be a fight.
 *
 * While paused, the native scheduler delivers no queue item or routine and no
 * native flow starts a new stage; the front end refuses its own automatic
 * senders (`yard ask`, trigger asks, fan-outs, recruits). What the user types
 * is never gated. Everything here is pure; `stores/automationStore.ts` keeps
 * the state and does the writes.
 */
import type { BudgetLevel } from "./budget";
import { localDay } from "./costs";
import { t } from "./i18n";
import type { ProviderUsage } from "./ipc";

/** The kv key the native scheduler reads. */
export const KV_AUTOMATION_PAUSED = "automation.paused";
/** Today's reasons the user resumed from (front end only). */
export const KV_PAUSE_SUPPRESSED = "automation.resumedToday";

export type PauseReason = "budget" | "quota" | "user";

const REASONS: readonly PauseReason[] = ["budget", "quota", "user"];

export interface AutomationPause {
  reason: PauseReason;
  /** Epoch ms of when it was paused. */
  at: number;
}

export interface PauseSuppression {
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  reasons: PauseReason[];
}

export interface PausePrefs {
  budgetPauseAutomation: boolean;
  /** 0 is off. */
  quotaPausePct: number;
}

function isReason(value: unknown): value is PauseReason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value);
}

/** The kv value, read defensively: empty, missing or junk is "not paused". */
export function parsePause(raw: string | null | undefined): AutomationPause | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { reason?: unknown; at?: unknown };
    if (!data || typeof data !== "object" || !isReason(data.reason)) return null;
    return { reason: data.reason, at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0 };
  } catch {
    return null;
  }
}

/** What goes into the kv: JSON for a pause, `""` for none. */
export function serializePause(pause: AutomationPause | null): string {
  return pause ? JSON.stringify({ reason: pause.reason, at: pause.at }) : "";
}

export function parseSuppression(raw: string | null | undefined): PauseSuppression | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { day?: unknown; reasons?: unknown };
    if (!data || typeof data.day !== "string" || !Array.isArray(data.reasons)) return null;
    return { day: data.day, reasons: data.reasons.filter(isReason) };
  } catch {
    return null;
  }
}

/** A provider's five-hour window: the "session" limit the CLIs reset every 5 h. */
function isFiveHourWindow(w: ProviderUsage["windows"][number]): boolean {
  return w.windowMinutes === 300 || w.key === "session";
}

/** The most used five-hour window across providers, `null` when none reported one. */
export function quotaPeak(providers: readonly ProviderUsage[]): number | null {
  let peak: number | null = null;
  for (const p of providers) {
    for (const w of p.windows) {
      if (!isFiveHourWindow(w) || !Number.isFinite(w.usedPercent)) continue;
      peak = peak === null ? w.usedPercent : Math.max(peak, w.usedPercent);
    }
  }
  return peak;
}

export interface PauseInputs {
  /** The day's budget level, when this call comes from the budget tick. */
  budgetLevel?: BudgetLevel;
  /** The peak five-hour window, when this call comes from a usage snapshot. */
  quotaPct?: number | null;
  prefs: PausePrefs;
  current: AutomationPause | null;
  suppressed: PauseSuppression | null;
  now: number;
}

/** The pause to write now, or `null` when nothing changes. */
export function pauseToApply(inputs: PauseInputs): AutomationPause | null {
  const { prefs, current, suppressed, now } = inputs;
  if (current) return null;
  const today = localDay(new Date(now));
  const resumed = (reason: PauseReason) => suppressed?.day === today && suppressed.reasons.includes(reason);
  if (prefs.budgetPauseAutomation && inputs.budgetLevel === "over" && !resumed("budget")) {
    return { reason: "budget", at: now };
  }
  const quota = inputs.quotaPct;
  if (prefs.quotaPausePct > 0 && quota != null && quota >= prefs.quotaPausePct && !resumed("quota")) {
    return { reason: "quota", at: now };
  }
  return null;
}

/** After the user resumes: that reason stays quiet for the rest of the local day. */
export function suppressAfterResume(
  previous: PauseSuppression | null,
  pause: AutomationPause,
  now: number,
): PauseSuppression {
  const day = localDay(new Date(now));
  const reasons = previous?.day === day ? previous.reasons : [];
  return { day, reasons: reasons.includes(pause.reason) ? [...reasons] : [...reasons, pause.reason] };
}

/** Why, in words: the chip's tooltip, the toast and the CLI's refusal. */
export function pauseReasonText(reason: PauseReason): string {
  switch (reason) {
    case "budget":
      return t("orçamento do dia estourado");
    case "quota":
      return t("janela de 5 h do plano quase no fim");
    case "user":
      return t("pausada por você");
  }
}

/** The status bar chip's tooltip and the toast. */
export function pauseMessage(pause: AutomationPause): string {
  return t("Automação pausada: {reason}. Retome pelo rodapé quando quiser.", {
    reason: pauseReasonText(pause.reason),
  });
}

/** What `yard` answers an agent whose automatic send was refused. */
export function pausedReply(pause: AutomationPause): string {
  return (
    `yard: a automação está pausada (${pauseReasonText(pause.reason)}). Nada foi enviado. ` +
    "Só o usuário retoma, pelo rodapé do Yard; até lá, termine o seu turno sem acionar outros agentes.\n"
  );
}
