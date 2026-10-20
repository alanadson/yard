/** Apply native queue changes without replacing intervening local edits. */
import type { QueueItem } from "./queue";
import { sameItems } from "./stableSelect";

function sameItem(left: QueueItem, right: QueueItem): boolean {
  return (["id", "terminalId", "taskId", "routineKey", "text", "at", "source", "by"] as const).every((key) => left[key] === right[key])
    && left.delivery?.status === right.delivery?.status && left.delivery?.attemptedAt === right.delivery?.attemptedAt
    && left.delivery?.error === right.delivery?.error && left.delivery?.owner === right.delivery?.owner;
}

export function mergeQueueAcknowledgement(current: QueueItem[], before: readonly QueueItem[], after: readonly QueueItem[], acknowledged: readonly QueueItem[]): QueueItem[] {
  const removed = new Set(before.filter((item) => !after.some((next) => next.id === item.id) && !acknowledged.some((next) => next.id === item.id)).map((item) => item.id));
  const result = current.filter((item) => !removed.has(item.id)).flatMap((item) => {
    const submitted = after.find((submitted) => submitted.id === item.id);
    if (!submitted || !sameItem(item, submitted)) return [item];
    const native = acknowledged.find((native) => native.id === item.id);
    return native ? [sameItem(item, native) ? item : native] : [];
  });
  const known = new Set([...before, ...after, ...current].map((item) => item.id));
  const merged = [...result, ...acknowledged.filter((item) => !known.has(item.id))];
  for (const terminalId of new Set(acknowledged.map((item) => item.terminalId))) {
    const postedIds = new Set(after.filter((item) => item.terminalId === terminalId).map((item) => item.id));
    const currentIds = new Set(current.filter((item) => item.terminalId === terminalId).map((item) => item.id));
    const postedOrder = after.filter((item) => item.terminalId === terminalId && currentIds.has(item.id)).map((item) => item.id);
    const currentOrder = current.filter((item) => item.terminalId === terminalId && postedIds.has(item.id)).map((item) => item.id);
    if (postedOrder.length !== currentOrder.length || postedOrder.some((id, index) => id !== currentOrder[index])) continue;
    const nativeIds = new Set(acknowledged.filter((item) => item.terminalId === terminalId).map((item) => item.id));
    const positions = merged.flatMap((item, index) => item.terminalId === terminalId && nativeIds.has(item.id) ? [index] : []);
    const present = new Map(merged.map((item) => [item.id, item]));
    const ordered = acknowledged.filter((item) => item.terminalId === terminalId && present.has(item.id)).map((item) => present.get(item.id)!);
    positions.forEach((position, index) => { merged[position] = ordered[index]; });
  }
  return sameItems(current, merged) ? current : merged;
}
