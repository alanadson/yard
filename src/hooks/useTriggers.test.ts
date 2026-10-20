/**
 * A trigger is an automatic sender, and it goes through the same door as the
 * others now: its prompt waits in the native queue, where the scheduler's
 * admission (`automationMaxAgents`) and the automation pause apply, instead
 * of being typed straight into the target the moment it went quiet. Nothing
 * on screen shows the difference between the two paths; only this does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  writePty: vi.fn(async () => undefined),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
}));

vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: vi.fn() }));

import { setPrefsTransport } from "../lib/prefs";
import { useAutomation } from "../stores/automationStore";
import { useProjects } from "../stores/projectsStore";
import { useQueue } from "../stores/queueStore";
import { fireBudgetEdge } from "./useTriggers";

let restore: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
  ipcMock.writePty.mockClear();
  restore?.();
  restore = setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async () => undefined,
    patchQueue: async (_before, after) => [...after],
  });
  useQueue.setState({ items: [], error: null });
  useAutomation.setState({ paused: null, suppressed: null });
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
});

/** A board with Codex and a trigger "when the budget blows, ask Codex to stop". */
function seed() {
  const s = useProjects.getState();
  const board = s.addBoard("Quadro");
  const target = s.addTerminal({ groupId: board, title: "Codex", kind: "agent", program: "codex.exe", cwd: "C:/p" });
  s.updateCanvas(board, (c) => ({
    ...c,
    triggers: [
      {
        id: "t1",
        sourceId: "*",
        event: "budget",
        action: { kind: "ask", targetId: target, text: "pare e resuma" },
        enabled: true,
        createdAt: 0,
      },
    ],
  }));
  return { board, target };
}

describe("a trigger's ask", () => {
  it("waits in the target's queue, tagged as a trigger, instead of being typed in", async () => {
    const { target } = seed();

    fireBudgetEdge("over");

    await vi.waitFor(() => expect(useQueue.getState().listFor(target)).toHaveLength(1));
    expect(useQueue.getState().listFor(target)[0]).toMatchObject({ source: "trigger", text: "pare e resuma" });
    expect(ipcMock.writePty).not.toHaveBeenCalled();
  });

  it("is held while automation is paused, and the trigger is not spent", () => {
    const { board, target } = seed();
    useAutomation.setState({ paused: { reason: "budget", at: 1 } });

    fireBudgetEdge("over");

    expect(useQueue.getState().listFor(target)).toEqual([]);
    expect(useProjects.getState().layoutOf(board).canvas?.triggers?.[0].lastRunAt).toBeUndefined();
  });
});
