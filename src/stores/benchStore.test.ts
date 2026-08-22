/**
 * The bench keeps the user's data (tasks and prompts) in a text kv — parsing
 * can never trust the saved format, and the `{{like this}}` variables are the
 * contract for filling them in at use time.
 */
import { describe, expect, it } from "vitest";

import {
  daysUntil,
  dueLabel,
  fillVars,
  parsePrompts,
  parseTasks,
  promptVars,
  relevantTasks,
  startOfDay,
  taskInScope,
  useBench,
  type BenchTask,
} from "./benchStore";

function reset() {
  useBench.setState({ tasks: [], prompts: [], taskFilter: "project" });
}

/** Local midnight `days` from today — the same instant the UI stores. */
function inDays(days: number): number {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return startOfDay(d.getTime());
}

describe("promptVars", () => {
  it("lists unique names in the order they appear", () => {
    expect(promptVars("Revise {{arquivo}} focando {{tema}} e {{arquivo}}")).toEqual([
      "arquivo",
      "tema",
    ]);
  });

  it("accepts inner spaces and trims the ends", () => {
    expect(promptVars("abra {{ nome do arquivo }}")).toEqual(["nome do arquivo"]);
  });

  it("ignores empty, broken or multi-line braces", () => {
    expect(promptVars("{{}} {{ }} {{a\nb}} texto {} {{ok}}")).toEqual(["ok"]);
  });
});

describe("fillVars", () => {
  it("substitutes the filled-in ones and preserves the blank ones", () => {
    const body = "Revise {{arquivo}} focando {{tema}}";
    expect(fillVars(body, { arquivo: "src/app.ts" })).toBe(
      "Revise src/app.ts focando {{tema}}",
    );
  });

  it("substitutes every occurrence of the same variable", () => {
    expect(fillVars("{{x}} e {{x}}", { x: "a" })).toBe("a e a");
  });

  it("a whitespace-only value counts as blank", () => {
    expect(fillVars("abra {{arquivo}}", { arquivo: "   " })).toBe(
      "abra {{arquivo}}",
    );
  });
});

describe("kv parsing", () => {
  it("survives invalid JSON and odd shapes", () => {
    expect(parseTasks(undefined)).toEqual([]);
    expect(parseTasks("não é json")).toEqual([]);
    expect(parseTasks('{"não":"é lista"}')).toEqual([]);
    expect(parsePrompts('[{"sem":"id"}, 42, null]')).toEqual([]);
  });

  it("normalises missing or mistyped fields", () => {
    const [t] = parseTasks(
      '[{"id":"a","text":"x","priority":9,"done":"sim","createdAt":"ontem"}]',
    );
    expect(t).toEqual({
      id: "a",
      text: "x",
      done: false,
      priority: 0,
      createdAt: 0,
      doneAt: null,
      projectId: null,
      dueAt: null,
    });

    const [p] = parsePrompts('[{"id":"b","body":"corpo","tags":["git",7]}]');
    expect(p.title).toBe("Sem título");
    expect(p.tags).toEqual(["git"]);
    expect(p.pinned).toBe(false);
  });

  it("snaps the due date to local midnight, however it arrives", () => {
    const noon = new Date(2026, 7, 20, 12, 34, 56).getTime();
    const [t] = parseTasks(
      `[{"id":"a","text":"x","projectId":"proj1","dueAt":${noon}}]`,
    );
    expect(t.projectId).toBe("proj1");
    expect(t.dueAt).toBe(new Date(2026, 7, 20).getTime());
  });
});

