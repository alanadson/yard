/**
 * Ranking behind the Busca (`Ctrl+P`).
 *
 * Two matchers, on purpose:
 *
 * - **word score** — how much of what was typed the candidate's own words
 *   cover. It is what makes "novo term" find "Novo terminal" and, more
 *   importantly, what stops "novo terminal na frente da api" from matching
 *   everything that merely contains "novo".
 * - **subsequence** — the acronym path: `ctc` reaching `CanvasView/TerminalCard`.
 *   Deliberately weaker; it only decides between candidates the word score
 *   left tied.
 *
 * Everything is compared **folded**: lowercase, accents stripped, whitespace
 * collapsed. Typing `portugues` has to find "Português" and `frente` has to
 * find "Frente" — in a Portuguese interface, a search that demands the right
 * accent is a search nobody uses twice.
 */

/** Letters and digits, for "is this the start of a word?" questions. */
const WORDISH = /[\p{L}\p{N}]/u;

/** Lowercase, accent-free, single-spaced. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Folded words of a string, punctuation and separators dropped. */
export function tokenize(value: string): string[] {
  return fold(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Navigation filler: words that say where the user is going, not what they
 * are looking for. "abrir a frente da api" means "frente api", so an unmatched
 * "abrir" must not count against the candidate.
 *
 * Verbs that actually name an action ("novo", "criar", "fechar") are **not**
 * here — those are exactly what separates one command from another.
 */
const FILLER = new Set([
  // pt
  "a", "as", "o", "os", "um", "uma", "de", "do", "da", "dos", "das", "em",
  "no", "na", "nos", "nas", "para", "pra", "por", "com", "e", "ao", "aos",
  "ir", "vai", "abrir", "abre", "mostrar", "mostra", "ver", "esse", "essa",
  // en
  "the", "to", "of", "in", "on", "for", "and", "go", "goto", "open", "show",
  "view", "me", "my",
]);

/**
 * Word-level score: 3 for an exact word, 2 for a prefix, 1 for a substring,
 * summed over what was typed.
 *
 * The gate at the end is the part that matters. Without it "frente api" scored
 * on every row that had the word "frente", so typing more words made the list
 * *worse* — the opposite of what typing more is for.
 */
export function wordScore(query: string, fields: readonly string[]): number {
  const candidate = fields.flatMap(tokenize);
  if (candidate.length === 0) return 0;

  let score = 0;
  let meaningful = 0;
  let covered = 0;
  for (const typed of tokenize(query)) {
    let best = 0;
    for (const word of candidate) {
      if (word === typed) best = Math.max(best, 3);
      else if (word.startsWith(typed)) best = Math.max(best, 2);
      else if (word.includes(typed)) best = Math.max(best, 1);
    }
    score += best;
    if (FILLER.has(typed)) continue;
    meaningful += 1;
    if (best > 0) covered += 1;
  }

  // Half of the meaningful words unmatched: the user meant something else.
  if (meaningful > 0 && covered * 2 <= meaningful) return 0; // i18n-ok
  return score;
}

/**
 * Classic fuzzy: every character typed appears, in order, somewhere in the
 * text. Returns 0 when it does not.
 *
 * The bonuses reward what the eye rewards — a hit at the start of the string,
 * a hit that opens a word, and hits that arrive in a run.
 */
export function subsequenceScore(query: string, text: string): number {
  const typed = fold(query).replace(/ /g, "");
  const target = fold(text);
  if (!typed) return 0;
  if (typed.length > target.length) return 0;

  let score = 0;
  let run = 0;
  let ti = 0;
  for (let index = 0; index < target.length && ti < typed.length; index++) {
    if (target[index] !== typed[ti]) {
      run = 0;
      continue;
    }
    let bonus = 1;
    if (index === 0) bonus += 5;
    else if (!WORDISH.test(target[index - 1])) bonus += 3;
    // Worth more than the word-start bonus on purpose: `term` belongs to
    // "terminal", not to "**t**oda **e**quipe **r**ecebe **m**ensagem".
    bonus += Math.min(run, 4) * 2;
    score += bonus;
    run += 1;
    ti += 1;
  }
  return ti === typed.length ? score : 0;
}

/**
 * Score of a candidate against every field it offers. 0 means "does not
 * match" — never show it.
 *
 * Word matches always outrank acronym luck: the subsequence lives in the
 * lower digits and only breaks ties between rows the words scored the same.
 */
export function matchScore(query: string, fields: readonly string[]): number {
  const words = wordScore(query, fields);
  let sub = 0;
  for (const field of fields) {
    sub = Math.max(sub, subsequenceScore(query, field));
    if (sub >= 999) break;
  }
  if (words === 0 && sub === 0) return 0;
  return words * 1000 + Math.min(sub, 999);
}

export interface RankOptions<T> {
  limit?: number;
  /** Nudge applied on top of the score — the active group's things come first. */
  weightOf?: (item: T) => number;
}

/**
 * Ranks `items` against `query`. An empty query keeps the given order (the
 * caller already sorted by what makes sense with nothing typed).
 *
 * Ties keep the input order, so the list never shuffles between keystrokes
 * that do not change the score.
 */
export function rank<T>(
  query: string,
  items: readonly T[],
  fieldsOf: (item: T) => readonly string[],
  opts: RankOptions<T> = {},
): T[] {
  const { limit, weightOf } = opts;
  const folded = fold(query);
  if (!folded) {
    if (!weightOf) return limit == null ? [...items] : items.slice(0, limit);
    const resting = items
      .map((item, order) => ({ item, order, weight: weightOf(item) }))
      .sort((a, b) => b.weight - a.weight || a.order - b.order)
      .map((h) => h.item);
    return limit == null ? resting : resting.slice(0, limit);
  }

  const hits: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const base = matchScore(folded, fieldsOf(item));
    if (base <= 0) return;
    hits.push({ item, score: base + (weightOf?.(item) ?? 0), order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  const cut = limit == null ? hits : hits.slice(0, limit);
  return cut.map((h) => h.item);
}
