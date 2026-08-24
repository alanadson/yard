/**
 * Anotações — the full-screen markdown notebook (Ctrl+Shift+N): notes that
 * live in nestable notebooks, wear colored labels and a status, and open in
 * the same four-mode markdown editor the files get.
 *
 * These are **not** the canvas sticky notes. A sticky note belongs to one
 * group's board and travels inside `layout_json`; a notebook note is knowledge
 * that follows the user across every project, so it lives in tables of its
 * own (persistence/notes.rs) and is loaded whole at boot — search, filters
 * and counters all run in memory, which for a personal notebook is cheaper
 * than a round-trip per keystroke.
 *
 * Persistence contract: structural edits (status, labels, move, pin, trash)
 * write immediately, row-sized; typing writes on a 600 ms debounce **per
 * note**, flushed when the view closes and when the window is about to.
 */
import { create } from "zustand";
import { nanoid } from "nanoid";

import { ipc, type NotesData } from "../lib/ipc";
import { runBackground } from "../lib/background";
import { persistPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";
import { useBrowsers } from "./browsersStore";
import { useEditor } from "./editorStore";
import { useProjects } from "./projectsStore";
import { useUI } from "./uiStore";
import {
  descendantsOf,
  fold,
  nextTagColor,
  NOTE_SORTS,
  STATUSES,
  type Collection,
  type Note,
  type Notebook,
  type NoteSort,
  type NoteStatus,
  type NoteTag,
} from "../lib/notes";

/** The four faces of the note editor — same vocabulary as the file editor. */
export type NotesMdMode = "live" | "source" | "split" | "read";

const MD_MODES: NotesMdMode[] = ["live", "source", "split", "read"];

/**
 * Where the notebook lives. One surface, one place at a time — `NoteSurface`'s
 * compartments are module singletons, so two mounted notebooks would fight
 * over the same restored editor states.
 *
 * - `overlay`: the sheet over the whole window (the original Ctrl+Shift+N).
 * - `tab`: docked as a tab of a pane, beside the CLIs, files and browsers.
 * - `center`: the whole central workspace area, panels and sidebar untouched.
 */
export type NotesPlace =
  | { kind: "overlay" }
  | { kind: "center" }
  | { kind: "tab"; groupId: string; slot: number };

/**
 * The docked notebook's id in the pane's tab bar (`activeBySlot`). A fixed
 * sentinel: there is only ever one notes tab, and nanoid never produces this.
 */
export const NOTES_TAB_ID = "yard-anotacoes";

const KV_OPEN = "notes.open";
const KV_PLACE = "notes.place";
const KV_SEL = "notes.sel";
const KV_SORT = "notes.sort";
const KV_RESOLVED = "notes.showResolved";
const KV_MD_MODE = "notes.mdMode";
const KV_RAIL_W = "notes.railW";
const KV_LIST_W = "notes.listW";

export const RAIL_DEFAULT = 232;
export const LIST_DEFAULT = 304;

/** Writes without blocking the UI; inert outside Tauri (vitest). */
const persist = (key: string, value: string) =>
  persistPref(key, value, (error) =>
    console.warn(`[yard] não consegui gravar ${key}`, error),
  );

// ---------------------------------------------------------------------------
// parsing — the backend hands JSON through; never trust the saved format
// ---------------------------------------------------------------------------

export function parseStatus(raw: unknown): NoteStatus {
  return STATUSES.includes(raw as NoteStatus) ? (raw as NoteStatus) : "none";
}

export function sanitizeData(data: NotesData): {
  notes: Note[];
  notebooks: Notebook[];
  tags: NoteTag[];
} {
  const notebooks: Notebook[] = (data.notebooks ?? [])
    .filter((n) => typeof n?.id === "string" && typeof n?.name === "string")
    .map((n) => ({
      id: n.id,
      name: n.name,
      parentId: typeof n.parentId === "string" ? n.parentId : null,
      icon: typeof n.icon === "string" && n.icon ? n.icon : null,
      sort: typeof n.sort === "number" ? n.sort : 0,
    }));
  const bookIds = new Set(notebooks.map((n) => n.id));
  // A parent that no longer exists would hide the whole branch from the rail.
  for (const n of notebooks) {
    if (n.parentId && !bookIds.has(n.parentId)) n.parentId = null;
  }

  const tags: NoteTag[] = (data.tags ?? [])
    .filter((t) => typeof t?.id === "string" && typeof t?.name === "string")
    .map((t) => ({
      id: t.id,
      name: t.name,
      color: typeof t.color === "string" && t.color ? t.color : "#5fa8ff",
      sort: typeof t.sort === "number" ? t.sort : 0,
    }));
  const tagIds = new Set(tags.map((t) => t.id));

  const notes: Note[] = (data.notes ?? [])
    .filter((n) => typeof n?.id === "string")
    .map((n) => ({
      id: n.id,
      title: typeof n.title === "string" ? n.title : "",
      body: typeof n.body === "string" ? n.body : "",
      notebookId:
        typeof n.notebookId === "string" && bookIds.has(n.notebookId)
          ? n.notebookId
          : null,
      tags: Array.isArray(n.tags)
        ? n.tags.filter((t): t is string => typeof t === "string" && tagIds.has(t))
        : [],
      status: parseStatus(n.status),
      pinned: n.pinned === true,
      createdAt: typeof n.createdAt === "number" ? n.createdAt : 0,
      updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : 0,
      deletedAt: typeof n.deletedAt === "number" ? n.deletedAt : null,
    }));

  return { notes, notebooks, tags };
}

export function parsePlace(raw: string | undefined): NotesPlace {
  if (!raw) return { kind: "overlay" };
  try {
    const p = JSON.parse(raw) as { kind?: unknown; groupId?: unknown; slot?: unknown };
    if (p?.kind === "center") return { kind: "center" };
    if (p?.kind === "tab" && typeof p.groupId === "string" && p.groupId) {
      return {
        kind: "tab",
        groupId: p.groupId,
        slot:
          typeof p.slot === "number" && Number.isFinite(p.slot)
            ? Math.max(0, p.slot | 0)
            : 0,
      };
    }
  } catch {
    /* fall through to the default */
  }
  return { kind: "overlay" };
}

/**
 * Is the notebook covering the window as an overlay right now? What
 * `lib/layers` and the global shortcuts consult. `place: tab` counts too:
 * that is the "peek" overlay a canvas-mode group answers with (its panes —
 * and therefore the tab — are not on screen, so the sheet is).
 */
export function notesOverlayVisible(): boolean {
  const s = useNotes.getState();
  return s.open && s.place.kind !== "center";
}

/** Is the notebook occupying the central workspace area? */
export function notesCenterVisible(): boolean {
  const s = useNotes.getState();
  return s.open && s.place.kind === "center";
}

export function parseCollection(raw: string | undefined): {
  collection: Collection;
  activeId: string | null;
} {
  const fallback = { collection: { kind: "all" } as Collection, activeId: null };
  if (!raw) return fallback;
  try {
    const data = JSON.parse(raw) as { collection?: Collection; activeId?: unknown };
    const c = data.collection;
    const ok =
      !!c &&
      (c.kind === "all" ||
        c.kind === "trash" ||
        (c.kind === "book" && typeof c.id === "string") ||
        (c.kind === "tag" && typeof c.id === "string") ||
        (c.kind === "status" && STATUSES.includes(c.status)));
    return {
      collection: ok ? c : { kind: "all" },
      activeId: typeof data.activeId === "string" ? data.activeId : null,
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// debounced writes — one timer per note, flushed on close
// ---------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const SAVE_DELAY = 600;

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

interface NotesState {
  loaded: boolean;
  /**
   * The notebook is summoned in its place (overlay/center). With `place:
   * tab` the tab itself is always in the bar; `open` there means the peek
   * overlay (see `notesOverlayVisible`).
   */
  open: boolean;
  /** Where the notebook lives — see `NotesPlace`. */
  place: NotesPlace;
  notes: Note[];
  notebooks: Notebook[];
  tags: NoteTag[];
  collection: Collection;
  activeId: string | null;
  query: string;
  sort: NoteSort;
  /** Show resolved notes (done/dropped) in the everyday collections. */
  showResolved: boolean;
  mdMode: NotesMdMode;
  railW: number;
  listW: number;
  /** Last write that failed — the view shows a banner while this is set. */
  saveError: string | null;
  /** One-shot focus request, consumed by the pane it names. */
  wantsFocus: "title" | "body" | "search" | null;

  load: (prefs?: PrefsSnapshot) => Promise<void>;
  /** Opens the view; with an id, lands on that note even if a filter hides it. */
  openView: (noteId?: string) => void;
  closeView: () => void;
  toggleView: () => void;

  /** Docks the notebook as a tab of the given pane (and makes it active). */
  dockTo: (groupId: string, slot: number) => void;
  /**
   * Docks into the pane the user is looking at (active group, focused slot).
   * Says why with a toast when it cannot (no group, canvas layout).
   */
  dockHere: () => boolean;
  /** The tab's X: back to a closed overlay, pane bar repaired. */
  closeDock: () => void;
  /** The placement switch: show the notebook as overlay or center. */
  setPlaceKind: (kind: "overlay" | "center") => void;
  /** Boot: a dock whose group left the workspace falls back to the overlay. */
  prune: () => void;
  /** Group(s) leaving the workspace mid-session — same fallback. */
  dropGroups: (groupIds: Iterable<string>) => void;

  select: (collection: Collection) => void;
  setActive: (id: string | null) => void;
  setQuery: (query: string) => void;
  setSort: (sort: NoteSort) => void;
  setShowResolved: (value: boolean) => void;
  setMdMode: (mode: NotesMdMode) => void;
  /** Live while dragging; `commit` persists on release. */
  setRailW: (w: number, commit?: boolean) => void;
  setListW: (w: number, commit?: boolean) => void;
  clearFocus: () => void;
  focusSearch: () => void;

  /** Creates in the current collection's context and focuses the title. */
  createNote: () => string;
  /** Title/body typing — debounced write. */
  updateNote: (id: string, patch: Partial<Pick<Note, "title" | "body">>) => void;
  setNoteBook: (id: string, notebookId: string | null) => void;
  setNoteStatus: (id: string, status: NoteStatus) => void;
  setNoteTags: (id: string, tagIds: string[]) => void;
  togglePin: (id: string) => void;
  duplicateNote: (id: string) => string | null;
  /** Flips one `- [ ]` checkbox by source line (the preview's clicks). */
  toggleNoteTask: (id: string, line: number) => void;
  trashNote: (id: string) => void;
  restoreNote: (id: string) => void;
  deleteForever: (id: string) => void;
  emptyTrash: () => void;
  /** Writes every note still on a debounce timer. Called before the app closes. */
  flush: () => void;

  addNotebook: (name: string, parentId: string | null) => string;
  renameNotebook: (id: string, name: string) => void;
  setNotebookIcon: (id: string, icon: string | null) => void;
  /** Children climb to the grandparent; the notes climb with them. */
  deleteNotebook: (id: string) => void;

  /** Returns the existing tag when the name (accent-insensitive) already exists. */
  ensureTag: (name: string) => string | null;
  renameTag: (id: string, name: string) => void;
  setTagColor: (id: string, color: string) => void;
  deleteTag: (id: string) => void;
}

export const useNotes = create<NotesState>((set, get) => {
  const persistNote = (note: Note) => {
    runBackground(() => ipc.noteSave(note), {
      success: () => {
        if (get().saveError) set({ saveError: null });
      },
      error: (e) => {
        console.warn("[yard] não consegui gravar a nota", e);
        set({ saveError: String(e) });
      },
    });
  };

  const saveNow = (id: string) => {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    const note = get().notes.find((n) => n.id === id);
    if (note) persistNote(note);
  };

  const queueSave = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const note = get().notes.find((n) => n.id === id);
        if (note) persistNote(note);
      }, SAVE_DELAY),
    );
  };

  /** Applies a patch, stamps `updatedAt`, and persists (immediately by default). */
  const patchNote = (
    id: string,
    patch: Partial<Note>,
    opts?: { debounce?: boolean; touch?: boolean },
  ) => {
    let changed: Note | undefined;
    const notes = get().notes.map((n) => {
      if (n.id !== id) return n;
      changed = {
        ...n,
        ...patch,
        ...(opts?.touch === false ? {} : { updatedAt: Date.now() }),
      };
      return changed;
    });
    if (!changed) return;
    set({ notes });
    if (opts?.debounce) queueSave(id);
    else saveNow(id);
  };

  const persistSelection = () => {
    const { collection, activeId } = get();
    persist(KV_SEL, JSON.stringify({ collection, activeId }));
  };

  const persistNotebook = (nb: Notebook) => {
    runBackground(() => ipc.notebookSave(nb), {
      error: (e) => {
        console.warn("[yard] não consegui gravar o caderno", e);
        set({ saveError: String(e) });
      },
    });
  };

  const persistTag = (tag: NoteTag) => {
    runBackground(() => ipc.noteTagSave(tag), {
      error: (e) => {
        console.warn("[yard] não consegui gravar a etiqueta", e);
        set({ saveError: String(e) });
      },
    });
  };

  const persistPlace = (place: NotesPlace) => persist(KV_PLACE, JSON.stringify(place));

  /**
   * The pane's bar pointed at the notes tab and the tab is leaving: hand the
   * bar to a neighbour in the same pane — same repair `browsersStore.close`
   * does — before it points at an id nothing renders.
   */
  const repairSlot = (groupId: string, slot: number) => {
    const { layoutOf, setActiveTab, terminalsOn, updateLayout } = useProjects.getState();
    const layout = layoutOf(groupId);
    if (layout.activeBySlot[slot] !== NOTES_TAB_ID) return;
    const terminal = terminalsOn(groupId, "grid").find((t) => t.slot === slot);
    const doc = useEditor
      .getState()
      .docs.find((d) => d.groupId === groupId && d.slot === slot);
    const browser = useBrowsers
      .getState()
      .tabs.find((b) => b.groupId === groupId && b.slot === slot);
    if (terminal) {
      setActiveTab(groupId, slot, terminal.id);
      useUI.getState().focusTerminal(terminal.id, slot);
    } else if (doc) {
      setActiveTab(groupId, slot, doc.id);
    } else if (browser) {
      setActiveTab(groupId, slot, browser.id);
    } else {
      const activeBySlot = { ...layout.activeBySlot };
      delete activeBySlot[slot];
      updateLayout(groupId, { activeBySlot });
    }
  };

  /**
   * Brings the docked tab to the screen: its group active, its tab on top.
   * A canvas-mode group has no tab bar to show it in — the peek overlay
   * answers instead (the panes are unmounted there, so the one-surface rule
   * holds). A dock whose group vanished falls back to the overlay for good.
   */
  const revealDock = (dock: { groupId: string; slot: number }): void => {
    const projects = useProjects.getState();
    if (!projects.groups.some((g) => g.id === dock.groupId)) {
      set({ place: { kind: "overlay" }, open: true });
      persistPlace({ kind: "overlay" });
      persist(KV_OPEN, "true");
      return;
    }
    if (projects.layoutOf(dock.groupId).surface === "canvas") {
      set({ open: true });
      persist(KV_OPEN, "true");
      return;
    }
    if (projects.activeGroupId !== dock.groupId) projects.setActiveGroup(dock.groupId);
    projects.setActiveTab(dock.groupId, dock.slot, NOTES_TAB_ID);
    useUI.getState().focusTerminal(null, dock.slot);
  };

  return {
    loaded: false,
    open: false,
    place: { kind: "overlay" },
    notes: [],
    notebooks: [],
    tags: [],
    collection: { kind: "all" },
    activeId: null,
    query: "",
    sort: "updated",
    showResolved: false,
    mdMode: "live",
    railW: RAIL_DEFAULT,
    listW: LIST_DEFAULT,
    saveError: null,
    wantsFocus: null,

    load: async (bootPrefs) => {
      try {
        const [data, prefs] = await Promise.all([
          ipc.notesLoad(),
          bootPrefs ? Promise.resolve(bootPrefs) : readPrefs(),
        ]);
        const sel = parseCollection(prefs[KV_SEL]);
        const sort = prefs[KV_SORT] as NoteSort;
        const mode = prefs[KV_MD_MODE] as NotesMdMode;
        const railW = Number(prefs[KV_RAIL_W]);
        const listW = Number(prefs[KV_LIST_W]);
        set({
          ...sanitizeData(data),
          loaded: true,
          open: prefs[KV_OPEN] === "true",
          place: parsePlace(prefs[KV_PLACE]),
          collection: sel.collection,
          activeId: sel.activeId,
          sort: NOTE_SORTS.includes(sort) ? sort : "updated",
          showResolved: prefs[KV_RESOLVED] === "true",
          mdMode: MD_MODES.includes(mode) ? mode : "live",
          railW: Number.isFinite(railW) && railW > 0 ? railW : RAIL_DEFAULT,
          listW: Number.isFinite(listW) && listW > 0 ? listW : LIST_DEFAULT,
        });
      } catch (e) {
        console.warn("[yard] não consegui carregar as anotações", e);
        // Still usable in memory; the save banner tells the rest.
        set({ loaded: true });
      }
    },

    openView: (noteId) => {
      if (noteId) {
        const note = get().notes.find((n) => n.id === noteId);
        if (note) {
          // Land where the note is actually visible: the trash for a deleted
          // one, its status row for a resolved one — "found it" must never
          // open onto a list that hides the very thing found.
          const collection: Collection = note.deletedAt !== null
            ? { kind: "trash" }
            : note.status === "done" || note.status === "dropped"
              ? { kind: "status", status: note.status }
              : { kind: "all" };
          set({ collection, activeId: noteId, query: "" });
          persistSelection();
        }
      }
      const { place } = get();
      // Docked: "open the notes" means "take me to the tab", not a sheet
      // over it (which would mount a second surface on top of the first).
      if (place.kind === "tab") {
        revealDock(place);
        return;
      }
      set({ open: true });
      persist(KV_OPEN, "true");
    },

    closeView: () => {
      get().flush();
      set({ open: false, wantsFocus: null });
      persist(KV_OPEN, "false");
    },

    toggleView: () => {
      // A docked notebook has no "toggle": the shortcut reveals the tab and
      // its X is what closes it. Everywhere else, the toggle of always.
      if (get().place.kind === "tab" && !get().open) get().openView();
      else if (get().open) get().closeView();
      else get().openView();
    },

    dockTo: (groupId, slot) => {
      const before = get().place;
      const place: NotesPlace = { kind: "tab", groupId, slot: Math.max(0, slot) };
      set({ place, open: false, wantsFocus: null });
      persistPlace(place);
      persist(KV_OPEN, "false");
      // Moving between panes leaves the old bar pointing at the tab.
      if (before.kind === "tab" && (before.groupId !== groupId || before.slot !== slot)) {
        repairSlot(before.groupId, before.slot);
      }
      useProjects.getState().setActiveTab(groupId, slot, NOTES_TAB_ID);
      useUI.getState().focusTerminal(null, slot);
    },

    dockHere: () => {
      const projects = useProjects.getState();
      const groupId = projects.activeGroupId;
      if (!groupId) {
        useUI.getState().showToast("Abra um grupo antes de pôr as anotações numa aba.");
        return false;
      }
      if (projects.layoutOf(groupId).surface === "canvas") {
        useUI
          .getState()
          .showToast(
            "Este grupo está mostrando o canvas, que não tem barra de abas — volte para os painéis ou use a área central.",
          );
        return false;
      }
      // The pane the user is looking at — same rule the file editor uses to
      // pick where a file opens.
      const { focusedTerminalId, focusedSlot } = useUI.getState();
      const focused = focusedTerminalId ? projects.terminal(focusedTerminalId) : undefined;
      const slot = Math.max(0, focused?.groupId === groupId ? focused.slot : focusedSlot);
      get().dockTo(groupId, slot);
      return true;
    },

    closeDock: () => {
      const { place } = get();
      if (place.kind !== "tab") return;
      get().flush();
      set({ place: { kind: "overlay" }, open: false, wantsFocus: null });
      persistPlace({ kind: "overlay" });
      persist(KV_OPEN, "false");
      repairSlot(place.groupId, place.slot);
    },

    setPlaceKind: (kind) => {
      const before = get().place;
      if (before.kind === kind && get().open) return;
      const place: NotesPlace = { kind };
      // "Show it there" is the gesture — the notebook stays on screen.
      set({ place, open: true });
      persistPlace(place);
      persist(KV_OPEN, "true");
      if (before.kind === "tab") repairSlot(before.groupId, before.slot);
    },

    prune: () => {
      const { place } = get();
      if (place.kind !== "tab") return;
      if (useProjects.getState().groups.some((g) => g.id === place.groupId)) return;
      set({ place: { kind: "overlay" } });
      persistPlace({ kind: "overlay" });
    },

    dropGroups: (groupIds) => {
      const { place } = get();
      if (place.kind !== "tab") return;
      const outside = new Set(groupIds);
      if (!outside.has(place.groupId)) return;
      // The group took the pane with it — nothing to repair, only the fall
      // back to the overlay (closed: losing a group must not pop a sheet).
      set({ place: { kind: "overlay" }, open: false });
      persistPlace({ kind: "overlay" });
      persist(KV_OPEN, "false");
    },

    select: (collection) => {
      set({ collection });
      persistSelection();
    },

    setActive: (id) => {
      set({ activeId: id });
      persistSelection();
    },

    setQuery: (query) => set({ query }),

    setSort: (sort) => {
      set({ sort });
      persist(KV_SORT, sort);
    },

    setShowResolved: (value) => {
      set({ showResolved: value });
      persist(KV_RESOLVED, String(value));
    },

    setMdMode: (mdMode) => {
      set({ mdMode });
      persist(KV_MD_MODE, mdMode);
    },

    setRailW: (w, commit) => {
      set({ railW: w });
      if (commit) persist(KV_RAIL_W, String(w));
    },

    setListW: (w, commit) => {
      set({ listW: w });
      if (commit) persist(KV_LIST_W, String(w));
    },

    clearFocus: () => set({ wantsFocus: null }),

    focusSearch: () => set({ wantsFocus: "search" }),

    // --- notes ---

    createNote: () => {
      const { collection } = get();
      const now = Date.now();
      const note: Note = {
        id: nanoid(12),
        title: "",
        body: "",
        notebookId: collection.kind === "book" ? collection.id : null,
        tags: collection.kind === "tag" ? [collection.id] : [],
        // Born already matching where the user is looking — except resolved
        // statuses: nobody writes a note that starts finished.
        status:
          collection.kind === "status" &&
          (collection.status === "active" || collection.status === "paused")
            ? collection.status
            : "none",
        pinned: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      const inHiddenCollection = collection.kind === "trash";
      set({
        notes: [note, ...get().notes],
        activeId: note.id,
        wantsFocus: "title",
        ...(inHiddenCollection ? { collection: { kind: "all" } as Collection } : {}),
      });
      persistNote(note);
      persistSelection();
      return note.id;
    },

    updateNote: (id, patch) => {
      patchNote(id, patch, { debounce: true });
    },

    setNoteBook: (id, notebookId) => patchNote(id, { notebookId }),

    setNoteStatus: (id, status) => patchNote(id, { status }),

    setNoteTags: (id, tagIds) => patchNote(id, { tags: tagIds }),

    // Pin is arrangement, not content: the row must not jump in a list
    // sorted by edit just because it was pinned.
    togglePin: (id) => {
      const note = get().notes.find((n) => n.id === id);
      if (note) patchNote(id, { pinned: !note.pinned }, { touch: false });
    },

    duplicateNote: (id) => {
      const src = get().notes.find((n) => n.id === id);
      if (!src) return null;
      const now = Date.now();
      const copy: Note = {
        ...src,
        id: nanoid(12),
        title: src.title ? `${src.title} (cópia)` : "",
        pinned: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      set({ notes: [copy, ...get().notes], activeId: copy.id });
      persistNote(copy);
      persistSelection();
      return copy.id;
    },

    toggleNoteTask: (id, line) => {
      const note = get().notes.find((n) => n.id === id);
      if (!note) return;
      const lines = note.body.split("\n");
      const target = lines[line];
      if (target === undefined) return;
      const replaced = target.replace(
        /^(\s*[-*+]\s+\[)([ xX])(\])/,
        (_m, a: string, mark: string, c: string) => `${a}${mark === " " ? "x" : " "}${c}`,
      );
      if (replaced === target) return;
      lines[line] = replaced;
      patchNote(id, { body: lines.join("\n") });
    },

    trashNote: (id) => {
      patchNote(id, { deletedAt: Date.now() }, { touch: false });
    },

    restoreNote: (id) => {
      patchNote(id, { deletedAt: null }, { touch: false });
    },

    deleteForever: (id) => {
      const timer = timers.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.delete(id);
      }
      set({
        notes: get().notes.filter((n) => n.id !== id),
        ...(get().activeId === id ? { activeId: null } : {}),
      });
      runBackground(() => ipc.noteDelete(id), {
        error: (e) => {
          console.warn("[yard] não consegui excluir a nota", e);
          set({ saveError: String(e) });
        },
      });
    },

    emptyTrash: () => {
      for (const n of get().notes) {
        if (n.deletedAt !== null) get().deleteForever(n.id);
      }
    },

    flush: () => {
      for (const id of [...timers.keys()]) saveNow(id);
    },

    // --- notebooks ---

    addNotebook: (name, parentId) => {
      const siblings = get().notebooks.filter((n) => n.parentId === parentId);
      const nb: Notebook = {
        id: nanoid(10),
        name: name.trim() || "Novo caderno",
        parentId,
        icon: null,
        sort: siblings.reduce((m, n) => Math.max(m, n.sort), -1) + 1,
      };
      set({ notebooks: [...get().notebooks, nb] });
      persistNotebook(nb);
      return nb.id;
    },

    renameNotebook: (id, name) => {
      const clean = name.trim();
      if (!clean) return;
      const notebooks = get().notebooks.map((n) =>
        n.id === id ? { ...n, name: clean } : n,
      );
      set({ notebooks });
      const nb = notebooks.find((n) => n.id === id);
      if (nb) persistNotebook(nb);
    },

    setNotebookIcon: (id, icon) => {
      const notebooks = get().notebooks.map((n) => (n.id === id ? { ...n, icon } : n));
      set({ notebooks });
      const nb = notebooks.find((n) => n.id === id);
      if (nb) persistNotebook(nb);
    },

    deleteNotebook: (id) => {
      const { notebooks, notes, collection } = get();
      const target = notebooks.find((n) => n.id === id);
      if (!target) return;
      const parent = target.parentId;
      // Children climb one level; the notes of *this* notebook follow them.
      // Nothing is lost by deleting a notebook — that is what the trash is for.
      const children = notebooks.filter((n) => n.parentId === id);
      const added = notebooks
        .filter((n) => n.id !== id)
        .map((n) => (n.parentId === id ? { ...n, parentId: parent } : n));
      const changedNotes = notes.filter((n) => n.notebookId === id);
      set({
        notebooks: added,
        notes: notes.map((n) => (n.notebookId === id ? { ...n, notebookId: parent } : n)),
        ...(collection.kind === "book" && collection.id === id
          ? { collection: parent ? ({ kind: "book", id: parent } as Collection) : { kind: "all" } }
          : {}),
      });
      for (const child of children) persistNotebook({ ...child, parentId: parent });
      for (const note of changedNotes) {
        const currentValue = get().notes.find((n) => n.id === note.id);
        if (currentValue) persistNote(currentValue);
      }
      runBackground(() => ipc.notebookDelete(id), {
        error: (e) => {
          console.warn("[yard] não consegui excluir o caderno", e);
          set({ saveError: String(e) });
        },
      });
      persistSelection();
    },

    // --- tags ---

    ensureTag: (name) => {
      const clean = name.trim();
      if (!clean) return null;
      const existing = get().tags.find((t) => fold(t.name) === fold(clean));
      if (existing) return existing.id;
      const tag: NoteTag = {
        id: nanoid(10),
        name: clean,
        color: nextTagColor(get().tags),
        sort: get().tags.reduce((m, t) => Math.max(m, t.sort), -1) + 1,
      };
      set({ tags: [...get().tags, tag] });
      persistTag(tag);
      return tag.id;
    },

    renameTag: (id, name) => {
      const clean = name.trim();
      if (!clean) return;
      const tags = get().tags.map((t) => (t.id === id ? { ...t, name: clean } : t));
      set({ tags });
      const tag = tags.find((t) => t.id === id);
      if (tag) persistTag(tag);
    },

    setTagColor: (id, color) => {
      const tags = get().tags.map((t) => (t.id === id ? { ...t, color } : t));
      set({ tags });
      const tag = tags.find((t) => t.id === id);
      if (tag) persistTag(tag);
    },

    deleteTag: (id) => {
      const { tags, notes, collection } = get();
      const notesWithIt = notes.filter((n) => n.tags.includes(id));
      set({
        tags: tags.filter((t) => t.id !== id),
        notes: notes.map((n) =>
          n.tags.includes(id) ? { ...n, tags: n.tags.filter((t) => t !== id) } : n,
        ),
        ...(collection.kind === "tag" && collection.id === id
          ? { collection: { kind: "all" } as Collection }
          : {}),
      });
      for (const note of notesWithIt) {
        const current = get().notes.find((n) => n.id === note.id);
        if (current) persistNote(current);
      }
      runBackground(() => ipc.noteTagDelete(id), {
        error: (e) => {
          console.warn("[yard] não consegui excluir a etiqueta", e);
          set({ saveError: String(e) });
        },
      });
      persistSelection();
    },
  };
});

/** Notebook ids that would create a cycle if `id` were moved under them. */
export function invalidParentsFor(notebooks: readonly Notebook[], id: string): Set<string> {
  return descendantsOf(notebooks, id);
}
