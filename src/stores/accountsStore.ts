// Only account metadata crosses IPC. Provider credentials remain in the CLI home.
import { create } from "zustand";
import { ipc, type AccountBinding, type AgentAccount } from "../lib/ipc";

interface AccountsState {
  accounts: AgentAccount[];
  selected: Record<string, string | null>;
  bindings: Record<string, AccountBinding>;
  load: () => Promise<void>;
}

let revision = 0;

export const useAccounts = create<AccountsState>((set) => ({
  accounts: [], selected: {}, bindings: {},
  load: async () => {
    const requested = ++revision;
    const snapshot = await ipc.accountsSnapshot();
    if (requested !== revision) return;
    set({ accounts: snapshot.accounts, selected: snapshot.selected,
      bindings: Object.fromEntries(snapshot.bindings.map((binding) => [binding.terminalId, binding])) });
  },
}));
