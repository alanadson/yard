/**
 * What the status bar says — the numbers, and the words around them.
 *
 * The bar is chrome that reads the whole workspace at once, so every reading
 * here is a reduction over a store the rest of the app consults one row at a
 * time. Kept out of the JSX because each one has a rule that is easy to get
 * subtly wrong: a blocked agent is *also* `finished`; an exited process still
 * has a row; a finished flow keeps its record until cleared.
 */
import type { ChangesSummary, TerminalRow } from "../../lib/ipc";
import type { FlowRun } from "../../stores/flowStore";
import { isLive, type TerminalRuntime } from "../../stores/terminalsStore";

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export type AgentTone = "waiting" | "running" | "finished";

export interface AgentSegment {
  tone: AgentTone;
  count: number;
  /** Count and word, ready to paint: "1 esperando você", "3 rodando". */
  label: string;
}

function agentLabel(tone: AgentTone, count: number): string {
  switch (tone) {
    case "waiting":
      return `${count} esperando você`;
    case "running":
      return `${count} rodando`;
    case "finished":
      return count === 1 ? "1 terminou" : `${count} terminaram`;
  }
}

/**
 * One segment per tone with a non-zero count, **waiting first**: the one
 * that costs dead time leads, the same order `jumpToAttention` walks.
 *
 * Only live processes count. `finished` is a latch released by focusing the
 * pane, so a finished-and-read agent is back to plain "rodando" — which is
 * what its green dot says everywhere else.
 */
export function agentSegments(
  rows: readonly TerminalRow[],
  byId: Readonly<Record<string, TerminalRuntime | undefined>>,
): AgentSegment[] {
  const counts: Record<AgentTone, number> = { waiting: 0, running: 0, finished: 0 };
  for (const row of rows) {
    const rt = byId[row.id];
    if (!isLive(rt)) continue;
    if (rt!.blocked) counts.waiting++;
    else if (rt!.finished) counts.finished++;
    else counts.running++;
  }
  return (["waiting", "running", "finished"] as const)
    .filter((tone) => counts[tone] > 0)
    .map((tone) => ({ tone, count: counts[tone], label: agentLabel(tone, counts[tone]) }));
}

/**
 * The chip's accessible name — and its visible words when there is nobody:
 * with segments, "Agentes: 1 esperando você, 2 rodando"; with no live
 * process on any floor, just the name. An empty bar is not news, and a
 * sentence about it ("nenhum agente rodando") reads like a complaint.
 */
export function agentsCaption(segments: readonly AgentSegment[]): string {
  if (segments.length === 0) return "Agentes";
  return `Agentes: ${segments.map((s) => s.label).join(", ")}`;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export interface GitChip {
  /** Branch name, or the SCM tab's words for a detached HEAD. */
  branch: string;
  detached: boolean;
  changed: number;
  additions: number;
  deletions: number;
  /** `additions` is a floor: the backend stopped counting new files. */
  partial: boolean;
  label: string;
}

/** `null` when there is nothing to say: no summary yet, or not a repository. */
export function gitChip(summary: ChangesSummary | undefined): GitChip | null {
  if (!summary || !summary.isRepo) return null;
  const changed = summary.files.length;
  return {
    branch: summary.branch ?? "HEAD solto",
    detached: summary.branch === null,
    changed,
    additions: summary.additions,
    deletions: summary.deletions,
    partial: summary.uncounted > 0,
    label:
      changed === 0 ? "sem alterações" : changed === 1 ? "1 alterado" : `${changed} alterados`,
  };
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------

export interface FlowChip {
  /** Runs still walking. */
  count: number;
  /** The run the chip points at — the oldest one still walking. */
  groupId: string;
  flowId: string;
  name: string;
  step: number;
  total: number;
  label: string;
}

/** `null` when no run is walking — a finished run is a record, not news. */
export function flowChip(runs: readonly FlowRun[]): FlowChip | null {
  const live = runs.filter((r) => !r.finishedAt).sort((a, b) => a.startedAt - b.startedAt);
  const first = live[0];
  if (!first) return null;
  const total = first.stages.length;
  const step = Math.min(first.current + 1, total);
  return {
    count: live.length,
    groupId: first.groupId,
    flowId: first.flowId,
    name: first.name,
    step,
    total,
    label:
      live.length === 1
        ? `${first.name} · etapa ${step}/${total}`
        : `${live.length} fluxos em andamento`,
  };
}
