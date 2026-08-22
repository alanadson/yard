/**
 * The Live view's "touched files" list is what the agent changed on disk
 * while it worked. Each row opens that file's diff — when there is a git
 * repository to compare against.
 *
 * In a project that is not a repository, the rows were `disabled` and the
 * tooltip showed only the path. Two things broke there: the user clicked and
 * nothing happened, never learning why; and `disabled` removes the element
 * from the tab order, so the whole list vanished for keyboard users — on a
 * screen whose content is precisely that list.
 *
 * The rule below keeps the row reachable **always** and puts the reason
 * where it gets read: in the tooltip and in the response to the click.
 */
import { describe, expect, it } from "vitest";

import { NO_REPO, fileRow } from "./fileRow";

describe("touched file row", () => {
  it("with a repository, the row opens the diff and the tooltip says so", () => {
    expect(fileRow("src/App.tsx", true)).toEqual({
      action: "abre-diff",
      tip: "src/App.tsx\nAbrir o diff",
    });
  });

  it("without a repository, the row explains instead of opening", () => {
    expect(fileRow("src/App.tsx", false)).toEqual({
      action: "explica",
      tip: `src/App.tsx\n${NO_REPO}`,
    });
  });

  it("the reason is a full sentence — it is what becomes the warning on click", () => {
    // Without this, the "why" would exist only as a greyed-out button.
    expect(NO_REPO).toMatch(/repositório git/);
  });

  it("never returns a state that takes the row away from the keyboard", () => {
    // The one-line regression: `disabled` makes the whole list vanish for
    // anyone navigating by Tab. No answer here asks for that.
    for (const eRepo of [true, false]) {
      expect(["abre-diff", "explica"]).toContain(fileRow("x", eRepo).action);
    }
  });
});
