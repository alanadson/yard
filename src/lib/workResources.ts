/** Saved review references determine navigation independently of the active project. */
import type { TaskResource } from "./work";

export type TaskResourceAction = { kind: "checkpoint"; root: string; id: string } | { kind: "front"; id: string } | { kind: "diff"; root: string; path: string } | { kind: "pull_request"; url: string };

export function taskResourceAction(resource: TaskResource, groups: readonly { id: string }[]): TaskResourceAction | null {
  if (resource.kind === "checkpoint" && resource.root) return { kind: "checkpoint", root: resource.root, id: resource.id };
  if (resource.kind === "front" && groups.some((group) => group.id === resource.id)) return { kind: "front", id: resource.id };
  if (resource.kind === "flow" && resource.root && groups.some((group) => group.id === resource.root)) return { kind: "front", id: resource.root };
  if (resource.kind === "diff" && resource.root) return { kind: "diff", root: resource.root, path: resource.id };
  if (resource.kind === "pull_request") {
    try {
      const url = new URL(resource.id);
      if (url.protocol === "https:" && !url.username && !url.password && /\/pull\/[1-9]\d*(?:\/|$)/.test(url.pathname)) return { kind: "pull_request", url: resource.id };
    } catch { return null; }
  }
  return null;
}
