/**
 * The panel toggles on the right of the title bar are *doors*, not gauges.
 *
 * The changes door used to wear the working tree's file count as a blue
 * notification pill — "58" in the corner of the eye all day long, for a
 * number that is the state of the tree, not a queue for the user. These
 * rules lock the replacement: the count rides in the balloon and in the
 * accessible name, never as a badge; the only mark a door wears is the
 * attention dot, and only a task due today or overdue earns it; and the
 * balloon names the action by state, so hovering a lit button teaches both
 * what it opens and that it is open.
 */
import { describe, expect, it } from "vitest";

import { dockToggle, dueTasks } from "./dockToggle";
import { startOfDay, type BenchTask } from "../../stores/benchStore";

/** A fixed "now": a Wednesday at 15:00, so midnight arithmetic is stable. */
const NOW = new Date(2026, 7, 26, 15, 0, 0).getTime();

/** Local midnight `days` from NOW — the same instant the UI stores. */
function inDays(days: number): number {
  return startOfDay(NOW + days * 86_400_000);
}

function task(over: Partial<BenchTask>): BenchTask {
  return {
    id: "t",
    text: "algo",
    done: false,
    priority: 0,
    createdAt: NOW,
    doneAt: null,
    projectId: "yard",
    dueAt: null,
    ...over,
  };
}

describe("dockToggle — the balloon names the action by state", () => {
  it("says Mostrar while the panel is closed and Esconder while it is open", () => {
    expect(dockToggle("sidebar", { open: false }).tip).toBe("Mostrar a barra lateral (Ctrl+B)");
    expect(dockToggle("sidebar", { open: true }).tip).toBe("Esconder a barra lateral (Ctrl+B)");
    expect(dockToggle("bench", { open: true }).tip).toBe("Esconder a bancada (Ctrl+Shift+B)");
    expect(dockToggle("notes", { open: true }).tip).toBe("Esconder as anotações (Ctrl+Shift+N)");
  });

  it("the accessible name stays the panel's name — the pressed state is the button's own", () => {
    expect(dockToggle("sidebar", { open: true }).label).toBe("Barra lateral");
    expect(dockToggle("sidebar", { open: false }).label).toBe("Barra lateral");
    expect(dockToggle("notes", { open: false }).label).toBe("Anotações");
  });

  it("a closed door says what is behind it", () => {
    expect(dockToggle("bench", { open: false }).tip).toBe(
      "Mostrar a bancada — arquivos, controle, tarefas e prompts (Ctrl+Shift+B)",
    );
    expect(dockToggle("notes", { open: false }).tip).toBe(
      "Mostrar as anotações — caderno markdown (Ctrl+Shift+N)",
    );
    expect(dockToggle("changes", { open: false, changed: 0 }).tip).toBe(
      "Mostrar arquivos e alterações (Ctrl+Shift+D)",
    );
  });
});

describe("dockToggle — the changed-file count is information, not a badge", () => {
  it("rides in the balloon and in the accessible name while the panel is closed", () => {
    const door = dockToggle("changes", { open: false, changed: 58 });
    expect(door.tip).toBe("Mostrar arquivos e alterações — 58 alterados (Ctrl+Shift+D)");
    expect(door.label).toBe("Arquivos e alterações, 58 alterados");
    expect(dockToggle("changes", { open: false, changed: 1 }).tip).toBe(
      "Mostrar arquivos e alterações — 1 alterado (Ctrl+Shift+D)",
    );
  });

  it("never lights the dot — 58 changed files is the state of the tree, not a queue", () => {
    expect(dockToggle("changes", { open: false, changed: 58 }).dot).toBe(false);
    expect(dockToggle("changes", { open: true, changed: 58 }).dot).toBe(false);
  });

  it("leaves the balloon once the panel is open — the number is on screen then", () => {
    expect(dockToggle("changes", { open: true, changed: 58 }).tip).toBe(
      "Esconder arquivos e alterações (Ctrl+Shift+D)",
    );
    // The name keeps it: a screen reader is not looking at the panel.
    expect(dockToggle("changes", { open: true, changed: 58 }).label).toBe(
      "Arquivos e alterações, 58 alterados",
    );
  });
});

describe("dockToggle — only a task due today or overdue earns the dot", () => {
  it("pending alone earns nothing", () => {
    const door = dockToggle("bench", { open: false, due: 0 });
    expect(door.dot).toBe(false);
    expect(door.label).toBe("Bancada");
  });

  it("with a due task the dot lights and the balloon says how many, in the right plural", () => {
    const one = dockToggle("bench", { open: false, due: 1 });
    expect(one.dot).toBe(true);
    expect(one.tip).toBe("Mostrar a bancada — 1 tarefa para hoje ou atrasada (Ctrl+Shift+B)");
    expect(one.label).toBe("Bancada, 1 tarefa para hoje ou atrasada");
    const two = dockToggle("bench", { open: true, due: 2 });
    expect(two.dot).toBe(true);
    expect(two.label).toBe("Bancada, 2 tarefas para hoje ou atrasadas");
  });
});

describe("dueTasks — what counts as due", () => {
  it("counts the open project's and the global tasks whose deadline is today or has passed", () => {
    const tasks = [
      task({ id: "hoje", dueAt: inDays(0) }),
      task({ id: "ontem", dueAt: inDays(-1) }),
      task({ id: "global", projectId: null, dueAt: inDays(-3) }),
      task({ id: "amanha", dueAt: inDays(1) }),
      task({ id: "sem-prazo", dueAt: null }),
    ];
    expect(dueTasks(tasks, "yard", NOW)).toBe(3);
  });

  it("a finished task is done nagging, and another project's list is not on the screen", () => {
    const tasks = [
      task({ id: "feita", dueAt: inDays(-2), done: true, doneAt: NOW }),
      task({ id: "outro", projectId: "outro", dueAt: inDays(-2) }),
    ];
    expect(dueTasks(tasks, "yard", NOW)).toBe(0);
  });
});
