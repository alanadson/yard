/**
 * "Ao Vivo" — state for the overlay that follows an agent session in real
 * time (tap on the `.jsonl` in the backend, `agents/tail.rs`).
 *
 * The backend sends raw, typed events; this store is the reducer that turns
 * them into what the screen draws: timeline, touched files, kanban of the
 * plan and sub-agents, accumulated usage.
 *
 * One session at a time: opening for another terminal tears down the
 * previous tap (the `tail_id` is the terminal id — switching files under
 * the same id replaces the tap in the backend).
 */
import { create } from "zustand";
import {
  ipc,
  on,
  type AgentSession,
  type FeedTodo,
  type SessionFeed,
  type TerminalRow,
  type UnlistenFn,
} from "../lib/ipc";
import {
  emptyFeedModel,
  reduceFeed,
  type AgentCard,
  type EntryIds,
  type FeedModel,
  type LiveEntry,
  type LiveFile,
  type LiveUsage,
  type PlanCard,
} from "../lib/liveModel";
import { uiLog } from "../lib/log";
import { bestSessionFor } from "../lib/sessionFind";
import { baseName } from "../lib/terminals";

/** Timeline entry: the raw event + completion state. */
// The feed model (entries, files, plan, sub-agents, usage) and its reducer
// live in `lib/liveModel.ts`; the digest and the transcript read the same
// arithmetic. The store keeps the names for its callers.
export type { AgentCard, LiveEntry, LiveFile, LiveUsage, PlanCard } from "../lib/liveModel";

export type LivePhase =
  | "closed"
  | "finding"
  | "none"
  | "backfill"
  | "live"
  /**
   * The listing itself failed. Without this the overlay sat in `finding`
   * forever: "looking for the agent's session…" is indistinguishable from
   * "it broke", and there was nothing to click.
   */
  | "error";

/** Timeline cap — long sessions must not grow without bound. */
interface LiveState {
  phase: LivePhase;
  terminalId: string | null;
  terminalTitle: string;
  terminalCwd: string | null;
  agentId: string | null;
  session: AgentSession | null;
  sessions: AgentSession[];
  /**
   * The user picked a session in the selector: stop following the newest
   * trail until the overlay reopens.
   */
  pinned: boolean;
  /** Why the search failed, when `phase === "error"`. */
  error: string | null;

  timeline: LiveEntry[];
  files: Record<string, LiveFile>;
  plan: Record<string, PlanCard>;
  todos: FeedTodo[];
  agents: AgentCard[];
  usage: LiveUsage;
  /** Tools awaiting a result — the "working" ("trabalhando") status. */
  pendingTools: number;
  lastEventAt: number;
  /** What the agent last said/thought (for the sub-header). */
  lastNote: string | null;
  lastNoteKind: "say" | "think" | null;
  counts: { edits: number; reads: number; runs: number; searches: number };

  openFor: (terminal: TerminalRow) => Promise<void>;
  switchSession: (session: AgentSession) => Promise<void>;
  /** Tries the search again after `phase === "error"`. */
  retry: () => Promise<void>;
  close: () => void;
}

const emptyFeedState = emptyFeedModel;

let nextId = 1;
/** The overlay's timeline ids: one sequence for the whole session. */
const ids: EntryIds = { next: () => nextId++ };
let unlisten: UnlistenFn | null = null;
let unlistenChanged: UnlistenFn | null = null;
let listenersPromise: Promise<void> | null = null;
let waitTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Every session already on disk when this overlay attached.
 *
 * Sessions are listed by *folder*, not by terminal — two CLIs in the same
 * project write two trails there, and "the most recent" alternates between
 * them at every turn. Following that alternation made the overlay jump to
 * the neighbour's conversation and wipe its own state (the board, the files,
 * the timeline) exactly when the watched agent went quiet, which is when
 * there was most to read.
 *
 * So only a trail *born after* we attached counts as "the CLI started a new
 * conversation" and is worth following.
 */
let knownSessions = new Set<string>();
/**
 * The terminal's resume arguments (`--resume <id>`), when it was born from
 * the sessions modal. It is the one case where the trail is known for
 * certain instead of guessed from timestamps.
 */
let resumeArgs: string[] = [];

/** Single global listeners; they filter by the current state. */
function ensureListeners(): Promise<void> {
  if (listenersPromise) return listenersPromise;
  listenersPromise = (async () => {
    if (!unlisten) {
      unlisten = await on.sessionFeed((p) => {
        const s = useLive.getState();
        if (s.terminalId && p.tailId === s.terminalId) applyFeed(p);
      });
    }
    if (!unlistenChanged) {
      // The backend watcher fires whenever any agent `.jsonl` changes — it is
      // what keeps session resolution alive: a freshly created CLI gets a
      // session on its first turn, and a new conversation becomes the trail
      // to follow.
      unlistenChanged = await on.agentsChanged(() => void refreshSessions());
    }
  })().catch((error) => {
    listenersPromise = null;
    throw error;
  });
  return listenersPromise;
}

/**
 * Reconciles the tap with the disk: finds the sessions for the terminal's
 * cwd, starts the tap when the first one shows up and — unless the user
 * pinned a session in the selector — moves to a conversation that was born
 * after we attached (a `/clear`, a restarted CLI).
 */
