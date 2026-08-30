/**
 * Why these rules matter: this search sweeps up to 8 MB per terminal off the
 * disk, on a keystroke, for every terminal that ever existed in the
 * workspace. What keeps it usable is entirely in this file — who gets asked
 * first, when the sweep is worth doing at all, and how a line of raw terminal
 * output becomes a row a human can read at a glance.
 */
import { describe, expect, it } from "vitest";

import {
  MIN_QUERY,
  hitRows,
  searchOrder,
  worthSearching,
} from "./outputSearch";
import type { TerminalHits } from "./ipc";

const term = (id: string, groupId: string, name: string) => ({
  id,
  groupId,
  name,
});

describe("worthSearching", () => {
  it("refuses a single letter — one keystroke must not sweep every .bin", () => {
    expect(worthSearching("e")).toBe(false);
    expect(worthSearching("er")).toBe(true);
    expect(MIN_QUERY).toBe(2);
  });

  it("counts the trimmed text, so two spaces are not a query", () => {
    expect(worthSearching("  ")).toBe(false);
    expect(worthSearching(" er ")).toBe(true);
  });
});

describe("searchOrder", () => {
  const terminals = [
    term("a", "g1", "claude"),
    term("b", "g2", "codex"),
    term("c", "g1", "pwsh"),
    term("d", "g3", "gemini"),
  ];

  it("asks the focused terminal first, then its group, then the rest", () => {
    expect(searchOrder(terminals, "g1", "c")).toEqual(["c", "a", "b", "d"]);
  });

  it("falls back to the active group when nothing is focused", () => {
    expect(searchOrder(terminals, "g1", null)).toEqual(["a", "c", "b", "d"]);
  });

  it("keeps the workspace order when there is no active group", () => {
    expect(searchOrder(terminals, null, null)).toEqual(["a", "b", "c", "d"]);
  });

  /** The regression: a focused terminal was asked twice and the row appeared duplicated. */
  it("never lists the same terminal twice", () => {
    const order = searchOrder(terminals, "g1", "a");
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("hitRows", () => {
  const answer: TerminalHits[] = [
    {
      terminalId: "a",
      more: 0,
      hits: [
        { line: 12, col: 6, text: "  erro: faltou o token  ", clipped: false },
        { line: 40, col: 0, text: "erro de novo", clipped: false },
      ],
    },
  ];

  it("shows the line the eye can read, not the raw one", () => {
    const [row] = hitRows(answer, () => "claude");
    expect(row.title).toBe("erro: faltou o token");
  });

  it("says which terminal said it, and leaves the sentence to be composed", () => {
    // The row carries the pieces, not a sentence: "linha" is a word, and the
    // interface has an English half. Composition happens where it is drawn.
    const [row] = hitRows(answer, () => "claude");
    expect(row.name).toBe("claude");
    expect(row.line).toBe(12);
  });

  it("gives each row an id of its own, so two hits in one terminal both show", () => {
    const rows = hitRows(answer, () => "claude");
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it("carries the terminal and the text along, because the row has to open it", () => {
    const [row] = hitRows(answer, () => "claude");
    expect(row.terminalId).toBe("a");
    expect(row.line).toBe(12);
    expect(row.match).toBe("erro: faltou o token");
  });

  /**
   * A clipped line starts mid-sentence. Without the ellipsis the row reads as
   * if the terminal had printed a word fragment.
   */
  it("marks a windowed line with an ellipsis on the side that was cut", () => {
    const rows = hitRows(
      [
        {
          terminalId: "a",
          more: 0,
          hits: [{ line: 1, col: 3, text: "xxxACHOU", clipped: true }],
        },
      ],
      () => "claude",
    );
    expect(rows[0].title).toBe("…xxxACHOU…");
  });

  it("uses the terminal's id when it has no name any more", () => {
    const [row] = hitRows(answer, () => undefined);
    expect(row.name).toBe("a");
  });

  it("keeps the backend's order — it is the priority order it was asked in", () => {
    const rows = hitRows(
      [
        { terminalId: "b", more: 0, hits: [{ line: 1, col: 0, text: "erro", clipped: false }] },
        { terminalId: "a", more: 0, hits: [{ line: 1, col: 0, text: "erro", clipped: false }] },
      ],
      (id) => id,
    );
    expect(rows.map((r) => r.terminalId)).toEqual(["b", "a"]);
  });
});
