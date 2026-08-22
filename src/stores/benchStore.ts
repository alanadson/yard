/**
 * Bench — the utility panel tucked against the right edge of the window:
 * the project files (the tree, in `editorStore`), the quick tasks (what *I*
 * need to do while the agents work) and the prompt library (titles, tags and
 * `{{like this}}` variables, to copy, send to the composer or inject straight
 * into the focused terminal).
 *
 * A task belongs to one project or to none. The project's tasks only show
 * while that project is open — switching projects switches the list, which is
 * the whole point of having more than one — and the global ones follow the
 * user everywhere. One flat array holds both: the scope is a field on the
 * task, so moving a task between projects is an edit, not a migration.
 *
 * Persistence: keys in the `kv` table (§4.3), like the preferences —
 * `bench.tasks` and `bench.prompts` each hold one JSON document; the open
 * state, the active tab and the task filter also survive a restart. Every operation is discrete
 * (add, check, save an edit), so each one writes immediately; the single
 * exception is drag reordering, which writes only at the end of the gesture.
 */
import { create } from "zustand";
import { nanoid } from "nanoid";
import { persistPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";

export type BenchTab = "files" | "search" | "scm" | "tasks" | "prompts";

const TABS: BenchTab[] = ["files", "search", "scm", "tasks", "prompts"];

/**
 * Which slice of the list the Tasks tab is showing.
 *
 * - `project`: only what belongs to the project that is open right now;
 * - `global`: only what follows the user across every project;
 * - `all`: everything, each row wearing the badge of where it lives.
 */
export type TaskFilter = "project" | "global" | "all";

const FILTERS: TaskFilter[] = ["project", "global", "all"];

export interface BenchTask {
  id: string;
  text: string;
  done: boolean;
  /** 0 = no flag; 1–3 = increasing priority (! !! !!!). */
  priority: 0 | 1 | 2 | 3;
  createdAt: number;
  doneAt: number | null;
  /**
   * Project the task belongs to; `null` = global (shows in every project).
   * Tasks written before scopes existed load as global — the list the user
   * already had is the one that follows them everywhere.
   */
  projectId: string | null;
  /** Deadline, as the local midnight of the day. `null` = no deadline. */
  dueAt: number | null;
}

export interface BenchPrompt {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** How many times it has been copied, sent or opened in the composer. */
  uses: number;
  lastUsedAt: number | null;
}

const KV_TASKS = "bench.tasks";
const KV_PROMPTS = "bench.prompts";
const KV_OPEN = "bench.open";
const KV_TAB = "bench.tab";
const KV_TASK_FILTER = "bench.taskFilter";

/**
 * Writes without blocking the UI. The synchronous try exists because of the
 * tests (outside Tauri, `invoke` blows up on the call, not on the promise).
 */
const persist = (key: string, value: string) =>
  persistPref(key, value, (error) =>
    console.warn(`[yard] não consegui gravar ${key}`, error),
  );

// ---------------------------------------------------------------------------
// parsing — kv gives back text; never trust the saved format
// ---------------------------------------------------------------------------

export function parseTasks(raw: string | undefined): BenchTask[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .filter((t) => typeof t.text === "string" && typeof t.id === "string")
      .map((t) => ({
        id: t.id as string,
        text: t.text as string,
        done: t.done === true,
        priority: ([0, 1, 2, 3] as const).includes(t.priority as 0 | 1 | 2 | 3)
          ? (t.priority as 0 | 1 | 2 | 3)
          : 0,
        createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
        doneAt: typeof t.doneAt === "number" ? t.doneAt : null,
        projectId: typeof t.projectId === "string" ? t.projectId : null,
        // A deadline is always stored as the day's local midnight; anything
        // else on disk (a full timestamp from an older write) is snapped back.
        dueAt: typeof t.dueAt === "number" ? startOfDay(t.dueAt) : null,
      }));
  } catch {
    return [];
  }
}

