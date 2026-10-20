/** Reference reads preserve the last acknowledged data when the native API cannot answer. */
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { reasonOf } from "../lib/loading";
import type { PricingReference } from "../lib/pricing";

interface PricingState {
  reference: PricingReference | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

let queryVersion = 0;

export const usePricing = create<PricingState>((set) => ({
  reference: null, loading: false, error: null,
  load: async () => {
    const version = ++queryVersion;
    set({ loading: true, error: null });
    try {
      const reference = await ipc.pricingReference();
      if (version === queryVersion) set({ reference, error: null });
    }
    catch (error) { if (version === queryVersion) set({ error: reasonOf(error) }); }
    finally { if (version === queryVersion) set({ loading: false }); }
  },
}));
