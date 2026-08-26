/**
 * Automatic update checks, off the boot's critical path.
 *
 * The first check waits `FIRST_CHECK_DELAY_MS` after mount — the terminals
 * that auto-start, the workspace load and the agent detection own that
 * window — and from then on an hourly tick asks `checkDue` whether six hours
 * went by since the last one (the stamp lives in kv, so a reload does not
 * fetch the manifest again). Turning the preference off stops the timers;
 * turning it on starts them over. Failures are a log line, never a toast:
 * nobody asked.
 */
import { useEffect } from "react";

import { checkDue, FIRST_CHECK_DELAY_MS } from "../lib/updater";
import { useUI } from "../stores/uiStore";
import { useUpdater } from "../stores/updaterStore";

const TICK_MS = 60 * 60 * 1000;

export function useUpdaterChecks() {
  const auto = useUI((s) => s.prefs.autoCheckUpdates);

  useEffect(() => {
    if (!auto) return;
    const run = () => {
      const { lastCheckAt, phase } = useUpdater.getState();
      if (phase === "downloading" || phase === "installing") return;
      if (!checkDue({ lastCheckAt, now: Date.now() })) return;
      void useUpdater.getState().check({ manual: false });
    };
    const first = window.setTimeout(run, FIRST_CHECK_DELAY_MS);
    const tick = window.setInterval(run, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(tick);
    };
  }, [auto]);
}
