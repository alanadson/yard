/** Prepare snapshots only for local agents working in Git directories. */
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { checkpointScope, type CheckpointScope } from "./checkpoints";
import { useProjects } from "../stores/projectsStore";
import { useQueue } from "../stores/queueStore";
import type { QueueItem } from "./queue";

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
  if (!ready(head.terminalId) || useQueue.getState().listFor(head.terminalId)[0]?.id !== head.id) return null;
  if (head.source !== "bridge") {
    try {
      const scope = await prepareTaskCheckpoint(head.terminalId, { id: head.id, text: head.text });
      if (scope) await ipc.checkpointCreate(scope.root, scope.taskId, scope.taskLabel, head.text.split(/\r?\n/)[0].slice(0, 160));
    } catch (e) {
      uiLog.warn(`não consegui salvar o checkpoint da tarefa ${head.id} em ${head.terminalId}: ${e}`);
    }
  }
  if (!ready(head.terminalId) || useQueue.getState().listFor(head.terminalId)[0]?.id !== head.id) return null;
  return useQueue.getState().take(head.terminalId);
}
