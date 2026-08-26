/**
 * Structural workspace state: projects -> groups -> terminals.
 *
 * This store is a **mirror** of what is in SQLite, not the source of truth
 * for what is running. Whether a process is alive is something only the
 * backend knows (§4.3); here we keep only the tree, the layout, and resume
 * metadata.
 */
import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  ipc,
  type GroupRow,
  type ProjectRow,
  type TerminalRow,
  type PtyKind,
} from "../lib/ipc";
import { EMPTY_CANVAS, normalizeCanvas, type CanvasData } from "../lib/canvas";
import { extractBoards } from "../lib/boards";
import { GROUND_FLOOR, normalizeFloor, type FloorMeta } from "../lib/floors";
import { t } from "../lib/i18n";
import {
  normalizeSurface,
  onSurface,
  splitLegacyMode,
  type GridMode,
  type Surface,
} from "../lib/surface";
import { Lru } from "../lib/lru";
import { uiLog } from "../lib/log";
import { readInitialPrefs } from "../lib/prefs";
import { sameRoot } from "../lib/roots";
import { useUI } from "./uiStore";

/**
 * The shape of the pane grid. Canvas is **not** one of these any more: it is
 * the other surface of the group (`GroupLayout.surface`), so switching to it
 * no longer erases the Grade/Holofote the user pinned. `lib/surface.ts` tells
 * the whole story, including how the old four-valued field is read.
 */
export type LayoutMode = GridMode;

/** Visual identity of the project (icon/color picker). */
export interface ProjectStyle {
  color?: string | null;
  icon?: string | null;
}

export interface GroupLayout {
  mode: LayoutMode;
  /** Which of the two surfaces the group is showing: the grid or the canvas. */
  surface: Surface;
  /** How many panes the grid shows (ignored in `auto` mode). */
  panelCount: number;
  /** Active sub-tab of each slot. */
  activeBySlot: Record<number, string>;
  /** Canvas-mode state (positions, drawings, notes). Only present if used. */
  canvas?: CanvasData;
  /** Floor metadata (isolated worktree). Absent = regular group / ground. */
  floor?: FloorMeta;
}

export const DEFAULT_LAYOUT: GroupLayout = {
  mode: "auto",
  surface: "grid",
  panelCount: 2,
  activeBySlot: {},
};

/**
 * Parse cache keyed by exact string. `layoutOf` runs on hot canvas paths
 * (the eraser queries items on every pointermove) and re-parsing the
 * whole JSON per call was expensive. It works because everyone treats the
 * parsed layout as immutable: writes go through spread + stringify.
 */
const parseCache = new Lru<string, GroupLayout>(64);

export function parseLayout(json: string): GroupLayout {
  const hit = parseCache.get(json);
  if (hit) return hit;
  let layout: GroupLayout;
  try {
    const parsed = JSON.parse(json || "{}");
    // `mode` used to hold `"canvas"` as a fourth value; `splitLegacyMode`
    // turns that back into the pair. An explicit `surface` (everything
    // written after the split) always wins over what the mode implied.
    const legacy = splitLegacyMode(parsed.mode);
    layout = {
      mode: legacy.mode,
      surface: parsed.surface === undefined ? legacy.surface : normalizeSurface(parsed.surface),
      panelCount: Math.min(6, Math.max(1, parsed.panelCount ?? 2)),
      activeBySlot: parsed.activeBySlot ?? {},
    };
    // Absent `canvas` stays absent: groups that never entered canvas
    // mode do not pay for the field in the persisted JSON.
    const canvas = normalizeCanvas(parsed.canvas);
    if (canvas) layout.canvas = canvas;
    const floor = normalizeFloor(parsed.floor);
    if (floor) layout.floor = floor;
  } catch {
    layout = { ...DEFAULT_LAYOUT };
  }
  parseCache.set(json, layout);
  return layout;
}

