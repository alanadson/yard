/**
 * File explorer and editor — the project tree (the bench's "Files" tab) and
 * the documents open in the editor.
 *
 * What this store solves, beyond holding text:
 *
 * - **The tree is lazy.** Each directory is read when it opens, and the
 *   listing is cached by path. A project with `node_modules` costs nothing
 *   as long as nobody expands the folder.
 * - **The disk belongs to someone else.** Here agents edit the same files all
 *   the time: the watcher feed (`files://activity`) reloads on its own
 *   whatever is open and untouched, marks as "changed on disk" whatever has a
 *   draft, and warns when a file disappears. Saving compares the mtime — if
 *   the disk moved underneath, the write stops and the user decides.
 * - **Closing loses nothing.** The documents live in the store, not in the
 *   overlay: closing the editor (Esc) and reopening gives the draft back
 *   where it was.
 */
import { create } from "zustand";

import {
  ipc,
  type DirEntryInfo,
  type FilesActivity,
} from "../lib/ipc";
import { uiLog } from "../lib/log";
import { toggleTaskLine } from "../lib/mdedit";
import { splitPath } from "../lib/paths";
import { persistPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";
import { rootedPathKey, sameRoot } from "../lib/roots";
import { useProjects } from "./projectsStore";
import { useUI } from "./uiStore";

/** A file open in the editor. */
export interface OpenDoc {
  /** Root + relative path. A path by itself is not unique across floors. */
  id: string;
  projectId: string | null;
  /**
   * Where the tab lives: the group and the pane that were in focus when the
   * file was opened. A document is a tab **next to the CLIs**, in the same
   * bar and at the same size, so it needs the same two coordinates a
   * terminal has. `null` = opened with no group (only the canvas overlay can
   * show it).
   */
  groupId: string | null;
  slot: number;
  root: string;
  /** Relative to the root, with `/`. */
  path: string;
  /** The buffer — what is on screen. */
  text: string;
  /** What was on disk at the last read/write. */
  saved: string;
  /** Changes only when fresh contents arrive from disk, not on each key. */
  diskVersion: number;
  modifiedAt: number;
  crlf: boolean;
  /** The file on disk starts with a UTF-8 BOM — the save puts it back. */
  bom: boolean;
  binary: boolean;
  truncated: boolean;
  /** Bytes on disk are not valid UTF-8 — the buffer is a lossy decode. */
  lossy: boolean;
  /** Size on disk, in bytes — the only measure a binary file has. */
  size: number;
  /**
   * MIME type when the file has a face of its own (`image/png`, `video/mp4`,
   * `application/pdf`). `null` = text, or a binary nobody can draw.
   */
  media: string | null;
  /** Changed on disk while there was a draft here. */
  stale: boolean;
  /** Was deleted (or moved) from outside. */
  missing: boolean;
  /** Error from the last write, if any. */
  error: string | null;
  saving: boolean;
}

/**
 * How a markdown file is shown. One setting for the whole editor, not per
 * file: someone who reads their docs rendered reads *all* of them rendered,
 * and a mode that reset per tab would be a switch you press forever.
 *
 * - `live` — the source, drawn like the document (markers fade off the lines
 *   you are not on). The default: it edits like a text file and reads like a
 *   page.
 * - `source` — raw markdown, nothing hidden. What an agent sees.
 * - `split` — writing on the left, rendered on the right, scrolling together.
 * - `read` — the rendered document alone, the whole width.
 */
export type MdMode = "live" | "source" | "split" | "read";

const MD_MODES: MdMode[] = ["live", "source", "split", "read"];

/**
 * Which tabs a cleanup is about. A document hangs from a pane (`groupId`) and
 * from a project (`projectId`), and both can leave the workspace under the
 * user — deleting a group, removing a project, ending a floor.
 */
export interface DocScope {
  groupId?: string;
  projectId?: string;
}

/** Does this tab belong to the group/project being taken down? */
function inScope(d: OpenDoc, scope: DocScope): boolean {
  if (scope.groupId !== undefined && d.groupId === scope.groupId) return true;
  if (scope.projectId !== undefined && d.projectId === scope.projectId) return true;
  return false;
}

export const isDirty = (d: OpenDoc) => d.text !== d.saved;
/** Truncated or binary cannot be saved — writing would cut off the rest. */
export const isReadOnly = (d: OpenDoc) => d.binary || d.truncated || d.lossy;

export const docId = rootedPathKey;

/** Parent directory of a relative path (`""` at the root). */
export function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/** The whole directory lineage of a path, from the root inward. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (const p of parts) out.push(out.length ? `${out[out.length - 1]}/${p}` : p);
  return out;
}

/** Joins directory and name without a double slash at the root. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Wait before re-reading directories the watcher touched — the feed arrives in bursts. */
const REFRESH_DEBOUNCE_MS = 350;

/**
 * Was this document moved by a rename of `path` (the file itself, or anything
 * under it as a directory)?
 */
function movedBy(doc: Pick<OpenDoc, "path">, path: string): boolean {
  return doc.path === path || doc.path.startsWith(`${path}/`);
}

/**
 * Tabs the rename is about to displace.
 *
 * The backend only refuses a rename whose destination exists **on disk**, so
 * `a.ts → b.ts` goes through while a tab for an already-deleted `b.ts` is
 * still open — and remapping ids then produced two documents sharing one id:
 * two React children with the same key, and two tabs the bar cannot tell
 * apart. The displaced one is the stale tab, pointing at a file that is gone;
 * the renamed one is the tab now backed by a real file, so that is the one
 * that keeps the address.
 */
function displacedByRename(
  docs: OpenDoc[],
  root: string,
  path: string,
  newPath: string,
): Set<string> {
  const incoming = new Set(
    docs
      .filter((d) => sameRoot(d.root, root) && movedBy(d, path))
      .map((d) => docId(d.root, `${newPath}${d.path.slice(path.length)}`)),
  );
  return new Set(
    docs
      .filter(
        (d) => sameRoot(d.root, root) && !movedBy(d, path) && incoming.has(d.id),
      )
      .map((d) => d.id),
  );
}

// --- surviving a reload -----------------------------------------------------
//
// The documents used to live only in memory. Closing the window was covered
// (`App.tsx` intercepts `onCloseRequested`, lists the dirty files and asks),
// but **F5, a webview reload and HMR do not go through that path** — and an
// unsaved buffer died there without a word. Meanwhile a three-word review note
// was being written to kv on every keystroke.
//
// Only the draft is stored, never a clean buffer: what matches the disk can be
// read back from the disk. That keeps the record small and makes the restore
// able to tell "the disk moved underneath while the app was gone".

const KV_DOCS = "editor.docs";
const KV_ACTIVE = "editor.active";
const KV_OPEN = "editor.open";
const KV_MD_MODE = "editor.mdMode";
const KV_OUTLINE = "editor.outline";
const KV_WRAP = "editor.wrap";

/** A draft this size is pathological; the kv is not a file system. */
const DRAFT_CAP = 1_000_000;
/** Total budget across all tabs, oldest-first until it fits. */
const DRAFTS_TOTAL_CAP = 4_000_000;
/** The buffer changes on every keystroke; the write does not need to. */
const PERSIST_DEBOUNCE_MS = 500;

interface StoredDoc {
  projectId: string | null;
  groupId: string | null;
  slot: number;
  root: string;
  path: string;
  /** Stamp of the last read/write — restore compares it with the disk. */
  modifiedAt: number;
  crlf: boolean;
  bom: boolean;
  /** Present only when the tab had unsaved text. */
  draft?: string;
}

export function parseStoredDocs(raw: string | undefined): StoredDoc[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .filter((d) => typeof d.root === "string" && typeof d.path === "string")
      .map((d) => ({
        projectId: typeof d.projectId === "string" ? d.projectId : null,
        groupId: typeof d.groupId === "string" ? d.groupId : null,
        slot: typeof d.slot === "number" ? d.slot : 0,
        root: d.root as string,
        path: d.path as string,
        modifiedAt: typeof d.modifiedAt === "number" ? d.modifiedAt : 0,
        crlf: d.crlf === true,
        bom: d.bom === true,
        draft: typeof d.draft === "string" ? d.draft : undefined,
      }));
  } catch {
    return [];
  }
}

