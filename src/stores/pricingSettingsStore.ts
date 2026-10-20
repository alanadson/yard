/** Native acknowledgements keep custom-rate edits and persisted revisions consistent. */
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { reasonOf } from "../lib/loading";
import type { CustomRate, PricingSettings } from "../lib/pricing";

interface PricingSettingsState {
  settings: PricingSettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (rates: CustomRate[], reviewedRevision?: number) => Promise<boolean>;
}

let queryVersion = 0;
const newerOrEqual = (settings: PricingSettings, current: PricingSettings | null) => !current || settings.revision >= current.revision;

export const usePricingSettings = create<PricingSettingsState>((set, get) => ({
  settings: null, loading: false, saving: false, error: null,
  load: async () => {
    const version = ++queryVersion;
    set({ loading: true, error: null });
    try {
      const settings = await ipc.pricingSettings();
      if (version === queryVersion && newerOrEqual(settings, get().settings)) set({ settings });
    }
    catch (error) { if (version === queryVersion) set({ error: reasonOf(error) }); }
    finally { if (version === queryVersion) set({ loading: false }); }
  },
  save: async (rates, reviewedRevision) => {
    const { settings, saving } = get();
    if (!settings || saving) return false;
    ++queryVersion;
    set({ saving: true, loading: false, error: null });
    try {
      const saved = await ipc.pricingSettingsSave(reviewedRevision ?? settings.revision, rates);
      if (newerOrEqual(saved, get().settings)) set({ settings: saved });
      return true;
    } catch (error) { set({ error: reasonOf(error) }); return false; }
    finally { set({ saving: false }); }
  },
}));
