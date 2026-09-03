/**
 * A card on a board runs in a folder the user picks, not in a project's: the
 * board belongs to no project, and the dialog has nothing to infer it from.
 * What it can offer is the folder the last card was given, because two cards
 * in a row almost always want the same place, and the fallback the caller
 * hands over (the home folder) when the board is still empty.
 */
import { describe, expect, it } from "vitest";

import { suggestBoardFolder } from "./boardFolder";

const card = (cwd: string, createdAt: number) => ({ cwd, createdAt });

describe("suggestBoardFolder", () => {
  it("offers the folder of the card created last, whatever order the list comes in", () => {
    expect(
      suggestBoardFolder([card("C:/a", 1), card("C:/c", 3), card("C:/b", 2)], "C:/home"),
    ).toBe("C:/c");
  });

  it("skips a card with no folder written on it", () => {
    expect(suggestBoardFolder([card("C:/a", 1), card("  ", 2)], "C:/home")).toBe("C:/a");
  });

  it("on an empty board it is the fallback the caller gave", () => {
    expect(suggestBoardFolder([], "C:/home")).toBe("C:/home");
    expect(suggestBoardFolder([card("", 1)], "")).toBe("");
  });
});
