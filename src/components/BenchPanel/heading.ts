/**
 * What the bench's header says. The panel used to be titled "Bancada" and
 * nothing else; in the floating-glass shape the title names the *active tab*
 * and carries one line of context under it — the line that turns a title into
 * a status.
 *
 * The rule lives here, out of the JSX, because it is all plural agreement and
 * order of urgency: exactly the kind of thing that reads fine on the screen
 * you happen to be looking at and is wrong on the other three.
 */

import { t, tn } from "../../lib/i18n";

export type BenchTab = "files" | "search" | "scm" | "tasks" | "prompts";

export interface BenchHeadingInfo {
  /**
   * Pending tasks in the scope segment on screen. Deliberately *not* the
   * text-filtered count: the header describes the list, the list describes
   * the search.
   */
  pending: number;
  /** The scope segment's own name — the project's, "Globais" or "Todas". */
  scopeName: string;
  /** Open documents with unsaved changes. */
  unsaved: number;
  /** Prompts in the library. */
  promptCount: number;
  /** The open project, or `null` when there is none. */
  projectName: string | null;
  /**
   * What the Source control tab has to say about the repository: the branch
   * and how many files are modified on it. `null` = no project is open.
   */
  scm: { isRepo: boolean; branch: string; changes: number } | null;
}

export interface BenchHeading {
  title: string;
  subtitle: string;
}

const NO_PROJECT = "Nenhum projeto aberto"; // i18n-ok

export function benchHeading(tab: BenchTab, info: BenchHeadingInfo): BenchHeading {
  switch (tab) {
    case "tasks":
      return {
        title: t("Tarefas"),
        subtitle: `${pendingText(info.pending)} · ${info.scopeName}`,
      };
    case "prompts":
      return {
        title: t("Prompts"),
        subtitle:
          info.promptCount === 0
            ? t("Biblioteca vazia")
            : t("{n} na biblioteca", { n: info.promptCount }),
      };
    case "search":
      return { title: t("Buscar"), subtitle: info.projectName ?? t(NO_PROJECT) };
    case "scm":
      return { title: t("Controle"), subtitle: scmText(info) };
    case "files":
      return {
        title: t("Arquivos"),
        // Unsaved work outranks the project's name: the name is still one
        // glance away in the sidebar, the warning is not.
        subtitle:
          info.unsaved > 0
            ? tn(info.unsaved, "{n} não salvo", "{n} não salvos")
            : (info.projectName ?? t(NO_PROJECT)),
      };
  }
}

/**
 * "main · 3 alterações". The branch comes first because it is what changes
 * the meaning of everything below it — committing on the wrong branch is this
 * tab's expensive mistake, and the file count protects nobody from it.
 */
function scmText(info: BenchHeadingInfo): string {
  if (!info.scm || !info.projectName) return t(NO_PROJECT);
  if (!info.scm.isRepo) return t("Sem repositório git");
  const n = info.scm.changes;
  const changesText = n === 0 ? t("sem alterações") : tn(n, "{n} alteração", "{n} alterações");
  return `${info.scm.branch} · ${changesText}`;
}

/** "nada pendente", "1 pendente", "4 pendentes" — never "0 pendentes". */
function pendingText(pending: number): string {
  if (pending === 0) return t("nada pendente");
  return tn(pending, "{n} pendente", "{n} pendentes");
}
