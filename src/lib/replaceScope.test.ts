/**
 * When a project-wide replace is allowed to run.
 *
 * This is the one button in the app that rewrites files the user is not
 * looking at, so the rule it obeys is narrow on purpose: **you may only
 * replace what is on screen.** Every refusal below is a case where the result
 * list and the disk would not be the same thing.
 *
 * The truncated case is the one worth reading twice. A search that hit its cap
 * is a list that is *shorter* than the truth, and a replace run from it would
 * quietly rewrite files that never appeared in it, the failure nobody would
 * notice until a diff three days later.
 */
import { describe, expect, it } from "vitest";

import { replaceReadiness } from "./replaceScope";

const outcome = (hits: number, files: number, truncated = false) => ({
  hits: Array.from({ length: hits }, (_, i) => ({
    path: `src/a${i % files}.ts`,
    line: i + 1,
    text: "porta",
  })),
  filesScanned: 40,
  filesHit: files,
  truncated,
});

const ready = {
  root: "C:/r",
  query: "porta",
  status: "done" as const,
  outcome: outcome(3, 2),
  current: true,
};

describe("replaceReadiness", () => {
  it("is ready when the list on screen is the whole answer", () => {
    expect(replaceReadiness(ready)).toEqual({ ok: true, files: 2, hits: 3 });
  });

  it("refuses with no project open", () => {
    expect(replaceReadiness({ ...ready, root: null })).toEqual({
      ok: false,
      reason: "sem-projeto",
    });
  });

  it("refuses a query too short to have been searched", () => {
    expect(replaceReadiness({ ...ready, query: "p" })).toEqual({
      ok: false,
      reason: "curto",
    });
  });

  it("refuses while the search is still running", () => {
    expect(replaceReadiness({ ...ready, status: "searching" })).toEqual({
      ok: false,
      reason: "buscando",
    });
  });

  it("refuses with nothing found", () => {
    expect(replaceReadiness({ ...ready, outcome: outcome(0, 0) })).toEqual({
      ok: false,
      reason: "sem-resultado",
    });
  });

  it("refuses when there is no result at all", () => {
    expect(replaceReadiness({ ...ready, outcome: null })).toEqual({
      ok: false,
      reason: "sem-resultado",
    });
  });

  it("refuses a list that belongs to another root", () => {
    // Switching floor leaves the old list on screen; replacing from it would
    // rewrite a different checkout of the same project.
    expect(replaceReadiness({ ...ready, current: false })).toEqual({
      ok: false,
      reason: "sem-resultado",
    });
  });

  it("refuses a list that stopped at a cap", () => {
    // The list is shorter than the truth. A replace run from it rewrites
    // files that were never on screen.
    expect(replaceReadiness({ ...ready, outcome: outcome(3, 2, true) })).toEqual({
      ok: false,
      reason: "truncado",
    });
  });

  it("counts the files once each, however many hits they hold", () => {
    const many = replaceReadiness({ ...ready, outcome: outcome(9, 3) });

    expect(many).toEqual({ ok: true, files: 3, hits: 9 });
  });
});
