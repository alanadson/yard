/**
 * The canvas and the pane grid used to be the same place with two skins: a
 * CLI opened in a pane became a card on the board, and a card recruited on
 * the board came back as a tab the moment the group left canvas mode. These
 * rules are what splits them — one terminal, one surface — and what keeps the
 * old `mode: "canvas"` workspaces readable after the split.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeSurface,
  onSurface,
  splitLegacyMode,
  type Surface,
} from "./surface";

describe("normalizeSurface", () => {
  it("without a surface the terminal is on the grid — that is where everything was born before the split", () => {
    expect(normalizeSurface(undefined)).toBe("grid");
    expect(normalizeSurface(null)).toBe("grid");
    expect(normalizeSurface("")).toBe("grid");
  });

  it("keeps the two it knows and refuses anything else", () => {
    expect(normalizeSurface("canvas")).toBe("canvas");
    expect(normalizeSurface("grid")).toBe("grid");
    expect(normalizeSurface("quadro")).toBe("grid");
    expect(normalizeSurface(7)).toBe("grid");
  });
});

describe("splitLegacyMode", () => {
  /**
   * The regression this locks down: `mode` used to hold four values, so
   * choosing Canvas *erased* the Holofote/Grade the user had pinned. Reading
   * an old workspace has to keep showing the canvas without inventing a grid
   * the user never asked for.
   */
  it("an old group in canvas mode keeps showing the canvas, over an automatic grid", () => {
    expect(splitLegacyMode("canvas")).toEqual({ mode: "auto", surface: "canvas" });
  });

  it("the three grid modes come back untouched, showing the grid", () => {
    expect(splitLegacyMode("auto")).toEqual({ mode: "auto", surface: "grid" });
    expect(splitLegacyMode("grid")).toEqual({ mode: "grid", surface: "grid" });
    expect(splitLegacyMode("spotlight")).toEqual({ mode: "spotlight", surface: "grid" });
  });

  it("junk in the persisted JSON falls back to the automatic grid", () => {
    expect(splitLegacyMode(undefined)).toEqual({ mode: "auto", surface: "grid" });
    expect(splitLegacyMode("holofote")).toEqual({ mode: "auto", surface: "grid" });
  });
});

describe("onSurface", () => {
  const rows: { id: string; surface?: Surface }[] = [
    { id: "a", surface: "grid" },
    { id: "b", surface: "canvas" },
    { id: "c" },
  ];

  it("hands each surface only what belongs to it", () => {
    expect(onSurface(rows, "grid").map((t) => t.id)).toEqual(["a", "c"]);
    expect(onSurface(rows, "canvas").map((t) => t.id)).toEqual(["b"]);
  });

  it("returns the same reference when nothing was filtered out — the grid re-renders on identity", () => {
    const onlyGrid = [{ id: "a", surface: "grid" as Surface }];
    expect(onSurface(onlyGrid, "grid")).toBe(onlyGrid);
  });
});
