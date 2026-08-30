/**
 * `yard search` — one agent finding what another one printed.
 *
 * The CLI already lets an agent ask a question and wait for the answer. What
 * it could not do is read the *past*: the error a build printed twenty
 * minutes ago in a terminal nobody has open. That is exactly the question
 * agents ask each other in a workspace with six of them, and until now the
 * answer was to ask a human to go and look.
 *
 * The two rules here exist because the answer is written into a terminal that
 * a language model reads:
 *
 * - it has a **shape** (grouped by terminal, line numbers on the left), so
 *   the agent can quote where it found something;
 * - it has a **ceiling**, per terminal and in total. `yard search e` must not
 *   paste four thousand lines into someone's context window.
 */
import { parseFlags } from "./bridgeCore";
import type { TerminalHits } from "./ipc";

/** Lines per terminal when `--limit` says nothing. */
export const DEFAULT_LIMIT = 4;
/** Ceiling on `--limit`: past this the answer stops being a search result. */
export const MAX_LIMIT = 20;
/** Ceiling on the whole answer, however many terminals matched. */
export const TOTAL_LIMIT = 60;

export interface SearchArgs {
  text: string;
  /** Sweep the whole workspace instead of the caller's group. */
  all: boolean;
  /** Lines per terminal. */
  limit: number;
}

export function parseSearch(argv: string[]): SearchArgs {
  const args = parseFlags(argv, { "--all": "bool", "--limit": "number" });
  const asked = args.number.limit;
  return {
    // A shell splits `yard search erro de build` into three arguments. Joining
    // them is what the user meant; asking for quotes is what a worse CLI does.
    text: args.positional.join(" ").trim(),
    all: args.bool.all === true,
    limit:
      asked === undefined
        ? DEFAULT_LIMIT
        : Math.min(MAX_LIMIT, Math.max(1, Math.trunc(asked))),
  };
}

export function formatSearch(
  answer: readonly TerminalHits[],
  nameOf: (terminalId: string) => string,
  text: string,
): string {
  const found = answer.reduce((n, term) => n + term.hits.length, 0);
  if (found === 0) {
    return `Nada encontrado para "${text}" no histórico dos terminais.\n`;
  }
  let out = `${found} linha${found === 1 ? "" : "s"} com "${text}":\n`;
  for (const term of answer) {
    out += `\n"${nameOf(term.terminalId)}"\n`;
    for (const hit of term.hits) {
      out += `${String(hit.line).padStart(4)}: ${hit.text}\n`;
    }
    if (term.more > 0) {
      out += `      (há mais ocorrências neste terminal — use --limit)\n`;
    }
  }
  return out;
}