describe("tasks", () => {
  it("adds at the top and toggles done with a timestamp", () => {
    reset();
    const s = useBench.getState();
    s.addTask("primeira");
    s.addTask("segunda");
    const [a, b] = useBench.getState().tasks;
    expect([a.text, b.text]).toEqual(["segunda", "primeira"]);

    s.toggleTask(a.id);
    const done = useBench.getState().tasks.find((t) => t.id === a.id)!;
    expect(done.done).toBe(true);
    expect(done.doneAt).not.toBeNull();

    s.toggleTask(a.id);
    const undone = useBench.getState().tasks.find((t) => t.id === a.id)!;
    expect(undone.done).toBe(false);
    expect(undone.doneAt).toBeNull();
  });

  /**
   * The contract changed here, on purpose: renaming to empty **cancels the
   * edit** instead of deleting the task.
   *
   * The two paths of the same field disagreed. The unmount (switching tabs,
   * closing the bench) already refused to write empty, with this reasoning
   * written in the code: "deleting because of a close would be a surprise,
   * not an intention". The explicit commit (Enter, clicking away) deleted —
   * no question, no warning, no way back, taking priority and due date with
   * it. Select-all-and-type-over is an everyday gesture; deleting has its own
   * door in the menu.
   */
  it("renaming to empty cancels the edit — the task stays as it was", () => {
    reset();
    const s = useBench.getState();
    s.addTask("descartável");
    const id = useBench.getState().tasks[0].id;

    s.renameTask(id, "   ");

    expect(useBench.getState().tasks).toHaveLength(1);
    expect(useBench.getState().tasks[0].text).toBe("descartável");
  });

  it("reorders by drag before/after the target", () => {
    reset();
    const s = useBench.getState();
    s.addTask("c");
    s.addTask("b");
    s.addTask("a"); // order: a b c
    const [ta, , tc] = useBench.getState().tasks;

    s.moveTask(ta.id, tc.id, false); // a to after c
    expect(useBench.getState().tasks.map((t) => t.text)).toEqual(["b", "c", "a"]);

    s.moveTask(ta.id, tc.id, true); // a to before c
    expect(useBench.getState().tasks.map((t) => t.text)).toEqual(["b", "a", "c"]);
  });

  it("clearing done tasks preserves the pending ones", () => {
    reset();
    const s = useBench.getState();
    s.addTask("fica");
    s.addTask("sai");
    const leaving = useBench.getState().tasks.find((t) => t.text === "sai")!;
    s.toggleTask(leaving.id);
    s.clearDone();
    expect(useBench.getState().tasks.map((t) => t.text)).toEqual(["fica"]);
  });

  it("clearing with a list does not run over what is off screen", () => {
    reset();
    const s = useBench.getState();
    s.addTask("do projeto", { projectId: "p1" });
    s.addTask("de outro projeto", { projectId: "p2" });
    for (const t of useBench.getState().tasks) s.toggleTask(t.id);
    const visible = useBench.getState().tasks.find((t) => t.projectId === "p1")!;

    s.clearDone([visible.id]);
    expect(useBench.getState().tasks.map((t) => t.text)).toEqual([
      "de outro projeto",
    ]);
  });

  it("duplicating lands right below and goes back to pending", () => {
    reset();
    const s = useBench.getState();
    s.addTask("depois");
    s.addTask("modelo", { projectId: "p1", priority: 2, dueAt: inDays(1) });
    const original = useBench.getState().tasks[0];
    s.toggleTask(original.id);

    const copyId = s.duplicateTask(original.id)!;
    const tasks = useBench.getState().tasks;
    expect(tasks.map((t) => t.id)).toEqual([original.id, copyId, tasks[2].id]);
    const theCopy = tasks[1];
    expect(theCopy.text).toBe("modelo");
    expect(theCopy.projectId).toBe("p1");
    expect(theCopy.priority).toBe(2);
    expect(theCopy.dueAt).toBe(original.dueAt);
    expect(theCopy.done).toBe(false);
    expect(theCopy.doneAt).toBeNull();
  });

  it("deleting the project takes only its own tasks", () => {
    reset();
    const s = useBench.getState();
    s.addTask("global");
    s.addTask("do p1", { projectId: "p1" });
    s.addTask("do p2", { projectId: "p2" });

    s.dropProject("p1");
    expect(useBench.getState().tasks.map((t) => t.text).sort()).toEqual([
      "do p2",
      "global",
    ]);
  });
});

describe("task scope", () => {
  const task = (over: Partial<BenchTask>): BenchTask => ({
    id: "x",
    text: "t",
    done: false,
    priority: 0,
    createdAt: 0,
    doneAt: null,
    projectId: null,
    dueAt: null,
    ...over,
  });

  it("the project filter only lets through the open project's tasks", () => {
    const inHouse = task({ id: "a", projectId: "p1" });
    const fromOutside = task({ id: "b", projectId: "p2" });
    const global = task({ id: "c", projectId: null });

    expect(taskInScope(inHouse, "project", "p1")).toBe(true);
    expect(taskInScope(fromOutside, "project", "p1")).toBe(false);
    expect(taskInScope(global, "project", "p1")).toBe(false);

    expect(taskInScope(global, "global", "p1")).toBe(true);
    expect(taskInScope(inHouse, "global", "p1")).toBe(false);

    for (const t of [inHouse, fromOutside, global]) {
      expect(taskInScope(t, "all", "p1")).toBe(true);
    }
  });

  it("with no project open, nothing is 'the project's'", () => {
    expect(taskInScope(task({ projectId: "p1" }), "project", null)).toBe(false);
    expect(taskInScope(task({ projectId: null }), "project", null)).toBe(false);
  });

  it("what counts for the badge is the open project plus the global ones", () => {
    const tasks = [
      task({ id: "a", projectId: "p1" }),
      task({ id: "b", projectId: "p2" }),
      task({ id: "c", projectId: null }),
    ];
    expect(relevantTasks(tasks, "p1").map((t) => t.id)).toEqual(["a", "c"]);
    expect(relevantTasks(tasks, null).map((t) => t.id)).toEqual(["c"]);
  });

  it("adding keeps the requested scope; without one, the task is global", () => {
    reset();
    const s = useBench.getState();
    s.addTask("global");
    s.addTask("do projeto", { projectId: "p1" });
    const [ofProject, global] = useBench.getState().tasks;
    expect(ofProject.projectId).toBe("p1");
    expect(global.projectId).toBeNull();

    s.setTaskProject(ofProject.id, null);
    expect(useBench.getState().tasks[0].projectId).toBeNull();
  });
});

