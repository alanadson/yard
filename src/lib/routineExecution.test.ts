/** Routine status must distinguish scheduling from confirmed delivery and ignore obsolete definitions. */
import { expect, it } from "vitest";
import { effectiveRoutine } from "./routineExecution";
import type { RoutineDef } from "./canvas";
import * as rules from "./routineExecution";

it("rearms a one-time routine with a fresh deadline and discards its previous delivery clock", () => {
  const routine: RoutineDef = { id: "reminder", terminalId: "agent", text: "Review", everyMin: 1, enabled: false, once: true, createdAt: 1000, lastRunAt: 62000 };
  expect(rules.setRoutineEnabled(routine, true, 200000)).toEqual({ id: "reminder", terminalId: "agent", text: "Review", everyMin: 1, enabled: true, once: true, createdAt: 200000 });
  expect(rules.setRoutineEnabled(routine, false, 200000)).toEqual(routine);
});

it("projects a completed one-time occurrence without changing its saved definition", () => {
  const routine: RoutineDef = { id: "reminder", terminalId: "agent", text: "Review the work", everyMin: 1, enabled: true, once: true, createdAt: 1000 };
  const report = { groupId: "group", routineId: routine.id, routine, status: "delivered" as const, scheduledAt: 61000, lastRunAt: 62000, queueId: "occurrence" };
  expect(effectiveRoutine("group", routine, [report])).toMatchObject({ enabled: false, lastRunAt: 62000, executionStatus: "delivered" });
  expect(routine.enabled).toBe(true);
  expect(effectiveRoutine("other-group", routine, [report])).toEqual(routine);
  expect(effectiveRoutine("group", { ...routine, text: "A different request" }, [report])).toEqual({ ...routine, text: "A different request" });
});

it("describes a delivered reminder as completed while a repeating routine keeps its next schedule", () => {
  const routine: RoutineDef = { id: "reminder", terminalId: "agent", text: "Review", everyMin: 1, enabled: false, once: true, createdAt: 1000 };
  expect(rules.routineExecutionView({ ...routine, executionStatus: "delivered" })).toEqual({ label: " · entregue", message: "Lembrete entregue." });
  expect(rules.routineExecutionView({ ...routine, once: false, enabled: true, executionStatus: "delivered" })).toEqual({ label: "", message: null });
});

/** Switching on a routine an agent created is the user's approval of it. */
it("switching a routine on approves one an agent created, and it stays approved when paused again", () => {
  const routine: RoutineDef = { id: "r", terminalId: "agent", text: "Review", everyMin: 30, enabled: false, createdAt: 1000, awaitingApproval: true };
  const on = rules.setRoutineEnabled(routine, true, 200000);
  expect(on.enabled).toBe(true);
  expect(on.awaitingApproval).toBeUndefined();
  expect(rules.setRoutineEnabled(on, false, 300000).awaitingApproval).toBeUndefined();
});