async function refreshSessions() {
  const s = useLive.getState();
  if (s.phase === "closed" || !s.terminalId || !s.agentId || !s.terminalCwd) {
    return;
  }
  const terminalId = s.terminalId;
  let sessions: AgentSession[];
  try {
    sessions = await ipc.listAgentSessions(s.agentId, s.terminalCwd);
  } catch (e) {
    const cur = useLive.getState();
    if (cur.terminalId !== terminalId || cur.phase === "closed") return;
    // Only the wait states become an error screen. Once the trail is running,
    // a failed poll is a hiccup — killing the feed on screen would be worse
    // than showing a slightly stale one.
    if (cur.phase === "finding" || cur.phase === "none") {
      useLive.setState({ phase: "error", error: String(e) });
    } else {
      uiLog.warn(`falha ao listar sessões do agente: ${e}`);
    }
    return;
  }

  const cur = useLive.getState();
  if (cur.terminalId !== terminalId || cur.phase === "closed") return;

  const best = sessions[0] ?? null;
  if (!best) {
    if (cur.phase === "finding") useLive.setState({ phase: "none", sessions });
    else useLive.setState({ sessions });
    return;
  }

  const waiting = cur.phase === "finding" || cur.phase === "none";
  // Newest among the ones that did not exist when we attached — an older
  // neighbour writing a line does not qualify, however recent that line is.
  const born = cur.pinned
    ? null
    : (sessions.find((x) => !knownSessions.has(x.externalId)) ?? null);
  // A resumed terminal carries its session id in the command line; that beats
  // "the most recent in the folder", which may well be the neighbour's.
  const target = waiting ? bestSessionFor(sessions, resumeArgs) : born;

  if (target && target.externalId !== cur.session?.externalId) {
    // Whatever is on disk now is "old news" from here on, including the trail
    // we are about to follow.
    for (const x of sessions) knownSessions.add(x.externalId);
    useLive.setState({
      sessions,
      session: target,
      phase: "backfill",
      error: null,
      ...emptyFeedState(),
    });
    try {
      await ipc.sessionTailStart(terminalId, target.file);
    } catch (e) {
      // The tap is what feeds the whole overlay. Failing to start it left the
      // view in `backfill` waiting on events that would never arrive.
      const now = useLive.getState();
      if (now.terminalId === terminalId && now.phase !== "closed") {
        useLive.setState({ phase: "error", error: String(e) });
      }
    }
  } else {
    for (const x of sessions) knownSessions.add(x.externalId);
    useLive.setState({ sessions });
  }
}

export const useLive = create<LiveState>((set, get) => ({
  phase: "closed",
  terminalId: null,
  terminalTitle: "",
  terminalCwd: null,
  agentId: null,
  session: null,
  sessions: [],
  pinned: false,
  error: null,
  ...emptyFeedState(),

  openFor: async (terminal) => {
    const prev = get().terminalId;
    if (prev && prev !== terminal.id) void ipc.sessionTailStop(prev);

    knownSessions = new Set();
    resumeArgs = terminal.resume ?? [];
    set({
      phase: "finding",
      terminalId: terminal.id,
      terminalTitle: baseName(terminal),
      terminalCwd: terminal.cwd,
      agentId: terminal.agentId ?? null,
      session: null,
      sessions: [],
      pinned: false,
      error: null,
      ...emptyFeedState(),
    });

    try {
      await ensureListeners();
    } catch (e) {
      set({ phase: "error", error: String(e) });
      return;
    }

    // Safety net for `agents://changed`: if the session directory did not
    // even exist when the app booted, the watcher is not observing it — the
    // poll (cheap: one listing) guarantees the wait always ends.
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = setInterval(() => {
      const s = useLive.getState();
      if (s.phase === "finding" || s.phase === "none") void refreshSessions();
    }, 2500);

    await refreshSessions();
  },

  switchSession: async (session) => {
    const terminalId = get().terminalId;
    if (!terminalId) return;
    // Manual choice: the trail stays pinned to this session until reopened.
    const previous = get().session;
    set({ session, pinned: true, phase: "backfill", error: null, ...emptyFeedState() });
    // Same tailId + new file = the backend swaps the tap.
    try {
      await ipc.sessionTailStart(terminalId, session.file);
    } catch (e) {
      // The tap never started: staying in `backfill` would spin forever on a
      // session that is not being read.
      set({ phase: "error", error: String(e), session: previous });
    }
  },

  retry: async () => {
    if (get().phase !== "error") return;
    set({ phase: "finding", error: null });
    await refreshSessions();
  },

  close: () => {
    const id = get().terminalId;
    if (id) void ipc.sessionTailStop(id);
    if (waitTimer) {
      clearInterval(waitTimer);
      waitTimer = null;
    }
    knownSessions = new Set();
    resumeArgs = [];
    set({
      phase: "closed",
      error: null,
      terminalId: null,
      terminalTitle: "",
      terminalCwd: null,
      agentId: null,
      session: null,
      sessions: [],
      pinned: false,
      ...emptyFeedState(),
    });
  },
}));

// ---------------------------------------------------------------------------
// feed reducer
// ---------------------------------------------------------------------------

/** Exported for the tests: this is the whole reduction, batch by batch. */
export function applyFeed(p: SessionFeed) {
  useLive.setState((s) => {
    const base: FeedModel = p.reset ? emptyFeedState() : s;
    return {
      ...reduceFeed(base, p.events, ids),
      phase: p.live ? "live" : s.phase === "closed" ? s.phase : "backfill",
      // Data arriving is the proof the tap recovered: an error screen must not
      // survive underneath a feed that is already filling in.
      error: null,
    };
  });
}