export function parsePrompts(raw: string | undefined): BenchPrompt[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .filter((p) => typeof p.id === "string" && typeof p.body === "string")
      .map((p) => ({
        id: p.id as string,
        title: typeof p.title === "string" ? p.title : "Sem título",
        body: p.body as string,
        tags: Array.isArray(p.tags)
          ? p.tags.filter((t): t is string => typeof t === "string")
          : [],
        pinned: p.pinned === true,
        createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
        updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
        uses: typeof p.uses === "number" ? p.uses : 0,
        lastUsedAt: typeof p.lastUsedAt === "number" ? p.lastUsedAt : null,
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// scope — a task belongs to one project, or to none (global)
// ---------------------------------------------------------------------------

/** Whether the task shows under `filter` while `activeProjectId` is open. */
export function taskInScope(
  task: BenchTask,
  filter: TaskFilter,
  activeProjectId: string | null,
): boolean {
  if (filter === "all") return true;
  if (filter === "global") return task.projectId === null;
  return task.projectId !== null && task.projectId === activeProjectId;
}

/**
 * Everything that concerns the user right now: the open project's tasks plus
 * the global ones. This is the number the title bar and the tab badge show —
 * a pending count that includes another project's list is a nag about work
 * that is not on the screen.
 */
export function relevantTasks(
  tasks: BenchTask[],
  activeProjectId: string | null,
): BenchTask[] {
  return tasks.filter(
    (t) => t.projectId === null || t.projectId === activeProjectId,
  );
}

// ---------------------------------------------------------------------------
// deadlines — stored as the local midnight of the day, shown as a relative word
// ---------------------------------------------------------------------------

/** Local midnight of the day `ts` falls in. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole days from today to the deadline; negative = overdue. */
export function daysUntil(dueAt: number, now: number): number {
  // Rounding, not truncating: a daylight-saving jump shifts the difference by
  // an hour and would otherwise turn "amanhã" into "hoje".
  return Math.round((startOfDay(dueAt) - startOfDay(now)) / 86_400_000);
}

// Written out instead of `Intl`: the label is three characters wide in a
// 248px panel, and every ICU version spells the abbreviations its own way
// ("ago." vs "ago", "sáb." vs "sáb") — the tests would follow the runtime.
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTHS_FULL = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export interface DueLabel {
  /** Short word for the pill. */
  text: string;
  /** How urgent it is — the pill's color. */
  state: "late" | "today" | "soon" | "far";
  /** The date spelled out, for the tooltip. */
  full: string;
}

export function dueLabel(dueAt: number, now: number = Date.now()): DueLabel {
  const d = new Date(dueAt);
  const full = `${d.getDate()} de ${MONTHS_FULL[d.getMonth()]} de ${d.getFullYear()}`;
  const days = daysUntil(dueAt, now);
  if (days < 0) {
    return {
      text: days === -1 ? "ontem" : "atrasada",
      state: "late",
      full: `Venceu em ${full}`,
    };
  }
  if (days === 0) return { text: "hoje", state: "today", full: `Vence hoje, ${full}` };
  if (days === 1) return { text: "amanhã", state: "soon", full: `Vence amanhã, ${full}` };
  const prefix = `Vence em ${full}`;
  // Inside the week the weekday says more than the date: "sex" is a plan,
  // "22/ago" is arithmetic.
  if (days < 7) return { text: WEEKDAYS[d.getDay()], state: "far", full: prefix };
  return {
    text: `${d.getDate()}/${MONTHS[d.getMonth()]}`,
    state: "far",
    full: prefix,
  };
}

// ---------------------------------------------------------------------------
// variables — `{{name}}` becomes a field to fill in at use time
// ---------------------------------------------------------------------------

/** Unique names, in the order they appear. Spaces allowed (`{{file name}}`). */
export function promptVars(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{([^{}\n]+)\}\}/g)) {
    const name = m[1].trim();
    if (name && name.length <= 48 && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Substitutes the filled-in variables; the ones left blank stay in the text
 * (whitespace only counts as blank).
 */
export function fillVars(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{([^{}\n]+)\}\}/g, (whole, raw: string) => {
    const value = values[raw.trim()];
    return value && value.trim() ? value : whole;
  });
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

interface BenchState {
  open: boolean;
  /**
   * What the **user** asked for, which is not always what fits on screen.
   *
   * A window too narrow for all three panels closes the bench, and that used
   * to go through `toggle` — writing `bench.open=false` to `kv`. Resizing the
   * window therefore erased a preference nobody changed: widening it again
   * left the bench closed, and so did the next launch.
   */
  wanted: boolean;
  tab: BenchTab;
  tasks: BenchTask[];
  /** Which slice of the tasks the tab is showing. Survives a restart. */
  taskFilter: TaskFilter;
  prompts: BenchPrompt[];
  /**
   * Set when the user opens the bench deliberately (button or shortcut): the
   * panel then moves focus to the active tab's field. The open state restored
   * at boot does not set it — nobody asked for focus there.
   */
  wantsFocus: boolean;

  load: (prefs?: PrefsSnapshot) => Promise<void>;
  toggle: () => void;
  /** Opens the bench straight onto a tab (shortcut); on the same tab, closes — it is a toggle. */
  openTab: (tab: BenchTab) => void;
  /**
   * Puts the bench on this tab without toggling — what "take me to this"
   * means. `openTab` is the shortcut's gesture (press again, it closes);
   * whoever arrives from a context menu asking for a search cannot get a
   * closed panel as the answer.
   */
  revealTab: (tab: BenchTab) => void;
  /**
   * Hide or restore the panel because of the window size. Never persists, and
   * restoring only reopens what the user actually wanted open.
   */
  setOpenForLayout: (open: boolean) => void;
  setTab: (tab: BenchTab) => void;
  clearFocus: () => void;

  setTaskFilter: (filter: TaskFilter) => void;
  /**
   * Opens the Tasks tab already showing `id` — the palette lands on a task
   * that the current filter may be hiding, and "found it" with an empty list
   * is worse than not finding it.
   */
  revealTask: (id: string, activeProjectId: string | null) => void;

  /** `projectId` omitted or `null` = global task. */
  addTask: (
    text: string,
    opts?: { projectId?: string | null; priority?: 0 | 1 | 2 | 3; dueAt?: number | null },
  ) => string | null;
  toggleTask: (id: string) => void;
  renameTask: (id: string, text: string) => void;
  cyclePriority: (id: string) => void;
  setPriority: (id: string, priority: 0 | 1 | 2 | 3) => void;
  /** Any instant of the day; it is snapped to the local midnight. `null` clears. */
  setTaskDue: (id: string, dueAt: number | null) => void;
  /** Moves the task between projects, or to global (`null`). */
  setTaskProject: (id: string, projectId: string | null) => void;
  duplicateTask: (id: string) => string | null;
  removeTask: (id: string) => void;
  /** Reorders pending task `id` before/after `overId` — without writing (live drag). */
  moveTask: (id: string, overId: string, before: boolean) => void;
  /** Writes the order at the end of the drag. */
  commitTasks: () => void;
  /** Restores the pre-drag order (Esc mid-gesture). Does not write — the disk still has it. */
  restoreTasks: (tasks: BenchTask[]) => void;
  /** Without `ids`, every completed task; with them, only those (what is on screen). */
  clearDone: (ids?: string[]) => void;
  /** Drops the tasks of a project that no longer exists. */
  dropProject: (projectId: string) => void;

  addPrompt: (data: { title: string; body: string; tags?: string[] }) => string;
  updatePrompt: (
    id: string,
    patch: Partial<Pick<BenchPrompt, "title" | "body" | "tags" | "pinned">>,
  ) => void;
  duplicatePrompt: (id: string) => string | null;
  removePrompt: (id: string) => void;
  togglePin: (id: string) => void;
  markUsed: (id: string) => void;
}

export const useBench = create<BenchState>((set, get) => {
  const setTasks = (tasks: BenchTask[], save = true) => {
    set({ tasks });
    if (save) persist(KV_TASKS, JSON.stringify(tasks));
  };
  const setPrompts = (prompts: BenchPrompt[]) => {
    set({ prompts });
    persist(KV_PROMPTS, JSON.stringify(prompts));
  };
  /** Puts the panel on a tab, no toggling involved. */
  const showTab = (tab: BenchTab, focus: boolean) => {
    set({ open: true, wanted: true, tab, wantsFocus: focus });
    persist(KV_OPEN, "true");
    persist(KV_TAB, tab);
  };

  return {
    open: false,
    wanted: false,
    tab: "files",
    tasks: [],
    taskFilter: "project",
    prompts: [],
    wantsFocus: false,

    load: async (prefs) => {
      try {
        const raw = prefs ?? (await readPrefs());
        const isOpen = raw[KV_OPEN] === "true";
        set({
          tasks: parseTasks(raw[KV_TASKS]),
          prompts: parsePrompts(raw[KV_PROMPTS]),
          open: isOpen,
          wanted: isOpen,
          tab: TABS.includes(raw[KV_TAB] as BenchTab)
            ? (raw[KV_TAB] as BenchTab)
            : "files",
          taskFilter: FILTERS.includes(raw[KV_TASK_FILTER] as TaskFilter)
            ? (raw[KV_TASK_FILTER] as TaskFilter)
            : "project",
        });
      } catch (e) {
        console.warn("[yard] não consegui carregar a bancada", e);
      }
    },

    toggle: () => {
      const open = !get().open;
      set({ open, wanted: open, wantsFocus: open });
      persist(KV_OPEN, String(open));
    },

    openTab: (tab) => {
      if (get().open && get().tab === tab) {
        get().toggle();
        return;
      }
      showTab(tab, true);
    },

    revealTab: (tab) => showTab(tab, true),

    setOpenForLayout: (open) => {
      // Reopening is conditional: the window making room is not a reason to
      // show a panel the user had closed on purpose.
      set((s) => ({ open: open ? s.wanted : false }));
    },

    setTab: (tab) => {
      set({ tab });
      persist(KV_TAB, tab);
    },

    clearFocus: () => set({ wantsFocus: false }),

    // --- tasks ---

    setTaskFilter: (filter) => {
      set({ taskFilter: filter });
      persist(KV_TASK_FILTER, filter);
    },

    revealTask: (id, activeProjectId) => {
      const task = get().tasks.find((t) => t.id === id);
      if (task && !taskInScope(task, get().taskFilter, activeProjectId)) {
        // "Todas" and not the task's own scope: the row keeps its badge, and
        // the neighbours the user was looking at stay on screen.
        get().setTaskFilter("all");
      }
      // Not `openTab`: that one is a toggle, and coming from the palette with
      // the tab already open it would answer "found it" by closing the panel.
      showTab("tasks", false);
    },

    addTask: (text, opts) => {
      const clean = text.trim();
      if (!clean) return null;
      const task: BenchTask = {
        id: nanoid(10),
        text: clean,
        done: false,
        priority: opts?.priority ?? 0,
        createdAt: Date.now(),
        doneAt: null,
        projectId: opts?.projectId ?? null,
        dueAt: opts?.dueAt != null ? startOfDay(opts.dueAt) : null,
      };
      // A new task goes on top of the pending ones: that is the one to work on.
      setTasks([task, ...get().tasks]);
      return task.id;
    },

    toggleTask: (id) => {
      setTasks(
        get().tasks.map((t) =>
          t.id === id
            ? { ...t, done: !t.done, doneAt: t.done ? null : Date.now() }
            : t,
        ),
      );
    },

    /**
     * Empty text **cancels the edit**; it does not delete.
     *
     * It used to delete, and the two paths of the same field disagreed: the
     * unmount (switching tabs, closing the bench) already refused to write
     * empty because "deleting because of a close would be a surprise, not an
     * intention" — while Enter deleted on the spot, no question and no way
     * back, priority and due date along with it. Select-all-and-type-over is
     * an everyday gesture; deleting has its own door in the task's menu.
     */
    renameTask: (id, text) => {
      const clean = text.trim();
      if (!clean) return;
      setTasks(get().tasks.map((t) => (t.id === id ? { ...t, text: clean } : t)));
    },

    cyclePriority: (id) => {
      setTasks(
        get().tasks.map((t) =>
          t.id === id
            ? { ...t, priority: ((t.priority + 1) % 4) as 0 | 1 | 2 | 3 }
            : t,
        ),
      );
    },

    setPriority: (id, priority) => {
      setTasks(get().tasks.map((t) => (t.id === id ? { ...t, priority } : t)));
    },

    setTaskDue: (id, dueAt) => {
      setTasks(
        get().tasks.map((t) =>
          t.id === id ? { ...t, dueAt: dueAt == null ? null : startOfDay(dueAt) } : t,
        ),
      );
    },

    setTaskProject: (id, projectId) => {
      setTasks(get().tasks.map((t) => (t.id === id ? { ...t, projectId } : t)));
    },

    duplicateTask: (id) => {
      const src = get().tasks.find((t) => t.id === id);
      if (!src) return null;
      const copy: BenchTask = {
        ...src,
        id: nanoid(10),
        // The copy is what is left to do, never a second trophy.
        done: false,
        doneAt: null,
        createdAt: Date.now(),
      };
      const tasks = [...get().tasks];
      tasks.splice(tasks.indexOf(src) + 1, 0, copy);
      setTasks(tasks);
      return copy.id;
    },

    removeTask: (id) => {
      setTasks(get().tasks.filter((t) => t.id !== id));
    },

    moveTask: (id, overId, before) => {
      if (id === overId) return;
      const tasks = [...get().tasks];
      const from = tasks.findIndex((t) => t.id === id);
      if (from < 0) return;
      const [moved] = tasks.splice(from, 1);
      const over = tasks.findIndex((t) => t.id === overId);
      if (over < 0) {
        setTasks(get().tasks, false);
        return;
      }
      tasks.splice(before ? over : over + 1, 0, moved);
      setTasks(tasks, false);
    },

    commitTasks: () => {
      persist(KV_TASKS, JSON.stringify(get().tasks));
    },

    restoreTasks: (tasks) => set({ tasks }),

    clearDone: (ids) => {
      // With a list, only those: the button lives under a filtered section and
      // must never reach the completed tasks of a project that is not on screen.
      const target = ids ? new Set(ids) : null;
      setTasks(get().tasks.filter((t) => !t.done || (target ? !target.has(t.id) : false)));
    },

    dropProject: (projectId) => {
      const tasks = get().tasks.filter((t) => t.projectId !== projectId);
      if (tasks.length !== get().tasks.length) setTasks(tasks);
    },

    // --- prompts ---

    addPrompt: ({ title, body, tags }) => {
      const now = Date.now();
      const prompt: BenchPrompt = {
        id: nanoid(10),
        title: title.trim() || "Sem título",
        body,
        tags: tags ?? [],
        pinned: false,
        createdAt: now,
        updatedAt: now,
        uses: 0,
        lastUsedAt: null,
      };
      setPrompts([prompt, ...get().prompts]);
      return prompt.id;
    },

    updatePrompt: (id, patch) => {
      setPrompts(
        get().prompts.map((p) =>
          p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
        ),
      );
    },

    duplicatePrompt: (id) => {
      const src = get().prompts.find((p) => p.id === id);
      if (!src) return null;
      const now = Date.now();
      const copy: BenchPrompt = {
        ...src,
        id: nanoid(10),
        title: `${src.title} (cópia)`,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        uses: 0,
        lastUsedAt: null,
      };
      setPrompts([copy, ...get().prompts]);
      return copy.id;
    },

    removePrompt: (id) => {
      setPrompts(get().prompts.filter((p) => p.id !== id));
    },

    togglePin: (id) => {
      setPrompts(
        get().prompts.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)),
      );
    },

    markUsed: (id) => {
      // Use does not touch `updatedAt`: the list sorts by edit, and the card
      // that was just clicked should not jump around.
      setPrompts(
        get().prompts.map((p) =>
          p.id === id ? { ...p, uses: p.uses + 1, lastUsedAt: Date.now() } : p,
        ),
      );
    },
  };
});
