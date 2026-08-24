/**
 * Lane assignment for the commit graph (§14.2, "Git Graph").
 *
 * The whole difficulty is that `git log` hands back a flat list and the graph
 * is in the `parents` links. Get the lanes wrong and the drawing is not
 * slightly off — it is a picture of a history that never happened: a branch
 * shown as linear, a merge shown as a fork, two unrelated lines sharing a
 * column.
 *
 * Commits arrive newest first, which is the order `scm_log` returns and the
 * order the rows are drawn in.
 */
import { describe, expect, it } from "vitest";

import { layoutCommits } from "./gitGraph";

/** `a <- b` reads "b is a's parent". */
const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("layoutCommits", () => {
  it("keeps a linear history in a single lane", () => {
    const rows = layoutCommits([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  });

  it("reports the widest lane, so the card knows how much gutter to draw", () => {
    const rows = layoutCommits([c("c", "b"), c("b", "a"), c("a")]);
    expect(Math.max(...rows.map((r) => r.lane))).toBe(0);
  });

  it("gives a side branch a lane of its own", () => {
    //   m        merge of main and feature
    //   |\
    //   | f      the feature commit
    //   |/
    //   a
    const rows = layoutCommits([c("m", "b", "f"), c("b", "a"), c("f", "a"), c("a")]);
    const lane = Object.fromEntries(rows.map((r) => [r.hash, r.lane]));
    expect(lane.b).not.toBe(lane.f);
  });

  it("puts a merge on the lane of its first parent's line", () => {
    // The merge belongs to the branch it was made *on*; drawing it on the
    // incoming branch's lane is what makes a graph read backwards.
    const rows = layoutCommits([c("m", "b", "f"), c("b", "a"), c("f", "a"), c("a")]);
    const lane = Object.fromEntries(rows.map((r) => [r.hash, r.lane]));
    expect(lane.m).toBe(lane.b);
  });

  it("links a merge down to both of its parents", () => {
    const rows = layoutCommits([c("m", "b", "f"), c("b", "a"), c("f", "a"), c("a")]);
    const merge = rows[0];
    expect(merge.links).toHaveLength(2);
  });

  it("brings the branches back together at the common ancestor", () => {
    // `a` is the parent of both `b` and `f`, so by the time it is drawn there
    // is one lane again — the join is what a graph is *for*.
    const rows = layoutCommits([c("m", "b", "f"), c("b", "a"), c("f", "a"), c("a")]);
    const root = rows[3];
    expect(root.lane).toBe(0);
    expect(root.merges).toContain(1);
  });

  it("carries a lane that skips a row straight through it", () => {
    // `f` is drawn after `b`, so at `b`'s row the feature lane is passing by
    // and its line has to be painted — otherwise the branch appears to start
    // out of nowhere one row later.
    const rows = layoutCommits([c("m", "b", "f"), c("b", "a"), c("f", "a"), c("a")]);
    expect(rows[1].through).toContain(1);
  });

  it("gives a root commit no links", () => {
    const rows = layoutCommits([c("a")]);
    expect(rows[0].links).toEqual([]);
  });

  it("reuses a lane freed by a branch that ended", () => {
    // Lanes are a scarce visual resource: a log of 200 commits with 40 short
    // branches must not drift 40 columns to the right.
    const rows = layoutCommits([
      c("m", "b", "f"),
      c("b", "a"),
      c("f", "a"),
      c("a"),
      c("z", "y"),
      c("y"),
    ]);
    expect(Math.max(...rows.map((r) => r.lane))).toBeLessThanOrEqual(1);
  });

  it("survives a parent that is not in the page", () => {
    // The log is paginated: the last row's parent is almost always off the
    // end. It must not throw and must not draw a line to nowhere.
    const rows = layoutCommits([c("b", "a")]);
    expect(rows[0].links).toEqual([]);
    expect(rows[0].lane).toBe(0);
  });

  it("handles two roots — an orphan branch in the same log", () => {
    const rows = layoutCommits([c("b"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0]);
  });
});
