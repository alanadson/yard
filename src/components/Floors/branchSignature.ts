import { parseLayout } from "../../stores/projectsStore";

/**
 * One string that changes only when an isolated front's branch appears,
 * leaves or is renamed. The fronts popover keys its `gh pr view` effect on
 * it: the group list itself is a new array on every layout write (a pan, a
 * tab switch), and one `gh` call per front per frame is what that cost.
 */
export function isolatedBranchSignature(layoutJsons: readonly string[]): string {
  return layoutJsons
    .map((json) => parseLayout(json).floor)
    .filter((f) => !!f && f.kind === "isolated" && !!f.branch)
    .map((f) => f!.branch!)
    .join("|");
}
