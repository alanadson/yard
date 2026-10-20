/** An older hook snapshot must never unlock a terminal currently waiting on permission. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as nativeHooks from "./nativeHooks";
import { useTerminals } from "../stores/terminalsStore";
import { useProjects } from "../stores/projectsStore";
import { sendability } from "./sendable";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2000); useTerminals.setState({ byId: {} }); useTerminals.getState().markRunning("agent", 42); });
afterEach(() => vi.useRealTimers());

it("keeps the newest permission when an older native hook snapshot arrives late", () => {
  const receiver = nativeHooks.createNativeHookReceiver();
  expect(receiver.accept({ terminalId: "agent", sequence: 2, event: { kind: "permission", ask: "Allow this edit?" } })).toBe(true);
  expect(receiver.accept({ terminalId: "agent", sequence: 1, event: { kind: "turn-end" } })).toBe(false);
  expect(useTerminals.getState().byId.agent.blocked).toBe(true);
  expect(useTerminals.getState().byId.agent.blockedAsk).toBe("Allow this edit?");
  expect(receiver.accept({ terminalId: "agent", sequence: 3, event: { kind: "turn-end" } })).toBe(true);
  expect(useTerminals.getState().byId.agent.blocked).toBe(false);
});

it("keeps a native permission when the same live process attaches after its boot snapshot", () => {
  nativeHooks.createNativeHookReceiver().accept({ terminalId: "agent", sequence: 2, event: { kind: "permission", ask: "Allow this edit?" } });
  useTerminals.getState().markRunning("agent", 42);
  expect(useTerminals.getState().byId.agent.blocked).toBe(true);
  expect(useTerminals.getState().byId.agent.permission).toBe(true);
  expect(useTerminals.getState().byId.agent.blockedAsk).toBe("Allow this edit?");
  useTerminals.getState().markRunning("agent", 43);
  expect(useTerminals.getState().byId.agent.blocked).toBe(false);
});

it("refuses automatic input when a native hook reports work despite a long output silence", () => {
  useProjects.setState({ terminals: [{ id: "agent", groupId: "group", title: "Agent", cwd: "C:/repo", program: "claude", args: [], kind: "agent", slot: 0, sort: 0, createdAt: 1000, alive: true }] });
  nativeHooks.createNativeHookReceiver().accept({ terminalId: "agent", sequence: 1, event: { kind: "turn-start" } });
  expect(sendability("agent", 100000).reason).toBe("busy");
});

it("shows ongoing work after a tool hook follows an earlier permission", () => {
  const receiver = nativeHooks.createNativeHookReceiver();
  receiver.accept({ terminalId: "agent", sequence: 1, event: { kind: "permission", ask: "Allow this edit?" } });
  receiver.accept({ terminalId: "agent", sequence: 2, event: { kind: "working" } });
  expect(useTerminals.getState().byId.agent.finished).toBe(false);
  expect(useTerminals.getState().byId.agent.blocked).toBe(false);
});

it("preserves a hook received during startup when the new process id becomes known", () => {
  useTerminals.getState().markStarting("agent");
  nativeHooks.createNativeHookReceiver().accept({ terminalId: "agent", sequence: 1, event: { kind: "permission", ask: "Allow this edit?" } });
  useTerminals.getState().markRunning("agent", 43);
  expect(useTerminals.getState().byId.agent.blocked).toBe(true);
  expect(useTerminals.getState().byId.agent.hookPhase).toBe("permission");
});

it("keeps native work and permission authoritative over a silent terminal heuristic", () => {
  expect(nativeHooks.inferredIdleOutcome("working", null, "Done")).toEqual({ kind: "working" });
  expect(nativeHooks.inferredIdleOutcome("permission", "Allow this edit?", "Done")).toEqual({ kind: "permission", ask: "Allow this edit?" });
  expect(nativeHooks.inferredIdleOutcome(undefined, null, "Done")).toEqual({ kind: "finished" });
});

it("keeps the original completion instant when a native snapshot is restored later", () => {
  nativeHooks.createNativeHookReceiver().accept({ terminalId: "agent", sequence: 1, at: 1000, event: { kind: "turn-end" } });
  expect(useTerminals.getState().byId.agent.finishedAt).toBe(1000);
});

it("keeps the native completion instant when a later idle observation confirms it", () => {
  nativeHooks.createNativeHookReceiver().accept({ terminalId: "agent", sequence: 1, at: 1000, event: { kind: "turn-end" } });
  nativeHooks.applyInferredIdle("agent", "Completed the edit.");
  expect(useTerminals.getState().byId.agent.finishedAt).toBe(1000);
});