interface ProjectsState {
  rev: number;
  loaded: boolean;
  /**
   * Why the workspace could not be read (locked `app.db`, corrupt file, no
   * disk). Non-null means **nothing is being persisted**: `save` refuses while
   * `loaded` is false, and an empty workspace on screen is indistinguishable
   * from a fresh install. `App` turns this into a blocking panel instead of
   * letting the user rebuild a workspace that will never reach the disk.
   */
  loadError: string | null;
  /**
   * Why the last write was refused. Unlike `loadError` the app is healthy —
   * which is exactly the danger: an autosave that fails silently loses the
   * change with nothing on screen. Cleared by the next accepted write.
   */
  saveError: string | null;
  projects: ProjectRow[];
  groups: GroupRow[];
  terminals: TerminalRow[];
  activeProjectId: string | null;
  activeGroupId: string | null;
  /**
   * The group the user was in before stepping onto a board — `null` when they
   * have not been in one this session.
   *
   * It exists because the canvas shows only the boards in the sidebar and a
   * board has no pane switch either, so "back to the panes" needs somewhere
   * concrete to point at. Session state: it is in the store (not a module
   * variable) so it resets with everything else, and `save` never sees it —
   * only projects, groups and terminals reach the disk.
   */
  groupBeforeBoard: string | null;

  load: () => Promise<void>;
  save: () => Promise<void>;
  scheduleSave: (delayMs?: number) => void;

  /**
   * Registers a project folder. `null` when that folder is already in the
   * workspace: the check used to live only in the dialog, so any other route
   * (a score, a future import, a test) could create two projects over one
   * directory — each with its own watcher and its own feed of the same disk.
   */
  addProject: (name: string, path: string, style?: ProjectStyle) => string | null;
  renameProject: (id: string, name: string) => void;
  /** Icon/color chosen in the picker (creation or "Personalizar…"). */
  setProjectStyle: (id: string, style: ProjectStyle) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;

  /**
   * Creates a board: a group with no project, showing the canvas. It is not
   * `addGroup(null)` on purpose — a board is a different thing from a floor,
   * and a caller that forgot to pass a project would silently make one.
   */
  addBoard: (name: string) => string;
  addGroup: (
    projectId: string,
    name?: string,
    opts?: {
      /** `false` = silent creation (floor CLI): does not switch the active group. */
      activate?: boolean;
      /** Extra fields for the initial layout (e.g. `floor`). */
      layout?: Partial<GroupLayout>;
    },
  ) => string;
  renameGroup: (id: string, name: string) => void;
  removeGroup: (id: string) => void;
  moveGroup: (id: string, delta: number) => void;
  setActiveGroup: (id: string | null) => void;
  /**
   * Leaves the board for `groupBeforeBoard`, or the active project's first
   * group. Does nothing when there is no project to go to.
   */
  leaveBoard: () => void;
  updateLayout: (groupId: string, patch: Partial<GroupLayout>) => void;
  /** Apply a transform to the group's canvas state and schedule a save. */
  updateCanvas: (groupId: string, fn: (c: CanvasData) => CanvasData) => void;
  setActiveTab: (groupId: string, slot: number, terminalId: string) => void;

  addTerminal: (input: {
    groupId: string;
    slot?: number;
    title?: string;
    kind?: PtyKind;
    agentId?: string | null;
    program: string;
    args?: string[];
    cwd: string;
    resume?: string[] | null;
    /** Which surface it is born on. Absent = the grid, where CLIs come from. */
    surface?: Surface;
  }) => string;
  updateTerminal: (id: string, patch: Partial<TerminalRow>) => void;
  /**
   * Moves the tab to `slot`, landing right before the terminal `beforeId` —
   * or at the end of that pane's section when `beforeId` is null. One action
   * for both gestures: dropping on a pane and dropping between two tabs.
   */
  moveTerminal: (id: string, slot: number, beforeId?: string | null) => void;
  /**
   * Swaps places with the neighbour in the same pane — the tree's "move
   * up/down", which is the same order the tab bar shows.
   */
  moveTerminalBy: (id: string, delta: -1 | 1) => void;
  removeTerminal: (id: string) => void;

