/**
 * Where a new CLI is born, now that a project's children are branches and
 * worktrees instead of folders.
 *
 * The list this builds is the one control that answers the question the app
 * used to answer by accident: a CLI opened with nothing chosen ran in the
 * project's root with the root's branch, even when the group holding it was
 * an isolated front: the tab said one thing and the process did another.
 *
 * Three rules here have already bitten in the app, and each one is a test:
 * the project root is itself a line in `git worktree list` and must not show
 * up a second time as something to adopt; a worktree the Yard already opened
 * as a front is not adoptable either, and the comparison has to survive
 * `C:\Proj` vs `c:/proj/`; and a bare worktree has no files to run in.
 */
import { describe, expect, it } from "vitest";

import {
  branchChoices,
  cwdFor,
  defaultDestination,
  destinationsOf,
  groundBranchOf,
  NEW_FRONT,
  type DestinationInput,
} from "./destination";
import { GROUND_FLOOR, type FloorMeta } from "./floors";

const GROUND: FloorMeta = GROUND_FLOOR;

function front(branch: string, path: string): FloorMeta {
  return { kind: "isolated", branch, worktreePath: path };
}

const PROJECT = "C:/Workspace/yard";

function world(over: Partial<DestinationInput> = {}): DestinationInput {
  return {
    projectPath: PROJECT,
    groups: [{ id: "g1", name: "Grupo 1", sort: 0 }],
    floorOf: () => GROUND,
    worktrees: [],
    groundBranch: "main",
    ...over,
  };
}

