/** Saved review references determine navigation independently of the active project. */
import type { TaskResource, WorkTask } from "./work";

export function taskWorkingRoot(task: Pick<WorkTask, "links">, terminals: readonly { id: string; cwd: string }[], projects: readonly { id: string; path: string }[]): string | null {
  return task.links.resources?.find((resource) => (resource.kind === "checkpoint" || resource.kind === "diff") && resource.root)?.root
    ?? terminals.find((terminal) => terminal.id === (task.links.executorTerminalId ?? task.links.terminalIds[0]))?.cwd
    ?? projects.find((project) => project.id === task.links.projectId)?.path ?? null;
}

export type TaskResourceAction = { kind: "checkpoint"; root: string; id: string } | { kind: "front"; id: string } | { kind: "diff"; root: string; path: string } | { kind: "pull_request"; url: string };

export type DeliveryArtifactAction = { kind: "file"; root: string; path: string } | { kind: "url"; url: string };

export function deliveryArtifactAction(reference: string, root: string | null): DeliveryArtifactAction | null {
  if (!reference.trim() || /[\r\n\0]/.test(reference)) return null;
  if (/^https?:\/\//i.test(reference.trim())) {
    try {
      const url = new URL(reference.trim());
      return url.username || url.password ? null : { kind: "url", url: url.toString() };
    } catch { return null; }
  }
  if (!root) return null;
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  let path = reference.trim().replaceAll("\\", "/");
  if (/^(?:[a-z]:|\/)/i.test(path)) {
    const windows = /^(?:[a-z]:|\/\/)/i.test(base);
    const prefix = `${base}/`;
    if (!(windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return null;
    path = path.slice(prefix.length);
  }
  if (path.split("/").includes("..") || path.includes(":")) return null;
  path = path.split("/").filter((part) => part && part !== ".").join("/");
  return path ? { kind: "file", root, path } : null;
}

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
