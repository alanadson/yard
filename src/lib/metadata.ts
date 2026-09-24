import type { Note } from "./notes";
import type { TerminalRuntime } from "../stores/terminalsStore";

export type RailNote = Pick<
  Note,
  "id" | "notebookId" | "tags" | "status" | "deletedAt"
>;

export function createRailNotesSelector() {
  let previous: readonly Note[] | undefined;
  let result: RailNote[] = [];
  return ({ notes }: { notes: readonly Note[] }): RailNote[] => {
    if (notes === previous) return result;
    previous = notes;
    const same =
      notes.length === result.length &&
      notes.every((note, i) => {
        const old = result[i];
        return (
          note.id === old.id &&
          note.notebookId === old.notebookId &&
          note.status === old.status &&
          note.deletedAt === old.deletedAt &&
          note.tags.length === old.tags.length &&
          note.tags.every((tag, j) => tag === old.tags[j])
        );
      });
    if (!same)
      result = notes.map(({ id, notebookId, tags, status, deletedAt }) => ({
        id,
        notebookId,
        tags,
        status,
        deletedAt,
      }));
    return result;
  };
}

export type TerminalSearchStatus = Pick<
  TerminalRuntime,
  "state" | "finished" | "unread" | "blocked"
>;

export function createTerminalSearchSelector() {
  let previous: Record<string, TerminalRuntime> | undefined;
  let result: Record<string, TerminalSearchStatus> = {};
  return ({ byId }: { byId: Record<string, TerminalRuntime> }) => {
    if (byId === previous) return result;
    previous = byId;
    const entries = Object.entries(byId);
    const same =
      entries.length === Object.keys(result).length &&
      entries.every(([id, runtime]) => {
        const old = result[id];
        return (
          old &&
          runtime.state === old.state &&
          runtime.finished === old.finished &&
          runtime.unread === old.unread &&
          runtime.blocked === old.blocked
        );
      });
    if (!same)
      result = Object.fromEntries(
        entries.map(([id, { state, finished, unread, blocked }]) => [
          id,
          { state, finished, unread, blocked },
        ]),
      );
    return result;
  };
}
