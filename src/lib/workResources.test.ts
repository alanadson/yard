/** Review navigation must preserve task scope and refuse unusable references. */
import { expect, it } from "vitest";
import { taskResourceAction, deliveryArtifactAction, taskWorkingRoot } from "./workResources";

it("keeps artifact navigation in the task worktree instead of the active project", () => {
  const task = { links: { projectId: "project", terminalIds: ["author"], executorTerminalId: "author", resources: [{ kind: "checkpoint" as const, id: "snapshot", root: "C:/worktree", label: "Before work" }] } };
  expect(taskWorkingRoot(task, [{ id: "author", cwd: "C:/other" }], [{ id: "project", path: "C:/project" }])).toBe("C:/worktree");
});

it("opens delivered files in their recorded folder and refuses paths outside it", () => {
  expect(deliveryArtifactAction("reports/proof.md", "C:/worktree")).toEqual({ kind: "file", root: "C:/worktree", path: "reports/proof.md" });
  expect(deliveryArtifactAction("C:\\worktree\\reports\\proof.md", "C:/worktree")).toEqual({ kind: "file", root: "C:/worktree", path: "reports/proof.md" });
  expect(deliveryArtifactAction("../secret.txt", "C:/worktree")).toBeNull();
  expect(deliveryArtifactAction("C:/other/proof.md", "C:/worktree")).toBeNull();
});

it("opens artifact web links without accepting executable schemes or embedded credentials", () => {
  expect(deliveryArtifactAction("https://example.com/report", null)).toEqual({ kind: "url", url: "https://example.com/report" });
  expect(deliveryArtifactAction("javascript:alert(1)", "C:/repo")).toBeNull();
  expect(deliveryArtifactAction("https://user:secret@example.com/report", "C:/repo")).toBeNull();
});

it("opens a checkpoint in its recorded directory instead of the active project", () => {
  expect(taskResourceAction({ kind: "checkpoint", id: "1000-1", root: "C:/worktree", label: "Before work" }, []))
    .toEqual({ kind: "checkpoint", root: "C:/worktree", id: "1000-1" });
});

it("keeps removed fronts unavailable while an existing front can be opened", () => {
  expect(taskResourceAction({ kind: "front", id: "removed", root: null, label: "Old front" }, [])).toBeNull();
  expect(taskResourceAction({ kind: "front", id: "front", root: null, label: "Current front" }, [{ id: "front" }])).toEqual({ kind: "front", id: "front" });
});

it("reviews a file diff in the directory recorded by its task", () => {
  expect(taskResourceAction({ kind: "diff", id: "src/api.ts", root: "C:/repo", label: "API change" }, [])).toEqual({ kind: "diff", path: "src/api.ts", root: "C:/repo" });
});

it("opens only HTTPS pull request links from recorded review evidence", () => {
  expect(taskResourceAction({ kind: "pull_request", id: "javascript:alert(1)", root: null, label: "Invalid link" }, [])).toBeNull();
  expect(taskResourceAction({ kind: "pull_request", id: "https://github.com/owner/repo/pull/12", root: null, label: "PR 12" }, [])).toEqual({ kind: "pull_request", url: "https://github.com/owner/repo/pull/12" });
});

it("opens a pipeline's recorded board so its execution can be reviewed", () => {
  expect(taskResourceAction({ kind: "flow", id: "pipeline", root: "board", label: "Pipeline" }, [{ id: "board" }])).toEqual({ kind: "front", id: "board" });
});
