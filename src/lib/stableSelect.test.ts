/**
 * Zustand compares a selector's answer by identity, and the shell's chrome
 * (the grid, the sidebar, the title bar) reads slices of stores that are
 * rewritten many times a second: a keystroke in a board note, a viewport
 * commit, a resources tick. A selector that builds a fresh array or object on
 * every call re-renders its component on every one of those writes, and one
 * that returns the whole store field re-renders on writes it never paints.
 * `stableSelect` is the middle way: build the projection, but hand back the
 * previous one while nothing the component reads has changed. These rules
 * lock the two halves of that promise, because each half fails silently: an
 * answer that is kept too eagerly paints stale data, one that is dropped too
 * eagerly is the re-render storm it exists to stop.
 */
import { describe, expect, it } from "vitest";

import { sameItems, stableSelect } from "./stableSelect";

interface State {
  rows: { id: string; group: string }[];
}

const byGroup = (group: string) => (s: State) => s.rows.filter((r) => r.group === group);

describe("stableSelect: the previous answer survives an equivalent one", () => {
  it("returns the same array while the rows it picks are the same objects", () => {
    const a = { id: "a", group: "g1" };
    const b = { id: "b", group: "g2" };
    const select = stableSelect(byGroup("g1"), sameItems);
    const first = select({ rows: [a, b] });
    // Another group's row was rewritten: the store field is a new array, the
    // slice this selector hands out is not.
    const second = select({ rows: [a, { ...b, group: "g2" }] });
    expect(second).toBe(first);
    expect(second).toEqual([a]);
  });

  it("hands out the new answer as soon as one of its own rows changes", () => {
    const a = { id: "a", group: "g1" };
    const select = stableSelect(byGroup("g1"), sameItems);
    const first = select({ rows: [a] });
    const renamed = { ...a };
    const second = select({ rows: [renamed] });
    expect(second).not.toBe(first);
    expect(second[0]).toBe(renamed);
  });

  it("the first call has nothing to compare against and answers the projection itself", () => {
    const calls: string[] = [];
    const select = stableSelect(
      (s: State) => s.rows.map((r) => r.id),
      (prev, next) => {
        calls.push("compared");
        return sameItems(prev, next);
      },
    );
    expect(select({ rows: [{ id: "a", group: "g" }] })).toEqual(["a"]);
    expect(calls).toEqual([]);
  });
});

describe("sameItems: the same elements in the same order", () => {
  it("is true for two arrays holding the same objects", () => {
    const a = { id: "a" };
    expect(sameItems([a], [a])).toBe(true);
    expect(sameItems([], [])).toBe(true);
  });

  it("is false for an equal-looking copy of an element", () => {
    expect(sameItems([{ id: "a" }], [{ id: "a" }])).toBe(false);
  });

  it("is false for a different length or a different order", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(sameItems([a], [a, b])).toBe(false);
    expect(sameItems([a, b], [b, a])).toBe(false);
  });
});
