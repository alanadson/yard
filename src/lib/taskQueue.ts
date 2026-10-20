/** Merge an acknowledged native enqueue with user edits made during the request. */
import { ipc } from "./ipc";
import { writeQueue } from "./prefs";
import { mergeQueueAcknowledgement } from "./queuePatch";
import { useQueue } from "../stores/queueStore";
import type { TaskQueueResult, WorkTask } from "./work";
import type { QueueItem } from "./queue";

export async function queueTask(id: string, revision: number, terminalId: string, queueId: string): Promise<WorkTask> {
  const before = useQueue.getState().items;
  const result = await ipc.taskEnqueue(id, revision, terminalId, queueId);
  await applyQueueAcknowledgement(id, before, result);
  return result.task;
}

async function applyQueueAcknowledgement(id: string, before: QueueItem[], result: TaskQueueResult): Promise<void> {
  const beforeIds = new Set(before.map((item) => item.id));
  const acknowledged = new Set(result.items.map((item) => item.id));
  const current = useQueue.getState().items.filter((item) => !(beforeIds.has(item.id) && item.taskId === id && !acknowledged.has(item.id)));
  const acknowledgedView = [...result.items, ...current.filter((item) => !acknowledged.has(item.id))];
  const reconciled = new Map(mergeQueueAcknowledgement(current, before, before, acknowledgedView).map((item) => [item.id, item]));
  const existing = new Set(current.map((item) => item.id));
  const items = [...current.map((item) => reconciled.get(item.id) ?? item),
    ...result.items.filter((item) => !beforeIds.has(item.id) && !existing.has(item.id))];
  useQueue.setState({ items });
  const native = await writeQueue(result.items, items);
  useQueue.setState((state) => ({ items: mergeQueueAcknowledgement(state.items, result.items, items, native) }));
}

export async function retryTaskPrompt(id: string, queueId: string): Promise<void> {
  const item = useQueue.getState().items.find((item) => item.id === id);
  if (!item || item.delivery?.status !== "uncertain") return;
  if (!item.taskId) {
    if (!(await useQueue.getState().retry(id, queueId))) throw new Error(useQueue.getState().error ?? "QUEUE_RETRY_CHANGED");
    return;
  }
  const before = useQueue.getState().items;
  const task = await ipc.taskGet(item.taskId);
  const result = task.status === "blocked"
    ? await ipc.taskEnqueue(task.id, task.revision, item.terminalId, queueId)
    : await ipc.taskRetryDelivery(task.id, task.revision, item.terminalId, id, queueId);
  await applyQueueAcknowledgement(task.id, before, result);
}

export async function cancelTaskPrompt(id: string): Promise<void> {
  const item = useQueue.getState().items.find((item) => item.id === id);
  if (!item || item.delivery?.status === "sending") return;
  let cancelledTaskId: string | undefined;
  if (item.taskId) {
    const task = await ipc.taskGet(item.taskId);
    if (task.status === "queued" || task.status === "blocked") {
      await ipc.taskTransition(task.id, task.revision, "cancelled");
      cancelledTaskId = task.id;
    }
  }
  const ids = useQueue.getState().items.filter((row) => row.id === id || (cancelledTaskId && row.taskId === cancelledTaskId)).map((row) => row.id);
  for (const currentId of ids) {
    if (!(await useQueue.getState().cancel(currentId))) throw new Error(useQueue.getState().error ?? "QUEUE_ITEM_CHANGED");
  }
}

export async function clearTaskPrompts(terminalId: string): Promise<void> {
  const ids = useQueue.getState().listFor(terminalId).map((item) => item.id);
  for (const id of ids) await cancelTaskPrompt(id);
}
