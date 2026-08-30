/**
 * The rules the front dialog runs on, out of the JSX so they can be read.
 *
 * The matrix is where they earn their place. Four rows, named from one
 * pattern, each needing its own branch and its own folder — and every one of
 * those decisions used to be made inside a `map` in the middle of a render,
 * where "the second row silently got the first row's branch" is a thing you
 * find out from git, at the end, once.
 */
import { describe, expect, it } from "vitest";

import type { Plan, PlannedItem } from "../../lib/provision/plan";
import { issue } from "../../lib/provision/errors";
import {
  applyPattern,
  applyToAll,
  canConfirm,
  duplicate,
  materialWarnings,
  newRow,
  nextRowFrom,
  progressOf,
  rowsForMode,
  adoptableWorktrees,
  chooseBranch,
  inlineIssue,
  isConfirmGesture,
  reuseOf,
  selectBranchMode,
  selectDestination,
  selectMode,
  switchProject,
  summaryOf,
  toSpecs,
  type FrontRow,
} from "./frontPlan";

const rows = (...names: string[]): FrontRow[] =>
  names.map((name, i) => newRow(`r${i}`, { name }));

function item(over: Partial<PlannedItem> = {}): PlannedItem {
  return {
    clientItemId: "a",
    kind: "new_worktree_new_branch",
    action: "create_worktree",
    displayName: "login",
    branch: "yard/login",
    base: { ref: "main", oid: "abc" },
    path: "C:/proj/.yard/floors/login",
    errors: [],
    warnings: [],
    agentId: null,
    prompt: "",
    ...over,
  };
}

const planOf = (items: PlannedItem[]): Plan => ({
  planId: "p",
  revision: 1,
  createdAt: 0,
  expiresAt: 1,
  valid: items.every((i) => i.errors.length === 0),
  isRepo: true,
  fingerprint: "f",
  items,
});

describe("a fresh row", () => {
  it("starts on the common case: a branch of its own, in a worktree of its own", () => {
    expect(newRow("r0").kind).toBe("new_worktree_new_branch");
  });

  it("leaves branch, folder and base empty, which is what lets the backend derive them", () => {
    const r = newRow("r0");
    expect([r.branch, r.worktreeName, r.baseRef]).toEqual(["", "", ""]);
  });
});

describe("changing the destination", () => {
  it("clears branch-only fields when the row moves to an existing worktree", () => {
    const changed = selectDestination(
      newRow("a", {
        name: "login",
        branch: "agent/login",
        worktreeName: "login",
        baseRef: "origin/main",
        agentId: "codex",
        prompt: "faça",
      }),
      "existing_worktree",
    );

    expect(changed.kind).toBe("existing_worktree");
    expect([changed.branch, changed.worktreeName, changed.baseRef]).toEqual(["", "", ""]);
    expect([changed.name, changed.agentId, changed.prompt]).toEqual(["login", "codex", "faça"]);
  });

  it("clears the explicit branch when its meaning changes from new to existing", () => {
    const changed = selectBranchMode(
      newRow("a", {
        branch: "agent/login",
        baseRef: "origin/main",
        agentId: "codex",
        prompt: "faça",
      }),
      "existing",
    );

    expect(changed.kind).toBe("new_worktree_existing_branch");
    expect(changed.branch).toBe("");
    expect([changed.baseRef, changed.agentId, changed.prompt]).toEqual([
      "origin/main",
      "codex",
      "faça",
    ]);
  });
});

describe("adding another after a run", () => {
  it("keeps the reusable context and clears the identity and task of the finished row", () => {
    const next = nextRowFrom(
      newRow("a", {
        name: "login",
        branch: "agent/login",
        worktreeName: "login",
        baseRef: "origin/main",
        worktreePath: "C:/worktrees/login",
        agentId: "codex",
        prompt: "faça login",
      }),
      "b",
    );

    expect([next.id, next.kind, next.baseRef, next.agentId]).toEqual([
      "b",
      "new_worktree_new_branch",
      "origin/main",
      "codex",
    ]);
    expect([next.name, next.branch, next.worktreeName, next.worktreePath, next.prompt]).toEqual([
      "",
      "",
      "",
      "",
      "",
    ]);
  });
});

