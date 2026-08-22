/**
 * A flow run is the only thing in the app that walks **on its own** after the
 * user presses the button: the engine drives the pipeline stage by stage
 * inside a CLI. That is why it cannot simply vanish.
 *
 * The regression these tests lock: the store claimed not to persist because
 * "after a reload the PTY it was watching is a new one" — and it is not. The
 * PTY is backend state and survives an F5/HMR; only the engine's loop dies. A
 * pipeline interrupted halfway turned into silence: no stamp for the next
 * stage, no HUD, no error, with the agent still working on the other side.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPrefsTransport } from "../lib/prefs";
import { useFlows, type FlowRun } from "./flowStore";

function run(patch: Partial<FlowRun> = {}): FlowRun {
  return {
    flowId: "f1",
    groupId: "g1",
    name: "Revisar e testar",
    task: "arrumar o parser",
    terminalId: "t1",
    stages: [
      { label: "Planejar", status: "done" },
      { label: "Executar", status: "working" },
      { label: "Revisar", status: "pending" },
    ],
    current: 1,
    brief: "carta da etapa 2",
    startedAt: 1_000,
    stageStartedAt: 2_000,
    finishedAt: null,
    error: null,
    cancelRequested: false,
    cancelled: false,
    ...patch,
  };
}

let written: Record<string, string>;

beforeEach(() => {
  written = {};
  setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      written[key] = value;
    },
  });
  useFlows.setState({ runs: {}, marks: {} });
});

describe("the run survives a reload", () => {
  it("a live run is written as soon as it starts", async () => {
    useFlows.getState().begin(run());
    await vi.waitFor(() => expect(written["flow.runs"]).toBeDefined());

    const stored = JSON.parse(written["flow.runs"]);
    expect(stored).toHaveLength(1);
    expect(stored[0].flowId).toBe("f1");
    expect(stored[0].current).toBe(1);
  });

  it("a finished run does not linger in the record", async () => {
    useFlows.getState().begin(run());
    useFlows.getState().patchRun("f1", { finishedAt: 9_000 });
    await vi.waitFor(() => expect(JSON.parse(written["flow.runs"])).toEqual([]));
  });

  it("what was walking comes back as interrupted, never as silence", async () => {
    await useFlows.getState().restore({ "flow.runs": JSON.stringify([run()]) });

    const restored = useFlows.getState().runs.f1;
    expect(restored).toBeDefined();
    expect(restored.finishedAt).not.toBeNull();
    expect(restored.error).toMatch(/recarregada/i);
    // The stage that held the baton has to say it stopped there.
    expect(restored.stages[1].status).toBe("error");
    // And what had already finished stays finished.
    expect(restored.stages[0].status).toBe("done");
  });

  it("a run that had already ended does not turn into an error on the way back", async () => {
    await useFlows
      .getState()
      .restore({ "flow.runs": JSON.stringify([run({ finishedAt: 9_000 })]) });
    expect(useFlows.getState().runs.f1).toBeUndefined();
  });

  it("a corrupted record does not bring the boot down", async () => {
    await useFlows.getState().restore({ "flow.runs": "{isso não é json" });
    expect(useFlows.getState().runs).toEqual({});
  });
});
