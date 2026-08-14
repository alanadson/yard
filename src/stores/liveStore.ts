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
  type FeedEvent,
  type FeedTodo,
  type SessionFeed,
  type TerminalRow,
  type UnlistenFn,
} from "../lib/ipc";
import { baseName } from "../lib/terminals";

/** Timeline entry: the raw event + completion state. */
export interface LiveEntry extends FeedEvent {
  id: number;
  /** Tool with no result yet = running right now. */
  pending?: boolean;
  /** Result arrived with an error. */
  failed?: boolean;
}

export interface LiveFile {
  path: string;
  edits: number;
  writes: number;
  reads: number;
  added: number;
  removed: number;
  lastAt: number;
  lastOp: "edit" | "write" | "read";
  /** At least one of the operations came from a sub-agent. */
  side?: boolean;
}

export interface PlanCard {
  /** taskId when known; otherwise TaskCreate's provisional toolId. */
  key: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  at: number;
}

export interface AgentCard {
  toolId: string;
  agentType: string | null;
  detail: string | null;
  startedAt: number;
  done: boolean;
  ok?: boolean;
  endedAt?: number;
  /** The immediate result indicated background execution. */
  bg?: boolean;
}

export interface LiveUsage {
  model: string | null;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export type LivePhase = "closed" | "finding" | "none" | "backfill" | "live";

/** Timeline cap — long sessions must not grow without bound. */
const TIMELINE_CAP = 400;

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

  timeline: LiveEntry[];
  files: Record<string, LiveFile>;
  plan: Record<string, PlanCard>;
  todos: FeedTodo[];
  agents: AgentCard[];
  usage: LiveUsage;
  /** Tools awaiting a result — the “trabalhando” status. */
  pendingTools: number;
  lastEventAt: number;
  /** What the agent last said/thought (for the sub-header). */
  lastNote: string | null;
  lastNoteKind: "say" | "think" | null;
  counts: { edits: number; reads: number; runs: number; searches: number };

  openFor: (terminal: TerminalRow) => Promise<void>;
  switchSession: (session: AgentSession) => Promise<void>;
  close: () => void;
}

const EMPTY_USAGE: LiveUsage = {
  model: null,
  inTokens: 0,
  outTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
};

function emptyFeedState() {
  return {
    timeline: [] as LiveEntry[],
    files: {} as Record<string, LiveFile>,
    plan: {} as Record<string, PlanCard>,
    todos: [] as FeedTodo[],
    agents: [] as AgentCard[],
    usage: { ...EMPTY_USAGE },
    pendingTools: 0,
    lastEventAt: 0,
    lastNote: null as string | null,
    lastNoteKind: null as "say" | "think" | null,
    counts: { edits: 0, reads: 0, runs: 0, searches: 0 },
  };
}

let nextId = 1;
let unlisten: UnlistenFn | null = null;
let unlistenChanged: UnlistenFn | null = null;
let waitTimer: ReturnType<typeof setInterval> | null = null;

/** Single global listeners; they filter by the current state. */
async function ensureListeners() {
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
}

/**
 * Reconciles the tap with the disk: finds the sessions for the terminal's
 * cwd, starts the tap when the first one shows up and — unless the user
 * pinned a session in the selector — follows the most recent one when the
 * CLI switches conversations.
 */
