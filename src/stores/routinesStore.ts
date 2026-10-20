/** Native routine results remain readable while a later status read fails. */
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { reasonOf } from "../lib/loading";
import { reconcileSnapshot } from "../lib/reconcileSnapshot";
import type { RoutineExecution } from "../lib/routineExecution";

interface RoutineExecutionState {
  items: RoutineExecution[];
  error: string | null;
  loading: boolean;
  load: () => Promise<void>;
}

export const useRoutineExecutions = create<RoutineExecutionState>((set, get) => ({
  items: [], error: null, loading: false,
  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const snapshot = await ipc.routineSnapshot();
      set({ items: reconcileSnapshot(get().items, snapshot,
        (item) => JSON.stringify([item.groupId, item.routineId])), error: null });
    }
    catch (error) { set({ error: reasonOf(error) }); }
    finally { set({ loading: false }); }
  },
}));