describe("the destinations of a project", () => {
  /**
   * The ground has no name of its own to print: it is the project root, and
   * the root is on a branch. "Principal · main" said the same thing twice,
   * with the half that is not real first.
   */
  it("puts the root first, called by the branch checked out there", () => {
    const list = destinationsOf(world());
    expect(list[0]).toMatchObject({ kind: "ground", groupId: "g1", branch: "main" });
    expect(list[0].label).toBe("main");
  });

  it("keeps the stored name for the ground of a project with no git", () => {
    expect(destinationsOf(world({ groundBranch: null }))[0].label).toBe("Grupo 1");
  });

  it("keeps the root usable when git has not said which branch it is on", () => {
    const list = destinationsOf(world({ groundBranch: null }));
    expect(list[0]).toMatchObject({ kind: "ground", groupId: "g1" });
    expect(list[0].branch).toBeNull();
  });

  it("lists each isolated front by its own branch", () => {
    const list = destinationsOf(
      world({
        groups: [
          { id: "g1", name: "Grupo 1", sort: 0 },
          { id: "g2", name: "fix-login", sort: 1 },
        ],
        floorOf: (id) =>
          id === "g2" ? front("yard/fix-login", `${PROJECT}/.yard/floors/fix-login`) : GROUND,
      }),
    );
    expect(list.map((d) => d.kind)).toEqual(["ground", "front", "new"]);
    expect(list[1]).toMatchObject({
      groupId: "g2",
      branch: "yard/fix-login",
      path: `${PROJECT}/.yard/floors/fix-login`,
    });
    // A front is named after its task, and carries its branch beside it.
    expect(list[1].label).toBe("fix-login · yard/fix-login");
  });

  /**
   * The regression this locks down: groups made before the folders were
   * retired have no worktree of their own. Dropping them from the picker
   * would leave their CLIs with no door to be born beside.
   */
  it("still offers the folder-groups of before, which run in the root", () => {
    const list = destinationsOf(
      world({
        groups: [
          { id: "g1", name: "Grupo 1", sort: 0 },
          { id: "g2", name: "Grupo 2", sort: 1 },
        ],
        floorOf: (id) => (id === "g2" ? { kind: "plain" } : GROUND),
      }),
    );
    expect(list.map((d) => d.kind)).toEqual(["ground", "ground", "new"]);
    expect(list[1]).toMatchObject({ groupId: "g2", path: PROJECT });
  });

  it("offers a worktree git knows about and the Yard has not opened yet", () => {
    const list = destinationsOf(
      world({
        worktrees: [
          { path: PROJECT, branch: "main", bare: false },
          { path: "D:/tmp/hotfix", branch: "hotfix", bare: false },
        ],
      }),
    );
    expect(list.map((d) => d.kind)).toEqual(["ground", "worktree", "new"]);
    expect(list[1]).toMatchObject({ path: "D:/tmp/hotfix", branch: "hotfix" });
  });

  it("never offers the project root as a worktree to adopt, since it is the ground", () => {
    const list = destinationsOf(
      world({ worktrees: [{ path: "c:\\workspace\\yard\\", branch: "main", bare: false }] }),
    );
    expect(list.map((d) => d.kind)).toEqual(["ground", "new"]);
  });

  it("never offers a worktree a front already opened, whatever the slashes and case", () => {
    const list = destinationsOf(
      world({
        groups: [
          { id: "g1", name: "Grupo 1", sort: 0 },
          { id: "g2", name: "fix-login", sort: 1 },
        ],
        floorOf: (id) =>
          id === "g2" ? front("yard/fix-login", "C:/Workspace/yard/.yard/floors/fix-login") : GROUND,
        worktrees: [
          { path: "c:\\Workspace\\Yard\\.yard\\floors\\fix-login", branch: "yard/fix-login", bare: false },
        ],
      }),
    );
    expect(list.map((d) => d.kind)).toEqual(["ground", "front", "new"]);
  });

  it("leaves out the bare worktree, since there are no files to run in", () => {
    const list = destinationsOf(
      world({ worktrees: [{ path: "D:/mirror.git", branch: null, bare: true }] }),
    );
    expect(list.map((d) => d.kind)).toEqual(["ground", "new"]);
  });

  it("closes the list with the door that opens a new front", () => {
    const list = destinationsOf(world());
    expect(list.at(-1)).toMatchObject({ kind: "new", value: NEW_FRONT });
  });

  it("gives every entry a value of its own, because the picker keys on it", () => {
    const list = destinationsOf(
      world({
        groups: [
          { id: "g1", name: "Grupo 1", sort: 0 },
          { id: "g2", name: "fix-login", sort: 1 },
        ],
        floorOf: (id) =>
          id === "g2" ? front("yard/fix-login", `${PROJECT}/.yard/floors/fix-login`) : GROUND,
        worktrees: [{ path: "D:/tmp/hotfix", branch: "hotfix", bare: false }],
      }),
    );
    expect(new Set(list.map((d) => d.value)).size).toBe(list.length);
  });

  it("orders the groups by sort, not by the order they arrived in", () => {
    const list = destinationsOf(
      world({
        groups: [
          { id: "g2", name: "fix-login", sort: 4 },
          { id: "g1", name: "Grupo 1", sort: 0 },
        ],
        floorOf: (id) =>
          id === "g2" ? front("yard/fix-login", `${PROJECT}/.yard/floors/fix-login`) : GROUND,
      }),
    );
    expect(list.map((d) => d.groupId)).toEqual(["g1", "g2", undefined]);
  });

  it("still answers with a new-front door when the project has no group at all", () => {
    const list = destinationsOf(world({ groups: [] }));
    expect(list.map((d) => d.kind)).toEqual(["new"]);
  });
});

describe("the destination a dialog opens on", () => {
  const list = () =>
    destinationsOf(
      world({
        groups: [
          { id: "g1", name: "Grupo 1", sort: 0 },
          { id: "g2", name: "fix-login", sort: 1 },
        ],
        floorOf: (id) =>
          id === "g2" ? front("yard/fix-login", `${PROJECT}/.yard/floors/fix-login`) : GROUND,
      }),
    );

  it("is the front in view, so Ctrl+T lands where the eye already is", () => {
    expect(defaultDestination(list(), "g2")).toBe("group:g2");
  });

  /** "Sem escolher worktree nem branch, a CLI vai para o chão." */
  it("is the root when nothing is in view: the ground, not a folder of its own", () => {
    expect(defaultDestination(list(), null)).toBe("group:g1");
  });

  it("falls back to the root when the group in view belongs to another project", () => {
    expect(defaultDestination(list(), "g-de-outro-projeto")).toBe("group:g1");
  });

  it("is empty when there is nowhere yet, and the caller opens the new-front door", () => {
    expect(defaultDestination(destinationsOf(world({ groups: [] })), null)).toBe("");
  });
});