/** Serializes the open tabs, dropping drafts that blow the budget. */
export function serializeDocs(docs: OpenDoc[]): string {
  let budget = DRAFTS_TOTAL_CAP;
  const out: StoredDoc[] = docs.map((d) => {
    const base: StoredDoc = {
      projectId: d.projectId,
      groupId: d.groupId,
      slot: d.slot,
      root: d.root,
      path: d.path,
      modifiedAt: d.modifiedAt,
      crlf: d.crlf,
      bom: d.bom,
    };
    if (!isDirty(d) || isReadOnly(d)) return base;
    if (d.text.length > DRAFT_CAP || d.text.length > budget) {
      uiLog.warn(`rascunho de ${d.path} grande demais para o autosave — só a aba foi guardada`);
      return base;
    }
    budget -= d.text.length;
    return { ...base, draft: d.text };
  });
  return JSON.stringify(out);
}

const write = (key: string, value: string) =>
  persistPref(key, value, (error) =>
    uiLog.warn(`não consegui gravar ${key}: ${error}`),
  );

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Distinguishes two jumps to the same line of the same file. */
let revealTick = 0;
/** One index walk at a time — a second call while one runs just waits its turn. */
let indexBuilding = false;

interface EditorState {
  /** Project and root the tree is showing (the active floor's worktree). */
  projectId: string | null;
  root: string | null;

