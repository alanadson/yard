/** Reviewing a correction must keep the earlier evidence available without duplicating the current report. */
import { expect, it } from "vitest";
import { canCancelWork, previousDeliveries, taskTimelineDetail, taskTimelineText, validationResultLabel, workQueueAction, workExecutionLabel } from "./workReview";

it("names a pipeline start as a pipeline action rather than a queued delivery", () => {
  expect(workExecutionLabel("enqueue", true)).toBe("Iniciar fluxo da tarefa");
});

it("keeps interrupted pipeline work out of the direct resend action", () => {
  expect(workQueueAction({ status: "blocked", links: { projectId: null, terminalIds: ["agent"], executionId: "pipeline-attempt" } })).toBeNull();
});

it("shows a linked review reference without exposing its serialized transport fields", () => {
  expect(taskTimelineText({ kind: "linked", detail: JSON.stringify({ kind: "diff", id: "src/api.ts", root: "C:/repo", label: "API change" }) }, {}, (text) => text)).toBe("API change: src/api.ts");
});

it("shows prior reports for the selected task while its newest report stays in the current delivery", () => {
  const first = { taskId: "task-1", revision: 4, at: 4000, recovered: false,
    delivery: { summary: "First report", artifacts: ["first-proof.txt"], checks: [] },
    criteria: [{ id: "criterion-1", text: "Preserve callers", evidence: ["first-proof.txt"] }] };
  const latest = { ...first, revision: 6, at: 6000, delivery: { ...first.delivery, summary: "Corrected report" } };
  const unrelated = { ...first, taskId: "task-2", revision: 8 };
  expect(previousDeliveries("task-1", [latest, unrelated, first])).toEqual([first]);
});

it("keeps a failed historical validation visibly different from a passing one", () => {
  expect(validationResultLabel(false)).toBe("Falhou");
  expect(validationResultLabel(true)).toBe("Passou");
});

it("offers explicit resend of interrupted work through its current executor instead of a former participant", () => {
  const task = { status: "blocked", links: { projectId: null, terminalIds: ["former", "current"], executorTerminalId: "current" } };
  expect(workQueueAction(task)).toEqual({ type: "resend", terminalId: "current" });
  expect(workQueueAction({ ...task, status: "running" })).toBeNull();
  expect(workQueueAction({ ...task, status: "in_review" })).toBeNull();
});

it("requires selecting an available executor when the previous task executor was removed", () => {
  const task = { status: "blocked", links: { projectId: null, terminalIds: ["former", "removed"], executorTerminalId: "removed" } };
  expect(workQueueAction(task, ["former", "other"])).toEqual({ type: "resend", terminalId: "", terminalMissing: true });
});

it("shows the executor's name in execution events without treating the name as a task status", () => {
  const names = { executor: "completed" };
  const translate = (text: string) => `Translated: ${text}`;
  expect(taskTimelineText({ kind: "started", detail: "executor" }, names, translate)).toBe("completed");
  expect(taskTimelineText({ kind: "submitted", detail: "executor" }, names, translate)).toBe("executor");
});

it("explains an application restart while preserving the agent's own report text", () => {
  expect(taskTimelineDetail({ kind: "interrupted", detail: "app_restarted" })).toEqual({ text: "O aplicativo reiniciou antes da entrega.", translated: true });
  expect(taskTimelineDetail({ kind: "submitted", detail: "Proof captured by the agent" })).toEqual({ text: "Proof captured by the agent", translated: false });
});

it("explains why lost queued work needs review before an explicit resend", () => {
  expect(taskTimelineDetail({ kind: "interrupted", detail: "queue_missing" })).toEqual({
    text: "O prompt da tarefa não foi encontrado na fila. Confira o agente antes de reenviar.", translated: true,
  });
});

it("lets interrupted work be cancelled while keeping active executions and reviewed reports protected", () => {
  expect(canCancelWork("blocked")).toBe(true);
  expect(canCancelWork("running")).toBe(false);
  expect(canCancelWork("in_review")).toBe(false);
  expect(canCancelWork("completed")).toBe(false);
});
