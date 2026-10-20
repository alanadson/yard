/** A failed native status read must keep the last known routine execution visible. */
import { beforeEach, expect, it, vi } from "vitest";
import { useRoutineExecutions } from "./routinesStore";
import type { RoutineExecution } from "../lib/routineExecution";

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { routineSnapshot: api.read } }));

beforeEach(() => { api.read.mockReset(); useRoutineExecutions.setState({ items: [], error: null, loading: false }); });

it("reuses unchanged routine results without confusing the same routine id in different groups", async () => {
  const first: RoutineExecution = {
    groupId: "first", routineId: "review", queueId: "first-occurrence", status: "queued", scheduledAt: 61_000, lastRunAt: null,
    routine: { id: "review", terminalId: "agent", text: "Review", enabled: true, everyMin: 1, createdAt: 1_000 },
  };
  const second: RoutineExecution = { ...first, groupId: "second", queueId: "second-occurrence" };
  api.read.mockResolvedValue([first, second]);
  await useRoutineExecutions.getState().load();
  const before = useRoutineExecutions.getState().items;
  api.read.mockResolvedValue(structuredClone([first, second]));
  await useRoutineExecutions.getState().load();
  expect(useRoutineExecutions.getState().items).toBe(before);

  api.read.mockResolvedValue([structuredClone(first), { ...second, status: "delivered", lastRunAt: 62_000 }]);
  await useRoutineExecutions.getState().load();
  expect(useRoutineExecutions.getState().items[0]).toBe(before[0]);
  expect(useRoutineExecutions.getState().items[1].status).toBe("delivered");
});

it("preserves the last native execution on read failure and clears the error after recovery", async () => {
  const record = { groupId: "group", routineId: "reminder", routine: { id: "reminder", terminalId: "agent", text: "Review", enabled: true, everyMin: 1, createdAt: 1000 },
    status: "delivered", scheduledAt: 61000, lastRunAt: 62000, queueId: "occurrence" };
  api.read.mockResolvedValueOnce([record]);
  await useRoutineExecutions.getState().load();
  api.read.mockRejectedValueOnce(new Error("Database unavailable"));
  await useRoutineExecutions.getState().load();
  expect(useRoutineExecutions.getState().items).toEqual([record]);
  expect(useRoutineExecutions.getState().error).toBe("Database unavailable");
  api.read.mockResolvedValueOnce([]);
  await useRoutineExecutions.getState().load();
  expect(useRoutineExecutions.getState().items).toEqual([]);
  expect(useRoutineExecutions.getState().error).toBeNull();
});
