/**
 * Two rules the sidebar needs now that boards exist.
 *
 * The bar has two sections — the boards on top, the projects below — and the
 * arrow keys have to walk from the last row of one into the first row of the
 * other, or half the bar becomes unreachable without a mouse. That order is
 * `treeRows`, and it is the same order the rows are painted in.
 *
 * The other rule is the label a card carries on a board. A board mixes
 * projects on purpose, so "Claude Code" alone stops being enough to tell two
 * cards apart — where it is running is the thing that distinguishes them.
 */
import { describe, expect, it } from "vitest";

import { cardOrigin, groupBranch, groundWithoutGit, sectionsFor, treeRows } from "./rows";

const board = (id: string) => ({ id, projectId: null as null, name: id });
const project = (id: string) => ({ id, name: id, path: `C:/Workspace/${id}` });

/**
 * The bar answers to the surface on screen. On the canvas the only thing that
 * can be on it is a board, so the projects tree is not a shortcut there — it
 * is a list of things that cannot be shown, taking the space from the one
 * list that can. The inverse holds on the panes: the Canvas button in the
 * title bar is the door to boards, so they do not compete with projects there.
 */
describe("sectionsFor", () => {
  it("on the canvas, only the boards", () => {
    expect(sectionsFor("canvas")).toEqual({ boards: true, projects: false });
  });

  it("on the panes, only the projects — boards belong to the Canvas category", () => {
    expect(sectionsFor("grid")).toEqual({ boards: false, projects: true });
  });
});

describe("treeRows", () => {
  const world = {
    sections: { boards: true, projects: true },
    boards: [board("b1"), board("b2")],
    projects: [project("p1")],
    groupsOf: (id: string) => (id === "p1" ? [{ id: "g1" }] : []),
    cardsOf: (id: string) =>
      id === "b1" ? [{ id: "c1" }, { id: "c2" }] : id === "g1" ? [{ id: "t1" }] : [],
  };

  it("walks the boards and their cards first, then the projects", () => {
    expect(treeRows({ ...world, collapsed: {} })).toEqual([
      { id: "b1", kind: "board" },
      { id: "c1", kind: "terminal" },
      { id: "c2", kind: "terminal" },
      { id: "b2", kind: "board" },
      { id: "p1", kind: "project" },
      { id: "g1", kind: "group" },
      { id: "t1", kind: "terminal" },
    ]);
  });

  it("a collapsed row hides its children from the walk, not just from the eye", () => {
    expect(treeRows({ ...world, collapsed: { b1: true, p1: true } })).toEqual([
      { id: "b1", kind: "board" },
      { id: "b2", kind: "board" },
      { id: "p1", kind: "project" },
    ]);
  });

  /**
   * The walk and the paint are the same list on purpose: an arrow that moves
   * the focus onto a row nobody drew loses the focus into nothing.
   */
  it("a hidden section is not in the walk either", () => {
    expect(
      treeRows({ ...world, sections: { boards: true, projects: false }, collapsed: {} }),
    ).toEqual([
      { id: "b1", kind: "board" },
      { id: "c1", kind: "terminal" },
      { id: "c2", kind: "terminal" },
      { id: "b2", kind: "board" },
    ]);
  });

  it("with no board yet, the walk starts at the projects", () => {
    expect(treeRows({ ...world, boards: [], collapsed: {} })).toEqual([
      { id: "p1", kind: "project" },
      { id: "g1", kind: "group" },
      { id: "t1", kind: "terminal" },
    ]);
  });
});

