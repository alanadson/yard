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
 * missing part as zero.
 */
import { t } from "./i18n";

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
}

export function budgetState(
  spent: number,
  limit: number,
  priced = true,
): BudgetState {
  const partial = !priced;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { level: "off", pct: 0, spent, limit: 0, partial };
  }
  const ratio = spent / limit;
  const level: BudgetLevel = ratio >= 1 ? "over" : ratio >= WARN_AT ? "warn" : "ok";
  return { level, pct: Math.round(ratio * 100), spent, limit, partial };
}

/** Whether the move from `before` to `after` is worth a word. */
export function worsened(before: BudgetLevel, after: BudgetLevel): boolean {
  const rank: Record<BudgetLevel, number> = { off: 0, ok: 1, warn: 2, over: 3 };
  return rank[after] > rank[before] && after !== "ok";
}

/** The sentence the toast and the notification carry. */
export function budgetMessage(state: BudgetState): string {
  const spent = state.spent.toFixed(2);
  const limit = state.limit.toFixed(2);
  return state.level === "over"
    ? t("Orçamento do dia estourado: US$ {spent} de US$ {limit}.", { spent, limit })
    : t("Orçamento do dia em {pct}%: US$ {spent} de US$ {limit}.", {
        pct: state.pct,
        spent,
        limit,
      });
}