  groupsOf: (projectId: string) => GroupRow[];
  /** The boards, in bar order. Never includes a project's groups. */
  boards: () => GroupRow[];
  /** Is this group a board — the canvas as its own container? */
  isBoard: (groupId: string) => boolean;
  terminalsOf: (groupId: string) => TerminalRow[];
  /**
   * The group's terminals on one surface — what the grid draws and what the
   * canvas draws. `terminalsOf` stays the whole group, because closing it,
   * scoring it or counting what is alive has to see both.
   */
  terminalsOn: (groupId: string, surface: Surface) => TerminalRow[];
  layoutOf: (groupId: string) => GroupLayout;
  /** The group's floor metadata; a group without `floor` is treated as ground. */
  floorOf: (groupId: string) => FloorMeta;
  /** Working root of the group: the floor's worktree or the project path. */
  rootOfGroup: (groupId: string) => string | null;
  projectOfGroup: (groupId: string) => ProjectRow | undefined;
  terminal: (id: string) => TerminalRow | undefined;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<void> | null = null;
let saveRequested = false;
/** Consecutive refused writes — the delay before trying again grows with it. */
let saveFailures = 0;
/** Backoff ceiling: a disk that came back should not wait a minute to be noticed. */
const SAVE_RETRY_MAX_MS = 10_000;

export const useProjects = create<ProjectsState>((set, get) => ({
  rev: 0,
  loaded: false,
  loadError: null,
  saveError: null,
  projects: [],
  groups: [],
  terminals: [],
  activeProjectId: null,
  activeGroupId: null,
  groupBeforeBoard: null,

  load: async () => {
    let snap: Awaited<ReturnType<typeof ipc.loadWorkspace>>;
    try {
      snap = await ipc.loadWorkspace();
    } catch (e) {
      // Fail loud. `loaded` stays false, so every later `save` is a no-op —
      // and without this flag the UI would show the welcome screen of a fresh
      // install while a whole session of work went nowhere.
      set({ loadError: String(e) });
      throw e;
    }
    const tabs = await collapseToTabs(snap.groups, snap.terminals);
    const { needsMark } = tabs;
    // Three migrations, one save. The order is not free: the surface stamp has
    // to run before the boards come out, because what travels to a board is
    // the terminals **on the canvas** — and until they are stamped, nobody
    // knows which those are.
    const stamped = stampSurfaces(tabs.groups, tabs.terminals);
    const carved = extractBoards(snap.projects, tabs.groups, stamped.terminals);
    const groups = carved.groups;
    const terminals = carved.terminals;
    const changed = tabs.changed || stamped.changed || carved.changed;

    // Where the user was is preserved when it still exists. `load` is not
    // only the boot path: it is also the recovery from a `save` refused for a
    // stale revision, and there throwing the selection back to the first
    // project teleported the user somewhere else mid-work.
    const previous = get();
    const projectStill =
      previous.activeProjectId &&
      snap.projects.some((p) => p.id === previous.activeProjectId)
        ? previous.activeProjectId
        : null;
    // On the very first load of the session there is no "before" in memory —
    // that is the app being reopened, and the floor the user left is on disk.
    // Without this the app came back on the project's first group, in
    // whatever mode *that* one is in, and the board the user closed was
    // simply somewhere else.
    const remembered = previous.activeGroupId ?? (await lastGroupPref());
    // A group whose canvas just became a board: the user was looking at that
    // canvas, so that is where they come back — not at the panes behind it.
    const followed =
      remembered && carved.boardOf.has(remembered)
        ? (carved.boardOf.get(remembered) as string)
        : remembered;
    const groupStill = groups.find((g) => g.id === followed) ?? null;
    const activeProjectId =
      projectStill ?? groupStill?.projectId ?? snap.projects[0]?.id ?? null;
    // A board has no project, so it can never "belong" to the active one —
    // it is kept by name instead, or the first group of the project wins.
    const activeGroupId =
      groupStill && (groupStill.projectId === null || groupStill.projectId === activeProjectId)
        ? groupStill.id
        : (groups.find((g) => g.projectId === activeProjectId)?.id ?? null);

    set({
      rev: snap.rev,
      projects: snap.projects,
      groups,
      terminals,
      activeProjectId,
      activeGroupId,
      loaded: true,
      loadError: null,
    });

    // The migration mark is only written **after** the new format has reached
    // the disk. Writing it first (as it used to) and dying in between left the
    // workspace unmigrated forever, with the mark claiming it had migrated.
    if (changed) await get().save();
    if (needsMark) {
      void ipc.writePref(TABS_MIGRATION_KEY, "true").catch(() => {});
    }
  },

  save: () => {
    // Calling `save` directly also cancels the pending debounce — whoever
    // saves immediately (window close) cannot let a late timer overwrite
    // afterwards.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveRequested = true;
    if (saveInFlight) return saveInFlight;
    if (!get().loaded) {
      saveRequested = false;
      return Promise.resolve();
    }
    const task = (async () => {
      try {
        while (saveRequested) {
          saveRequested = false;
          const { rev, projects, groups, terminals, loaded } = get();
          // Saving before load finishes would wipe the whole workspace with an
          // empty snapshot — the worst possible bug in this app.
          if (!loaded) continue;
          try {
            const result = await ipc.saveWorkspace({ rev, projects, groups, terminals });
            if (result.accepted) {
              saveFailures = 0;
              set({ rev: result.rev, saveError: null });
            } else {
              // The backend had newer state: reload instead of insisting.
              //
              // Reloading throws away whatever is in memory and has not
              // reached the disk, so it cannot be silent — it used to be a
              // `console.warn` in a packaged app with no console. It takes two
              // instances over the same data directory to get here (the single
              // instance lock is off when `YARD_DATA_DIR` is set), and that is
              // exactly when the user needs to be told.
              uiLog.warn("snapshot recusado (rev atrasada); recarregando do disco");
              useUI
                .getState()
                .showToast(
                  t(
                    "Outra instância do Yard gravou este workspace — recarreguei do disco, e o que estava só aqui na tela se perdeu.",
                  ),
                  "error",
                );
              saveRequested = false;
              await get().load();
            }
          } catch (e) {
            // The write itself failed (disk gone, IPC dropped, DB locked).
            // `saveRequested` was already consumed at the top of the loop, so
            // without putting it back the change is lost with no trace — and
            // callers use `void save()`, so the rejection had nowhere to go.
            saveFailures += 1;
            saveRequested = true;
            set({ saveError: String(e) });
            uiLog.error(`falha ao gravar o workspace (tentativa ${saveFailures}): ${e}`);
            break;
          }
        }
      } finally {
        saveInFlight = null;
        // Retry outside the loop, so a disk that stays down does not spin.
        if (saveRequested && saveFailures > 0) {
          get().scheduleSave(Math.min(600 * 2 ** saveFailures, SAVE_RETRY_MAX_MS));
        }
      }
    })();
    saveInFlight = task;
    return task;
  },

  scheduleSave: (delayMs = 600) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void get().save();
    }, delayMs);
  },

