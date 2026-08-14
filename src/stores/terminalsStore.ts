/**
 * Mirror of PTY runtime state — what the backend says is
 * happening. Nothing here is persisted: on the next boot, Rust's
 * `list_ptys` is in charge.
 *
 * Two rules keep this store from becoming the app's re-render engine:
 *
 * - **Nothing enters `byId` that nobody paints.** The activity heartbeat
 *   (`lastByteAt`/`idleMs`) arrives per PTY event and is read only by the
 *   routine scheduler and by `yard ask`, always through `getState()` — never
 *   as a subscription. Keeping it here would invalidate `byId` dozens of
 *   times per second and re-render every tree that watches the map.
 * - **A write that changes nothing returns the same state.** `patch` is
 *   called on *every* output chunk of an unfocused terminal to set
 *   `unread: true`, which is already true after the first one.
 */
import { create } from "zustand";
import type { ExitInfo, ExitReason, PtyResource } from "../lib/ipc";

export type RunState = "idle" | "starting" | "running" | "exited" | "error";

export interface TerminalRuntime {
  state: RunState;
  pid: number | null;
  exit: ExitInfo | null;
  error: string | null;
  /** New output since the last time the pane was focused. */
  unread: boolean;
  /** The agent stopped writing after working (§5.7). */
  finished: boolean;
  rssMb: number;
  cpu: number;
}

const EMPTY: TerminalRuntime = {
  state: "idle",
  pid: null,
  exit: null,
  error: null,
  unread: false,
  finished: false,
  rssMb: 0,
  cpu: 0,
};

/** Is the process up (or on its way up)? The check every pane makes. */
export function isLive(rt?: TerminalRuntime | null): boolean {
  return rt?.state === "running" || rt?.state === "starting";
}

// ---------------------------------------------------------------------------
// activity heartbeat — outside React on purpose (see the note at the top)
// ---------------------------------------------------------------------------

export interface Activity {
  /** Epoch ms of the last byte written by the process. */
  lastByteAt: number;
  idleMs: number;
}

const NO_ACTIVITY: Activity = { lastByteAt: 0, idleMs: 0 };
const activityById = new Map<string, Activity>();

export function markActivity(id: string, lastByteAt: number, idleMs: number) {
  activityById.set(id, { lastByteAt, idleMs });
}

export function getActivity(id: string): Activity {
  return activityById.get(id) ?? NO_ACTIVITY;
}

interface TerminalsState {
  byId: Record<string, TerminalRuntime>;
  systemAvailableMb: number;
  systemTotalMb: number;
  totalRssMb: number;

  get: (id: string) => TerminalRuntime;
  patch: (id: string, patch: Partial<TerminalRuntime>) => void;
  markStarting: (id: string) => void;
  markRunning: (id: string, pid: number | null) => void;
  markExited: (id: string, code: number | null, reason: ExitReason) => void;
  markError: (id: string, message: string) => void;
  markFinished: (id: string) => void;
  markRead: (id: string) => void;
  applyResources: (
    perPty: PtyResource[],
    totals: { totalRssMb: number; availableMb: number; totalMb: number },
  ) => void;
  forget: (id: string) => void;
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  byId: {},
  systemAvailableMb: 0,
  systemTotalMb: 0,
  totalRssMb: 0,

  get: (id) => get().byId[id] ?? EMPTY,

  patch: (id, patch) =>
    set((s) => {
      const cur = s.byId[id] ?? EMPTY;
      // The hot case is `{ unread: true }` on an already-unread terminal:
      // one chunk of agent output per frame, each one re-rendering the whole
      // sidebar tree, every tab bar and the composer for no visible change.
      let dirty = false;
      for (const key of Object.keys(patch) as (keyof TerminalRuntime)[]) {
        if (cur[key] !== patch[key]) {
          dirty = true;
          break;
        }
      }
      if (!dirty) return s;
      return { byId: { ...s.byId, [id]: { ...cur, ...patch } } };
    }),

  markStarting: (id) =>
    get().patch(id, { state: "starting", exit: null, error: null, finished: false }),

  markRunning: (id, pid) =>
    get().patch(id, {
      state: "running",
      pid,
      exit: null,
      error: null,
      finished: false,
    }),

  markExited: (id, code, reason) =>
    get().patch(id, {
      state: "exited",
      pid: null,
      finished: false,
      exit: { code, reason, at: Date.now() },
    }),

  markError: (id, message) =>
    get().patch(id, { state: "error", error: message, pid: null }),

  markFinished: (id) => get().patch(id, { finished: true, unread: true }),

  markRead: (id) => get().patch(id, { unread: false, finished: false }),

  applyResources: (perPty, totals) =>
    set((s) => {
      // The tick fires on a timer for every PTY at once; between two ticks an
      // idle process reports the same numbers, so rebuilding its entry would
      // re-render its card for nothing.
      let byId = s.byId;
      for (const r of perPty) {
        const cur = byId[r.id] ?? EMPTY;
        if (cur.rssMb === r.rssMb && cur.cpu === r.cpu && byId[r.id]) continue;
        if (byId === s.byId) byId = { ...s.byId };
        byId[r.id] = { ...cur, rssMb: r.rssMb, cpu: r.cpu };
      }
      const same =
        byId === s.byId &&
        s.totalRssMb === totals.totalRssMb &&
        s.systemAvailableMb === totals.availableMb &&
        s.systemTotalMb === totals.totalMb;
      if (same) return s;
      return {
        byId,
        totalRssMb: totals.totalRssMb,
        systemAvailableMb: totals.availableMb,
        systemTotalMb: totals.totalMb,
      };
    }),

  forget: (id) =>
    set((s) => {
      activityById.delete(id);
      if (!(id in s.byId)) return s;
      const byId = { ...s.byId };
      delete byId[id];
      return { byId };
    }),
}));
