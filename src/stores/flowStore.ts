/**
 * Runtime state of flow runs (Flow mode) — which pipeline is walking, in
 * which CLI, which stage holds the baton, how each one ended. The definitions
 * live on the canvas (`flow` items).
 *
 * Written by the engine (`lib/flowRun.ts`), read by the cards, the flow
 * card and the HUD. `marks` is the same information pivoted by terminal —
 * the executing card needs "how am I doing" in O(1) on every render.
 *
 * **Live runs are written to `kv`.** This used to be memory-only, on the
 * reasoning that "after a reload the PTY it was watching is a new one" — which
 * is false: the PTY belongs to the backend and survives F5/HMR (that is what
 * `reconcileAliveFlags` reconciles). Only the engine's loop dies, and the run
 * disappeared with it: no stamp for the next stage, no HUD, no error, while
 * the agent kept working. The record is what lets `restore` come back and say
 * so. It is deliberately *not* a resume: the engine walks a copy of the
 * pipeline with a byte baseline of its own, and pretending to pick that up
 * mid-stage would risk stamping a stage twice into a live CLI. Saying the
 * truth loudly beats both the silence and a wrong guess.
 */
import { create } from "zustand";

import { persistJsonPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";
import { uiLog } from "../lib/log";

export type FlowStageStatus =
  | "pending"
  | "waiting" // its turn arrived; waiting for the CLI to be ready
  | "working"
  | "blocked" // stopped at a question only the user can answer
  | "done"
  | "error";

export interface FlowRunStage {
  /** What the chips call this stage (the user's title or "Etapa n"). */
  label: string;
  status: FlowStageStatus;
}

export interface FlowRun {
  /** Canvas item id of the flow card. */
  flowId: string;
  groupId: string;
  name: string;
  task: string;
  /** The wired CLI executing every stage of this run. */
  terminalId: string;
  /**
   * Terminal that asked for this run (`yard flow run`). The final summary is
   * delivered back into it when it is not the executor itself.
   */
  callerId?: string;
  stages: FlowRunStage[];
  /** Index of the stage holding the baton; `stages.length` when all done. */
  current: number;
  /**
   * The current stage's full briefing (instructions, task, carry, summary
   * contract), written by the engine right before it stamps the CLI. It is
   * what `yard flow stage` answers — the prompt gets the stamp, the agent
   * fetches the letter here.
   */
  brief: string;
  startedAt: number;
  stageStartedAt: number;
  /** Set when the run stopped for any reason (done, error, cancelled). */
  finishedAt: number | null;
  error: string | null;
  /** Raised by the user/CLI; the engine notices on its next tick. */
  cancelRequested: boolean;
  cancelled: boolean;
}

/** How the executing terminal's card wears the run. */
export interface FlowMark {
  name: string;
  step: number;
  total: number;
  status: FlowStageStatus;
}

interface FlowsState {
  /** By flow (item) id — one live (or lingering finished) run per flow. */
  runs: Record<string, FlowRun>;
  /** terminalId -> mark of the run executing there. Derived on every write. */
  marks: Record<string, FlowMark>;

  begin: (run: FlowRun) => void;
  patchRun: (flowId: string, patch: Partial<FlowRun>) => void;
  setStage: (flowId: string, index: number, status: FlowStageStatus) => void;
  requestCancel: (flowId: string) => void;
  /** Dismisses a finished run (the HUD's ×). Live runs stay. */
  clear: (flowId: string) => void;
  /**
   * Brings back what was walking when the webview went away, as an
   * **interrupted** run — see the note at the top of the file.
   */
  restore: (prefs?: PrefsSnapshot) => Promise<void>;
}

const KV_RUNS = "flow.runs";

/** Never trust the saved format: a crooked row disappears, the rest lives. */
export function parseStoredRuns(raw: string | undefined): FlowRun[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.flatMap((item) => {
      const r = item as Partial<FlowRun>;
      if (typeof r?.flowId !== "string" || typeof r.groupId !== "string") return [];
      if (typeof r.terminalId !== "string" || !Array.isArray(r.stages)) return [];
      const stages = r.stages.flatMap((s) =>
        s && typeof s.label === "string" && typeof s.status === "string"
          ? [{ label: s.label, status: s.status as FlowStageStatus }]
          : [],
      );
      if (!stages.length) return [];
      return [
        {
          flowId: r.flowId,
          groupId: r.groupId,
          name: typeof r.name === "string" ? r.name : "Fluxo",
          task: typeof r.task === "string" ? r.task : "",
          terminalId: r.terminalId,
          ...(typeof r.callerId === "string" ? { callerId: r.callerId } : {}),
          stages,
          current: typeof r.current === "number" ? r.current : 0,
          brief: typeof r.brief === "string" ? r.brief : "",
          startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
          stageStartedAt: typeof r.stageStartedAt === "number" ? r.stageStartedAt : 0,
          finishedAt: typeof r.finishedAt === "number" ? r.finishedAt : null,
          error: typeof r.error === "string" ? r.error : null,
          cancelRequested: r.cancelRequested === true,
          cancelled: r.cancelled === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * The message a run that did not survive the reload wears. It names what the
 * agent is doing on the other side, because the process is still there and the
 * user is the only one who can pick the work back up.
 */
// Kept Portuguese on purpose: it is a *marker* — persisted in the run, compared
// by identity at boot — so the render site says `t(run.error)`; the English
// line lives in `i18n/en/stores.ts` under this exact text.
export const INTERRUPTED =
  "a interface foi recarregada no meio da esteira — as etapas seguintes não " + // i18n-ok
  "foram enviadas. A CLI continua com o que já recebeu; rode o fluxo de novo " + // i18n-ok
  "a partir daqui se ainda fizer sentido.";

/** Marks a run the engine can no longer be walking. */
function interrupt(run: FlowRun, now: number): FlowRun {
  const i = Math.min(Math.max(run.current, 0), run.stages.length - 1);
  return {
    ...run,
    stages: run.stages.map((s, idx) =>
      idx === i && s.status !== "done" ? { ...s, status: "error" } : s,
    ),
    finishedAt: now,
    error: INTERRUPTED,
  };
}

function markOf(run: FlowRun): FlowMark {
  const i = Math.min(run.current, run.stages.length - 1);
  const cur = run.stages[i];
  const status: FlowStageStatus = run.error
    ? "error"
    : run.finishedAt && !run.cancelled
      ? "done"
      : (cur?.status ?? "pending");
  return {
    name: run.name,
    step: Math.min(run.current + 1, run.stages.length),
    total: run.stages.length,
    status,
  };
}

function deriveMarks(runs: Record<string, FlowRun>): Record<string, FlowMark> {
  const marks: Record<string, FlowMark> = {};
  for (const run of Object.values(runs)) {
    if (run.stages.length) marks[run.terminalId] = markOf(run);
  }
  return marks;
}

export const useFlows = create<FlowsState>((set, get) => {
  const write = (runs: Record<string, FlowRun>) => {
    set({ runs, marks: deriveMarks(runs) });
    // Only what is still walking: a finished run has nothing to rescue, and
    // the record is read exactly once, at boot.
    persistJsonPref(
      KV_RUNS,
      Object.values(runs).filter((r) => !r.finishedAt),
      (error) => uiLog.warn(`não consegui guardar o estado do fluxo: ${error}`),
    );
  };

  return {
    runs: {},
    marks: {},

    begin: (run) => write({ ...get().runs, [run.flowId]: run }),

    patchRun: (flowId, patch) => {
      const cur = get().runs[flowId];
      if (!cur) return;
      write({ ...get().runs, [flowId]: { ...cur, ...patch } });
    },

    setStage: (flowId, index, status) => {
      const cur = get().runs[flowId];
      if (!cur || !cur.stages[index] || cur.stages[index].status === status) return;
      const stages = cur.stages.map((s, i) => (i === index ? { ...s, status } : s));
      write({ ...get().runs, [flowId]: { ...cur, stages } });
    },

    requestCancel: (flowId) => {
      const cur = get().runs[flowId];
      if (!cur || cur.finishedAt) return;
      write({ ...get().runs, [flowId]: { ...cur, cancelRequested: true } });
    },

    clear: (flowId) => {
      const cur = get().runs[flowId];
      if (!cur || !cur.finishedAt) return;
      const runs = { ...get().runs };
      delete runs[flowId];
      write(runs);
    },

    restore: async (prefs) => {
      let raw: PrefsSnapshot;
      try {
        raw = prefs ?? (await readPrefs());
      } catch (e) {
        uiLog.warn(`não consegui ler os fluxos em andamento: ${e}`);
        return;
      }
      // Anything still marked as walking was walking when the webview went
      // away — the engine that was driving it does not exist any more.
      const orphans = parseStoredRuns(raw[KV_RUNS]).filter((r) => !r.finishedAt);
      if (!orphans.length) return;

      const now = Date.now();
      const runs = { ...get().runs };
      for (const run of orphans) {
        // A run started after the boot read wins: it has a live engine.
        if (runs[run.flowId]) continue;
        runs[run.flowId] = interrupt(run, now);
        uiLog.warn(`fluxo "${run.name}": interrompido por um reload da interface`);
      }
      write(runs);
    },
  };
});

/** Is any *live* run using this terminal? The engine's double-booking guard. */
export function terminalBusyInFlow(terminalId: string): FlowRun | undefined {
  return Object.values(useFlows.getState().runs).find(
    (r) => !r.finishedAt && r.terminalId === terminalId,
  );
}
