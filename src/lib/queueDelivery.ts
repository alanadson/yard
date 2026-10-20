/** Persist a delivery reservation before writing so a failure never discards the user's prompt. */
import { useQueue } from "../stores/queueStore";
import { injectPrompt } from "./inject";
import { dispatchQueuedItem, readNativeQueue, writeQueue } from "./prefs";
import { mergeQueueAcknowledgement } from "./queuePatch";
import type { QueueItem } from "./queue";
import { prepareQueuedTask } from "./taskCheckpoint";
import { ipc } from "./ipc";

export type QueueDeliveryResult =
  | { status: "delivered" | "skipped" }
  | { status: "uncertain" | "failed"; error: string };

async function saveQueue(before: QueueItem[], after = useQueue.getState().items): Promise<void> {
  const acknowledged = await writeQueue(before, after);
  useQueue.setState((state) => ({ items: mergeQueueAcknowledgement(state.items, before, after, acknowledged) }));
}

function markDelivery(id: string, delivery: QueueItem["delivery"]): void {
  useQueue.setState((state) => ({ items: state.items.map((item) => item.id === id ? { ...item, delivery } : item) }));
}

export async function refreshNativeQueue(): Promise<void> {
  const before = useQueue.getState().items;
  const previousError = useQueue.getState().error;
  const request = readNativeQueue();
  if (!request) return;
  try {
    const acknowledged = await request;
    useQueue.setState((state) => ({ items: mergeQueueAcknowledgement(state.items, before, before, acknowledged),
      error: state.error === previousError ? null : state.error }));
  } catch (error) {
    useQueue.setState({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function deliverQueueItem(head: QueueItem, ready: (id: string) => boolean, now: number): Promise<QueueDeliveryResult> {
  const item = await prepareQueuedTask(head, ready);
  const current = useQueue.getState().listFor(head.terminalId)[0];
  if (!item || current?.id !== item.id || current.delivery) return { status: "skipped" };
  const beforeReservation = useQueue.getState().items;
  const native = dispatchQueuedItem(item.id, item.terminalId, now);
  if (native) {
    markDelivery(item.id, { status: "sending", attemptedAt: now, owner: "native" });
    const reserved = useQueue.getState().items;
    try {
      const result = await native;
      const after = result.status === "delivered" ? reserved.filter((row) => row.id !== item.id) : reserved;
      useQueue.setState((state) => ({ items: mergeQueueAcknowledgement(state.items, beforeReservation, after, result.items) }));
      return result.status === "uncertain" ? { status: "uncertain", error: result.error ?? "QUEUE_NATIVE_UNCERTAIN" } : { status: result.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markDelivery(item.id, { status: "uncertain", attemptedAt: now, owner: "native", error: message });
      return { status: "uncertain", error: message };
    }
  }
  markDelivery(item.id, { status: "sending", attemptedAt: now });
  try {
    await saveQueue(beforeReservation);
  } catch (error) {
    markDelivery(item.id, undefined);
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (!useQueue.getState().items.some((current) => current.id === item.id) || !ready(item.terminalId)) {
    const beforeRelease = useQueue.getState().items;
    markDelivery(item.id, undefined);
    await saveQueue(beforeRelease);
    return { status: "skipped" };
  }
  try {
    if (item.taskId) await ipc.taskClaim(item.taskId, item.id, item.terminalId);
    await injectPrompt(item.terminalId, item.text);
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error);
    const beforeFailure = useQueue.getState().items;
    markDelivery(item.id, { status: "uncertain", attemptedAt: now, error: message });
    await saveQueue(beforeFailure);
    return { status: "uncertain", error: message };
  }
  try {
    const beforeAcknowledgement = useQueue.getState().items;
    const remaining = beforeAcknowledgement.filter((current) => current.id !== item.id);
    await saveQueue(beforeAcknowledgement, remaining);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const beforeFailure = useQueue.getState().items;
    markDelivery(item.id, { status: "uncertain", attemptedAt: now, error: message });
    await saveQueue(beforeFailure);
    return { status: "uncertain", error: message };
  }
  return { status: "delivered" };
}