describe("cardOrigin", () => {
  const projects = [
    { id: "p1", name: "yard", path: "C:\\Workspace\\Code\\yard" },
    { id: "p2", name: "Interagia", path: "C:/Workspace/Code/interagia" },
  ];

  it("names the project the card is running in", () => {
    expect(cardOrigin(projects, "C:/Workspace/Code/yard")).toBe("yard");
    expect(cardOrigin(projects, "C:\\Workspace\\Code\\interagia")).toBe("Interagia");
  });

  it("a folder inside the project still belongs to it", () => {
    expect(cardOrigin(projects, "C:/Workspace/Code/yard/src-tauri")).toBe("yard");
  });

  /**
   * The regression this prevents: a plain prefix test made
   * `.../yard-antigo` belong to `.../yard`, so a card in a neighbouring
   * folder was labelled with the wrong project.
   */
  it("a folder that merely starts with the same letters does not belong to it", () => {
    expect(cardOrigin(projects, "C:/Workspace/Code/yard-antigo")).toBeNull();
  });

  it("a folder outside every project has no origin to show", () => {
    expect(cardOrigin(projects, "C:/Users/alanr")).toBeNull();
    expect(cardOrigin(projects, "")).toBeNull();
  });

  /** The deepest match wins: a project inside another is the closer answer. */
  it("with nested projects, the innermost one is the origin", () => {
    const nested = [
      ...projects,
      { id: "p3", name: "plugin", path: "C:/Workspace/Code/yard/plugins/x" },
    ];
    expect(cardOrigin(nested, "C:/Workspace/Code/yard/plugins/x/src")).toBe("plugin");
  });
});

/**
 * A project's children stopped being folders. What hangs off a project now is
 * the ground (its own root, on whatever branch is checked out there) and the
 * fronts, a `git worktree` each. The row has to say which, or the tree reads
 * as the folder list it no longer is.
 *
 * The groups made before the change have no worktree: they run in the root,
 * exactly like the ground, and the row says so instead of leaving them blank.
 */
describe("groupBranch", () => {
  const front = { kind: "isolated" as const, branch: "yard/fix-login", worktreePath: "C:/w/f" };

  it("a front carries its own branch", () => {
    expect(groupBranch(front, "main")).toBe("yard/fix-login");
  });

  /**
   * The contract that changed: the ground used to carry a chip with the root's
   * branch beside a stored name ("Principal"). The branch **is** its name now
   * (`groupLabel`), and a chip repeating it would print `main` twice on one
   * row.
   */
  it("the ground carries no chip: its branch is already its name", () => {
    expect(groupBranch({ kind: "ground" }, "main")).toBeNull();
  });

  it("a folder-group of before carries the root's branch, since it runs there under its own name", () => {
    expect(groupBranch({ kind: "plain" }, "main")).toBe("main");
  });

  it("says nothing when git said nothing, as in a project with no repository", () => {
    expect(groupBranch({ kind: "ground" }, null)).toBeNull();
    expect(groupBranch({ kind: "plain" }, null)).toBeNull();
  });

  it("says nothing for a front whose branch never reached the layout", () => {
    expect(groupBranch({ kind: "isolated", worktreePath: "C:/w/f" }, "main")).toBeNull();
  });
});

/**
 * Why one project's ground says `master` and the next one says "Principal".
 *
 * The first is a repository and the row prints the branch checked out there.
 * The second has no `.git` at all, so there is no branch to print and the row
 * falls back to a stored name that looks exactly like a branch could. Two
 * rows, side by side, differing for a reason nothing on screen states.
 *
 * The row has to say it. The one thing it must not do is say it too early:
 * before `git worktree list` comes back there is no branch *yet*, and
 * announcing "sem git" over a repository that simply has not answered is a
 * worse lie than the silence it replaces.
 */
describe("the ground of a project with no repository", () => {
  it("is marked, so the row beside it printing a branch stops being a mystery", () => {
    expect(groundWithoutGit({ kind: "ground" }, null, true)).toBe(true);
  });

  it("is not marked while the listing has not come back: unknown is not no", () => {
    expect(groundWithoutGit({ kind: "ground" }, null, false)).toBe(false);
  });

  it("is not marked when there is a branch to print", () => {
    expect(groundWithoutGit({ kind: "ground" }, "master", true)).toBe(false);
    // Whitespace is not a branch name, and it used to pass for one.
    expect(groundWithoutGit({ kind: "ground" }, "   ", true)).toBe(true);
  });

  it("is never said of a front, which exists only because there is a repository", () => {
    expect(groundWithoutGit({ kind: "isolated", worktreePath: "C:/w/f" }, null, true)).toBe(false);
    expect(groundWithoutGit({ kind: "plain" }, null, true)).toBe(false);
  });
});
