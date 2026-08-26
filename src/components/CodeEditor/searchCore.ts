/**
 * The arithmetic behind the find bar's counter — kept away from the DOM so it
 * can be tested with a plain document.
 *
 * The count comes from the *same* cursor the search commands use
 * (`SearchQuery.getCursor`), so what the badge says and what Enter jumps to
 * can never drift apart.
 */
import type { SearchQuery } from "@codemirror/search";
import type { Text } from "@codemirror/state";
import { t, tn } from "../../lib/i18n";

/**
 * How many matches the bar is willing to walk on a keystroke. A 20k-line file
 * with `a` typed in the field would otherwise scan the whole buffer on every
 * character; past this many the answer is "more than enough" anyway.
 */
export const MATCH_CAP = 1000;

export type MatchStats = {
  /** Matches found, never above the cap. */
  total: number;
  /** 1-based index of the match under the selection, or 0 when there is none. */
  current: number;
  /** The walk stopped at the cap — the real total is higher. */
  capped: boolean;
  /** `idle`: nothing typed. `invalid`: a regexp that does not compile. */
  status: "idle" | "invalid" | "ok";
};

/** Where the search stands over `doc`, from the point of view of `sel`. */
export function matchStats(
  doc: Text,
  query: SearchQuery,
  sel: { from: number; to: number },
  cap = MATCH_CAP,
): MatchStats {
  if (!query.search) return { total: 0, current: 0, capped: false, status: "idle" };
  // `valid` is false for a regexp that does not compile — asking it for a
  // cursor would throw.
  if (!query.valid) return { total: 0, current: 0, capped: false, status: "invalid" };

  const cursor = query.getCursor(doc);
  let total = 0;
  let current = 0;
  let capped = false;
  for (;;) {
    const step = cursor.next();
    if (step.done) break;
    total++;
    if (step.value.from === sel.from && step.value.to === sel.to) current = total;
    if (total >= cap) {
      capped = true;
      break;
    }
  }
  return { total, current, capped, status: "ok" };
}

/** The badge's text: short enough to live inside the field. */
export function matchLabel(s: MatchStats): string {
  if (s.status === "idle") return "";
  if (s.status === "invalid") return t("regex inválida");
  if (s.total === 0) return t("sem ocorrências");
  const total = `${s.total}${s.capped ? "+" : ""}`;
  if (s.current > 0) return t("{current} de {total}", { current: s.current, total });
  // A capped count is never "one": the plural form carries the "+".
  return tn(s.capped ? 2 : s.total, "{n} ocorrência", "{n} ocorrências", { n: total });
}
