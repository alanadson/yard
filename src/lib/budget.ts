/**
 * A ceiling on the day's spend.
 *
 * "Custos e uso" (`lib/costs.ts`) is an excellent rear-view mirror: tokens and
 * dollars per day, project, agent and model, read from the CLIs' own session
 * files. It is also entirely passive — you find out on Thursday what Tuesday
 * cost. With six agents running unattended, and one of them looping, that is
 * the wrong moment to find out.
 *
 * The budget is the same numbers with a line drawn across them, and the whole
 * design question is *when to speak*. The answer here is: only when the level
 * gets worse (`worsened`). Not on a timer, not while it stays where it is, and
 * never on the way down — the day's total resets at midnight, and a balloon at
 * 00:00 saying "you are within budget again" is how a feature earns itself an
 * off switch.
 *
 * The `partial` flag is inherited from the costs panel and matters for the
 * same reason: a day with a model outside the price table has a **floor**, not
 * a total. Saying "half your budget" from a floor would be counting the
 * missing part as zero. And a day with **no** priced usage at all (a
 * Codex-only day) is `unknown`: the budget cannot measure it, and says so
 * instead of reading 0% as "ok".
 */
import { totals } from "./costs";
import { t } from "./i18n";
import type { UsageRow } from "./ipc";

/** Where the warning starts: four fifths, while there is still time to act. */
export const WARN_AT = 0.8;

export type BudgetLevel = "off" | "ok" | "warn" | "over";

export interface BudgetState {
  level: BudgetLevel;
  /** Percentage of the limit, past 100 when it is blown. 0 when off. */
  pct: number;
  spent: number;
  limit: number;
  /** The spend is a floor: some rows had no price. */
  partial: boolean;
  /** There was usage and none of it had a price: the spend is not known at all. */
  unknown: boolean;
}

export function budgetState(
  spent: number,
  limit: number,
  priced = true,
): BudgetState {
  const partial = !priced;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { level: "off", pct: 0, spent, limit: 0, partial, unknown: false };
  }
  const ratio = spent / limit;
  const level: BudgetLevel = ratio >= 1 ? "over" : ratio >= WARN_AT ? "warn" : "ok";
  return { level, pct: Math.round(ratio * 100), spent, limit, partial, unknown: false };
}

/** The budget of one local day, from the usage rows the costs panel reads. */
export function budgetOfDay(rows: readonly UsageRow[], limit: number, day: string): BudgetState {
  const sum = totals(rows.filter((row) => row.day === day));
  const state = budgetState(sum.costUsd ?? 0, limit, sum.priced);
  return { ...state, unknown: state.level !== "off" && sum.rows > 0 && sum.costUsd === null };
}

/** Whether the move from `before` to `after` is worth a word. */
export function worsened(before: BudgetLevel, after: BudgetLevel): boolean {
  const rank: Record<BudgetLevel, number> = { off: 0, ok: 1, warn: 2, over: 3 };
  return rank[after] > rank[before] && after !== "ok";
}

/** The sentence the toast, the notification and the chip's tooltip carry. */
export function budgetMessage(state: BudgetState): string {
  const spent = state.spent.toFixed(2);
  const limit = state.limit.toFixed(2);
  if (state.unknown) {
    return t(
      "Orçamento do dia sem medida: o uso de hoje é de modelos sem preço conhecido (teto de US$ {limit}).",
      { limit },
    );
  }
  const head =
    state.level === "over"
      ? t("Orçamento do dia estourado: US$ {spent} de US$ {limit}.", { spent, limit })
      : t("Orçamento do dia em {pct}%: US$ {spent} de US$ {limit}.", {
          pct: state.pct,
          spent,
          limit,
        });
  return state.partial
    ? `${head} ${t("Parte do uso de hoje está sem preço conhecido: o gasto real é maior.")}`
    : head;
}

/**
 * The footer chip, or `null` when there is nothing worth a chip. From "warn"
 * up as before, and also whenever the number is not the whole story: a floor
 * reads "≥", and a day with no price at all says so instead of hiding.
 */
export function budgetChip(state: BudgetState): { label: string; tone: "warn" | "over" | "partial" } | null {
  if (state.level === "off") return null;
  if (state.unknown) return { label: t("orçamento sem preço"), tone: "partial" };
  const loud = state.level === "warn" || state.level === "over";
  if (!loud && !state.partial) return null;
  const label = state.partial
    ? t("≥ {pct}% do orçamento", { pct: state.pct })
    : t("{pct}% do orçamento", { pct: state.pct });
  return { label, tone: state.level === "over" ? "over" : loud ? "warn" : "partial" };
}
