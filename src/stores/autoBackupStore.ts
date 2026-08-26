/**
 * Automatic backups — the piece that touches the disk.
 *
 * `lib/autoBackup.ts` decides *when*; this store does the run: it hands the
 * backend the folder and the retention from `prefs`, remembers the stamp of
 * the last copy (in memory and in the kv, so a reload does not restart the
 * calendar), and refuses to overlap — two exports at once would fight over
 * the same zip name and the same database lock.
 */
import { create } from "zustand";

import { KV_LAST_AUTO, parseLastAuto } from "../lib/autoBackup";
import { t } from "../lib/i18n";
import { ipc, type AutoBackupReport } from "../lib/ipc";
import { uiLog } from "../lib/log";
import { persistPref, type PrefsSnapshot } from "../lib/prefs";
import { useUI } from "./uiStore";

interface AutoBackupState {
  /** Epoch ms of the last automatic copy; `0` = never. */
  lastAutoAt: number;
  running: boolean;
  /** The last failure, for the Settings row; cleared by the next success. */
  lastError: string | null;
  load: (prefs: PrefsSnapshot) => void;
  /**
   * Writes a copy now. `auto` is the timer's run: silent on success. A run
   * while another is in flight returns `null` without touching the backend.
   */
  runNow: (opts?: { auto?: boolean; now?: number }) => Promise<AutoBackupReport | null>;
}

export const useAutoBackup = create<AutoBackupState>((set, get) => ({
  lastAutoAt: 0,
  running: false,
  lastError: null,

  load: (prefs) => set({ lastAutoAt: parseLastAuto(prefs[KV_LAST_AUTO]) }),

  runNow: async ({ auto = false, now = Date.now() } = {}) => {
    if (get().running) return null;
    set({ running: true });
    const { autoBackupDir, autoBackupKeep } = useUI.getState().prefs;
    const dir = autoBackupDir.trim() ? autoBackupDir.trim() : null;
    try {
      const report = await ipc.backupAutoRun(dir, autoBackupKeep);
      set({ lastAutoAt: now, lastError: null });
      persistPref(KV_LAST_AUTO, String(now), (error) =>
        uiLog.warn(`backup automático: não consegui guardar a data: ${error}`),
      );
      uiLog.info(
        `backup automático gravado em ${report.path} (${report.bytes} bytes, ${report.pruned.length} apagados)`, // i18n-ok — log line
      );
      if (!auto) {
        useUI
          .getState()
          .showToast(
            t("Backup automático gravado ({kb} KB).", {
              kb: Math.max(1, Math.round(report.bytes / 1024)),
            }),
          );
      }
      return report;
    } catch (error) {
      const message = String(error);
      set({ lastError: message });
      uiLog.error(`backup automático falhou: ${message}`);
      // The timer's failure is the one that matters most: nobody is looking.
      useUI.getState().showToast(t("Backup automático falhou: {reason}", { reason: message }), "error");
      return null;
    } finally {
      set({ running: false });
    }
  },
}));
