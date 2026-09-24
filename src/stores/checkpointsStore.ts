/** The open checkpoint manager publishes only reads belonging to its current task. */
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Checkpoint, CheckpointScope, CheckpointPreview } from "../lib/checkpoints";
import { ReadCoordinator } from "../lib/readCoordinator";
import { t } from "../lib/i18n";
import { useUI } from "./uiStore";

const reads = new ReadCoordinator();

interface CheckpointState {
  scope: CheckpointScope | null;
  rows: Checkpoint[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  preview: CheckpointPreview | null;
  comparing: boolean;
  busy: boolean;
  open: (scope: CheckpointScope) => Promise<void>;
  close: () => void;
  refresh: () => Promise<void>;
  select: (id: string) => Promise<void>;
  restore: (guard: (root: string) => string | null, confirm: (message: string) => Promise<boolean>) => Promise<Checkpoint | null>;
  create: (label: string) => Promise<Checkpoint | null>;
  remove: (id: string) => Promise<void>;
}

export const useCheckpoints = create<CheckpointState>((set, get) => ({
  scope: null, rows: [], loading: false, error: null, selectedId: null, preview: null, comparing: false, busy: false,
  open: async (scope) => {
    if (get().busy) return;
    reads.invalidate("list");
    reads.invalidate("preview");
    set({ scope, rows: [], error: null, selectedId: null, preview: null, comparing: false });
    useUI.getState().openModal("checkpoints");
    await get().refresh();
  },
  close: () => {
    if (get().busy) return;
    reads.invalidate("list");
    reads.invalidate("preview");
    set({ scope: null, rows: [], loading: false, error: null, selectedId: null, preview: null, comparing: false });
    if (useUI.getState().modal === "checkpoints") useUI.getState().closeModal();
  },
  refresh: async () => {
    const scope = get().scope;
    if (!scope) return;
    set({ loading: true, error: null });
    await reads.run("list", scope.root, () => ipc.checkpointList(scope.root),
      (rows) => set({ rows, loading: false }),
      (error) => set({ error: String(error), loading: false }));
  },
  select: async (id) => {
    if (get().busy) return;
    const scope = get().scope;
    if (!scope) return;
    set({ selectedId: id, preview: null, comparing: true, error: null });
    await reads.run("preview", `${scope.root}\0${id}`, () => ipc.checkpointPreview(scope.root, id),
      (preview) => set({ preview, comparing: false }),
      (error) => set({ error: String(error), comparing: false }));
  },
  restore: async (guard, confirm) => {
    const { scope, selectedId, preview, busy, rows } = get();
    const row = rows.find((item) => item.id === selectedId);
    if (!scope || !row || !preview || busy || !preview.files.length) return null;
    const reason = preview.blockedReason ?? guard(scope.root);
    if (reason) { set({ error: reason }); return null; }
    if (!(await confirm(t('Restaurar "{label}" em {root}? {n} arquivo(s) serão alterados. Um checkpoint de recuperação será salvo antes.', {
      label: row.label, root: scope.root, n: preview.files.length,
    })))) return null;
    if (get().scope !== scope || get().selectedId !== selectedId || get().preview !== preview || get().busy) return null;
    const changed = guard(scope.root);
    if (changed) { set({ error: changed }); return null; }
    set({ busy: true, error: null });
    try {
      const recovery = await ipc.checkpointRestore(scope.root, row.id, preview.token);
      set({ preview: null, selectedId: null });
      await get().refresh();
      return recovery;
    } catch (error) {
      set({ error: String(error), preview: null });
      return null;
    } finally { set({ busy: false }); }
  },
  create: async (label) => {
    const { scope, busy } = get();
    if (!scope || busy || !label.trim()) return null;
    set({ busy: true, error: null });
    try {
      const row = await ipc.checkpointCreate(scope.root, scope.taskId, scope.taskLabel, label.trim());
      await get().refresh();
      return row;
    } catch (error) { set({ error: String(error) }); return null; }
    finally { set({ busy: false }); }
  },
  remove: async (id) => {
    const { scope, busy, rows } = get();
    if (!scope || busy || !rows.some((row) => row.id === id)) return;
    set({ busy: true, error: null });
    try {
      await ipc.checkpointDelete(scope.root, id);
      reads.invalidate("preview");
      set({ selectedId: null, preview: null, comparing: false });
      await get().refresh();
    } catch (error) { set({ error: String(error) }); }
    finally { set({ busy: false }); }
  },
}));
