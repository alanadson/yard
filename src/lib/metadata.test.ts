// Metadata consumers should react to status changes without following body or resource ticks.
import { expect, it } from "vitest";
import {
  createRailNotesSelector,
  createTerminalSearchSelector,
} from "./metadata";
import type { Note } from "./notes";
import { useTerminals } from "../stores/terminalsStore";

it("keeps rail metadata stable during note edits and updates it when a note moves", () => {
  const select = createRailNotesSelector();
  const note: Note = {
    id: "n",
    title: "title",
    body: "first",
    notebookId: null,
    tags: ["t"],
    status: "active",
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const first = select({ notes: [note] });
  expect(select({ notes: [{ ...note, body: "second", updatedAt: 1 }] })).toBe(
    first,
  );
  const moved = select({ notes: [{ ...note, notebookId: "book" }] });
  expect(moved).not.toBe(first);
  expect(moved[0].notebookId).toBe("book");
});

it("keeps terminal search status stable across resource ticks and publishes waiting changes", () => {
  const select = createTerminalSearchSelector();
  const runtime = useTerminals.getState().get("metadata-test");
  const first = select({ byId: { a: runtime } });
  expect(select({ byId: { a: { ...runtime, cpu: 12, rssMb: 300 } } })).toBe(
    first,
  );
  const waiting = select({ byId: { a: { ...runtime, finished: true } } });
  expect(waiting).not.toBe(first);
  expect(waiting.a.finished).toBe(true);
});