  /** Listing per directory (`""` = root). */
  dirs: Record<string, DirEntryInfo[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  /** Read error per directory (permission denied, directory gone). */
  dirError: Record<string, string>;
  /**
   * Items the backend refused to list per directory, past its cap. Kept
   * because a truncated listing that says nothing reads as a complete one:
   * the file simply is not there, and the user concludes it does not exist.
   */
  dirDropped: Record<string, number>;
  /** Name filter, applied to the directories already loaded. */
  filter: string;

  docs: OpenDoc[];
  activeId: string | null;
  /** The editor (overlay) is open. */
  open: boolean;
  /**
   * A pending "put the caret here" — how a search hit (or anything else that
   * knows a line) lands *inside* the file it just opened. The editing surface
   * consumes it and clears it; `tick` distinguishes two jumps to the same line.
   */
  reveal: { id: string; line: number; tick: number } | null;
  /**
   * Every file path under the root — what lets Ctrl+P offer a file nobody has
   * browsed to. `null` = not built yet; `indexStale` = the watcher saw files
   * being born or dying since, so the next use rebuilds.
   */
  fileIndex: string[] | null;
  indexTruncated: boolean;
  indexStale: boolean;
  /**
   * Line wrapping in the editor. Remembered across sessions like `mdMode` and
   * the outline rail beside it: it is how the user reads, not something about
   * a particular file, and a `.log` of 400 columns came back running off the
   * right edge at every boot.
   */
  wrap: boolean;
  /** The tree rail inside the editor. */
  rail: boolean;
  /** How markdown files open — see `MdMode`. Remembered across sessions. */
  mdMode: MdMode;
  /** The heading rail on the right of a markdown file. */
  outline: boolean;

  setRoot: (projectId: string | null, root: string | null) => void;
  setFilter: (filter: string) => void;
  loadDir: (path: string, force?: boolean) => Promise<void>;
  toggleDir: (path: string) => void;
  refreshTree: () => void;

  openFile: (path: string) => Promise<void>;
  /** Opens the file and asks the surface to land the caret on `line` (1-based). */
  openFileAt: (path: string, line: number) => Promise<void>;
  /** The surface applied (or gave up on) the pending reveal. */
  clearReveal: () => void;
  /** Builds (or rebuilds, when stale) the quick-open index of the root. */
  ensureFileIndex: () => Promise<void>;
  closeEditor: () => void;
  setActive: (id: string) => void;
  /**
   * Moves the tab to another pane (or another position in the same bar),
   * landing right before the doc `beforeId` — or at the end of that pane's
   * section when `beforeId` is null. The dragged tab becomes the pane's
   * active one, same as a terminal dropped there.
   */
  moveDoc: (
    id: string,
    groupId: string,
    slot: number,
    beforeId?: string | null,
  ) => void;
  closeDoc: (id: string) => void;
  /** Open docs of a group/project that still hold text nobody saved. */
  unsavedOf: (scope: DocScope) => OpenDoc[];
  /** Drops every tab of a group/project that is leaving the workspace. */
  dropScope: (scope: DocScope) => void;
  setText: (id: string, text: string) => void;
  save: (id: string) => Promise<boolean>;
  saveAll: () => Promise<void>;
  /** Discards the draft and re-reads from disk. */
  reload: (id: string) => Promise<void>;
  /** Writes over even with the disk changed (the user chose to). */
  overwrite: (id: string) => Promise<boolean>;
  setWrap: (wrap: boolean) => void;
  setRail: (rail: boolean) => void;
  setMdMode: (mode: MdMode) => void;
  setOutline: (outline: boolean) => void;
  /** Ticks or unticks the task on a source line — the preview's checkbox. */
  toggleTask: (id: string, line: number) => void;

  createEntry: (dir: string, name: string, isDir: boolean) => Promise<void>;
  renameEntry: (path: string, newPath: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;

  /** Reacts to the watcher feed: re-reads directories and syncs what is open. */
  applyActivity: (p: FilesActivity) => void;

  /** Brings back the tabs and drafts a reload would otherwise have eaten. */
  restore: (prefs?: PrefsSnapshot) => Promise<void>;
  /** Writes the tabs and drafts to kv (debounced). */
  persist: () => void;
}

const pendingDirs = new Set<string>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let treeGeneration = 0;

// --- where a file's tab goes ------------------------------------------------
//
// A document is a tab in the **same bar as the CLIs**, in the pane that had
// focus — that is the whole point of it not being a modal window: the file
// sits next to the agent editing it, at the same size, and switching between
// the two is one click in a bar you were already using.
//
// The canvas is the exception with no tab bar to put it in: there the editor
// still opens as the big overlay (`open`), which is also what `Esc` closes.

interface TabTarget {
  groupId: string | null;
  slot: number;
  /** No tab bar to land in (canvas mode, or no group at all). */
  overlay: boolean;
}

function tabTarget(): TabTarget {
  const { activeGroupId, layoutOf } = useProjects.getState();
  if (!activeGroupId) return { groupId: null, slot: 0, overlay: true };
  const { focusedTerminalId, focusedSlot } = useUI.getState();
  const focused = focusedTerminalId
    ? useProjects.getState().terminal(focusedTerminalId)
    : undefined;
  const slot = focused?.groupId === activeGroupId ? focused.slot : focusedSlot;
  return {
    groupId: activeGroupId,
    slot: Math.max(0, slot),
    overlay: layoutOf(activeGroupId).surface === "canvas",
  };
}

/** Selects the document's tab in its pane, unless it is the overlay's job. */
function showTab(
  groupId: string | null,
  slot: number,
  id: string,
  target: TabTarget,
): void {
  if (target.overlay || !groupId) return;
  useProjects.getState().setActiveTab(groupId, slot, id);
  // Focus leaves the terminal — otherwise the keyboard would keep typing into
  // a CLI that is no longer the thing on screen.
  useUI.getState().focusTerminal(null, slot);
}

export const useEditor = create<EditorState>((set, get) => {
  /** Applies a patch to one open document, without touching the others. */
  const patchDoc = (id: string, patch: Partial<OpenDoc>) => {
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }));
    // Every buffer change funnels through here, so this is the one place the
    // autosave has to hang from.
    get().persist();
  };

  /**
   * Reconciles a document with disk without overwriting a draft that appeared
   * while the read was in flight. Shared by watcher events and root switches.
   */
  const syncDocFromDisk = async (id: string) => {
    const before = get().docs.find((d) => d.id === id);
    if (!before) return;
    try {
      const file = await ipc.fsReadText(before.root, before.path);
      const current = get().docs.find((d) => d.id === id);
      if (!current || current.root !== before.root || current.path !== before.path) return;
      if (isDirty(current)) {
        patchDoc(id, {
          stale: file.modifiedAt !== current.modifiedAt || file.text !== current.saved,
          missing: false,
          error: null,
        });
        return;
      }
      patchDoc(id, {
        text: file.text,
        saved: file.text,
        diskVersion: current.diskVersion + 1,
        modifiedAt: file.modifiedAt,
        crlf: file.crlf,
        bom: file.bom,
        binary: file.binary,
        truncated: file.truncated,
        lossy: file.lossy,
        size: file.size,
        media: file.media,
        stale: false,
        missing: false,
        error: null,
      });
    } catch (error) {
      if (get().docs.some((d) => d.id === id)) {
        patchDoc(id, { missing: true, error: String(error) });
      }
    }
  };

