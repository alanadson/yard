import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ArchivedOutput, ArchivedPreview } from "../lib/outputHistory";

let previewVersion = 0;
let listVersion = 0;

interface OutputHistoryState {
  records: ArchivedOutput[];
  selected: ArchivedOutput | null;
  preview: ArchivedPreview | null;
  error: string | null;
  loading: boolean;
  previewLoading: boolean;
  select: (record: ArchivedOutput) => Promise<void>;
  load: (terminalId?: string | null) => Promise<void>;
}

export const useOutputHistory = create<OutputHistoryState>((set, get) => ({
  records: [], selected: null, preview: null, error: null, loading: false, previewLoading: false,
  load: async (terminalId = null) => {
    const version = ++listVersion;
    ++previewVersion;
    const selected = get().selected;
    set({ records: [], selected: null, preview: null, error: null, loading: true, previewLoading: false });
    try {
      const records = await ipc.ptyArchives(terminalId);
      if (version !== listVersion) return;
      set({ records, loading: false });
      const record = records.find((record) => record.name === selected?.name) ?? records[0];
      if (record) await get().select(record);
    } catch (error) {
      if (version === listVersion) set({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (version === listVersion) set({ loading: false }); }
  },
  select: async (record) => {
    const version = ++previewVersion;
    set({ selected: record, preview: null, previewLoading: true, error: null });
    try {
      const preview = await ipc.ptyArchivePreview(record.terminalId, record.name);
      if (version === previewVersion) set({ preview });
    } catch (error) {
      if (version === previewVersion) set({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (version === previewVersion) set({ previewLoading: false }); }
  },
}));
