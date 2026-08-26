// i18n-scan: tables
/**
 * What the background of each bench tab offers on right-click.
 *
 * The rows already had a menu through the kebab; the panel around them — the
 * header, the space below the last task, the empty area when there is none —
 * had nothing. And that is exactly where the gesture tends to land: "I want
 * to create one" and "I want to change what I am seeing" are requests about
 * the *list*, not about one of its items.
 *
 * Only the decision lives here. No `useBench` — the actions come injected,
 * which is what lets the rule be tested without mounting the panel.
 */
import type { MenuEntry } from "../components/ContextMenu";
import type { TaskFilter } from "../stores/benchStore";
import { t, tn } from "./i18n";

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export interface BenchTasksMenuActions {
  /** Moves the cursor to the "what comes next" field — creating is typing. */
  newTask: () => void;
  setScope: (scope: TaskFilter) => void;
  setShowDone: (show: boolean) => void;
  /** Deletes the done tasks on screen (the caller asks first). */
  clearDone: () => void;
}

export interface BenchTasksMenuContext {
  scope: TaskFilter;
  /** Done tasks visible in the current slice — the reach of "Clear". */
  doneCount: number;
  showDone: boolean;
  hasProject: boolean;
}

const SCOPE_LABEL: Record<TaskFilter, string> = {
  project: "Deste projeto",
  global: "Globais",
  all: "Todas",
};

const SCOPES: TaskFilter[] = ["project", "global", "all"];

export function benchTasksPaneMenu(
  ctx: BenchTasksMenuContext,
  act: BenchTasksMenuActions,
): MenuEntry[] {
  return [
    { id: "nova", label: t("Nova tarefa"), onSelect: act.newTask },
    { kind: "sep" },
    {
      id: "escopo",
      label: t("Mostrar"),
      submenu: SCOPES.map((s) => ({
        id: `escopo-${s}`,
        label: t(SCOPE_LABEL[s]),
        checked: ctx.scope === s,
        // With no project open, "this project" is an empty list that looks
        // like data loss. Dimmed, not absent, because the segment is still in
        // the bar right above — vanishing here would contradict the screen.
        disabled: s === "project" && !ctx.hasProject,
        onSelect: () => act.setScope(s),
      })),
    },
    { kind: "sep" },
    {
      id: "concluidas",
      label: ctx.showDone ? t("Esconder concluídas") : t("Mostrar concluídas"),
      checked: ctx.showDone,
      disabled: ctx.doneCount === 0,
      onSelect: () => act.setShowDone(!ctx.showDone),
    },
    {
      id: "limpar-concluidas",
      label:
        ctx.doneCount > 0
          ? tn(ctx.doneCount, "Limpar {n} concluída", "Limpar {n} concluídas")
          : t("Limpar concluídas"),
      danger: true,
      disabled: ctx.doneCount === 0,
      onSelect: act.clearDone,
    },
  ];
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

export interface BenchPromptsMenuActions {
  newPrompt: () => void;
  setTag: (tag: string | null) => void;
  clearQuery: () => void;
}

export interface BenchPromptsMenuContext {
  /** The tag filtering right now, or `null` for "all". */
  tag: string | null;
  tags: readonly string[];
  query: string;
}

export function benchPromptsPaneMenu(
  ctx: BenchPromptsMenuContext,
  act: BenchPromptsMenuActions,
): MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: "novo", label: t("Novo prompt"), onSelect: act.newPrompt },
  ];
  if (ctx.tags.length > 0) {
    entries.push(
      { kind: "sep" },
      {
        id: "etiqueta",
        label: t("Filtrar por etiqueta"),
        submenu: [
          {
            id: "etiqueta-todas",
            label: t("Todas"),
            checked: ctx.tag === null,
            onSelect: () => act.setTag(null),
          },
          { kind: "sep" as const },
          ...ctx.tags.map((t) => ({
            id: `etiqueta-${t}`,
            label: t,
            checked: ctx.tag === t,
            // Clicking the one already filtering turns the filter off: that is
            // what the bar's chip does, and two doors to the same thing must agree.
            onSelect: () => act.setTag(ctx.tag === t ? null : t),
          })),
        ],
      },
    );
  }
  entries.push(
    { kind: "sep" },
    {
      id: "limpar",
      label: t("Limpar a busca"),
      disabled: ctx.query.trim() === "",
      onSelect: act.clearQuery,
    },
  );
  return entries;
}
