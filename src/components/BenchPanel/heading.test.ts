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
  problems: { errors: 0, warnings: 0, other: 0 },
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


/**
 * The Problems tab's line. It is a count that has to stay readable at a
 * glance while it changes under the reader as a server finishes indexing, so
 * the ordering is by severity and a zero is never spelled out: "2 erros" says
 * more than "2 erros · 0 avisos · 0 notas", and it says it faster.
 */
describe("benchHeading, the Problems tab", () => {
  const withProblems = (errors: number, warnings: number, other = 0) =>
    benchHeading("problems", {
      ...base,
      projectName: "yard",
      problems: { errors, warnings, other },
    });

  it("is named for what it lists", () => {
    expect(withProblems(0, 0).title).toBe("Problemas");
  });

  it("says so plainly when there is nothing wrong", () => {
    expect(withProblems(0, 0).subtitle).toBe("Nada a corrigir");
  });

  it("counts errors before warnings", () => {
    expect(withProblems(2, 1).subtitle).toBe("2 erros · 1 aviso");
  });

  it("agrees in number", () => {
    expect(withProblems(1, 0).subtitle).toBe("1 erro");
    expect(withProblems(0, 1).subtitle).toBe("1 aviso");
    expect(withProblems(0, 3).subtitle).toBe("3 avisos");
  });

  it("leaves out the kinds there are none of", () => {
    // "2 erros · 0 avisos · 0 notas" is slower to read and says less.
    expect(withProblems(2, 0).subtitle).toBe("2 erros");
    expect(withProblems(0, 0, 4).subtitle).toBe("4 notas");
  });

  it("says which project the count is about when there is nothing to count", () => {
    expect(benchHeading("problems", base).subtitle).toBe("Nenhum projeto aberto");
  });
});