async function refreshSessions() {
  const s = useLive.getState();
  if (s.phase === "closed" || !s.terminalId || !s.agentId || !s.terminalCwd) {
    return;
  }
  const terminalId = s.terminalId;
  const sessions = await ipc.listAgentSessions(s.agentId, s.terminalCwd);

  const cur = useLive.getState();
  if (cur.terminalId !== terminalId || cur.phase === "closed") return;

  const best = sessions[0] ?? null;
  if (!best) {
    if (cur.phase === "finding") useLive.setState({ phase: "none", sessions });
    else useLive.setState({ sessions });
    return;
  }

  const waiting = cur.phase === "finding" || cur.phase === "none";
  const newer =
    !cur.pinned &&
    cur.session != null &&
    best.externalId !== cur.session.externalId;

  if (waiting || newer) {
    useLive.setState({
      sessions,
      session: best,
      phase: "backfill",
      ...emptyFeedState(),
    });
    await ipc.sessionTailStart(terminalId, best.file);
  } else {
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
  ...emptyFeedState(),

  openFor: async (terminal) => {
    const prev = get().terminalId;
    if (prev && prev !== terminal.id) void ipc.sessionTailStop(prev);

    set({
      phase: "finding",
      terminalId: terminal.id,
      terminalTitle: baseName(terminal),
      terminalCwd: terminal.cwd,
      agentId: terminal.agentId ?? null,
      session: null,
      sessions: [],
      pinned: false,
      ...emptyFeedState(),
    });

    await ensureListeners();

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
    set({ session, pinned: true, phase: "backfill", ...emptyFeedState() });
    // Same tailId + new file = the backend swaps the tap.
    await ipc.sessionTailStart(terminalId, session.file);
  },

  close: () => {
    const id = get().terminalId;
    if (id) void ipc.sessionTailStop(id);
    if (waitTimer) {
      clearInterval(waitTimer);
      waitTimer = null;
    }
    set({
      phase: "closed",
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

function applyFeed(p: SessionFeed) {
  useLive.setState((s) => {
    const base = p.reset ? emptyFeedState() : s;

    const timeline = [...base.timeline];
    const files = { ...base.files };
    const plan = { ...base.plan };
    let todos = base.todos;
    const agents = base.agents.map((a) => ({ ...a }));
    let usage = base.usage;
    let pendingTools = base.pendingTools;
    let lastEventAt = base.lastEventAt;
    let lastNote = base.lastNote;
    let lastNoteKind = base.lastNoteKind;
    const counts = { ...base.counts };

    /** toolId -> index into the timeline (only pending ones matter). */
    const pendingIdx = new Map<string, number>();
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i];
      if (e.kind === "tool" && e.toolId && e.pending) pendingIdx.set(e.toolId, i);
    }

    const push = (entry: LiveEntry) => {
      timeline.push(entry);
    };

    for (const ev of p.events) {
      if (ev.at > lastEventAt) lastEventAt = ev.at;

      switch (ev.kind) {
        case "say":
        case "think": {
          lastNote = ev.text ?? lastNote;
          lastNoteKind = ev.kind;
          push({ ...ev, id: nextId++ });
          break;
        }
        case "prompt":
        case "notify": {
          if (ev.kind === "notify") {
            // Task notification: the oldest background sub-agent still
            // running is the one that finished.
            const oldest = agents.find((a) => !a.done && a.bg);
            if (oldest) {
              oldest.done = true;
              oldest.ok = true;
              oldest.endedAt = ev.at;
            }
          }
          push({ ...ev, id: nextId++ });
          break;
        }
        case "tool": {
          const entry: LiveEntry = { ...ev, id: nextId++, pending: !!ev.toolId };
          push(entry);
          if (ev.toolId) {
            pendingIdx.set(ev.toolId, timeline.length - 1);
            pendingTools++;
          }

          // per-file aggregate
          if (ev.path && (ev.op === "edit" || ev.op === "write" || ev.op === "read")) {
            const f = files[ev.path] ?? {
              path: ev.path,
              edits: 0,
              writes: 0,
              reads: 0,
              added: 0,
              removed: 0,
              lastAt: 0,
              lastOp: ev.op,
            };
            if (ev.op === "edit") f.edits++;
            else if (ev.op === "write") f.writes++;
            else f.reads++;
            f.added += ev.added ?? 0;
            f.removed += ev.removed ?? 0;
            f.lastAt = ev.at;
            f.lastOp = ev.op;
            if (ev.side) f.side = true;
            files[ev.path] = f;
          }

          if (ev.op === "edit" || ev.op === "write") counts.edits++;
          else if (ev.op === "read") counts.reads++;
          else if (ev.op === "run") counts.runs++;
          else if (ev.op === "search") counts.searches++;

          // kanban
          if (ev.op === "agent" && ev.toolId) {
            agents.push({
              toolId: ev.toolId,
              agentType: ev.agentType ?? null,
              detail: ev.detail ?? null,
              startedAt: ev.at,
              done: false,
            });
          } else if (ev.op === "plan") {
            if (ev.tool === "TaskCreate" && ev.toolId) {
              plan[ev.toolId] = {
                key: ev.toolId,
                subject: ev.detail ?? "tarefa",
                status: "pending",
                at: ev.at,
              };
            } else if (ev.tool === "TaskUpdate" && ev.taskId) {
              const card = plan[ev.taskId];
              if (ev.status === "deleted") {
                delete plan[ev.taskId];
              } else {
                plan[ev.taskId] = {
                  key: ev.taskId,
                  subject: ev.detail ?? card?.subject ?? `tarefa #${ev.taskId}`,
                  status:
                    (ev.status as PlanCard["status"] | undefined) ??
                    card?.status ??
                    "pending",
                  at: card?.at ?? ev.at,
                };
              }
            }
          } else if (ev.op === "todo" && ev.todos) {
            todos = ev.todos;
          }
          break;
        }
        case "result": {
          if (!ev.toolId) break;
          const idx = pendingIdx.get(ev.toolId);
          if (idx != null) {
            const t = timeline[idx];
            timeline[idx] = {
              ...t,
              pending: false,
              failed: ev.ok === false,
            };
            pendingIdx.delete(ev.toolId);
            if (pendingTools > 0) pendingTools--;
          }
          // TaskCreate returns "Task #N created" — swap the provisional key.
          if (ev.taskId && plan[ev.toolId]) {
            const card = plan[ev.toolId];
            delete plan[ev.toolId];
            plan[ev.taskId] = { ...card, key: ev.taskId };
          }
          const agent = agents.find((a) => a.toolId === ev.toolId && !a.done);
          if (agent) {
            const bg =
              ev.ok !== false && /background|segundo plano/i.test(ev.text ?? "");
            if (bg) {
              agent.bg = true;
            } else {
              agent.done = true;
              agent.ok = ev.ok !== false;
              agent.endedAt = ev.at;
            }
          }
          break;
        }
        case "usage": {
          usage = {
            model: ev.model ?? usage.model,
            inTokens: ev.inTokens ?? usage.inTokens,
            outTokens: ev.outTokens ?? usage.outTokens,
            cacheRead: ev.cacheRead ?? usage.cacheRead,
            cacheWrite: ev.cacheWrite ?? usage.cacheWrite,
            costUsd: ev.costUsd ?? usage.costUsd,
          };
          break;
        }
      }
    }

    if (timeline.length > TIMELINE_CAP) {
      timeline.splice(0, timeline.length - TIMELINE_CAP);
    }

    return {
      timeline,
      files,
      plan,
      todos,
      agents,
      usage,
      pendingTools,
      lastEventAt,
      lastNote,
      lastNoteKind,
      counts,
      phase: p.live ? "live" : s.phase === "closed" ? s.phase : "backfill",
    };
  });
}
