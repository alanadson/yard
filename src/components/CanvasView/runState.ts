/**
 * What a flow run's row says about its state, and whether that needs a
 * clock. Only a run still going shows elapsed time; the other states are a
 * fixed word, and their rows have no reason to re-render every second.
 */
import type { FlowRun } from "../../stores/flowStore";

export type RunState =
  | { kind: "running"; since: number }
  | { kind: "failed" }
  | { kind: "cancelled" }
  | { kind: "done" };

export function runState(run: Pick<FlowRun, "startedAt" | "error" | "cancelled" | "finishedAt">): RunState {
  if (run.error) return { kind: "failed" };
  if (run.cancelled) return { kind: "cancelled" };
  if (!run.finishedAt) return { kind: "running", since: run.startedAt };
  return { kind: "done" };
}
