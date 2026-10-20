/**
 * The quota half of the automation pause (`lib/automationPause.ts` decides,
 * `stores/automationStore.ts` writes). Every `usage://update` snapshot is one
 * reading of the providers' five-hour windows: the moment the most used one
 * reaches `quotaPausePct`, automation stops before the plan runs dry in the
 * middle of a turn nobody is watching.
 */
import { useEffect } from "react";

import { quotaPeak } from "../lib/automationPause";
import { useAutomation } from "../stores/automationStore";
import { useUsage } from "../stores/usageStore";

export function useQuotaPause() {
  useEffect(
    () =>
      useUsage.subscribe((state, previous) => {
        if (state.providers === previous.providers) return;
        void useAutomation.getState().observe({ quotaPct: quotaPeak(state.providers) }, Date.now());
      }),
    [],
  );
}
