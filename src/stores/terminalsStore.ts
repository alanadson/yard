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
import { appendTail } from "../lib/blocked";
import type { ExitInfo, ExitReason, PtyResource } from "../lib/ipc";
import { useProjects } from "./projectsStore";

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
  /**
   * When the latest idle event landed (`markFinished`/`markBlocked`), 0 before
   * the first. `finished` is a latch — only focusing the pane releases it —
   * so anyone waiting for a turn to END must compare this against their own
   * start time instead of trusting the flag: a stale `true` from the previous
   * turn is indistinguishable from a fresh one by the flag alone.
   */
  finishedAt: number;
  /**
   * It stopped because it is asking *you* something. Always accompanied by
   * `finished` — a blocked agent did stop working — so every reader that only
   * knows about `finished` keeps behaving as it did. What changes is priority:
   * this one costs dead time, an ordinary finish costs nothing.
   */
  blocked: boolean;
  /** What it is asking, in one line. Tooltip and notification body. */
  blockedAsk: string | null;
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
  finishedAt: 0,
  blocked: false,
  blockedAsk: null,
  rssMb: 0,
  cpu: 0,
};

/** Is the process up (or on its way up)? The check every pane makes. */
export function isLive(rt?: TerminalRuntime | null): boolean {
  return rt?.state === "running" || rt?.state === "starting";
}

/**
 * What `yard wait` is waiting for.
 *
 * `stopped` is the default because it is the only one that cannot hang: an
 * orchestrator asking for `done` on an agent that stops at a question would
 * sit there until the timeout, which is the exact failure the command exists
 * to remove.
 */
export type WaitUntil = "stopped" | "done" | "blocked";

/** Has this terminal reached what the caller is waiting for? */
export function reachedWait(rt: TerminalRuntime | undefined, until: WaitUntil): boolean {
  if (!rt) return false;
  // A process that went down will never reach anything else. Reporting it is
  // an answer; holding the line until the timeout is not.
  if (rt.state === "exited" || rt.state === "error") return true;
  if (until === "blocked") return rt.blocked;
  if (until === "done") return rt.finished && !rt.blocked;
  return rt.finished;
}

/**
 * `TerminalRow.alive` is the *persisted* half of this mirror: it is what
 * decides whether a pane auto-starts on the next boot. It used to be written
 * only on the way up, so it latched at `true` forever — a CLI killed on
 * purpose came back by itself on the next launch, and every "how many are
 * alive" reader counted the dead.
 *
 * Anything that observes a process going down funnels through here.
 */
function clearPersistedAlive(id: string) {
  const row = useProjects.getState().terminal(id);
  if (row?.alive) useProjects.getState().updateTerminal(id, { alive: false });
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

// ---------------------------------------------------------------------------
// output tail — raw bytes for the blocked detector, same rule as above
// ---------------------------------------------------------------------------

/**
 * The last bytes each terminal wrote, kept verbatim.
 *
 * This is fed on **every** output chunk, so it does nothing but concatenate
 * and slice — no regex, no parse, no store write. The reading (`classifyPrompt`)
 * happens once per idle event, which is once per agent turn.
 */
const tailById = new Map<string, string>();

export function feedTail(id: string, chunk: string) {
  tailById.set(id, appendTail(tailById.get(id) ?? "", chunk));
}

export function readTail(id: string): string {
  return tailById.get(id) ?? "";
}

/**
 * The process went down — including on the way to a restart, where the screen
 * that comes back is a new one. Unlike the announced addresses, nothing here
 * survives its process: a question the dead run left on screen would still be
 * sitting in the window the classifier reads.
 */
export function clearTail(id: string) {
  tailById.delete(id);
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
  markBlocked: (id: string, ask: string) => void;
  clearBlocked: (id: string) => void;
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
    get().patch(id, {
      state: "starting",
      exit: null,
      error: null,
      finished: false,
      blocked: false,
      blockedAsk: null,
    }),

  markRunning: (id, pid) =>
    get().patch(id, {
      state: "running",
      pid,
      exit: null,
      error: null,
      finished: false,
      blocked: false,
      blockedAsk: null,
    }),

  markExited: (id, code, reason) => {
    get().patch(id, {
      state: "exited",
      pid: null,
      finished: false,
      blocked: false,
      blockedAsk: null,
      exit: { code, reason, at: Date.now() },
    });
    clearPersistedAlive(id);
  },

  markError: (id, message) => {
    get().patch(id, { state: "error", error: message, pid: null });
    clearPersistedAlive(id);
  },

  markFinished: (id) =>
    get().patch(id, {
      finished: true,
      finishedAt: Date.now(),
      unread: true,
      blocked: false,
      blockedAsk: null,
    }),

  markBlocked: (id, ask) =>
    get().patch(id, {
      finished: true,
      finishedAt: Date.now(),
      unread: true,
      blocked: true,
      blockedAsk: ask,
    }),

  /**
   * It started writing again — whatever it was asking for, it got.
   *
   * This exists because the answer does not have to come from the pane: an
   * agent unblocked by `yard ask`, by a routine or by another agent would keep
   * the badge until someone happened to focus it. Called from the activity
   * heartbeat (450 ms), never from the output chunk itself, which is the hot
   * path this store's header is about.
   */
  clearBlocked: (id) => {
    if (!get().byId[id]?.blocked) return;
    get().patch(id, { blocked: false, blockedAsk: null });
  },

  markRead: (id) =>
    get().patch(id, {
      unread: false,
      finished: false,
      blocked: false,
      blockedAsk: null,
    }),

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
      tailById.delete(id);
      if (!(id in s.byId)) return s;
      const byId = { ...s.byId };
      delete byId[id];
      return { byId };
    }),
}));
