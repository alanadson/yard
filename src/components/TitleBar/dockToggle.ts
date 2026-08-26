/**
 * What each panel toggle in the title bar says and shows.
 *
 * The buttons on the right of the bar are **doors, not gauges**: each one
 * opens a panel and shows whether it is open, and that is all. The changes
 * door used to carry the working tree's file count as a blue notification
 * pill — "58" in the corner of the eye all day long, for a number that is
 * the state of the tree, not a queue for the user, and that already lives
 * in the status bar's branch chip and inside the panel. Here the count rides
 * in the balloon and in the accessible name, one hover away instead of in
 * the face.
 *
 * The only mark a door wears is the attention dot, and only what actually
 * asks for the user earns it: a task due today or overdue. Pending tasks
 * are a list, not an alert.
 *
 * The balloon names the *action* by state — "Mostrar…" while closed,
 * "Esconder…" while open — so hovering a lit button teaches both what it
 * opens and that it is open. The accessible name stays the panel's name:
 * `aria-pressed` is what tells a screen reader the state, and a name that
 * flips would announce a different button each time.
 */
import { t, tn } from "../../lib/i18n";
import { daysUntil, relevantTasks, type BenchTask } from "../../stores/benchStore";

export type DockPanel = "sidebar" | "changes" | "bench" | "notes";

export interface DockToggleState {
  open: boolean;
  /** Files changed in the active project's working tree (the changes door). */
  changed?: number;
  /** Tasks due today or overdue, from `dueTasks` (the bench door). */
  due?: number;
}

export interface DockToggleLabel {
  /** The balloon: the action by state, what is behind the door, the shortcut. */
  tip: string;
  /** The accessible name: the panel's name plus what is in it — stable across states. */
  label: string;
  /** Whether the button wears the attention dot. */
  dot: boolean;
}

const SHORTCUT: Record<DockPanel, string> = {
  sidebar: "Ctrl+B",
  changes: "Ctrl+Shift+D",
  bench: "Ctrl+Shift+B",
  notes: "Ctrl+Shift+N",
};

export function dockToggle(panel: DockPanel, state: DockToggleState): DockToggleLabel {
  const key = SHORTCUT[panel];
  switch (panel) {
    case "sidebar":
      return {
        tip: state.open
          ? t("Esconder a barra lateral ({key})", { key })
          : t("Mostrar a barra lateral ({key})", { key }),
        label: t("Barra lateral"),
        dot: false,
      };
    case "changes": {
      const changed = state.changed ?? 0;
      const count = tn(changed, "{n} alterado", "{n} alterados");
      return {
        tip: state.open
          ? t("Esconder arquivos e alterações ({key})", { key })
          : changed > 0
            ? t("Mostrar arquivos e alterações — {count} ({key})", { count, key })
            : t("Mostrar arquivos e alterações ({key})", { key }),
        label:
          changed > 0
            ? t("Arquivos e alterações, {count}", { count })
            : t("Arquivos e alterações"),
        dot: false,
      };
    }
    case "bench": {
      const due = state.due ?? 0;
      const count = tn(due, "{n} tarefa para hoje ou atrasada", "{n} tarefas para hoje ou atrasadas");
      return {
        tip: state.open
          ? t("Esconder a bancada ({key})", { key })
          : due > 0
            ? t("Mostrar a bancada — {count} ({key})", { count, key })
            : t("Mostrar a bancada — arquivos, controle, tarefas e prompts ({key})", { key }),
        label: due > 0 ? t("Bancada, {count}", { count }) : t("Bancada"),
        dot: due > 0,
      };
    }
    case "notes":
      return {
        tip: state.open
          ? t("Esconder as anotações ({key})", { key })
          : t("Mostrar as anotações — caderno markdown ({key})", { key }),
        label: t("Anotações"),
        dot: false,
      };
  }
}

/**
 * How many of the tasks on the user's plate right now — the open project's
 * plus the global ones, the same set the bench shows — are due today or
 * overdue. Done tasks are done nagging.
 */
export function dueTasks(
  tasks: BenchTask[],
  activeProjectId: string | null,
  now: number,
): number {
  return relevantTasks(tasks, activeProjectId).filter(
    (task) => !task.done && task.dueAt !== null && daysUntil(task.dueAt, now) <= 0,
  ).length;
}
