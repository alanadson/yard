/**
 * The notebook has two places, the centre of the workspace and a pane tab,
 * and never a sheet over the window: the sheet was an HTML overlay, and a
 * portal's page (an OS window) painted straight through it. The rules here
 * keep every fallback landing in the centre, and the canvas answer ("summon
 * the docked notebook where there is no tab bar") landing there too.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  NOTES_TAB_ID,
  notesCenterVisible,
  parseCollection,
  parsePlace,
  parseStatus,
  sanitizeData,
  useNotes,
} from "./notesStore";
import { useProjects } from "./projectsStore";
import type { NotesData } from "../lib/ipc";

/**
 * A group seeded straight into the store, on the surface the test names. The
 * canvas is the boards (`lib/surface.ts`), so "canvas" seeds a board, a group
 * with no project; "grid" seeds a project's group.
 */
const seedGroup = (id: string, surface: "grid" | "canvas") => {
  useProjects.setState({
    projects: [],
    groups: [
      {
        id,
        projectId: surface === "canvas" ? null : "p1",
        name: "Grupo",
        layoutJson: JSON.stringify({ surface }),
        suspended: false,
        sort: 0,
      },
    ],
    terminals: [],
    activeProjectId: "p1",
    activeGroupId: id,
  });
};

const resetStore = () => {
  useProjects.setState({
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
  useNotes.setState({
    loaded: true,
    open: false,
    place: { kind: "center" },
    notes: [],
    notebooks: [],
    tags: [],
    collection: { kind: "all" },
    activeId: null,
    query: "",
    sort: "updated",
    showResolved: false,
    saveError: null,
    wantsFocus: null,
  });
};

beforeEach(resetStore);

describe("parseStatus", () => {
  it("anything outside the list becomes none", () => {
    expect(parseStatus("active")).toBe("active");
    expect(parseStatus("banana")).toBe("none");
    expect(parseStatus(undefined)).toBe("none");
  });
});

describe("sanitizeData", () => {
  it("drops orphan notebook and tag references", () => {
    const data: NotesData = {
      notes: [
        {
          id: "n1",
          title: "x",
          body: "",
          notebookId: "fantasma",
          tags: ["viva", "morta"],
          status: "done",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
      notebooks: [
        { id: "nb", name: "Caderno", parentId: "sumiu", icon: null, sort: 0 },
      ],
      tags: [{ id: "viva", name: "Viva", color: "#fff", sort: 0 }],
    };
    const s = sanitizeData(data);
    expect(s.notes[0].notebookId).toBeNull();
    expect(s.notes[0].tags).toEqual(["viva"]);
    // A parent that no longer exists must not hide the whole branch.
    expect(s.notebooks[0].parentId).toBeNull();
  });
});

describe("parseCollection", () => {
  it("falls back to 'all' when the kv is broken", () => {
    expect(parseCollection("{noise").collection).toEqual({ kind: "all" });
    expect(parseCollection(undefined).collection).toEqual({ kind: "all" });
    const ok = parseCollection('{"collection":{"kind":"trash"},"activeId":"n1"}');
    expect(ok.collection).toEqual({ kind: "trash" });
    expect(ok.activeId).toBe("n1");
  });
});

describe("parsePlace", () => {
  it("anything off the format falls back to the centre", () => {
    expect(parsePlace(undefined)).toEqual({ kind: "center" });
    expect(parsePlace("{noise")).toEqual({ kind: "center" });
    expect(parsePlace('{"kind":"tab"}')).toEqual({ kind: "center" });
    expect(parsePlace('{"kind":"banana"}')).toEqual({ kind: "center" });
  });

  it("a place saved as the retired overlay comes back in the centre, no sheet ever again", () => {
    expect(parsePlace('{"kind":"overlay"}')).toEqual({ kind: "center" });
  });

  it("accepts the two places and normalises the slot", () => {
    expect(parsePlace('{"kind":"center"}')).toEqual({ kind: "center" });
    expect(parsePlace('{"kind":"tab","groupId":"g1","slot":2}')).toEqual({
      kind: "tab",
      groupId: "g1",
      slot: 2,
    });
    expect(parsePlace('{"kind":"tab","groupId":"g1","slot":-3}')).toEqual({
      kind: "tab",
      groupId: "g1",
      slot: 0,
    });
  });
});

describe("where the notebook lives", () => {
  it("docking closes the centre; the tab's X gives back the centre, closed", () => {
    useNotes.getState().openView();
    useNotes.getState().dockTo("g1", 1);
    expect(useNotes.getState().place).toEqual({ kind: "tab", groupId: "g1", slot: 1 });
    expect(useNotes.getState().open).toBe(false);
    useNotes.getState().closeDock();
    expect(useNotes.getState().place).toEqual({ kind: "center" });
    expect(useNotes.getState().open).toBe(false);
  });

  it("from the tab, 'take the centre' moves the notebook and keeps it on screen", () => {
    useNotes.getState().dockTo("g1", 0);
    useNotes.getState().placeCenter();
    expect(useNotes.getState().place).toEqual({ kind: "center" });
    expect(useNotes.getState().open).toBe(true);
    expect(notesCenterVisible()).toBe(true);
  });

  it("the dock's group vanishing drops the tab back to the centre, closed", () => {
    useNotes.getState().dockTo("g1", 0);
    useNotes.getState().dropGroups(["outro"]);
    expect(useNotes.getState().place.kind).toBe("tab");
    useNotes.getState().dropGroups(["g1"]);
    expect(useNotes.getState().place).toEqual({ kind: "center" });
    expect(useNotes.getState().open).toBe(false);
  });

  it("dockHere with no active group refuses and explains", () => {
    expect(useNotes.getState().dockHere()).toBe(false);
    expect(useNotes.getState().place).toEqual({ kind: "center" });
  });

  it("summoning the notebook docked in a grid group jumps to its tab, no centre", () => {
    seedGroup("g1", "grid");
    useNotes.getState().dockTo("g1", 0);
    useProjects.getState().setActiveTab("g1", 0, "outra-aba");
    useNotes.getState().openView();
    expect(useNotes.getState().open).toBe(false);
    expect(notesCenterVisible()).toBe(false);
    expect(useProjects.getState().layoutOf("g1").activeBySlot[0]).toBe(NOTES_TAB_ID);
  });

  it("a board has no tab bar: summoning the docked notebook shows it in the centre and keeps the dock", () => {
    seedGroup("g1", "canvas");
    useNotes.getState().dockTo("g1", 0);
    useNotes.getState().openView();
    expect(useNotes.getState().open).toBe(true);
    expect(useNotes.getState().place).toEqual({ kind: "tab", groupId: "g1", slot: 0 });
    expect(notesCenterVisible()).toBe(true);
    // The same key dismisses it: back to the board, the dock untouched.
    useNotes.getState().toggleView();
    expect(useNotes.getState().open).toBe(false);
    expect(useNotes.getState().place.kind).toBe("tab");
  });

  it("in the centre the toggle is still the usual one", () => {
    useNotes.getState().toggleView();
    expect(useNotes.getState().open).toBe(true);
    useNotes.getState().toggleView();
    expect(useNotes.getState().open).toBe(false);
  });
});

describe("creation", () => {
  it("is born in the current collection's notebook and asks for focus on the title", () => {
    const nbId = useNotes.getState().addNotebook("Trabalho", null);
    useNotes.getState().select({ kind: "book", id: nbId });
    const id = useNotes.getState().createNote();
    const note = useNotes.getState().notes.find((n) => n.id === id)!;
    expect(note.notebookId).toBe(nbId);
    expect(useNotes.getState().activeId).toBe(id);
    expect(useNotes.getState().wantsFocus).toBe("title");
  });

  it("in the trash, creates in 'all' — a new note is not born deleted", () => {
    useNotes.getState().select({ kind: "trash" });
    const id = useNotes.getState().createNote();
    const note = useNotes.getState().notes.find((n) => n.id === id)!;
    expect(note.deletedAt).toBeNull();
    expect(useNotes.getState().collection).toEqual({ kind: "all" });
  });

  it("in an active-status collection inherits the status; a resolved one does not", () => {
    useNotes.getState().select({ kind: "status", status: "paused" });
    const a = useNotes.getState().createNote();
    expect(useNotes.getState().notes.find((n) => n.id === a)!.status).toBe("paused");
    useNotes.getState().select({ kind: "status", status: "done" });
    const b = useNotes.getState().createNote();
    expect(useNotes.getState().notes.find((n) => n.id === b)!.status).toBe("none");
  });
});

describe("trash", () => {
  it("deleting is reversible; deleting for good leaves no trace", () => {
    const id = useNotes.getState().createNote();
    useNotes.getState().trashNote(id);
    expect(useNotes.getState().notes.find((n) => n.id === id)!.deletedAt).not.toBeNull();
    useNotes.getState().restoreNote(id);
    expect(useNotes.getState().notes.find((n) => n.id === id)!.deletedAt).toBeNull();
    useNotes.getState().trashNote(id);
    useNotes.getState().emptyTrash();
    expect(useNotes.getState().notes.find((n) => n.id === id)).toBeUndefined();
    expect(useNotes.getState().activeId).toBeNull();
  });
});

describe("preview tasks", () => {
  it("toggleNoteTask flips only that line's checkbox", () => {
    const id = useNotes.getState().createNote();
    useNotes.getState().updateNote(id, { body: "- [ ] a\n- [x] b" });
    useNotes.getState().toggleNoteTask(id, 0);
    useNotes.getState().toggleNoteTask(id, 1);
    expect(useNotes.getState().notes.find((n) => n.id === id)!.body).toBe(
      "- [x] a\n- [ ] b",
    );
  });
});

describe("notebooks", () => {
  it("deleting moves children and notes up to the grandparent", () => {
    const s = useNotes.getState();
    const grandparentId = s.addNotebook("Avô", null);
    const parentId = s.addNotebook("Pai", grandparentId);
    const childId = s.addNotebook("Filho", parentId);
    const noteId = s.createNote();
    s.setNoteBook(noteId, parentId);
    useNotes.getState().select({ kind: "book", id: parentId });

    useNotes.getState().deleteNotebook(parentId);

    const st = useNotes.getState();
    expect(st.notebooks.find((n) => n.id === childId)!.parentId).toBe(grandparentId);
    expect(st.notes.find((n) => n.id === noteId)!.notebookId).toBe(grandparentId);
    // The collection that pointed at the dead notebook follows the content.
    expect(st.collection).toEqual({ kind: "book", id: grandparentId });
  });
});

describe("tags", () => {
  it("ensureTag deduplicates ignoring accents and case", () => {
    const a = useNotes.getState().ensureTag("Reunião");
    const b = useNotes.getState().ensureTag("reuniao");
    expect(a).toBe(b);
    expect(useNotes.getState().tags).toHaveLength(1);
  });

  it("deleting the tag removes it from the notes and leaves the collection", () => {
    const tagId = useNotes.getState().ensureTag("rust")!;
    const noteId = useNotes.getState().createNote();
    useNotes.getState().setNoteTags(noteId, [tagId]);
    useNotes.getState().select({ kind: "tag", id: tagId });

    useNotes.getState().deleteTag(tagId);

    const st = useNotes.getState();
    expect(st.notes.find((n) => n.id === noteId)!.tags).toEqual([]);
    expect(st.collection).toEqual({ kind: "all" });
  });
});

describe("pinning", () => {
  it("does not touch updatedAt — the list must not dance", () => {
    const id = useNotes.getState().createNote();
    const before = useNotes.getState().notes.find((n) => n.id === id)!.updatedAt;
    useNotes.getState().togglePin(id);
    const after = useNotes.getState().notes.find((n) => n.id === id)!;
    expect(after.pinned).toBe(true);
    expect(after.updatedAt).toBe(before);
  });
});