  // --- projects ---
  addProject: (name, path, style) => {
    if (get().projects.some((p) => sameRoot(p.path, path))) return null;
    const id = nanoid(10);
    const project: ProjectRow = {
      id,
      name,
      path,
      color: style?.color ?? null,
      icon: style?.icon ?? null,
      sort: get().projects.length,
      createdAt: Date.now(),
    };
    const groupId = nanoid(10);
    const group: GroupRow = {
      id: groupId,
      projectId: id,
      name: "Principal",
      layoutJson: JSON.stringify(DEFAULT_LAYOUT),
      suspended: false,
      sort: 0,
    };
    set((s) => ({
      projects: [...s.projects, project],
      groups: [...s.groups, group],
      activeProjectId: id,
      activeGroupId: groupId,
    }));
    get().scheduleSave();
    return id;
  },

  renameProject: (id, name) => {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
    get().scheduleSave();
  },

  setProjectStyle: (id, style) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id
          ? {
              ...p,
              color: style.color !== undefined ? style.color : p.color,
              icon: style.icon !== undefined ? style.icon : p.icon,
            }
          : p,
      ),
    }));
    get().scheduleSave();
  },

  removeProject: (id) => {
    const groupIds = get()
      .groups.filter((g) => g.projectId === id)
      .map((g) => g.id);
    const siblings = get().projects.filter((p) => p.id !== id);
    const nextProject =
      get().activeProjectId === id ? (siblings[0] ?? null) : null;
    const nextGroup = nextProject
      ? get().groups.find((g) => g.projectId === nextProject.id) ?? null
      : null;
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      groups: s.groups.filter((g) => g.projectId !== id),
      terminals: s.terminals.filter((t) => !groupIds.includes(t.groupId)),
      activeProjectId:
        s.activeProjectId === id ? (nextProject?.id ?? null) : s.activeProjectId,
      activeGroupId: groupIds.includes(s.activeGroupId ?? "")
        ? (nextGroup?.id ?? null)
        : s.activeGroupId,
    }));
    get().scheduleSave();
  },

  setActiveProject: (id) => {
    const group = get().groups.find((g) => g.projectId === id);
    set({ activeProjectId: id, activeGroupId: group?.id ?? null });
  },

  // --- groups ---
  addBoard: (name) => {
    const id = nanoid(10);
    const siblings = get().groups.filter((g) => g.projectId === null);
    const group: GroupRow = {
      id,
      projectId: null,
      name: name.trim() || `Quadro ${siblings.length + 1}`,
      // A board is the canvas and nothing else, so it is born showing it. The
      // grid fields stay at their defaults and are never read for a board.
      layoutJson: JSON.stringify({ ...DEFAULT_LAYOUT, surface: "canvas" }),
      suspended: false,
      sort: siblings.reduce((max, g) => Math.max(max, g.sort + 1), 0),
    };
    set((s) => ({ groups: [...s.groups, group], activeGroupId: id }));
    get().scheduleSave();
    return id;
  },

  addGroup: (projectId, name, opts) => {
    const id = nanoid(10);
    const siblings = get().groups.filter((g) => g.projectId === projectId);
    const count = siblings.length;
    // Past the end, not "how many there are": removing the middle group left
    // 0 and 2, and the next one was born on 2 as well — a tie whose order is
    // then decided by array position, which nobody can see or change.
    const sort = siblings.reduce((max, g) => Math.max(max, g.sort + 1), 0);
    const group: GroupRow = {
      id,
      projectId,
      name: name ?? t("Grupo {n}", { n: count + 1 }),
      layoutJson: JSON.stringify({ ...DEFAULT_LAYOUT, ...(opts?.layout ?? {}) }),
      suspended: false,
      sort,
    };
    set((s) => ({
      groups: [...s.groups, group],
      ...(opts?.activate === false ? {} : { activeGroupId: id }),
    }));
    get().scheduleSave();
    return id;
  },

  renameGroup: (id, name) => {
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
    }));
    get().scheduleSave();
  },

  removeGroup: (id) => {
    const group = get().groups.find((g) => g.id === id);
    const siblings = group
      ? get()
          .groups.filter((g) => g.projectId === group.projectId && g.id !== id)
          .sort((a, b) => a.sort - b.sort)
      : [];
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      terminals: s.terminals.filter((t) => t.groupId !== id),
      activeGroupId:
        s.activeGroupId === id ? (siblings[0]?.id ?? null) : s.activeGroupId,
    }));
    get().scheduleSave();
  },

  moveGroup: (id, delta) => {
    const group = get().groups.find((g) => g.id === id);
    if (!group || delta === 0) return;
    const siblings = get()
      .groups.filter((g) => g.projectId === group.projectId)
      .sort((a, b) => a.sort - b.sort);
    const i = siblings.findIndex((g) => g.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    const next = [...siblings];
    const swap = next[i];
    next[i] = next[j];
    next[j] = swap;
    const order = new Map(next.map((g, idx) => [g.id, idx]));
    set((s) => ({
      groups: s.groups.map((g) =>
        order.has(g.id) ? { ...g, sort: order.get(g.id)! } : g,
      ),
    }));
    get().scheduleSave();
  },

  leaveBoard: () => {
    const s = get();
    const remembered =
      s.groupBeforeBoard && s.groups.find((g) => g.id === s.groupBeforeBoard);
    const fallback = s.activeProjectId ? s.groupsOf(s.activeProjectId)[0] : undefined;
    const target = remembered || fallback;
    // Nothing to leave to: the workspace has no project yet. Doing nothing is
    // right — the button that calls this is not offered in that state either.
    if (target) get().setActiveGroup(target.id);
  },

  setActiveGroup: (id) => {
    const group = get().groups.find((g) => g.id === id);
    // Stepping onto a board: remember where from, and never overwrite that
    // with another board — two boards in a row would erase the way back.
    const current = get().groups.find((g) => g.id === get().activeGroupId);
    const before =
      group?.projectId === null && current && current.projectId !== null
        ? current.id
        : get().groupBeforeBoard;
    set({
      groupBeforeBoard: before,
      activeGroupId: id,
      // A board has no project, and blanking the active one would empty the
      // bench, the changes panel and the file tree the moment the user looked
      // at a board. They keep pointing where they were.
      activeProjectId: group?.projectId ?? get().activeProjectId,
    });
  },

  updateLayout: (groupId, patch) => {
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              layoutJson: JSON.stringify({
                ...parseLayout(g.layoutJson),
                ...patch,
                // A board has no panes at all. Enforced here, the only door
                // layout writes go through, because the way out was a trap:
                // the user landed on an empty grid whose "Canvas" button was
                // exactly the one they had just left.
                ...(g.projectId === null ? { surface: "canvas" as const } : {}),
              }),
            }
          : g,
      ),
    }));
    get().scheduleSave();
  },

  updateCanvas: (groupId, fn) => {
    const layout = get().layoutOf(groupId);
    const current = layout.canvas ?? {
      ...EMPTY_CANVAS,
      viewport: { ...EMPTY_CANVAS.viewport },
    };
    get().updateLayout(groupId, { canvas: fn(current) });
  },

  setActiveTab: (groupId, slot, terminalId) => {
    const layout = get().layoutOf(groupId);
    get().updateLayout(groupId, {
      activeBySlot: { ...layout.activeBySlot, [slot]: terminalId },
    });
  },

  // --- terminals ---
  addTerminal: (input) => {
    const id = nanoid(12);
    const siblings = get().terminals.filter((t) => t.groupId === input.groupId);
    const row: TerminalRow = {
      id,
      groupId: input.groupId,
      // Creating a terminal never splits the screen: each CLI takes the whole
      // pane and the new one becomes another tab on top (§F2). Splitting is
      // still possible, but only on purpose — by dragging the tab to another pane.
      slot: input.slot ?? 0,
      title: input.title ?? null,
      kind: input.kind ?? "shell",
      agentId: input.agentId ?? null,
      program: input.program,
      args: input.args ?? [],
      cwd: input.cwd,
      resume: input.resume ?? null,
      surface: input.surface ?? "grid",
      // Same reason as `addGroup`: `siblings.length` collides with a surviving
      // tab once anything has been closed, and the tab order stops being
      // something the user can reason about.
      sort: siblings.reduce((max, t) => Math.max(max, t.sort + 1), 0),
      alive: false,
      createdAt: Date.now(),
    };
    set((s) => ({ terminals: [...s.terminals, row] }));
    get().setActiveTab(input.groupId, row.slot, id);
    get().scheduleSave();
    return id;
  },

  updateTerminal: (id, patch) => {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
    get().scheduleSave();
  },

  moveTerminal: (id, slot, beforeId = null) => {
    const term = get().terminal(id);
    if (!term || beforeId === id) return;
    if (term.slot === slot && beforeId === null) return;
    // The group's bar order without the moved tab, then the tab put back at
    // the drop point. `sort` is renumbered for the whole surface so it stays
    // unique — a tie would leave the order to array position, which nothing
    // guarantees across a save/load.
    //
    // Only the terminal's own surface takes part: `slot` means "pane" and the
    // canvas has none, so a card left on the default slot 0 would otherwise
    // be counted among the tabs of pane 0 and shuffled along with them.
    const rest = get()
      .terminalsOn(term.groupId, normalizeSurface(term.surface))
      .filter((t) => t.id !== id);
    let i = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
    if (i < 0) {
      i = rest.length;
      for (let j = rest.length - 1; j >= 0; j--) {
        if (rest[j].slot === slot) {
          i = j + 1;
          break;
        }
      }
    }
    const order = new Map(
      [...rest.slice(0, i), { ...term, slot }, ...rest.slice(i)].map(
        (t, idx) => [t.id, idx] as const,
      ),
    );
    set((s) => ({
      terminals: s.terminals.map((t) =>
        order.has(t.id)
          ? { ...t, sort: order.get(t.id)!, ...(t.id === id ? { slot } : {}) }
          : t,
      ),
    }));
    get().setActiveTab(term.groupId, slot, id);
    get().scheduleSave();
  },

  moveTerminalBy: (id, delta) => {
    const term = get().terminal(id);
    if (!term) return;
    // Only among siblings of the same pane, on the same surface: the order
    // the tree shows is that pane's tab bar, and swapping with a neighbour
    // from another pane — or with a card that merely shares the slot number —
    // would move the tab somewhere nobody asked for.
    const siblings = get()
      .terminalsOn(term.groupId, normalizeSurface(term.surface))
      .filter((t) => t.slot === term.slot);
    const i = siblings.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    const a = siblings[i];
    const b = siblings[j];
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === a.id ? { ...t, sort: b.sort } : t.id === b.id ? { ...t, sort: a.sort } : t,
      ),
    }));
    get().scheduleSave();
  },

  removeTerminal: (id) => {
    const term = get().terminal(id);
    set((s) => ({ terminals: s.terminals.filter((t) => t.id !== id) }));
    if (term) {
      const layout = get().layoutOf(term.groupId);
      if (layout.activeBySlot[term.slot] === id) {
        // The pane falls back to another of its own tabs — a card that shares
        // the slot number is not one of them.
        const next = get()
          .terminalsOn(term.groupId, normalizeSurface(term.surface))
          .find((t) => t.slot === term.slot);
        const activeBySlot = { ...layout.activeBySlot };
        if (next) activeBySlot[term.slot] = next.id;
        else delete activeBySlot[term.slot];
        get().updateLayout(term.groupId, { activeBySlot });
      }
    }
    get().scheduleSave();
  },

  // --- selectors ---
  groupsOf: (projectId) =>
    get()
      .groups.filter((g) => g.projectId === projectId)
      .sort((a, b) => a.sort - b.sort),
  boards: () =>
    get()
      .groups.filter((g) => g.projectId === null)
      .sort((a, b) => a.sort - b.sort),
  isBoard: (groupId) =>
    get().groups.find((g) => g.id === groupId)?.projectId === null,
  terminalsOf: (groupId) =>
    get()
      .terminals.filter((t) => t.groupId === groupId)
      .sort((a, b) => a.sort - b.sort),
  terminalsOn: (groupId, surface) => onSurface(get().terminalsOf(groupId), surface),
  layoutOf: (groupId) => {
    const g = get().groups.find((x) => x.id === groupId);
    return g ? parseLayout(g.layoutJson) : { ...DEFAULT_LAYOUT };
  },
  // `GROUND_FLOOR` is a module constant: the selector always returns the
  // same reference for regular groups (Zustand selector rule).
  floorOf: (groupId) => get().layoutOf(groupId).floor ?? GROUND_FLOOR,
  rootOfGroup: (groupId) => {
    const floor = get().floorOf(groupId);
    if (floor.kind === "isolated" && floor.worktreePath) return floor.worktreePath;
    return get().projectOfGroup(groupId)?.path ?? null;
  },
  projectOfGroup: (groupId) => {
    const g = get().groups.find((x) => x.id === groupId);
    return g ? get().projects.find((p) => p.id === g.projectId) : undefined;
  },
  terminal: (id) => get().terminals.find((t) => t.id === id),
}));

