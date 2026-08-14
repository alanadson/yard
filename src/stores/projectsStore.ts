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
import { GROUND_FLOOR, normalizeFloor, type FloorMeta } from "../lib/floors";
import { Lru } from "../lib/lru";

export type LayoutMode = "auto" | "grid" | "spotlight" | "canvas";

/** Visual identity of the project (icon/color picker). */
export interface ProjectStyle {
  color?: string | null;
  icon?: string | null;
}

export interface GroupLayout {
  mode: LayoutMode;
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
    layout = {
      mode: parsed.mode ?? DEFAULT_LAYOUT.mode,
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
  projects: ProjectRow[];
  groups: GroupRow[];
  terminals: TerminalRow[];
  activeProjectId: string | null;
  activeGroupId: string | null;

  load: () => Promise<void>;
  save: () => Promise<void>;
  scheduleSave: () => void;

  addProject: (name: string, path: string, style?: ProjectStyle) => string;
  renameProject: (id: string, name: string) => void;
  /** Icon/color chosen in the picker (creation or "Personalizar…"). */
  setProjectStyle: (id: string, style: ProjectStyle) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;

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
  }) => string;
  updateTerminal: (id: string, patch: Partial<TerminalRow>) => void;
  moveTerminal: (id: string, slot: number) => void;
  removeTerminal: (id: string) => void;

  groupsOf: (projectId: string) => GroupRow[];
  terminalsOf: (groupId: string) => TerminalRow[];
  layoutOf: (groupId: string) => GroupLayout;
  /** The group's floor metadata; a group without `floor` is treated as ground. */
  floorOf: (groupId: string) => FloorMeta;
  /** Working root of the group: the floor's worktree or the project path. */
  rootOfGroup: (groupId: string) => string | null;
  projectOfGroup: (groupId: string) => ProjectRow | undefined;
  terminal: (id: string) => TerminalRow | undefined;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useProjects = create<ProjectsState>((set, get) => ({
  rev: 0,
  loaded: false,
  projects: [],
  groups: [],
  terminals: [],
  activeProjectId: null,
  activeGroupId: null,

  load: async () => {
    const snap = await ipc.loadWorkspace();
    const { groups, terminals, changed } = await collapseToTabs(
      snap.groups,
      snap.terminals,
    );
    const firstProject = snap.projects[0]?.id ?? null;
    const firstGroup =
      groups.find((g) => g.projectId === firstProject)?.id ?? null;
    set({
      rev: snap.rev,
      projects: snap.projects,
      groups,
      terminals,
      activeProjectId: firstProject,
      activeGroupId: firstGroup,
      loaded: true,
    });
    if (changed) get().scheduleSave();
  },

  save: async () => {
    // Calling `save` directly also cancels the pending debounce — whoever
    // saves immediately (window close) cannot let a late timer overwrite
    // afterwards.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const { rev, projects, groups, terminals, loaded } = get();
    // Saving before load finishes would wipe the whole workspace with an
    // empty snapshot — the worst possible bug in this app.
    if (!loaded) return;
    const result = await ipc.saveWorkspace({ rev, projects, groups, terminals });
    if (result.accepted) {
      set({ rev: result.rev });
    } else {
      // The backend had newer state: reload instead of insisting.
      console.warn("[yard] snapshot recusado (rev atrasada); recarregando");
      await get().load();
    }
  },

  scheduleSave: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void get().save();
    }, 600);
  },

  // --- projects ---
  addProject: (name, path, style) => {
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
  addGroup: (projectId, name, opts) => {
    const id = nanoid(10);
    const count = get().groups.filter((g) => g.projectId === projectId).length;
    const group: GroupRow = {
      id,
      projectId,
      name: name ?? `Grupo ${count + 1}`,
      layoutJson: JSON.stringify({ ...DEFAULT_LAYOUT, ...(opts?.layout ?? {}) }),
      suspended: false,
      sort: count,
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

  setActiveGroup: (id) => {
    const group = get().groups.find((g) => g.id === id);
    set({
      activeGroupId: id,
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
      sort: siblings.length,
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

  moveTerminal: (id, slot) => {
    const term = get().terminal(id);
    if (!term || term.slot === slot) return;
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, slot } : t)),
    }));
    get().setActiveTab(term.groupId, slot, id);
    get().scheduleSave();
  },

  removeTerminal: (id) => {
    const term = get().terminal(id);
    set((s) => ({ terminals: s.terminals.filter((t) => t.id !== id) }));
    if (term) {
      const layout = get().layoutOf(term.groupId);
      if (layout.activeBySlot[term.slot] === id) {
        const next = get()
          .terminalsOf(term.groupId)
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
  terminalsOf: (groupId) =>
    get()
      .terminals.filter((t) => t.groupId === groupId)
      .sort((a, b) => a.sort - b.sort),
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
): Promise<{ groups: GroupRow[]; terminals: TerminalRow[]; changed: boolean }> {
  const intacto = { groups, terminals, changed: false };
  try {
    const kv = await ipc.readPrefs();
    if (kv[TABS_MIGRATION_KEY] === "true") return intacto;
  } catch {
    // Without kv access we cannot tell if it already migrated; leave the workspace alone.
    return intacto;
  }
  void ipc.writePref(TABS_MIGRATION_KEY, "true").catch(() => {});
  if (terminals.every((t) => t.slot === 0)) return intacto;

  const juntos = terminals.map((t) => ({ ...t, slot: 0 }));
  return {
    terminals: juntos,
    changed: true,
    groups: groups.map((g) => {
      const layout = parseLayout(g.layoutJson);
      const doGrupo = juntos.filter((t) => t.groupId === g.id);
      // Numeric keys are iterated in ascending order, so this picks the
      // active tab of the leftmost pane that still exists.
      const ativo =
        Object.values(layout.activeBySlot).find((id) =>
          doGrupo.some((t) => t.id === id),
        ) ?? doGrupo[0]?.id;
      return {
        ...g,
        layoutJson: JSON.stringify({
          ...layout,
          mode: "auto" as LayoutMode,
          activeBySlot: ativo ? { 0: ativo } : {},
        }),
      };
    }),
  };
}
