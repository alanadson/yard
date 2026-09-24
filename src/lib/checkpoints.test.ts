/** Checkpoint ownership follows the actual task and worktree, never the visible project's ground. */
import { describe, expect, it } from "vitest";
import { checkpointScope, restoreBlockReason, checkpointChangeLabel, checkpointRootsOverlap } from "./checkpoints";

it("protects editor drafts opened through a nested root or a Windows canonical alias", () => {
  expect(checkpointRootsOverlap("C:/repo", "\\\\?\\C:\\repo\\src")).toBe(true);
  expect(checkpointRootsOverlap("C:/repo", "C:/repo-other")).toBe(false);
  expect(restoreBlockReason("C:/repo", [{ root: "C:/repo/src", text: "draft", saved: "saved", crlf: false, savedCrlf: false }], false)).not.toBeNull();
});

it("describes added files as removals when explaining what restore will do", () => {
  expect(["added", "modified", "deleted"].map((status) => checkpointChangeLabel(status as "added" | "modified" | "deleted")))
    .toEqual(["Será removido", "Será restaurado", "Será recriado"]);
});

describe("restoreBlockReason", () => {
  it("refuses a restore while an agent in the working directory is running", () => {
    expect(restoreBlockReason("C:/work/front", [], true)).toBe("Aguarde os agentes desta pasta terminarem antes de restaurar.");
  });
  it("refuses a restore while the same working directory has an unsaved editor draft", () => {
    expect(restoreBlockReason("C:/work/front", [
      { root: "c:\\work\\front", text: "draft", saved: "disk", crlf: true, savedCrlf: true },
    ], false)).toBe("Salve ou descarte os arquivos abertos desta pasta antes de restaurar.");
    expect(restoreBlockReason("C:/work/front", [
      { root: "C:/work/other", text: "draft", saved: "disk", crlf: true, savedCrlf: true },
    ], false)).toBeNull();
  });
});

describe("checkpointScope", () => {
  it("keeps an explicitly dispatched bench task separate from the front's other work", () => {
    expect(checkpointScope(
      { id: "agent-one", cwd: "C:/work/front", groupId: "front", title: "Claude" },
      { id: "front", name: "Front", layoutJson: "{}" },
      { id: "bench-task", text: "Fix the failing test" },
    )).toEqual({ root: "C:/work/front", taskId: "bench-task", taskLabel: "Fix the failing test" });
  });
  it("uses the front task identity and the terminal's actual working directory", () => {
    expect(checkpointScope(
      { id: "agent-one", cwd: "C:/work/login-front", groupId: "front-one", title: "Claude" },
      { id: "front-one", name: "Login", layoutJson: JSON.stringify({ floor: { kind: "isolated", task: { id: "login-task", prompt: "Fix login", createdAt: 1000 } } }) },
    )).toEqual({ root: "C:/work/login-front", taskId: "login-task", taskLabel: "Fix login" });
  });
});