  /** Re-reads from disk the directories the watcher touched, in a single burst. */
  const flushDirs = () => {
    refreshTimer = null;
    const targets = [...pendingDirs];
    pendingDirs.clear();
    const { dirs } = get();
    for (const dir of targets) {
      if (dirs[dir]) void get().loadDir(dir, true);
    }
  };

  const queueDir = (dir: string) => {
    pendingDirs.add(dir);
    if (refreshTimer) return;
    refreshTimer = setTimeout(flushDirs, REFRESH_DEBOUNCE_MS);
  };

  return {
    projectId: null,
    root: null,
    dirs: {},
    expanded: {},
    loading: {},
    dirError: {},
    dirDropped: {},
    filter: "",
    docs: [],
    activeId: null,
    open: false,
    reveal: null,
    fileIndex: null,
    indexTruncated: false,
    indexStale: false,
    wrap: false,
    rail: true,
    mdMode: "live",
    outline: false,

    setRoot: (projectId, root) => {
      if (sameRoot(get().root, root) && get().projectId === projectId) return;
      // Switching projects resets the tree, but **not** the open documents:
      // an unsaved draft must not vanish because someone clicked another
      // project in the sidebar. They keep pointing at the old root until they
      // are closed; each `OpenDoc.root` records where it came from.
      treeGeneration++;
      pendingDirs.clear();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      set({
        projectId,
        root,
        dirs: {},
        expanded: {},
        loading: {},
        dirError: {},
        dirDropped: {},
        // Another root, another repo: the old index answers about the old one.
        fileIndex: null,
        indexTruncated: false,
        indexStale: false,
      });
      if (root) {
        void get().loadDir("");
        for (const doc of get().docs) {
          if (sameRoot(doc.root, root)) void syncDocFromDisk(doc.id);
        }
      }
    },

    setFilter: (filter) => set({ filter }),

    loadDir: async (path, force = false) => {
      const { root, dirs, loading } = get();
      if (!root) return;
      if (loading[path]) return;
      if (dirs[path] && !force) return;

      const generation = treeGeneration;
      set((s) => ({ loading: { ...s.loading, [path]: true } }));
      try {
        const listing = await ipc.fsListDir(root, path);
        if (generation !== treeGeneration || !sameRoot(get().root, root)) return;
        set((s) => {
          const dirError = { ...s.dirError };
          delete dirError[path];
          const dirDropped = { ...s.dirDropped };
          // Only carry the key while there is something to say — the tree
          // checks for a truthy value, not for the key's presence.
          if (listing.dropped > 0) dirDropped[path] = listing.dropped;
          else delete dirDropped[path];
          return { dirs: { ...s.dirs, [path]: listing.entries }, dirError, dirDropped };
        });
      } catch (e) {
        if (generation !== treeGeneration || !sameRoot(get().root, root)) return;
        set((s) => ({ dirError: { ...s.dirError, [path]: String(e) } }));
        uiLog.warn(`não consegui listar ${path || "a raiz"}: ${e}`);
      } finally {
        if (generation !== treeGeneration || !sameRoot(get().root, root)) return;
        set((s) => ({ loading: { ...s.loading, [path]: false } }));
      }
    },

    toggleDir: (path) => {
      const isExpanded = get().expanded[path];
      set((s) => ({ expanded: { ...s.expanded, [path]: !isExpanded } }));
      if (!isExpanded) void get().loadDir(path);
    },

    refreshTree: () => {
      for (const path of Object.keys(get().dirs)) void get().loadDir(path, true);
    },

    // --- documents ----------------------------------------------------------

    openFile: async (path) => {
      const { root, projectId, docs } = get();
      if (!root) return;
      const id = docId(root, path);
      const target = tabTarget();

      // The tree reveals the opened path, even when it comes from outside
      // (changes panel, live feed).
      const lineage = ancestors(path);
      if (lineage.length) {
        set((s) => {
          const expanded = { ...s.expanded };
          for (const dir of lineage) expanded[dir] = true;
          return { expanded };
        });
        for (const dir of lineage) void get().loadDir(dir);
      }

      const isOpen = docs.find((d) => d.id === id);
      if (isOpen) {
        // Already open: bring its tab to the front where it already lives —
        // moving it to another pane because it was clicked from elsewhere
        // would take the file away from the split the user built.
        showTab(isOpen.groupId, isOpen.slot, id, target);
        set({ activeId: id, open: target.overlay });
        return;
      }

      try {
        const file = await ipc.fsReadText(root, path);
        if (!sameRoot(get().root, root)) return;
        // The read may finish after another attempt on the same file.
        if (get().docs.some((d) => d.id === id)) {
          set({ activeId: id, open: target.overlay });
          return;
        }
        set((s) => ({
          docs: [
            ...s.docs,
            {
              id,
              projectId,
              groupId: target.groupId,
              slot: target.slot,
              root,
              path,
              text: file.text,
              saved: file.text,
              diskVersion: 1,
              modifiedAt: file.modifiedAt,
              crlf: file.crlf,
              bom: file.bom,
              binary: file.binary,
              truncated: file.truncated,
              lossy: file.lossy,
              size: file.size,
              media: file.media,
              stale: false,
              missing: false,
              error: null,
              saving: false,
            },
          ],
          activeId: id,
          open: target.overlay,
        }));
        showTab(target.groupId, target.slot, id, target);
        get().persist();
      } catch (e) {
        uiLog.warn(`não consegui abrir ${path}: ${e}`);
        throw e;
      }
    },

    openFileAt: async (path, line) => {
      const { root } = get();
      if (!root) return;
      await get().openFile(path);
      // Set *after* the open resolved: the surface consumes it on mount/switch,
      // and setting it first would let a failed open leave a ghost jump behind.
      revealTick += 1;
      set({ reveal: { id: docId(root, path), line, tick: revealTick } });
    },

    clearReveal: () => set({ reveal: null }),

    ensureFileIndex: async () => {
      const { root, fileIndex, indexStale } = get();
      if (!root || indexBuilding) return;
      if (fileIndex && !indexStale) return;
      indexBuilding = true;
      try {
        const index = await ipc.fsIndexFiles(root);
        // The walk may outlive a project switch; the answer is about old news.
        if (!sameRoot(get().root, root)) return;
        set({
          fileIndex: index.paths,
          indexTruncated: index.truncated,
          indexStale: false,
        });
      } catch (e) {
        uiLog.warn(`não consegui indexar os arquivos do projeto: ${e}`);
      } finally {
        indexBuilding = false;
      }
    },

    closeEditor: () => {
      set({ open: false });
      get().persist();
    },
    /**
     * Which document the editor is on. Deliberately *not* raising the
     * overlay: this is also what the pane's tab bar calls, and a click on a
     * tab must not throw a modal window over the pane it lives in.
     */
    setActive: (id) => {
      const doc = get().docs.find((d) => d.id === id);
      set({ activeId: id });
      if (doc?.groupId) {
        useProjects.getState().setActiveTab(doc.groupId, doc.slot, id);
        useUI.getState().focusTerminal(null, doc.slot);
      }
      get().persist();
    },

    moveDoc: (id, groupId, slot, beforeId = null) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc || beforeId === id) return;
      if (doc.groupId === groupId && doc.slot === slot && beforeId === null) return;
      set((s) => {
        // Per-pane order is the array order: putting the doc right before
        // `beforeId` (a tab of the target pane) lands it there in that pane's
        // slice; the global end is every pane's end.
        const rest = s.docs.filter((d) => d.id !== id);
        let i = beforeId ? rest.findIndex((d) => d.id === beforeId) : -1;
        if (i < 0) i = rest.length;
        return {
          docs: [
            ...rest.slice(0, i),
            { ...doc, groupId, slot },
            ...rest.slice(i),
          ],
          activeId: id,
        };
      });
      useProjects.getState().setActiveTab(groupId, slot, id);
      useUI.getState().focusTerminal(null, slot);
      get().persist();
    },

    closeDoc: (id) => {
      const isClosed = get().docs.find((d) => d.id === id) ?? null;
      set((s) => {
        const docs = s.docs.filter((d) => d.id !== id);
        if (s.activeId !== id) return { docs };
        // Closed the active tab: go to the neighbor on the right, as in VS Code.
        const idx = s.docs.findIndex((d) => d.id === id);
        const following = docs[Math.min(idx, docs.length - 1)] ?? null;
        return {
          docs,
          activeId: following?.id ?? null,
          open: docs.length > 0 && s.open,
        };
      });
      // The pane's bar pointed at this tab: hand it to the neighbour in the
      // same pane, document or CLI, before it points at nothing.
      if (isClosed?.groupId) {
        const { layoutOf, setActiveTab, terminalsOn } = useProjects.getState();
        if (layoutOf(isClosed.groupId).activeBySlot[isClosed.slot] === id) {
          const otherDoc = get().docs.find(
            (d) => d.groupId === isClosed.groupId && d.slot === isClosed.slot,
          );
          const terminal = terminalsOn(isClosed.groupId, "grid").find(
            (t) => t.slot === isClosed.slot,
          );
          if (otherDoc) {
            setActiveTab(isClosed.groupId, isClosed.slot, otherDoc.id);
          } else if (terminal) {
            setActiveTab(isClosed.groupId, isClosed.slot, terminal.id);
            useUI.getState().focusTerminal(terminal.id, isClosed.slot);
          }
        }
      }
      get().persist();
    },

    unsavedOf: (scope) =>
      get().docs.filter((d) => inScope(d, scope) && isDirty(d) && !isReadOnly(d)),

    /**
     * The group/project is leaving the workspace and its tabs go with it.
     *
     * Every other store already had this and the editor was the one left out:
     * the bench drops its tasks (`dropProject`), the review drops its
     * annotations (`clearProject`), the changes panel drops feed and watcher.
     * The documents stayed, pointing at a `groupId` nothing resolves — so the
     * pane grid (which slices tabs by group) never drew them again, while the
     * close-the-window warning went on counting them and the kv went on
     * restoring them at every boot. On a floor it was worse: `encerrar` deletes
     * the worktree, so the draft could not even be saved back.
     *
     * Whoever calls this is expected to have asked about `unsavedOf` first —
     * that is where the user still has a chance to keep the text.
     */
    dropScope: (scope) => {
      const closing = new Set(
        get().docs.filter((d) => inScope(d, scope)).map((d) => d.id),
      );
      if (closing.size === 0) return;
      set((s) => {
        const docs = s.docs.filter((d) => !closing.has(d.id));
        return {
          docs,
          activeId:
            s.activeId && closing.has(s.activeId)
              ? (docs[0]?.id ?? null)
              : s.activeId,
          open: docs.length > 0 && s.open,
        };
      });
      get().persist();
    },

    setText: (id, text) => patchDoc(id, { text, error: null }),

    save: async (id) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc || doc.saving) return false;
      if (isReadOnly(doc)) return false;
      if (!isDirty(doc) && !doc.missing) return true;

      patchDoc(id, { saving: true, error: null });
      try {
        // `missing` = the file vanished from disk; writing means re-creating
        // it, and then there is no previous stamp to check against.
        const written = await ipc.fsWriteText(
          doc.root,
          doc.path,
          doc.text,
          doc.missing ? null : { modifiedAt: doc.modifiedAt, size: doc.size },
          doc.crlf,
          doc.bom,
        );
        patchDoc(id, {
          saved: doc.text,
          modifiedAt: written.modifiedAt,
          // The size is half of the conflict test now, so it has to move with
          // the file — a stale one would make the next save a false conflict.
          size: written.size,
          stale: false,
          missing: false,
          error: null,
          saving: false,
        });
        return true;
      } catch (e) {
        const msg = String(e);
        patchDoc(id, {
          saving: false,
          error: msg,
          stale: msg.includes("CONFLITO") ? true : get().docs.find((d) => d.id === id)?.stale ?? false,
        });
        return false;
      }
    },

    saveAll: async () => {
      for (const doc of get().docs) {
        if (isDirty(doc) && !isReadOnly(doc)) await get().save(doc.id);
      }
    },

    reload: async (id) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc) return;
      try {
        const file = await ipc.fsReadText(doc.root, doc.path);
        patchDoc(id, {
          text: file.text,
          saved: file.text,
          diskVersion: doc.diskVersion + 1,
          modifiedAt: file.modifiedAt,
          crlf: file.crlf,
          bom: file.bom,
          binary: file.binary,
          truncated: file.truncated,
          lossy: file.lossy,
          size: file.size,
          media: file.media,
          stale: false,
          missing: false,
          error: null,
        });
      } catch (e) {
        patchDoc(id, { missing: true, error: String(e) });
      }
    },

    /**
     * Writes over whatever is on disk — the user saw the conflict and chose
     * their own text.
     *
     * `stale` is only cleared **after** the write lands. Clearing it up front
     * (as this used to, together with `modifiedAt`) meant a failed overwrite —
     * read-only file, a lock from another process — took the warning banner
     * down with it: the file still diverged from the buffer, and the only two
     * ways out of the conflict, "Recarregar" and "Salvar por cima", vanished
     * along with the explanation.
     */
    overwrite: async (id) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc || doc.saving) return false;
      // Same gate as `save`, and it was missing here: "Salvar por cima" on a
      // truncated file would write the loaded head over the whole file, and on
      // a lossy one it would write the U+FFFD in place of the real bytes.
      if (isReadOnly(doc)) return false;
      patchDoc(id, { saving: true, error: null });
      try {
        // `null` as the expected stamp is what makes this an overwrite: the
        // backend skips the mtime comparison instead of trusting a fake one.
        const written = await ipc.fsWriteText(
          doc.root,
          doc.path,
          doc.text,
          null,
          doc.crlf,
          doc.bom,
        );
        patchDoc(id, {
          saved: doc.text,
          modifiedAt: written.modifiedAt,
          size: written.size,
          stale: false,
          missing: false,
          error: null,
          saving: false,
        });
        return true;
      } catch (e) {
        // `stale` stays as it was: the disk is still ahead of the buffer.
        patchDoc(id, { saving: false, error: String(e) });
        return false;
      }
    },

    setWrap: (wrap) => {
      set({ wrap });
      get().persist();
    },
    setRail: (rail) => set({ rail }),
    setMdMode: (mdMode) => {
      set({ mdMode });
      get().persist();
    },
    setOutline: (outline) => {
      set({ outline });
      get().persist();
    },

    toggleTask: (id, line) => {
      const doc = get().docs.find((d) => d.id === id);
      if (!doc || isReadOnly(doc)) return;
      const lines = doc.text.split("\n");
      if (line < 0 || line >= lines.length) return;
      const next = toggleTaskLine(lines[line]);
      if (next === lines[line]) return;
      lines[line] = next;
      // Through `setText`, like any other edit: it becomes a draft the user
      // still has to save, and the editing surface picks the change up from
      // the store instead of the two of them writing over each other.
      get().setText(id, lines.join("\n"));
    },

    // --- tree: create, rename, delete ---------------------------------------

    createEntry: async (dir, name, isDirectory) => {
      const { root } = get();
      if (!root) return;
      const path = joinPath(dir, name.trim().replace(/\\/g, "/"));
      await ipc.fsCreateEntry(root, path, isDirectory);
      await get().loadDir(dir, true);
      if (isDirectory) {
        set((s) => ({ expanded: { ...s.expanded, [path]: true } }));
        await get().loadDir(path, true);
      } else {
        await get().openFile(path);
      }
    },

    renameEntry: async (path, newPath) => {
      const { root } = get();
      if (!root || path === newPath) return;
      await ipc.fsRenameEntry(root, path, newPath);

      // The tree comes along. Without this, `dirs`/`expanded` kept the whole
      // subtree under the **old** path: the expansion state vanished, and
      // later re-creating a directory with the old name showed the ghost
      // listing of the previous one. (`deleteEntry` already pruned; this is
      // not pruning, it is a change of address — the content still exists.)
      const renameKey = (key: string) =>
        key === path
          ? newPath
          : key.startsWith(`${path}/`)
            ? `${newPath}${key.slice(path.length)}`
            : key;

      set((s) => {
        const moveIt = <T,>(record: Record<string, T>): Record<string, T> => {
          const out: Record<string, T> = {};
          for (const [key, value] of Object.entries(record)) out[renameKey(key)] = value;
          return out;
        };
        const dirs: Record<string, DirEntryInfo[]> = {};
        for (const [key, entries] of Object.entries(s.dirs)) {
          const newKey = renameKey(key);
          dirs[newKey] =
            newKey === key
              ? entries
              : entries.map((e) => ({ ...e, path: renameKey(e.path) }));
        }
        // The parent directory lists the renamed item under its old name
        // until the re-read just below lands; remapping here keeps the row
        // from flashing the wrong text.
        const parent = parentDir(path);
        if (dirs[parent]) {
          dirs[parent] = dirs[parent].map((e) =>
            e.path === path
              ? { ...e, path: newPath, name: newPath.split("/").pop() ?? e.name }
              : e,
          );
        }
        return {
          dirs,
          expanded: moveIt(s.expanded),
          loading: moveIt(s.loading),
          dirError: moveIt(s.dirError),
          dirDropped: moveIt(s.dirDropped),
        };
      });

      // What was open follows the new path — including the files inside a
      // renamed directory. Tabs whose address the rename is taking over are
      // dropped first, so no two documents end up sharing an id.
      set((s) => {
        const displaced = displacedByRename(s.docs, root, path, newPath);
        return {
          docs: s.docs
            .filter((d) => !displaced.has(d.id))
            .map((d) =>
              sameRoot(d.root, root) && d.path === path
                ? { ...d, id: docId(d.root, newPath), path: newPath }
                : sameRoot(d.root, root) && d.path.startsWith(`${path}/`)
                  ? (() => {
                      const nextPath = `${newPath}${d.path.slice(path.length)}`;
                      return { ...d, id: docId(d.root, nextPath), path: nextPath };
                    })()
                  : d,
            ),
          activeId: (() => {
            const active = s.docs.find((d) => d.id === s.activeId);
            // The active tab was the one being displaced: the address it
            // pointed at now belongs to the renamed document, which is where
            // the selection should land.
            if (!active || displaced.has(active.id)) return s.activeId;
            if (!sameRoot(active.root, root)) return s.activeId;
            if (active.path === path) return docId(root, newPath);
            if (active.path.startsWith(`${path}/`)) {
              return docId(root, `${newPath}${active.path.slice(path.length)}`);
            }
            return s.activeId;
          })(),
        };
      });

      const before = parentDir(path);
      const after = parentDir(newPath);
      await get().loadDir(before, true);
      if (after !== before) await get().loadDir(after, true);
    },

    deleteEntry: async (path) => {
      const { root } = get();
      if (!root) return;
      await ipc.fsDeleteEntry(root, path);
      // Drop it from the tree cache along with the subdirectories it carried.
      set((s) => {
        const dirs = { ...s.dirs };
        const expanded = { ...s.expanded };
        const dirDropped = { ...s.dirDropped };
        // `dirError` too: it was the one map left behind, so a folder that had
        // failed to list kept its error under a key nothing would ever clear.
        const dirError = { ...s.dirError };
        const underDir = (key: string) => key === path || key.startsWith(`${path}/`);
        for (const key of Object.keys(dirs)) if (underDir(key)) delete dirs[key];
        for (const key of Object.keys(expanded)) if (underDir(key)) delete expanded[key];
        for (const key of Object.keys(dirDropped)) if (underDir(key)) delete dirDropped[key];
        for (const key of Object.keys(dirError)) if (underDir(key)) delete dirError[key];
        // The open tabs stay: the text is still here and can be saved back.
        // They just start announcing themselves as "gone from disk".
        const docs = s.docs.map((d) =>
          sameRoot(d.root, root) && (d.path === path || d.path.startsWith(`${path}/`))
            ? { ...d, missing: true }
            : d,
        );
        return { dirs, expanded, dirDropped, dirError, docs };
      });
      await get().loadDir(parentDir(path), true);
    },

    // --- the disk changed from outside --------------------------------------

    applyActivity: (p) => {
      const { projectId, root, docs, dirs } = get();
      if (!root || !sameRoot(root, p.root) || (projectId && p.projectId !== projectId)) return;

      // Files being born or dying age the quick-open index. Only the flag is
      // set here — rebuilding is left to the next Ctrl+P, not to a feed that
      // arrives in bursts while an agent works.
      if (
        get().fileIndex &&
        !get().indexStale &&
        p.events.some((ev) => ev.kind === "created" || ev.kind === "deleted")
      ) {
        set({ indexStale: true });
      }

      for (const ev of p.events) {
        const dir = parentDir(ev.path);
        if (dirs[dir]) queueDir(dir);

        const doc = docs.find((d) => sameRoot(d.root, p.root) && d.path === ev.path);
        if (!doc) continue;
        if (ev.kind === "deleted") {
          patchDoc(doc.id, { missing: true });
        } else if (isDirty(doc)) {
          patchDoc(doc.id, { stale: true, missing: false });
        } else {
          void syncDocFromDisk(doc.id);
        }
      }
    },

    persist: () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        const { docs, activeId, open, mdMode, outline, wrap } = get();
        write(KV_DOCS, serializeDocs(docs));
        write(KV_ACTIVE, activeId ?? "");
        write(KV_OPEN, String(open));
        write(KV_MD_MODE, mdMode);
        write(KV_OUTLINE, String(outline));
        write(KV_WRAP, String(wrap));
      }, PERSIST_DEBOUNCE_MS);
    },

    restore: async (prefs) => {
      let raw: Record<string, string>;
      try {
        raw = prefs ?? (await readPrefs());
      } catch (e) {
        uiLog.warn(`não consegui ler os rascunhos guardados: ${e}`);
        return;
      }

      // The view settings come back even when no tab does — they are how the
      // user reads markdown, not something about a particular file.
      const mode = raw[KV_MD_MODE] as MdMode | undefined;
      set({
        ...(mode && MD_MODES.includes(mode) ? { mdMode: mode } : {}),
        ...(raw[KV_OUTLINE] ? { outline: raw[KV_OUTLINE] === "true" } : {}),
        ...(raw[KV_WRAP] ? { wrap: raw[KV_WRAP] === "true" } : {}),
      });

      const stored = parseStoredDocs(raw[KV_DOCS]);
      if (stored.length === 0) return;

      // The disk is the authority on what the file *is*; the record is the
      // authority on what the user had *typed*. Reading first is what lets
      // the restore say "this changed underneath while you were away".
      const docs: OpenDoc[] = [];
      for (const g of stored) {
        const id = docId(g.root, g.path);
        if (docs.some((d) => d.id === id)) continue;
        try {
          const file = await ipc.fsReadText(g.root, g.path);
          const draft = g.draft ?? null;
          docs.push({
            id,
            projectId: g.projectId,
            groupId: g.groupId,
            slot: g.slot,
            root: g.root,
            path: g.path,
            text: draft ?? file.text,
            saved: file.text,
            diskVersion: 1,
            modifiedAt: file.modifiedAt,
            crlf: file.crlf,
            bom: file.bom,
            binary: file.binary,
            truncated: file.truncated,
            lossy: file.lossy,
            size: file.size,
            media: file.media,
            // A draft plus a file that moved on disk is exactly the conflict
            // the banner already knows how to explain.
            stale: draft !== null && file.modifiedAt !== g.modifiedAt,
            missing: false,
            error: null,
            saving: false,
          });
        } catch (e) {
          // Gone from disk. A tab with a draft still has to come back — the
          // text only exists here now, and saving re-creates the file.
          if (!g.draft) continue;
          docs.push({
            id,
            projectId: g.projectId,
            groupId: g.groupId,
            slot: g.slot,
            root: g.root,
            path: g.path,
            text: g.draft,
            saved: "",
            diskVersion: 1,
            modifiedAt: g.modifiedAt,
            crlf: g.crlf,
            bom: g.bom,
            binary: false,
            truncated: false,
            lossy: false,
            size: g.draft.length,
            media: null,
            stale: false,
            missing: true,
            error: String(e),
            saving: false,
          });
        }
      }
      if (docs.length === 0) return;

      set((s) => {
        // Anything opened while the read was in flight wins — the user's
        // click is newer than the record.
        const added = docs.filter((d) => !s.docs.some((x) => x.id === d.id));
        const everything = [...added, ...s.docs];
        const savedActive = raw[KV_ACTIVE] || null;
        return {
          docs: everything,
          activeId:
            s.activeId ??
            (everything.some((d) => d.id === savedActive) ? savedActive : everything[0]?.id ?? null),
          // Reopening the overlay is only right if it was open when the app
          // went away — that is the difference between an F5 and a cold boot
          // after the user deliberately closed it.
          open: s.open || raw[KV_OPEN] === "true",
        };
      });
    },
  };
});

