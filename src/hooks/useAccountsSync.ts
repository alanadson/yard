// Refresh account metadata on account changes and terminal creation, never on terminal output.
import { useEffect } from "react";
import { on } from "../lib/ipc";
import { useAccounts } from "../stores/accountsStore";
import { useProjects } from "../stores/projectsStore";
import { useUsage } from "../stores/usageStore";

export function useAccountsSync() {
  useEffect(() => {
    const refresh = () => { void useAccounts.getState().load().catch(() => {}); };
    refresh();
    const listening = on.accountsChanged(refresh);
    const stopAccounts = useAccounts.subscribe((state, previous) => {
      if (state.selected !== previous.selected) useUsage.getState().selectAccounts(state.selected);
    });
    const unsubscribe = useProjects.subscribe((state, previous) => {
      if (state.terminals !== previous.terminals) refresh();
    });
    return () => { unsubscribe(); stopAccounts(); void listening.then((stop) => stop()); };
  }, []);
}
