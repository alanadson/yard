// Applying a role must report delivery only after the PTY accepted the prompt and Enter.
import { afterEach, expect, it, vi } from "vitest";
const { writes } = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock("./ipc", () => ({
  ipc: {
    ptyProbe: async () => ({ alive: true }),
    writePty: async (_id: string, text: string) => {
      writes.push(text);
    },
  },
}));
import { applyRoleToProcess } from "./roleBrief";
import { markActivity } from "../stores/terminalsStore";
import type { TerminalRow } from "./ipc";
afterEach(() => {
  vi.useRealTimers();
  writes.length = 0;
});

it("keeps role delivery pending until the prompt has been submitted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  markActivity("role-test", 1_000, 9_000);
  const terminal: TerminalRow = {
    id: "role-test",
    groupId: "g",
    slot: 0,
    title: "test",
    kind: "agent",
    agentId: "codex",
    program: "codex",
    args: [],
    cwd: "C:/project",
    resume: null,
    sort: 0,
    alive: true,
    createdAt: 1,
  };
  const result = applyRoleToProcess(terminal, undefined, {
    name: "Review",
    text: "Review the changes",
  });
  expect(result).toBeInstanceOf(Promise);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(result).resolves.toBe(true);
  expect(writes.at(-1)).toBe("\r");
});
