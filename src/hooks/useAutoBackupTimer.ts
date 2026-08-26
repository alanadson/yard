/**
 * The clock behind the automatic backup.
 *
 * First look a minute after boot — never on the boot's critical path, the
 * terminals come first — then once an hour. Each look asks `backupDue` with
 * the mode from `prefs` and the stamp from the store; the store does the
 * rest (and refuses to overlap). A day-long period checked hourly is at
 * most an hour late, which is the precision a nightly copy needs.
 */
import { useEffect } from "react";

import { backupDue } from "../lib/autoBackup";
import { useAutoBackup } from "../stores/autoBackupStore";
import { useUI } from "../stores/uiStore";

const FIRST_LOOK_MS = 60_000;
const EVERY_MS = 3_600_000;

export function useAutoBackupTimer() {
  useEffect(() => {
    const look = () => {
      const mode = useUI.getState().prefs.autoBackup;
      const { lastAutoAt } = useAutoBackup.getState();
      if (!backupDue({ mode, lastAt: lastAutoAt, now: Date.now() })) return;
      void useAutoBackup.getState().runNow({ auto: true });
    };
    const first = setTimeout(look, FIRST_LOOK_MS);
    const every = setInterval(look, EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
}
