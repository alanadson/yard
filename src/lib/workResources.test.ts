/** Review navigation must preserve task scope and refuse unusable references. */
import { expect, it } from "vitest";
import { taskResourceAction } from "./workResources";

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
