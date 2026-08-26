/**
 * In-app updates — the one place that talks to the updater plugin.
 *
 * The plugin fetches `latest.json` from the GitHub release, verifies the
 * minisign signature against the public key in `tauri.conf.json` and runs the
 * NSIS installer (`installMode: passive`). This store keeps what the screen
 * needs around that: the phase, the version on offer with a summary of its
 * notes, the download progress, and two kv rows — when the last check
 * happened (so a reload does not fire another one) and which version the
 * user chose to ignore.
 *
 * Rules are pure in `lib/updater.ts`; this file only orders the effects.
 */
import { create } from "zustand";
import { check as pluginCheck, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { uiLog } from "../lib/log";
import { persistPref, type PrefsSnapshot } from "../lib/prefs";
import {
  KV_LAST_CHECK,
  KV_SKIP,
  parseLastCheck,
  shouldOffer,
  updateSummary,
} from "../lib/updater";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "none"
  | "available"
  | "downloading"
  | "installing"
  | "error";

interface UpdaterState {
  phase: UpdaterPhase;
  /** The version on offer (or the one being installed). */
  version: string | null;
  /** Up to three lines of the release notes. */
  notes: string[];
  progress: { downloaded: number; total: number | null };
  /** The last failure, kept beside the phase so an offer can show its own error. */
  error: string | null;
  lastCheckAt: number;
  skipVersion: string | null;

  load: (prefs: PrefsSnapshot) => void;
  check: (opts: { manual: boolean; now?: number }) => Promise<void>;
  install: () => Promise<void>;
  skip: () => void;
  /** Test seam: back to the boot state, the plugin handle released. */
  reset: () => void;
}

/**
 * The plugin's handle for the offer on the table. Not in the state on
 * purpose: it is a resource, not data, and `close()` must run exactly once.
 */
let pending: Update | null = null;
let checking: Promise<void> | null = null;

async function dropPending() {
  const u = pending;
  pending = null;
  if (u) await u.close().catch(() => {});
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: "idle",
  version: null,
  notes: [],
  progress: { downloaded: 0, total: null },
  error: null,
  lastCheckAt: 0,
  skipVersion: null,

  load: (prefs) => {
    set({
      lastCheckAt: parseLastCheck(prefs[KV_LAST_CHECK]),
      skipVersion: prefs[KV_SKIP]?.trim() || null,
    });
  },

  check: ({ manual, now = Date.now() }) => {
    // One check at a time: a manual click while the automatic one is in
    // flight would fetch the manifest twice and could race the phase.
    if (checking) return checking;
    checking = (async () => {
      set({ phase: "checking", error: null });
      try {
        await dropPending();
        const update = await pluginCheck();
        set({ lastCheckAt: now });
        persistPref(KV_LAST_CHECK, String(now), (e) =>
          uiLog.warn(`não consegui gravar a hora da verificação de atualização: ${e}`),
        );
        if (!update || !update.available) {
          set({ phase: "none", version: null, notes: [] });
          return;
        }
        const offer = shouldOffer({
          version: update.version,
          skipVersion: get().skipVersion,
          manual,
        });
        if (!offer) {
          await update.close().catch(() => {});
          set({ phase: "none", version: null, notes: [] });
          return;
        }
        pending = update;
        const summary = updateSummary(update.version, update.body);
        set({
          phase: "available",
          version: update.version,
          notes: summary.notes,
          progress: { downloaded: 0, total: null },
        });
        uiLog.info(`atualização disponível: ${update.version}`);
      } catch (e) {
        uiLog.warn(`verificação de atualização falhou: ${e}`);
        set({ phase: "error", error: String(e) });
      } finally {
        checking = null;
      }
    })();
    return checking;
  },

  install: async () => {
    const update = pending;
    if (!update || get().phase !== "available") return;
    set({ phase: "downloading", error: null, progress: { downloaded: 0, total: null } });
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          set({ progress: { downloaded: 0, total: event.data.contentLength ?? null } });
        } else if (event.event === "Progress") {
          set((s) => ({
            progress: {
              downloaded: s.progress.downloaded + event.data.chunkLength,
              total: s.progress.total,
            },
          }));
        } else if (event.event === "Finished") {
          set({ phase: "installing" });
        }
      });
      pending = null;
      // On Windows the installer takes over from here; the relaunch is what
      // the plugin's own docs ask for, and the Job Objects clean the PTYs up.
      await relaunch();
    } catch (e) {
      uiLog.error(`falha ao instalar a atualização: ${e}`);
      set({ phase: "available", error: String(e) });
    }
  },

  skip: () => {
    const version = get().version;
    if (!version) return;
    persistPref(KV_SKIP, version, (e) =>
      uiLog.warn(`não consegui gravar a versão ignorada: ${e}`),
    );
    void dropPending();
    set({ phase: "none", skipVersion: version, version: null, notes: [] });
  },

  reset: () => {
    pending = null;
    checking = null;
    set({
      phase: "idle",
      version: null,
      notes: [],
      progress: { downloaded: 0, total: null },
      error: null,
      lastCheckAt: 0,
      skipVersion: null,
    });
  },
}));
