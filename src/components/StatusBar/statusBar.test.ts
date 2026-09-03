/**
 * The status bar is the one piece of chrome that reads the whole workspace at
 * a glance. Its numbers come from three stores that each mean something
 * different by "state": a blocked agent is *also* `finished`, an exited
 * process still has a row, a flow that ended keeps its record until someone
 * clears it. Getting any of these wrong makes the bar lie — and a bar that
 * says "3 rodando" while one of them is stuck on a question is worse than no
 * bar, because it is the question that costs dead time.
 */
import { describe, expect, it } from "vitest";

import type { ChangesSummary, TerminalRow } from "../../lib/ipc";
import type { FlowRun } from "../../stores/flowStore";
import type { TerminalRuntime } from "../../stores/terminalsStore";
import { agentSegments, agentsCaption, flowChip, gitChip } from "./statusBar";

const row = (id: string): TerminalRow => ({
  id,
  groupId: "g",
  slot: 0,
  kind: "agent",
  program: "claude",
  args: [],
  cwd: "C:\\p",
  sort: 0,
  alive: true,
  createdAt: 1,
});

const rt = (patch: Partial<TerminalRuntime>): TerminalRuntime => ({
  state: "running",
  pid: 1,
  exit: null,
  error: null,
  unread: false,
  finished: false,
  finishedAt: 0,
  blocked: false,
  blockedAsk: null,
  permission: false,
  rssMb: 0,
  cpu: 0,
  ...patch,
});

describe("agentSegments — who is doing what across the workspace", () => {
  it("a blocked agent counts as waiting, never as running — and waiting comes first", () => {
    const segments = agentSegments([row("a"), row("b")], {
      a: rt({ blocked: true, finished: true }),
      b: rt({}),
    });
    expect(segments.map((s) => [s.tone, s.count])).toEqual([
      ["waiting", 1],
      ["running", 1],
    ]);
  });

  it("finished (and not blocked) is its own count, in the announcer's words", () => {
    expect(agentSegments([row("a")], { a: rt({ finished: true }) })).toEqual([
      { tone: "finished", count: 1, label: "1 terminou" },
    ]);
    expect(
      agentSegments([row("a"), row("b")], {
        a: rt({ finished: true }),
        b: rt({ finished: true }),
      })[0].label,
    ).toBe("2 terminaram");
  });

  it("dead and never-started terminals are not on the bar", () => {
    expect(
      agentSegments([row("a"), row("b"), row("c")], {
        a: rt({ state: "exited", pid: null }),
        b: rt({ state: "error", pid: null }),
      }),
    ).toEqual([]);
  });

  it("a process still starting is already 'rodando' — the bar is about what is up", () => {
    expect(agentSegments([row("a")], { a: rt({ state: "starting", pid: null }) })).toEqual([
      { tone: "running", count: 1, label: "1 rodando" },
    ]);
  });

  it("'esperando você' does not change with the number", () => {
    const segments = agentSegments([row("a"), row("b")], {
      a: rt({ blocked: true, finished: true }),
      b: rt({ blocked: true, finished: true }),
    });
    expect(segments[0].label).toBe("2 esperando você");
  });
});

describe("agentsCaption — the chip's words, with someone to count or with nobody", () => {
  it("with nobody on any floor the chip is only its name, 'Agentes' — an empty bar is not news", () => {
    const caption = agentsCaption([]);
    expect(caption).toBe("Agentes");
    // The wordings that came before — "nenhum agente rodando", "tudo quieto" —
    // narrated an absence; a label does not need to.
    expect(caption).not.toMatch(/nenhum|quieto|rodando/i);
  });

  it("with someone on a floor the caption is every segment in one sentence, waiting first", () => {
    const segments = agentSegments([row("a"), row("b")], {
      a: rt({ blocked: true, finished: true }),
      b: rt({}),
    });
    expect(agentsCaption(segments)).toBe("Agentes: 1 esperando você, 1 rodando");
  });
});

describe("gitChip — the active project's branch", () => {
  const summary = (patch: Partial<ChangesSummary>): ChangesSummary => ({
    isRepo: true,
    branch: "main",
    files: [],
    additions: 0,
    deletions: 0,
    uncounted: 0,
    ...patch,
  });
  const file = (path: string) => ({ path }) as ChangesSummary["files"][number];

  it("no summary yet, or a folder that is not a repository: no chip", () => {
    expect(gitChip(undefined)).toBeNull();
    expect(gitChip(summary({ isRepo: false }))).toBeNull();
  });

  it("a clean tree says so instead of showing a zero", () => {
    expect(gitChip(summary({}))).toMatchObject({
      branch: "main",
      detached: false,
      changed: 0,
      label: "sem alterações",
    });
  });

  it("counts the changed files, singular and plural, with the line totals", () => {
    expect(gitChip(summary({ files: [file("a.ts")] }))?.label).toBe("1 alterado");
    expect(
      gitChip(summary({ files: [file("a.ts"), file("b.ts")], additions: 12, deletions: 4 })),
    ).toMatchObject({ changed: 2, additions: 12, deletions: 4, label: "2 alterados" });
  });

  it("a detached HEAD is named as such, in the SCM tab's words", () => {
    expect(gitChip(summary({ branch: null }))).toMatchObject({
      branch: "HEAD solto",
      detached: true,
    });
  });

  it("marks the additions as partial when the backend stopped counting", () => {
    expect(gitChip(summary({ uncounted: 3 }))?.partial).toBe(true);
    expect(gitChip(summary({}))?.partial).toBe(false);
  });
});

describe("flowChip — pipelines still walking", () => {
  const run = (patch: Partial<FlowRun>): FlowRun => ({
    flowId: "f1",
    groupId: "g",
    name: "Revisão",
    task: "",
    terminalId: "t",
    stages: [
      { label: "a", status: "done" },
      { label: "b", status: "working" },
      { label: "c", status: "pending" },
      { label: "d", status: "pending" },
    ],
    current: 1,
    brief: "",
    startedAt: 100,
    stageStartedAt: 100,
    finishedAt: null,
    error: null,
    cancelRequested: false,
    cancelled: false,
    ...patch,
  });

  it("nothing running: no chip — a finished run is a record, not news", () => {
    expect(flowChip([])).toBeNull();
    expect(flowChip([run({ finishedAt: 200 })])).toBeNull();
  });

  it("one run: its name and where it is, so the bar reads like the HUD", () => {
    expect(flowChip([run({})])).toMatchObject({
      count: 1,
      flowId: "f1",
      groupId: "g",
      step: 2,
      total: 4,
      label: "Revisão · etapa 2/4",
    });
  });

  it("several runs: the count, pointing at the oldest one still walking", () => {
    const chip = flowChip([
      run({ flowId: "f2", startedAt: 300 }),
      run({}),
      run({ flowId: "f3", finishedAt: 400 }),
    ]);
    expect(chip).toMatchObject({ count: 2, flowId: "f1", label: "2 fluxos em andamento" });
  });

  it("the step never runs past the total — `current` equals the stage count once every stage is done", () => {
    expect(flowChip([run({ current: 4 })])?.step).toBe(4);
  });
});