describe("due dates", () => {
  it("counts whole days between midnights", () => {
    const now = new Date(2026, 7, 17, 23, 30).getTime();
    expect(daysUntil(new Date(2026, 7, 17, 0, 5).getTime(), now)).toBe(0);
    expect(daysUntil(new Date(2026, 7, 18, 0, 5).getTime(), now)).toBe(1);
    expect(daysUntil(new Date(2026, 7, 16, 22, 0).getTime(), now)).toBe(-1);
  });

  it("says the due date in words, and in red once it has passed", () => {
    const now = new Date(2026, 7, 17, 9, 0).getTime();
    const day = (d: number) => new Date(2026, 7, 17 + d).getTime();

    expect(dueLabel(day(0), now)).toMatchObject({ text: "hoje", state: "today" });
    expect(dueLabel(day(1), now)).toMatchObject({ text: "amanhã", state: "soon" });
    expect(dueLabel(day(-1), now)).toMatchObject({ text: "ontem", state: "late" });
    expect(dueLabel(day(-5), now)).toMatchObject({ text: "atrasada", state: "late" });
    // Inside the week, the weekday says more than the date.
    expect(dueLabel(day(3), now).text).toMatch(/^(dom|seg|ter|qua|qui|sex|sáb)$/);
    expect(dueLabel(day(30), now)).toMatchObject({ text: "16/set", state: "far" });
  });

  it("stores the due date at the day's midnight and knows how to clear it", () => {
    reset();
    const s = useBench.getState();
    const id = s.addTask("com prazo")!;
    s.setTaskDue(id, new Date(2026, 7, 20, 18, 45).getTime());
    expect(useBench.getState().tasks[0].dueAt).toBe(new Date(2026, 7, 20).getTime());

    s.setTaskDue(id, null);
    expect(useBench.getState().tasks[0].dueAt).toBeNull();
  });
});

describe("prompts", () => {
  it("using does not touch updatedAt (the card does not jump around)", () => {
    reset();
    const s = useBench.getState();
    const id = s.addPrompt({ title: "t", body: "corpo" });
    const before = useBench.getState().prompts[0].updatedAt;
    s.markUsed(id);
    const after = useBench.getState().prompts[0];
    expect(after.uses).toBe(1);
    expect(after.lastUsedAt).not.toBeNull();
    expect(after.updatedAt).toBe(before);
  });

  it("duplicating resets usage and unpins the copy", () => {
    reset();
    const s = useBench.getState();
    const id = s.addPrompt({ title: "original", body: "x", tags: ["git"] });
    s.togglePin(id);
    s.markUsed(id);
    const copyId = s.duplicatePrompt(id)!;
    const copy = useBench.getState().prompts.find((p) => p.id === copyId)!;
    expect(copy.title).toBe("original (cópia)");
    expect(copy.tags).toEqual(["git"]);
    expect(copy.pinned).toBe(false);
    expect(copy.uses).toBe(0);
  });
});

describe("revealTab", () => {
  /**
   * The regression it locks: "Buscar «x» no projeto" left the context menu
   * calling `openTab`, which is a toggle — with the bench already on the
   * search, the answer to "find this" was **closing the panel**.
   */
  it("opens the requested tab even when the bench is already on it", () => {
    useBench.setState({ open: true, tab: "search" });
    useBench.getState().revealTab("search");
    expect(useBench.getState().open).toBe(true);
    expect(useBench.getState().tab).toBe("search");
  });

  it("opens a closed bench and asks for focus on the tab's field", () => {
    useBench.setState({ open: false, tab: "files", wantsFocus: false });
    useBench.getState().revealTab("tasks");
    expect(useBench.getState().open).toBe(true);
    expect(useBench.getState().tab).toBe("tasks");
    expect(useBench.getState().wantsFocus).toBe(true);
  });
});

describe("useBench.load", () => {
  /**
   * The stored tab comes back as it was. The stumble here is always the same:
   * a new tab enters the interface and nobody adds it to the list that
   * validates the value read from the kv — so the tab opens, gets used, and
   * on the next restart the panel quietly falls back to "Arquivos".
   */
  it("the stored tab comes back as it was — including the newest one", async () => {
    reset();
    await useBench.getState().load({ "bench.tab": "scm" });
    expect(useBench.getState().tab).toBe("scm");
  });

  it("a value that is no tab at all falls back to Files, without breaking", async () => {
    reset();
    await useBench.getState().load({ "bench.tab": "inventada" });
    expect(useBench.getState().tab).toBe("files");
  });
});