/**
 * The sentence a "delete this group/project" confirmation owes the user when
 * tabs with unsaved text are about to go with it.
 *
 * The dialogs used to talk only about processes ("2 CLIs ainda rodando"),
 * which was the whole story back when a document was a modal window nobody
 * could leave open by accident. Now a file is a tab in the pane — it survives
 * a reload, so it can easily be sitting there, half written, days later.
 * Empty string when there is nothing to lose, so it composes into the existing
 * sentences without an `if` at each call site.
 */
export function unsavedWarning(scope: DocScope): string {
  const dirtyDocs = useEditor.getState().unsavedOf(scope);
  if (dirtyDocs.length === 0) return "";
  const names = dirtyDocs
    .slice(0, 3)
    .map((d) => splitPath(d.path).base)
    .join(", ");
  const rest = dirtyDocs.length > 3 ? ` e mais ${dirtyDocs.length - 3}` : "";
  return (
    `\n\nAtenção: ${dirtyDocs.length} arquivo(s) aberto(s) com alterações não salvas ` +
    `vão junto (${names}${rest}). Salve antes se quiser manter o texto.`
  );
}

/**
 * Name shown on the tab: the file, plus the parent directory when two open
 * docs share the same name (`index.tsx` from two components, the most common
 * case here).
 */
export function tabLabel(doc: Pick<OpenDoc, "id" | "path" | "root">, all: Pick<OpenDoc, "id" | "path" | "root">[]): string {
  const { base } = splitPath(doc.path);
  const duplicates = all.filter((d) => d.id !== doc.id && splitPath(d.path).base === base);
  if (duplicates.length === 0) return base;
  const parent = parentDir(doc.path).split("/").pop();
  const local = parent ? `${parent}/${base}` : base;
  return duplicates.some((d) => d.path === doc.path) ? `${local} — ${doc.root}` : local;
}
