export function frontToResume<
  T extends { groupId: string | null; state: string },
>(parent: string | null, stage: string, items: readonly T[]): T | null {
  return parent === "new-terminal" &&
    stage === "done" &&
    items.length === 1 &&
    items[0].state === "ready" &&
    items[0].groupId
    ? items[0]
    : null;
}