describe("switching between one agent and a matrix", () => {
  it("discards hidden extra rows when leaving multi-agent mode so they cannot block the single plan", () => {
    const visible = rowsForMode(
      [newRow("a", { name: "login" }), newRow("b", { name: "" })],
      false,
    );

    expect(visible.map((row) => row.id)).toEqual(["a"]);
  });
});

describe("naming a whole matrix from one pattern", () => {
  it("gives each row its own name, counting from one", () => {
    const named = applyPattern(rows("", "", ""), "exp-{index}", (r) => r.agentId ?? "");
    expect(named.map((r) => r.name)).toEqual(["exp-1", "exp-2", "exp-3"]);
  });

  it("uses the agent of each row, which is the whole point of a fleet", () => {
    const list = [newRow("a", { agentId: "codex" }), newRow("b", { agentId: "claude" })];
    expect(applyPattern(list, "{agent}", (r) => r.agentId ?? "").map((r) => r.name)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("makes a pattern with no placeholder unique anyway, instead of naming four rows the same", () => {
    const named = applyPattern(rows("", "", ""), "login", () => "");
    expect(named.map((r) => r.name)).toEqual(["login", "login-2", "login-3"]);
  });
});

describe("applying one value to every row", () => {
  it("writes the field on all of them and leaves the rest alone", () => {
    const list = [newRow("a", { name: "um" }), newRow("b", { name: "dois" })];
    const done = applyToAll(list, { baseRef: "origin/main" });
    expect(done.map((r) => r.baseRef)).toEqual(["origin/main", "origin/main"]);
    expect(done.map((r) => r.name)).toEqual(["um", "dois"]);
  });
});

describe("duplicating a row", () => {
  it("copies what was chosen and clears what has to be unique", () => {
    const list = [
      newRow("a", { name: "um", branch: "agent/um", worktreeName: "um", prompt: "faça", baseRef: "dev" }),
    ];
    const [, copy] = duplicate(list, "a", "b");
    expect(copy.id).toBe("b");
    // Kept: the shape of the work.
    expect([copy.kind, copy.baseRef, copy.prompt]).toEqual(["new_worktree_new_branch", "dev", "faça"]);
    // Cleared: the identity. Two rows carrying one branch is a refusal, and a
    // duplicate button that produces one is a button that never works.
    expect([copy.name, copy.branch, copy.worktreeName]).toEqual(["", "", ""]);
  });

  it("lands right after the row it copied, where the eye is", () => {
    const list = [newRow("a"), newRow("b")];
    expect(duplicate(list, "a", "novo").map((r) => r.id)).toEqual(["a", "novo", "b"]);
  });
});

describe("what the rows become on the way to the planner", () => {
  it("carries every typed field through untouched", () => {
    const [spec] = toSpecs([
      newRow("a", { name: "login", branch: "agent/login", agentId: "codex", prompt: "faça" }),
    ]);
    expect(spec).toEqual({
      clientItemId: "a",
      kind: "new_worktree_new_branch",
      displayName: "login",
      branchName: "agent/login",
      worktreeName: "",
      baseRef: "",
      worktreePath: "",
      agentId: "codex",
      prompt: "faça",
    });
  });
});

describe("the line under the button", () => {
  it("counts what is about to be written, not how many rows there are", () => {
    const s = summaryOf(
      planOf([
        item({ clientItemId: "a" }),
        item({ clientItemId: "b", action: "adopt_worktree", base: null }),
        item({ clientItemId: "c", action: "use_ground", base: null }),
        item({ clientItemId: "d", agentId: "codex" }),
      ]),
    );
    expect(s).toEqual({ worktrees: 2, branches: 2, adopted: 1, ground: 1, agents: 1 });
  });
});

describe("the progress headline", () => {
  it("counts every settled row and never presents a running row as finished", () => {
    const progress = progressOf([
      { state: "ready" },
      { state: "failed" },
      { state: "running" },
      { state: "pending" },
    ]);
    expect(progress).toEqual({ settled: 2, total: 4, percent: 50 });
  });
});

describe("the warnings that have to be read before the button works", () => {
  it("holds the button for a destination somebody else is already working in", () => {
    const p = planOf([item({ warnings: [issue("WORKTREE_SHARED")], agentId: "codex" })]);
    expect(materialWarnings(p).map((w) => w.code)).toEqual(["WORKTREE_SHARED"]);
    expect(canConfirm(p, [])).toBe(false);
    expect(canConfirm(p, ["WORKTREE_SHARED"])).toBe(true);
  });

  it("holds it for the ground too, which is the person's own working copy", () => {
    const p = planOf([item({ warnings: [issue("GROUND_IN_USE")], agentId: "codex" })]);
    expect(canConfirm(p, [])).toBe(false);
  });

  it("does not hold it for a warning that is only information", () => {
    // Uncommitted work at the destination and a project with no git are worth
    // saying and not worth a checkbox: a dialog that asks to tick everything
    // teaches people to tick without reading.
    const p = planOf([item({ warnings: [issue("WORKTREE_DIRTY"), issue("NOT_A_REPO")] })]);
    expect(materialWarnings(p)).toEqual([]);
    expect(canConfirm(p, [])).toBe(true);
  });

  it("never lets an acknowledgement unblock a real refusal", () => {
    const p = planOf([item({ errors: [issue("NAME_TAKEN", { name: "x" })] })]);
    expect(canConfirm(p, ["WORKTREE_SHARED", "GROUND_IN_USE"])).toBe(false);
  });

  it("asks for each distinct warning once, however many rows carry it", () => {
    const p = planOf([
      item({ clientItemId: "a", warnings: [issue("WORKTREE_SHARED")], agentId: "codex" }),
      item({ clientItemId: "b", warnings: [issue("WORKTREE_SHARED")], agentId: "claude" }),
    ]);
    expect(materialWarnings(p)).toHaveLength(1);
  });
});

/**
 * Which worktrees "Worktree existente" is actually allowed to offer.
 *
 * The rule used to live inside a `filter` in the middle of the render, and
 * the count it produced decided nothing: the destination was offerable even
 * when the answer was zero, so choosing it put an empty picker on screen with
 * two red errors under it and no way forward. What the list is worth is the
 * decision it feeds, so it has to be readable on its own.
 */
describe("the worktrees a front may adopt", () => {
  const wt = (path: string, branch: string | null = null, bare = false) => ({
    path,
    branch,
    bare,
  });
  const GROUND = "C:/proj";

  it("offers a worktree on the disk that no front has opened", () => {
    const list = adoptableWorktrees([wt(GROUND, "main"), wt("D:/tmp/hotfix", "hotfix")], {
      groundPath: GROUND,
      ownedPaths: [],
    });
    expect(list.map((w) => w.path)).toEqual(["D:/tmp/hotfix"]);
  });

  /**
   * The ground is the project's own checkout, not a loose worktree. Offering
   * it here would be a second name for the copy the user already has open,
   * which is exactly what "Workspace atual" is for.
   */
  it("never offers the ground itself, whatever the slashes and the case", () => {
    const list = adoptableWorktrees([wt("c:\\proj\\", "main")], {
      groundPath: GROUND,
      ownedPaths: [],
    });
    expect(list).toEqual([]);
  });

  it("never offers a bare repository, which has no working copy to open", () => {
    const list = adoptableWorktrees([wt(GROUND, "main"), wt("D:/mirror", null, true)], {
      groundPath: GROUND,
      ownedPaths: [],
    });
    expect(list).toEqual([]);
  });

  /**
   * Two fronts on one worktree is the failure that never shows on screen:
   * closing either of them takes the files out from under the other.
   */
  it("never offers one a front already works in", () => {
    const list = adoptableWorktrees([wt(GROUND, "main"), wt("D:/tmp/hotfix", "hotfix")], {
      groundPath: GROUND,
      ownedPaths: ["d:\\tmp\\hotfix\\"],
    });
    expect(list).toEqual([]);
  });

  it("answers with nothing when the repository has only its own checkout", () => {
    expect(adoptableWorktrees([wt(GROUND, "main")], { groundPath: GROUND, ownedPaths: [] })).toEqual(
      [],
    );
  });
});

/**
 * A warning holds the button only when it describes a risk the confirmation
 * would actually take on. Both of these say the same thing: something else
 * will be writing in that folder. With no agent on the row there is no
 * something else, and a checkbox over a risk nobody is running teaches people
 * to tick without reading, which costs more than it saves.
 */
describe("the warnings that hold the button, and the row that carries no agent", () => {
  const ground = (over: Partial<PlannedItem> = {}) =>
    item({
      action: "use_ground",
      kind: "current_workspace",
      warnings: [issue("GROUND_IN_USE")],
      ...over,
    });

  it("holds the button when the row starts an agent in the folder you have open", () => {
    const p = planOf([ground({ agentId: "codex" })]);
    expect(materialWarnings(p).map((w) => w.code)).toEqual(["GROUND_IN_USE"]);
    expect(canConfirm(p, [])).toBe(false);
  });

  it("does not hold it for a front that opens empty: nothing else writes there", () => {
    const p = planOf([ground({ agentId: null })]);
    expect(materialWarnings(p)).toEqual([]);
    expect(canConfirm(p, [])).toBe(true);
  });

  it("still says it: it is read, it just is not a checkbox", () => {
    expect(planOf([ground({ agentId: null })]).items[0].warnings.map((w) => w.code)).toEqual([
      "GROUND_IN_USE",
    ]);
  });

  it("holds the button for a shared worktree only when this row brings a writer", () => {
    const shared = (agentId: string | null) =>
      planOf([item({ action: "adopt_worktree", warnings: [issue("WORKTREE_SHARED")], agentId })]);
    expect(canConfirm(shared("codex"), [])).toBe(false);
    expect(canConfirm(shared(null), [])).toBe(true);
  });
});

describe("os dois modos de nomear a frente", () => {
  /**
   * The dialog used to ask "which kind of git object do you want", with a tab
   * for each. It asks one question now: what is this front called, or what is
   * it made from. Picking a branch is the second answer, and reusing it is a
   * checkbox under the branch, not a category of its own.
   */
  it("voltar para o nome larga a branch escolhida e o que veio com ela", () => {
    const fromBranch = newRow("r", {
      kind: "existing_worktree",
      name: "solta",
      prompt: "arruma",
      agentId: "claude",
      branch: "solta",
      baseRef: "master",
      worktreePath: "D:/tmp/solta",
    });
    expect(selectMode(fromBranch, "name")).toMatchObject({
      kind: "new_worktree_new_branch",
      name: "solta",
      prompt: "arruma",
      agentId: "claude",
      branch: "",
      baseRef: "",
      worktreePath: "",
    });
  });

  it("ir para a branch não mexe em nada: o picker começa vazio", () => {
    const typed = newRow("r", { name: "login" });
    expect(selectMode(typed, "branch")).toBe(typed);
  });
});

describe("o que reutilizar uma branch significa", () => {
  /**
   * git gives one worktree per branch, so a branch already checked out can
   * only be worked on where it already is. That is the whole table, and it is
   * why "reuse" is one checkbox with four different meanings instead of four
   * destinations on a tab strip.
   */
  it("depende de onde a branch já está", () => {
    expect(reuseOf("free")).toBe("new_worktree_existing_branch");
    expect(reuseOf("ground")).toBe("current_workspace");
    expect(reuseOf("worktree")).toBe("existing_worktree");
  });

  it("uma branch que já é de outra frente não pode ser reutilizada", () => {
    expect(reuseOf("front")).toBeNull();
  });
});

describe("escolher uma branch", () => {
  const row = newRow("r");
  const free = { name: "feature/login", where: "free" as const, path: null };
  const ground = { name: "master", where: "ground" as const, path: "C:/proj" };
  const solta = { name: "solta", where: "worktree" as const, path: "D:/tmp/solta" };
  const alheia = { name: "fix", where: "front" as const, path: "D:/tmp/hotfix" };

  /**
   * The default, and the one the old dialog could not say without typing the
   * base by hand in "Avançado": the branch you picked is where the new one
   * grows from.
   */
  it("sem reutilizar, a branch escolhida é de onde a frente parte", () => {
    expect(chooseBranch(row, free, false)).toMatchObject({
      kind: "new_worktree_new_branch",
      baseRef: "feature/login",
      branch: "",
      worktreePath: "",
    });
  });

  it("reutilizando uma branch livre, a frente nasce direto nela", () => {
    expect(chooseBranch(row, free, true)).toMatchObject({
      kind: "new_worktree_existing_branch",
      branch: "feature/login",
      baseRef: "",
    });
  });

  it("reutilizando a branch do chão, a frente é o workspace já aberto", () => {
    expect(chooseBranch(row, ground, true)).toMatchObject({
      kind: "current_workspace",
      branch: "master",
    });
  });

  it("reutilizando uma branch que já tem worktree no disco, ele é adotado", () => {
    expect(chooseBranch(row, solta, true)).toMatchObject({
      kind: "existing_worktree",
      branch: "solta",
      worktreePath: "D:/tmp/solta",
    });
  });

  /**
   * The checkbox is disabled for this one, and the fallback still has to be
   * safe: growing a new branch from it takes nothing away from the front that
   * is already working there.
   */
  it("uma branch de outra frente cai no caminho seguro: vira base, não destino", () => {
    expect(chooseBranch(row, alheia, true)).toMatchObject({
      kind: "new_worktree_new_branch",
      baseRef: "fix",
      worktreePath: "",
    });
  });

  it("o nome sai da branch quando ninguém digitou um, e um digitado fica", () => {
    expect(chooseBranch(row, free, false).name).toBe("feature/login");
    expect(chooseBranch(newRow("r", { name: "meu" }), free, false).name).toBe("meu");
  });
});

describe("trocar de projeto", () => {
  /**
   * A branch, uma base e um worktree pertencem a *um* repositório. Levá-los
   * para outro projeto é pedir uma branch que não existe lá, e a recusa só
   * apareceria depois, falando de um nome que a pessoa não digitou de novo.
   */
  it("larga tudo que era do repositório antigo e guarda o que era da pessoa", () => {
    const row = newRow("r", {
      kind: "new_worktree_existing_branch",
      name: "login",
      prompt: "arruma o login",
      agentId: "claude",
      branch: "feature/antiga",
      baseRef: "origin/main",
      worktreeName: "pasta",
      worktreePath: "C:/antigo/wt",
    });
    const moved = switchProject(row);
    expect(moved).toMatchObject({
      kind: "new_worktree_existing_branch",
      name: "login",
      prompt: "arruma o login",
      agentId: "claude",
      branch: "",
      baseRef: "",
      worktreeName: "",
      worktreePath: "",
    });
  });

  /**
   * The two destinations that name something in the old repository go back to
   * the default tab: the worktree is on the other disk, and the ground was
   * that project's branch. Keeping either leaves a row pointing at a place the
   * person is no longer looking at.
   */
  it("a adoção e o chão voltam para a aba padrão: os dois eram do outro projeto", () => {
    const adopting = newRow("r", { kind: "existing_worktree", worktreePath: "C:/antigo/wt" });
    expect(switchProject(adopting).kind).toBe("new_worktree_new_branch");
    const ground = newRow("r", { kind: "current_workspace", branch: "master" });
    expect(switchProject(ground).kind).toBe("new_worktree_new_branch");
  });
});

describe("o gesto que confirma", () => {
  it("é Ctrl+Enter, e também Cmd+Enter", () => {
    expect(isConfirmGesture({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isConfirmGesture({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true);
  });

  /** Enter sozinho é o que se aperta ao terminar de digitar um nome. */
  it("não é Enter sozinho, nem outra tecla com Ctrl", () => {
    expect(isConfirmGesture({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
    expect(isConfirmGesture({ key: "s", ctrlKey: true, metaKey: false })).toBe(false);
  });
});

describe("a recusa que aparece debaixo do campo", () => {
  /**
   * The regression this locks down: the dialog opened with a red banner
   * under an empty name field. Nothing was wrong yet — the person had not
   * typed anything — and the first thing the screen did was tell them off.
   * The plan strip still carries the refusal and the button is still held.
   */
  it("um campo ainda vazio não é um erro: a cobrança fica para o plano", () => {
    expect(inlineIssue(issue("NAME_REQUIRED"), "")).toBeNull();
    expect(inlineIssue(issue("BRANCH_REQUIRED"), "")).toBeNull();
    expect(inlineIssue(issue("WORKTREE_REQUIRED"), "")).toBeNull();
  });

  it("uma recusa sobre o que a pessoa escreveu aparece na hora", () => {
    const taken = issue("BRANCH_ALREADY_EXISTS", { branch: "yard/login" });
    expect(inlineIssue(taken, "yard/login")).toBe(taken);
    // Even with the field empty: this one is not about the emptiness.
    expect(inlineIssue(taken, "")).toBe(taken);
  });

  it("sem recusa nenhuma, não há nada a mostrar", () => {
    expect(inlineIssue(null, "")).toBeNull();
    expect(inlineIssue(null, "login")).toBeNull();
  });
});
