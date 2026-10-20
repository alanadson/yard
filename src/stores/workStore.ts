import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { NewTask, WorkTask, TaskCursor } from "../lib/work";

let queryVersion = 0;

interface WorkState {
  tasks: WorkTask[];
  selectedId: string | null;
  total: number;
  next: TaskCursor | null;
  loading: boolean;
  filter: "all" | "attention";
  attentionTotal: number;
  setFilter: (filter: "all" | "attention") => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  create: (input: NewTask) => Promise<WorkTask>;
}

export const useWork = create<WorkState>((set, get) => ({
  tasks: [], selectedId: null, total: 0, next: null, loading: false, filter: "all", attentionTotal: 0,
  setFilter: async (filter) => {
    if (filter === get().filter) return;
    ++queryVersion;
    set({ filter, tasks: [], selectedId: null, next: null, total: 0 });
    await get().refresh();
  },
  refresh: async () => {
    const version = ++queryVersion;
    set({ loading: true });
    try {
      const attention = get().filter === "attention";
      const pageBudget = Math.max(1, Math.ceil(get().tasks.length / 200));
      let page = await ipc.taskList(null, 200, attention);
      if (version !== queryVersion) return;
      let fresh = page.tasks;
      for (let index = 1; attention && page.next && index < pageBudget; index++) {
        page = await ipc.taskList(page.next, 200, true);
        if (version !== queryVersion) return;
        fresh = [...fresh, ...page.tasks.filter((task) => !fresh.some((row) => row.id === task.id))];
      }
      const selected = get().selectedId;
      const existing = get().tasks;
      const tasks = attention ? fresh : [...fresh, ...existing.filter((task) => !fresh.some((row) => row.id === task.id))];
      set({ tasks, next: !attention && existing.length > fresh.length ? get().next : page.next, total: page.total, attentionTotal: page.attentionTotal ?? 0,
        selectedId: tasks.some((task) => task.id === selected) ? selected : tasks[0]?.id ?? null });
    } finally { if (version === queryVersion) set({ loading: false }); }
  },
  loadMore: async () => {
    const cursor = get().next;
    if (!cursor || get().loading) return;
    const version = ++queryVersion;
    set({ loading: true });
    try {
      const page = await ipc.taskList(cursor, 200, get().filter === "attention");
      if (version !== queryVersion) return;
      set((state) => ({ tasks: [...state.tasks, ...page.tasks.filter((task) => !state.tasks.some((old) => old.id === task.id))], next: page.next, total: page.total, attentionTotal: page.attentionTotal ?? 0 }));
    } finally { if (version === queryVersion) set({ loading: false }); }
  },
  create: async (input) => {
    await get().setFilter("all");
    const task = await ipc.taskCreate(input);
    ++queryVersion;
    set((state) => ({ tasks: [task, ...state.tasks.filter((row) => row.id !== task.id)], selectedId: task.id, total: state.total + (state.tasks.some((row) => row.id === task.id) ? 0 : 1), loading: false }));
    return task;
  },
}));
