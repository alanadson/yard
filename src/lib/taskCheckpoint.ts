/** Prepare snapshots only for local agents working in Git directories. */
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { checkpointScope, type CheckpointScope } from "./checkpoints";
import { useProjects } from "../stores/projectsStore";
import { useQueue } from "../stores/queueStore";
import type { QueueItem } from "./queue";
import { checkpointFailureText } from "./checkpointNotices";
import { useUI } from "../stores/uiStore";

export async function prepareTaskCheckpoint(
  terminalId: string,
  task?: { id: string; text: string },
): Promise<CheckpointScope | undefined> {
  const workspace = useProjects.getState();
  const terminal = workspace.terminals.find((row) => row.id === terminalId);
  if (!terminal || terminal.kind !== "agent") return undefined;
  const runtime = (await ipc.listPtys()).find((row) => row.id === terminalId);
  if (!runtime) return undefined;
  const program = runtime.program.replaceAll("\\", "/").split("/").pop() ?? "";
  if (/^(ssh|wsl)(\.exe)?$/i.test(program)) return undefined;
  if (!(await ipc.scmInfo(terminal.cwd)).isRepo) return undefined;
  return checkpointScope(terminal, workspace.groups.find((group) => group.id === terminal.groupId), task);
}

/**
 * The checkpoint is best effort: a snapshot that cannot be saved is logged
 * and the task still goes out. Throwing here left the head in the queue,
 * where the runner retried it (and toasted) on every tick, forever.
 */
export async function takeCheckpointedTask(head: QueueItem, ready: (id: string) => boolean): Promise<QueueItem | null> {
  if (!(await prepareQueuedTask(head, ready))) return null;
  return useQueue.getState().take(head.terminalId);
}

/** Preparing a delivery keeps the prompt in the queue until its outcome is recorded. */
export async function prepareQueuedTask(head: QueueItem, ready: (id: string) => boolean): Promise<QueueItem | null> {
  if (!ready(head.terminalId) || useQueue.getState().listFor(head.terminalId)[0]?.id !== head.id) return null;
  if (head.source !== "bridge") {
    try {
      const scope = await prepareTaskCheckpoint(head.terminalId, { id: head.taskId ?? head.id, text: head.text });
      if (scope) await ipc.checkpointCreate(scope.root, scope.taskId, scope.taskLabel, head.text.split(/\r?\n/)[0].slice(0, 160));
    } catch (e) {
      const root = useProjects.getState().terminals.find((terminal) => terminal.id === head.terminalId)?.cwd ?? head.terminalId;
      uiLog.warn(`Checkpoint unavailable for request ${head.id} in ${root}: ${e}`);
      useUI.getState().showToast(checkpointFailureText(root, String(e)), "error");
    }
  }
  if (!ready(head.terminalId) || useQueue.getState().listFor(head.terminalId)[0]?.id !== head.id) return null;
  return useQueue.getState().listFor(head.terminalId)[0] ?? null;
}