/** Floor the user was on, remembered across restarts. */
const LAST_GROUP_KEY = "ui.lastGroup";

async function lastGroupPref(): Promise<string | null> {
  try {
    const kv = await readInitialPrefs();
    return kv[LAST_GROUP_KEY] || null;
  } catch {
    return null;
  }
}

// A subscription instead of a write at each call site: the active group moves
// from half a dozen places (picking a floor, creating one, deleting the one
// you were on, switching project) and the one that forgets to save is the one
// that sends the user back to the wrong board.
useProjects.subscribe((state, prev) => {
  if (state.activeGroupId === prev.activeGroupId) return;
  void ipc.writePref(LAST_GROUP_KEY, state.activeGroupId ?? "").catch(() => {});
});

/**
 * Gives a surface to every terminal that predates the split.
 *
 * Before it, the grid and the canvas drew the **same** terminals, so there is
 * no honest way to tell which of the two a given CLI "belonged" to — it
 * belonged to both. The rule that moves nothing on screen is the group's own
 * surface: whatever the user had in front of them when they closed the app is
 * where their CLIs are when it opens again.
 *
 * Idempotent, and deliberately without a `kv` mark: a terminal that already
 * carries a surface is never touched, so a workspace that has been through
 * here once costs a single pass over the array and no write.
 */
