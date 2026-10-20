/**
 * The pause is shared state between this window and the native scheduler,
 * and the kv key is the only channel between them: a pause that lives only in
 * memory stops the front end's senders and leaves the queue and the routines
 * running in Rust. So every change here has to reach `automation.paused`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  writePref: vi.fn(async (_key: string, _value: string) => undefined),
}));

vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));

import { KV_AUTOMATION_PAUSED, KV_PAUSE_SUPPRESSED } from "../lib/automationPause";
import { useAutomation } from "./automationStore";
import { DEFAULT_PREFS, useUI } from "./uiStore";

const NOW = new Date(2026, 9, 19, 15, 0).getTime();

beforeEach(() => {
  ipcMock.writePref.mockClear();
  useAutomation.setState({ paused: null, suppressed: null });
  useUI.setState({ prefs: { ...DEFAULT_PREFS }, toasts: [] });
});

describe("the automation pause", () => {
  it("pauses on a budget reading over the ceiling, writes the kv key and says why", async () => {
    await useAutomation.getState().observe({ budgetLevel: "over" }, NOW);

    expect(useAutomation.getState().paused).toEqual({ reason: "budget", at: NOW });
    expect(ipcMock.writePref).toHaveBeenCalledWith(KV_AUTOMATION_PAUSED, JSON.stringify({ reason: "budget", at: NOW }));
    expect(useUI.getState().toasts.map((toast) => toast.message).join(" ")).toContain("Automação pausada");
  });

  it("resuming clears the key, and the same reason does not pause again that day", async () => {
    await useAutomation.getState().observe({ budgetLevel: "over" }, NOW);
    ipcMock.writePref.mockClear();

    await useAutomation.getState().resume(NOW + 1_000);

    expect(useAutomation.getState().paused).toBeNull();
    expect(ipcMock.writePref).toHaveBeenCalledWith(KV_AUTOMATION_PAUSED, "");
    expect(ipcMock.writePref).toHaveBeenCalledWith(
      KV_PAUSE_SUPPRESSED,
      JSON.stringify({ day: "2026-10-19", reasons: ["budget"] }),
    );
    await useAutomation.getState().observe({ budgetLevel: "over" }, NOW + 60_000);
    expect(useAutomation.getState().paused).toBeNull();
  });

  it("reads a pause left by a previous run, and today's resumed reasons, at boot", () => {
    useAutomation.getState().load({
      [KV_AUTOMATION_PAUSED]: JSON.stringify({ reason: "quota", at: 1 }),
      [KV_PAUSE_SUPPRESSED]: JSON.stringify({ day: "2026-10-19", reasons: ["budget"] }),
    });

    expect(useAutomation.getState().paused).toEqual({ reason: "quota", at: 1 });
    expect(useAutomation.getState().suppressed).toEqual({ day: "2026-10-19", reasons: ["budget"] });
  });
});
