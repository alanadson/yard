// Partial native registration must not leak the listener that succeeded.
import { expect, it, vi } from "vitest";
import { ipc, on, type ActivityPayload } from "./ipc";
import { startPtyWatch } from "./ptyWatch";
import { useProjects } from "../stores/projectsStore";
import { getActivity, useTerminals } from "../stores/terminalsStore";

it("releases the successful listener when another subscription fails", async () => {
  const previous = useProjects.getState().terminals;
  let released = false;
  vi.spyOn(on, "exit").mockResolvedValue(() => {
    released = true;
  });
  vi.spyOn(on, "activity").mockRejectedValue(new Error("registration failed"));
  useProjects.setState({
    terminals: [
      {
        id: "watch-test",
        groupId: "g",
        slot: 0,
        kind: "shell",
        program: "pwsh",
        args: [],
        cwd: "C:/repo",
        sort: 0,
        alive: false,
        createdAt: 0,
      },
    ],
  });
  const stop = startPtyWatch();
  try {
    await vi.waitFor(() => expect(released).toBe(true));
  } finally {
    stop();
    useProjects.setState({ terminals: previous });
    vi.restoreAllMocks();
  }
});

// The backend only sends a heartbeat when it has something new to say, so a
// listener that registers late (a webview reload, a slow `listen`) would never
// hear about an idle terminal again: `lastByteAt` would stay 0, which reads as
// "just spawned" (keeps the PC awake) and "never went quiet" (the role
// briefing waits forever). The watch asks for the current beat once its
// listener is in place, and treats the answer exactly like a heartbeat.

function row(id: string) {
  return {
    id,
    groupId: "g",
    slot: 0,
    kind: "agent" as const,
    program: "claude",
    args: [],
    cwd: "C:/repo",
    sort: 0,
    alive: true,
    createdAt: 0,
  };
}

async function watching(id: string, run: () => Promise<void>) {
  const previous = useProjects.getState().terminals;
  useProjects.setState({ terminals: [row(id)] });
  const stop = startPtyWatch();
  try {
    await run();
  } finally {
    stop();
    useProjects.setState({ terminals: previous });
    useTerminals.getState().forget(id);
    vi.restoreAllMocks();
  }
}

it("a terminal that went quiet before its listener registered still reports its last byte", async () => {
  vi.spyOn(on, "exit").mockResolvedValue(() => {});
  vi.spyOn(on, "activity").mockResolvedValue(() => {});
  vi.spyOn(ipc, "ptyActivity").mockResolvedValue({
    id: "watch-seed",
    lastByteAt: 4_242,
    idleMs: 60_000,
  });
  await watching("watch-seed", async () => {
    await vi.waitFor(() => expect(getActivity("watch-seed").lastByteAt).toBe(4_242));
  });
});

it("a heartbeat that lands before the snapshot answers is not overwritten by it", async () => {
  let beat: ((p: ActivityPayload) => void) | undefined;
  let answer: ((p: ActivityPayload | null) => void) | undefined;
  vi.spyOn(on, "exit").mockResolvedValue(() => {});
  vi.spyOn(on, "activity").mockImplementation(async (_id, cb) => {
    beat = cb;
    return () => {};
  });
  vi.spyOn(ipc, "ptyActivity").mockImplementation(
    () => new Promise((resolve) => (answer = resolve)),
  );
  await watching("watch-race", async () => {
    await vi.waitFor(() => expect(answer).toBeDefined());
    beat!({ id: "watch-race", lastByteAt: 9_000, idleMs: 10 });
    answer!({ id: "watch-race", lastByteAt: 5_000, idleMs: 4_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(getActivity("watch-race")).toEqual({ lastByteAt: 9_000, idleMs: 10 });
  });
});

it("a snapshot that says 'writing' clears a stale block, like a heartbeat", async () => {
  vi.spyOn(on, "exit").mockResolvedValue(() => {});
  vi.spyOn(on, "activity").mockResolvedValue(() => {});
  vi.spyOn(ipc, "ptyActivity").mockResolvedValue({
    id: "watch-writing",
    lastByteAt: 7_000,
    idleMs: 120,
  });
  useTerminals.getState().markBlocked("watch-writing", "(y/N)");
  await watching("watch-writing", async () => {
    await vi.waitFor(() => expect(useTerminals.getState().byId["watch-writing"]?.blocked).toBe(false));
  });
});

it("a terminal with no live process has no snapshot to apply", async () => {
  vi.spyOn(on, "exit").mockResolvedValue(() => {});
  vi.spyOn(on, "activity").mockResolvedValue(() => {});
  const asked = vi.spyOn(ipc, "ptyActivity").mockResolvedValue(null);
  await watching("watch-dead", async () => {
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith("watch-dead"));
    await Promise.resolve();
    expect(getActivity("watch-dead")).toEqual({ lastByteAt: 0, idleMs: 0 });
  });
});
