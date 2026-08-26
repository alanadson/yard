/**
 * The data behind "Custos e uso": the window in days and the rows the
 * backend bucketed for it.
 *
 * Reads are sequenced by a request counter — the answer for a window the
 * user already left is dropped, so a slow "30 dias" never paints over a fast
 * "Hoje". A failed read keeps the rows already on screen and records why.
 */
import { create } from "zustand";

import type { CostRange, UsageRow } from "../lib/costs";
import { ipc } from "../lib/ipc";
import { reasonOf } from "../lib/loading";
import { useUI } from "./uiStore";

interface CostsState {
  days: CostRange;
  rows: UsageRow[];
  loading: boolean;
  error: string | null;
  /** Epoch ms of the last successful read; 0 before the first. */
  loadedAt: number;

  /** Opens the panel and reads the current window. */
  open: (days?: CostRange) => Promise<void>;
  /** Switches the window and reads it. */
  setDays: (days: CostRange) => Promise<void>;
  refresh: () => Promise<void>;
}

let request = 0;

export const useCosts = create<CostsState>((set, get) => ({
  days: 7,
  rows: [],
  loading: false,
  error: null,
  loadedAt: 0,

  open: async (days) => {
    if (days) set({ days });
    useUI.getState().openModal("costs");
    await get().refresh();
  },

  setDays: async (days) => {
    set({ days });
    await get().refresh();
  },

  refresh: async () => {
    const mine = ++request;
    const { days } = get();
    set({ loading: true, error: null });
    try {
      const rows = await ipc.usageHistory(days);
      if (mine !== request) return;
      set({ rows, loading: false, loadedAt: Date.now() });
    } catch (e) {
      if (mine !== request) return;
      set({ loading: false, error: reasonOf(e) });
    }
  },
}));
