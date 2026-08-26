/**
 * The feed model — what a session's events add up to: the timeline, the
 * files touched, the plan and its sub-agents, the accumulated usage.
 *
 * It was born inside `liveStore.ts` as the reducer of the "Ao Vivo" overlay.
 * It lives here, pure, because the same arithmetic answers two other
 * questions the store never asked: what an agent did while nobody was
 * looking (the "Ombro" digest, `shoulder.ts`) and what a session reads like
 * from the start (`transcript.ts`). One reducer, three readers — a second
 * copy would count a file's edits one way on the overlay and another way on
 * the digest.
 */
import { t } from "./i18n";
import type { FeedEvent, FeedTodo } from "./ipc";

export interface LiveEntry extends FeedEvent {
  id: number;
  pending?: boolean;
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
  side?: boolean;
}

export interface PlanCard {
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

export const EMPTY_USAGE: LiveUsage = {
  model: null,
  inTokens: 0,
  outTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
};

export interface FeedModel {
  timeline: LiveEntry[];
  files: Record<string, LiveFile>;
  plan: Record<string, PlanCard>;
  todos: FeedTodo[];
  agents: AgentCard[];
  usage: LiveUsage;
  pendingTools: number;
  lastEventAt: number;
  lastNote: string | null;
  lastNoteKind: "say" | "think" | null;
  counts: { edits: number; reads: number; runs: number; searches: number };
}

/** The overlay keeps the tail of the timeline: enough to scroll, never a leak. */
export const TIMELINE_CAP = 400;

export function emptyFeedModel(): FeedModel {
  return {
    timeline: [],
    files: {},
    plan: {},
    todos: [],
    agents: [],
    usage: { ...EMPTY_USAGE },
    pendingTools: 0,
    lastEventAt: 0,
    lastNote: null,
    lastNoteKind: null,
    counts: { edits: 0, reads: 0, runs: 0, searches: 0 },
  };
}

/** Where timeline ids come from — the caller owns the sequence. */
export interface EntryIds {
  next: () => number;
}

/** A private sequence for callers that never share a timeline (the digest). */
export function localIds(): EntryIds {
  let n = 1;
  return { next: () => n++ };
}

/**
 * Folds a batch of events into the model. Pure: returns a new model, never
 * touches `base`.
 *
 * `cap` bounds the timeline; pass `Infinity` to keep every entry (the
 * transcript wants all of them, the overlay only the recent ones).
 */
export function reduceFeed(
  base: FeedModel,
  events: readonly FeedEvent[],
  ids: EntryIds,
  cap: number = TIMELINE_CAP,
): FeedModel {
  const timeline = [...base.timeline];
  const files = { ...base.files };
  const plan = { ...base.plan };
  let all = base.todos;
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

  for (const ev of events) {
    if (ev.at > lastEventAt) lastEventAt = ev.at;

    switch (ev.kind) {
      case "say":
      case "think": {
        lastNote = ev.text ?? lastNote;
        lastNoteKind = ev.kind;
        push({ ...ev, id: ids.next() });
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
        push({ ...ev, id: ids.next() });
        break;
      }
      case "tool": {
        const entry: LiveEntry = { ...ev, id: ids.next(), pending: !!ev.toolId };
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
                subject: ev.detail ?? card?.subject ?? t("tarefa #{id}", { id: ev.taskId }),
                status:
                  (ev.status as PlanCard["status"] | undefined) ??
                  card?.status ??
                  "pending",
                at: card?.at ?? ev.at,
              };
            }
          }
        } else if (ev.op === "todo" && ev.todos) {
          // An empty `TodoWrite` is how a CLI *clears* its list — which is
          // exactly what it does when the work is finished. Taking it
          // literally made the board vanish at the moment it had the most
          // to say ("everything done"), so the last list with content stays
          // on screen; the next real plan replaces it.
          if (ev.todos.length > 0) all = ev.todos;
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
          const bg = ev.ok !== false && /background|segundo plano/i.test(ev.text ?? "");
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

  if (Number.isFinite(cap) && timeline.length > cap) {
    timeline.splice(0, timeline.length - cap);
  }

  return {
    timeline,
    files,
    plan,
    todos: all,
    agents,
    usage,
    pendingTools,
    lastEventAt,
    lastNote,
    lastNoteKind,
    counts,
  };
}