function stampSurfaces(
  groups: GroupRow[],
  terminals: TerminalRow[],
): { terminals: TerminalRow[]; changed: boolean } {
  if (terminals.every((t) => t.surface === "grid" || t.surface === "canvas")) {
    return { terminals, changed: false };
  }
  const surfaceOfGroup = new Map(
    groups.map((g) => [g.id, parseLayout(g.layoutJson).surface] as const),
  );
  return {
    changed: true,
    terminals: terminals.map((t) =>
      t.surface === "grid" || t.surface === "canvas"
        ? t
        : { ...t, surface: surfaceOfGroup.get(t.groupId) ?? "grid" },
    ),
  };
}

/** Mark in `kv` that the tab-merge already ran on this profile. */
const TABS_MIGRATION_KEY = "layoutTabsMigrated";

/**
 * One-shot migration to the tab layout.
 *
 * Workspaces created before this change opened one pane per terminal; this
 * merges them all into the full pane and puts the group back in auto mode.
 * Runs **once only**: after that, whoever drags a tab to split the screen
 * on purpose keeps the split across sessions.
 */
async function collapseToTabs(
  groups: GroupRow[],
  terminals: TerminalRow[],
): Promise<{
  groups: GroupRow[];
  terminals: TerminalRow[];
  changed: boolean;
  /** The `kv` mark still has to be written — the caller does it after saving. */
  needsMark: boolean;
}> {
  const untouched = { groups, terminals, changed: false, needsMark: false };
  try {
    const kv = await readInitialPrefs();
    if (kv[TABS_MIGRATION_KEY] === "true") return untouched;
  } catch {
    // Without kv access we cannot tell if it already migrated; leave the workspace alone.
    return untouched;
  }
  if (terminals.every((t) => t.slot === 0)) return { ...untouched, needsMark: true };

  const collapsed = terminals.map((t) => ({ ...t, slot: 0 }));
  return {
    terminals: collapsed,
    changed: true,
    needsMark: true,
    groups: groups.map((g) => {
      const layout = parseLayout(g.layoutJson);
      const ofGroup = collapsed.filter((t) => t.groupId === g.id);
      // Numeric keys are iterated in ascending order, so this picks the
      // active tab of the leftmost pane that still exists.
      const isActive =
        Object.values(layout.activeBySlot).find((id) =>
          ofGroup.some((t) => t.id === id),
        ) ?? ofGroup[0]?.id;
      return {
        ...g,
        layoutJson: JSON.stringify({
          ...layout,
          mode: "auto" as LayoutMode,
          activeBySlot: isActive ? { 0: isActive } : {},
        }),
      };
    }),
  };
}
