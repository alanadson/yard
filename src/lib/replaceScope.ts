/**
 * Whether a project-wide replace may run, and over what.
 *
 * This is the only button in the app that rewrites files the user is not
 * looking at, so it obeys one rule: **you may only replace what is on
 * screen.** Every refusal below is a case where the result list and the disk
 * are not the same thing.
 *
 * The truncated case is the important one. A search that stopped at a cap
 * produced a list *shorter* than the truth, and a replace run from it would
 * rewrite files that never appeared in it, a failure nobody notices until a
 * diff three days later. The answer is to refuse and let the user narrow the
 * search, not to do most of the job.
 */
import type { SearchOutcome } from "./ipc";
import { MIN_QUERY } from "../stores/searchStore";

export type ReplaceRefusal =
  /** No project open. */
  | "sem-projeto"
  /** The query is shorter than the search itself accepts. */
  | "curto"
  /** The list is still being built. */
  | "buscando"
  /** Nothing found, or the list belongs to another root. */
  | "sem-resultado"
  /** The search hit a cap: the list is not the whole truth. */
  | "truncado";

export type ReplaceReadiness =
  | { ok: true; files: number; hits: number }
  | { ok: false; reason: ReplaceRefusal };

export function replaceReadiness(state: {
  root: string | null;
  query: string;
  status: "idle" | "searching" | "done" | "error";
  outcome: SearchOutcome | null;
  /** Is the outcome about the root on screen? (`outcomeIsCurrent`) */
  current: boolean;
}): ReplaceReadiness {
  if (!state.root) return { ok: false, reason: "sem-projeto" };
  if (state.query.trim().length < MIN_QUERY) return { ok: false, reason: "curto" };
  if (state.status === "searching") return { ok: false, reason: "buscando" };
  if (!state.outcome || !state.current || state.outcome.hits.length === 0) {
    return { ok: false, reason: "sem-resultado" };
  }
  if (state.outcome.truncated) return { ok: false, reason: "truncado" };

  const files = new Set(state.outcome.hits.map((hit) => hit.path));
  return { ok: true, files: files.size, hits: state.outcome.hits.length };
}
