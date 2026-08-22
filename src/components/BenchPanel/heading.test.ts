/**
 * The bench's header no longer just says "Bancada": it now names the open tab
 * and, under it, carries the single line of context the panel has room for.
 * That line is what keeps the title from becoming decoration — and it is where
 * the bugs live: plural agreement ("1 pendente" vs "2 pendentes"), the scope
 * the number refers to (counting "Todas" while the list shows only "Globais"
 * is a lie), and the order of urgency in Files (the unsaved warning before the
 * project's name). None of this shows up on screen when it breaks: it shows
 * up wrong.
 */
import { describe, expect, it } from "vitest";

import { benchHeading, type BenchHeadingInfo } from "./heading";

const base: BenchHeadingInfo = {
  pending: 0,
  scopeName: "Todas",
  unsaved: 0,
  promptCount: 0,
  projectName: null,
  scm: null,
};

describe("benchHeading", () => {
  it("gives each tab its own name — the panel is no longer called 'Bancada'", () => {
    expect(benchHeading("files", base).title).toBe("Arquivos");
    expect(benchHeading("search", base).title).toBe("Buscar");
    expect(benchHeading("tasks", base).title).toBe("Tarefas");
    expect(benchHeading("prompts", base).title).toBe("Prompts");
    expect(benchHeading("scm", base).title).toBe("Controle");
  });

  it("Source control names the branch and counts what is modified on it", () => {
    expect(
      benchHeading("scm", {
        ...base,
        projectName: "Yard",
        scm: { isRepo: true, branch: "main", changes: 3 },
      }).subtitle,
    ).toBe("main · 3 alterações");
  });

  it("a single change is spoken of in the singular", () => {
    expect(
      benchHeading("scm", {
        ...base,
        projectName: "Yard",
        scm: { isRepo: true, branch: "main", changes: 1 },
      }).subtitle,
    ).toBe("main · 1 alteração");
  });

  it("a clean branch never says zero", () => {
    expect(
      benchHeading("scm", {
        ...base,
        projectName: "Yard",
        scm: { isRepo: true, branch: "main", changes: 0 },
      }).subtitle,
    ).toBe("main · sem alterações");
  });

  it("a project that is not a repository says so — not a blank branch", () => {
    expect(
      benchHeading("scm", {
        ...base,
        projectName: "Yard",
        scm: { isRepo: false, branch: "", changes: 0 },
      }).subtitle,
    ).toBe("Sem repositório git");
  });

  it("with no project open, Source control says the same as the other tabs", () => {
    expect(benchHeading("scm", base).subtitle).toBe("Nenhum projeto aberto");
  });

  it("Tasks counts what is pending AND says which scope it is talking about", () => {
    expect(
      benchHeading("tasks", { ...base, pending: 3, scopeName: "Yard" }).subtitle,
    ).toBe("3 pendentes · Yard");
  });

  it("a single pending task is spoken of in the singular", () => {
    expect(
      benchHeading("tasks", { ...base, pending: 1, scopeName: "Globais" }).subtitle,
    ).toBe("1 pendente · Globais");
  });

  it("with nothing pending the subtitle still names the scope — the number goes, not the context", () => {
    expect(
      benchHeading("tasks", { ...base, pending: 0, scopeName: "Yard" }).subtitle,
    ).toBe("nada pendente · Yard");
  });

  it("Files warns about unsaved work before saying the project's name", () => {
    expect(
      benchHeading("files", { ...base, unsaved: 2, projectName: "Yard" }).subtitle,
    ).toBe("2 não salvos");
  });

  it("a single file left to save is spoken of in the singular", () => {
    expect(
      benchHeading("files", { ...base, unsaved: 1, projectName: "Yard" }).subtitle,
    ).toBe("1 não salvo");
  });

  it("with nothing left to save, Files shows the open project", () => {
    expect(
      benchHeading("files", { ...base, projectName: "Yard" }).subtitle,
    ).toBe("Yard");
  });

  it("with no project open the subtitle says so instead of going silent", () => {
    expect(benchHeading("files", base).subtitle).toBe("Nenhum projeto aberto");
    expect(benchHeading("search", base).subtitle).toBe("Nenhum projeto aberto");
  });

  it("Search names the project the search happens in", () => {
    expect(
      benchHeading("search", { ...base, projectName: "Yard", unsaved: 3 }).subtitle,
    ).toBe("Yard");
  });

  it("an empty library never says zero", () => {
    expect(benchHeading("prompts", base).subtitle).toBe("Biblioteca vazia");
  });

  it("a stocked library counts what it holds", () => {
    expect(
      benchHeading("prompts", { ...base, promptCount: 12 }).subtitle,
    ).toBe("12 na biblioteca");
  });
});
