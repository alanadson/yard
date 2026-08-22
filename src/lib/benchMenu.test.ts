/**
 * The background menus of the bench — the right-hand panel (Ctrl+Shift+B).
 *
 * Task rows and prompt cards already had a menu, but only through the kebab:
 * right-click did nothing anywhere in the panel, neither on a row nor in the
 * empty space. What these assertions lock down is what the background of
 * each tab offers — and, above all, what it must **not** offer:
 *
 * - "Project" as a scope, with no project open, is an empty list in disguise;
 * - clearing done tasks with zero done tasks deletes what, exactly?
 * - filtering by tag with no tags at all is an empty submenu.
 */
import { describe, expect, it, vi } from "vitest";

import {
  benchPromptsPaneMenu,
  benchTasksPaneMenu,
  type BenchPromptsMenuActions,
  type BenchTasksMenuActions,
} from "./benchMenu";
import type { MenuEntry } from "../components/ContextMenu";

function tasks(): BenchTasksMenuActions {
  return {
    newTask: vi.fn(),
    setScope: vi.fn(),
    setShowDone: vi.fn(),
    clearDone: vi.fn(),
  };
}

function prompts(): BenchPromptsMenuActions {
  return { newPrompt: vi.fn(), setTag: vi.fn(), clearQuery: vi.fn() };
}

function findItem(entries: MenuEntry[], id: string) {
  return entries.find((e) => "id" in e && e.id === id) as
    | Extract<MenuEntry, { id: string }>
    | undefined;
}

const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { id: string }> => "id" in e).map((e) => e.id);

describe("benchTasksPaneMenu", () => {
  it("creating a task comes first — that is what the tab is for", () => {
    const act = tasks();
    const menu = benchTasksPaneMenu(
      { scope: "project", doneCount: 0, showDone: true, hasProject: true },
      act,
    );
    expect(ids(menu)[0]).toBe("nova");
    findItem(menu, "nova")?.onSelect?.();
    expect(act.newTask).toHaveBeenCalled();
  });

  it("the scope in use comes checked, and switching calls the store with it", () => {
    const act = tasks();
    const sub =
      findItem(
        benchTasksPaneMenu(
          { scope: "global", doneCount: 0, showDone: true, hasProject: true },
          act,
        ),
        "escopo",
      )?.submenu ?? [];
    expect(findItem(sub, "escopo-global")?.checked).toBe(true);
    expect(findItem(sub, "escopo-project")?.checked).toBe(false);
    findItem(sub, "escopo-all")?.onSelect?.();
    expect(act.setScope).toHaveBeenCalledWith("all");
  });

  it("with no project open, the 'Project' scope shows dimmed — it does not vanish", () => {
    const sub =
      findItem(
        benchTasksPaneMenu(
          { scope: "global", doneCount: 0, showDone: true, hasProject: false },
          tasks(),
        ),
        "escopo",
      )?.submenu ?? [];
    expect(findItem(sub, "escopo-project")?.disabled).toBe(true);
    expect(findItem(sub, "escopo-global")?.disabled).toBeFalsy();
  });

  it("with nothing done, show and clear done are both dimmed", () => {
    const menu = benchTasksPaneMenu(
      { scope: "all", doneCount: 0, showDone: true, hasProject: true },
      tasks(),
    );
    expect(findItem(menu, "concluidas")?.disabled).toBe(true);
    expect(findItem(menu, "limpar-concluidas")?.disabled).toBe(true);
  });

  it("clear done says how many it will take and is destructive", () => {
    const item = findItem(
      benchTasksPaneMenu(
        { scope: "all", doneCount: 3, showDone: true, hasProject: true },
        tasks(),
      ),
      "limpar-concluidas",
    );
    expect(item?.label).toContain("3");
    expect(item?.danger).toBe(true);
    expect(item?.disabled).toBeFalsy();
  });
});

describe("benchPromptsPaneMenu", () => {
  it("creating a prompt is the first entry", () => {
    const act = prompts();
    const menu = benchPromptsPaneMenu({ tag: null, tags: [], query: "" }, act);
    expect(ids(menu)[0]).toBe("novo");
    findItem(menu, "novo")?.onSelect?.();
    expect(act.newPrompt).toHaveBeenCalled();
  });

  it("with no tags at all, the filter does not appear — an empty submenu is no menu", () => {
    expect(ids(benchPromptsPaneMenu({ tag: null, tags: [], query: "" }, prompts()))).not.toContain(
      "etiqueta",
    );
  });

  it("with tags, 'All' comes checked when there is no filter", () => {
    const sub =
      findItem(
        benchPromptsPaneMenu({ tag: null, tags: ["git", "revisão"], query: "" }, prompts()),
        "etiqueta",
      )?.submenu ?? [];
    expect(findItem(sub, "etiqueta-todas")?.checked).toBe(true);
    expect(findItem(sub, "etiqueta-git")?.checked).toBe(false);
  });

  it("picking the tag in use clears the filter — clicking again unchecks", () => {
    const act = prompts();
    const sub =
      findItem(
        benchPromptsPaneMenu({ tag: "git", tags: ["git"], query: "" }, act),
        "etiqueta",
      )?.submenu ?? [];
    expect(findItem(sub, "etiqueta-git")?.checked).toBe(true);
    findItem(sub, "etiqueta-git")?.onSelect?.();
    expect(act.setTag).toHaveBeenCalledWith(null);
  });

  it("clear search only wakes up when there is a search", () => {
    expect(
      findItem(benchPromptsPaneMenu({ tag: null, tags: [], query: "  " }, prompts()), "limpar")
        ?.disabled,
    ).toBe(true);
    expect(
      findItem(benchPromptsPaneMenu({ tag: null, tags: [], query: "revisar" }, prompts()), "limpar")
        ?.disabled,
    ).toBeFalsy();
  });
});
