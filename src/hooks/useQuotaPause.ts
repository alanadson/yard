/**
 * The quota half of the automation pause (`lib/automationPause.ts` decides,
 * `stores/automationStore.ts` writes). Every `usage://update` snapshot is one
 * reading of the providers' five-hour windows: the moment the most used one
 * reaches `quotaPausePct`, automation stops before the plan runs dry in the
 * middle of a turn nobody is watching.
 */
import { useEffect } from "react";

import { quotaPeak } from "../lib/automationPause";
import { automationAccountUsage } from "../lib/accounts";
import { useAccounts } from "../stores/accountsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useAutomation } from "../stores/automationStore";
import { useUsage } from "../stores/usageStore";

export function useQuotaPause() {
  useEffect(() => {
    const observe = () => {
      const state = useUsage.getState();
      const active = new Set(Object.entries(useTerminals.getState().byId).filter(([, terminal]) => isLive(terminal)).map(([id]) => id));
      const providers = automationAccountUsage(state.providers, state.accounts, Object.values(useAccounts.getState().bindings), active);
      void useAutomation.getState().observe({ quotaPct: quotaPeak(providers) }, Date.now());
    };
    const stopUsage = useUsage.subscribe((state, previous) => {
      if (state.providers !== previous.providers || state.accounts !== previous.accounts) observe();
    });
    const stopAccounts = useAccounts.subscribe((state, previous) => {
      if (state.bindings !== previous.bindings) observe();
    });
    return () => { stopUsage(); stopAccounts(); };
  }, []);
}