/**
 * One call answers both halves: `git worktree list` names the branch checked
 * out at the root *and* every worktree beside it. Asking `git status` for the
 * root as well would be a second process for something already on the wire.
 */
describe("the branch of the ground, read from the worktree list", () => {
  it("is the branch git reports for the project's own root", () => {
    expect(
      groundBranchOf(
        [
          { path: "c:\\workspace\\yard", branch: "main", bare: false },
          { path: `${PROJECT}/.yard/floors/fix`, branch: "yard/fix", bare: false },
        ],
        PROJECT,
      ),
    ).toBe("main");
  });

  it("is null when the root is not in the list, as in a project with no git", () => {
    expect(groundBranchOf([], PROJECT)).toBeNull();
  });

  it("is null on a detached HEAD, where git names no branch", () => {
    expect(groundBranchOf([{ path: PROJECT, branch: null, bare: false }], PROJECT)).toBeNull();
  });
});

/**
 * The regression this locks down: a CLI opened inside an isolated front was
 * spawned with the *project's* root as its cwd, so the tab said "fix-login"
 * and the agent edited the files of `main`.
 */
describe("the folder a CLI is spawned in", () => {
  it("is the front's worktree when the front is the destination", () => {
    const list = destinationsOf(
      world({
        groups: [
          { id: "g1", name: "Grupo 1", sort: 0 },
          { id: "g2", name: "fix-login", sort: 1 },
        ],
        floorOf: (id) =>
          id === "g2" ? front("yard/fix-login", `${PROJECT}/.yard/floors/fix-login`) : GROUND,
      }),
    );
    expect(cwdFor(list[1], PROJECT)).toBe(`${PROJECT}/.yard/floors/fix-login`);
  });

  it("is the project's root for the ground", () => {
    expect(cwdFor(destinationsOf(world())[0], PROJECT)).toBe(PROJECT);
  });

  it("is the project's root when the destination vanished under the dialog", () => {
    expect(cwdFor(undefined, PROJECT)).toBe(PROJECT);
  });
});

/**
 * Which branches a new front may check out.
 *
 * git refuses `worktree add` on a branch that is already checked out
 * somewhere else, and the message it prints names a path, not the front the
 * Yard opened there. Offering the branch anyway means the dialog builds a
 * name, spends a round trip and comes back with an error that reads like a
 * bug in the app. The list says up front which ones are taken, and where.
 */
describe("the branches a front can be opened from", () => {
  const branch = (name: string, over: Partial<{ remote: boolean }> = {}) => ({
    name,
    remote: false,
    ...over,
  });

  it("leaves the remotes out, because a worktree on a remote ref detaches HEAD", () => {
    expect(
      branchChoices([branch("main"), branch("origin/main", { remote: true })], []).map(
        (b) => b.name,
      ),
    ).toEqual(["main"]);
  });

  /**
   * Every local branch is offered, because every one of them can be the point
   * a new branch grows from. What changes between them is not whether they can
   * be picked, it is what *reusing* one would mean, and that is `where`.
   */
  it("offers every local branch and says where each one already lives", () => {
    const list = branchChoices(
      [branch("master"), branch("fix"), branch("solta"), branch("livre")],
      [
        { path: PROJECT, branch: "master", bare: false },
        { path: "D:/tmp/hotfix", branch: "fix", bare: false },
        { path: "D:/tmp/solta", branch: "solta", bare: false },
      ],
      { groundPath: PROJECT, ownedPaths: ["D:/tmp/hotfix"] },
    );
    expect(list).toEqual([
      // The ground comes first: it is the one people ask for by name.
      { name: "master", where: "ground", path: PROJECT },
      { name: "fix", where: "front", path: "D:/tmp/hotfix" },
      { name: "solta", where: "worktree", path: "D:/tmp/solta" },
      { name: "livre", where: "free", path: null },
    ]);
  });

  it("without knowing the ground, a branch checked out anywhere is just somewhere", () => {
    expect(
      branchChoices([branch("master")], [{ path: PROJECT, branch: "master", bare: false }]),
    ).toEqual([{ name: "master", where: "worktree", path: PROJECT }]);
  });

  it("keeps the order git gave, where the recent branch comes first there", () => {
    expect(branchChoices([branch("z"), branch("a")], []).map((b) => b.name)).toEqual(["z", "a"]);
  });
});
