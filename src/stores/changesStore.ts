/**
 * Project files: live feed + change review (git).
 *
 * The backend watches the root of each visited project and sends batches of
 * `files://activity`; here they become a per-project feed (dedup by path,
 * newest first) and trigger a debounced `git status` refresh.
 * That keeps the "N changed files" badge honest even with the panel
 * closed, without running git in a loop.
 */
import { create } from "zustand";
import {
  ipc,
  type ChangesSummary,
  type FileDiff,
  type FileEventKind,
  type FilesActivity,
} from "../lib/ipc";
import { uiLog } from "../lib/log";
import { Lru } from "../lib/lru";

export interface LiveEntry {
  path: string;
  kind: FileEventKind;
  at: number;
  /** How many batches touched this path since the app opened. */
  count: number;
}

export type ChangesTab = "live" | "review";
export type ViewerMode = "unified" | "split";

/** What the large viewer is showing. */
export interface ViewerTarget {
  projectId: string;
  path: string;
}

/** Per-project feed cap — too old no longer matters. */
const LIVE_CAP = 300;
/** Minimum interval between `git status` of the same project. */
const GIT_REFRESH_MS = 1200;
/** Giant `-U<n>` = the whole file becomes a single hunk. */
const WHOLE_FILE_CONTEXT = 1_000_000;

const gitTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Diff cache shared by peek, inline expand, and the
// viewer. Invalidated per project on every new `git status` — if the summary
// changed, any stored diff may be stale.
const diffCache = new Lru<string, FileDiff>(120);

function invalidateDiffs(projectId: string) {
  diffCache.prune((key) => key.startsWith(`${projectId}|`));
}

/** Fetch (with cache) the diff of a project file. */
export async function fetchDiff(
  projectId: string,
  root: string,
  file: { path: string; untracked: boolean; origPath?: string | null },
  whole: boolean,
): Promise<FileDiff> {
  const key = `${projectId}|${file.path}|${whole ? "w" : "n"}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const diff = await ipc.gitFileDiff(
    root,
    file.path,
    file.untracked,
    file.origPath ?? null,
    whole ? WHOLE_FILE_CONTEXT : null,
  );
  diffCache.set(key, diff);
  return diff;
}

interface ChangesState {
  open: boolean;
  tab: ChangesTab;
  /** projectId -> root watched on the backend. */
  watched: Record<string, string>;
  liveByProject: Record<string, LiveEntry[]>;
  droppedByProject: Record<string, number>;
  gitByProject: Record<string, ChangesSummary | undefined>;
  gitLoading: Record<string, boolean>;

  /** Large diff viewer (null = closed). */
  viewer: ViewerTarget | null;
  viewerMode: ViewerMode;
  /** Whole file (giant context) instead of only the changed hunks. */
  viewerWhole: boolean;
  /** Word wrap in the diff. */
  viewerWrap: boolean;

  toggle: () => void;
  setTab: (tab: ChangesTab) => void;
  openViewer: (projectId: string, path: string) => void;
  closeViewer: () => void;
  setViewerMode: (mode: ViewerMode) => void;
  setViewerWhole: (whole: boolean) => void;
  setViewerWrap: (wrap: boolean) => void;
  ensureWatch: (projectId: string, root: string) => Promise<void>;
  /** Tear down watchers for projects that left the workspace. */
  syncWatches: (projects: { id: string; path: string }[]) => void;
  applyActivity: (p: FilesActivity) => void;
  refreshGit: (projectId: string, root: string) => Promise<void>;
  scheduleGitRefresh: (projectId: string, root: string) => void;
  clearLive: (projectId: string) => void;
}

export const useChanges = create<ChangesState>((set, get) => ({
  open: false,
  tab: "live",
  watched: {},
  liveByProject: {},
  droppedByProject: {},
  gitByProject: {},
  gitLoading: {},

  viewer: null,
  viewerMode: "unified",
  viewerWhole: false,
  viewerWrap: false,

  toggle: () => set((s) => ({ open: !s.open })),
  setTab: (tab) => set({ tab }),

  openViewer: (projectId, path) => set({ viewer: { projectId, path } }),
  closeViewer: () => set({ viewer: null }),
  setViewerMode: (viewerMode) => set({ viewerMode }),
  setViewerWhole: (viewerWhole) => set({ viewerWhole }),
  setViewerWrap: (viewerWrap) => set({ viewerWrap }),

  ensureWatch: async (projectId, root) => {
    const { watched } = get();
    if (watched[projectId] === root) return;
    try {
      await ipc.watchProject(projectId, root);
      set((s) => ({ watched: { ...s.watched, [projectId]: root } }));
      // First git snapshot already on entry — the badge does not wait for activity.
      void get().refreshGit(projectId, root);
    } catch (e) {
      uiLog.warn(`nao consegui observar ${root}: ${e}`);
    }
  },

  syncWatches: (projects) => {
    const { watched } = get();
    for (const id of Object.keys(watched)) {
      if (projects.some((p) => p.id === id)) continue;
      void ipc.unwatchProject(id).catch(() => {});
      set((s) => {
        const watchedNext = { ...s.watched };
        delete watchedNext[id];
        return { watched: watchedNext };
      });
    }
  },

  applyActivity: (p) => {
    set((s) => {
      // A `Map` for the whole batch instead of find+filter per event: a burst
      // of 50 touched files against a 300-entry feed used to cost thousands of
      // comparisons and 50 throwaway arrays, every 250 ms.
      const byPath = new Map<string, LiveEntry>();
      // Seeded oldest-first: `Map` keeps insertion order, so delete+set moves
      // a re-touched path to the *end*, and one `reverse()` at the bottom
      // produces the newest-first order the feed is stored in.
      const prior = s.liveByProject[p.projectId] ?? [];
      for (let i = prior.length - 1; i >= 0; i--) byPath.set(prior[i].path, prior[i]);
      for (const ev of p.events) {
        const existing = byPath.get(ev.path);
        // "created then modified" is still a session novelty;
        // anything followed by delete is delete.
        const kind =
          ev.kind === "modified" && existing?.kind === "created"
            ? "created"
            : ev.kind;
        byPath.delete(ev.path);
        byPath.set(ev.path, {
          path: ev.path,
          kind,
          at: ev.at,
          count: (existing?.count ?? 0) + 1,
        });
      }
      const next = [...byPath.values()].reverse().slice(0, LIVE_CAP);
      return {
        liveByProject: { ...s.liveByProject, [p.projectId]: next },
        droppedByProject: {
          ...s.droppedByProject,
          [p.projectId]: (s.droppedByProject[p.projectId] ?? 0) + p.dropped,
        },
      };
    });
    get().scheduleGitRefresh(p.projectId, p.root);
  },

  scheduleGitRefresh: (projectId, root) => {
    // Simple throttle: one refresh per window, fired at the end of it. Under
    // continuous activity that becomes "every 1.2 s", never a burst.
    if (gitTimers.has(projectId)) return;
    gitTimers.set(
      projectId,
      setTimeout(() => {
        gitTimers.delete(projectId);
        void get().refreshGit(projectId, root);
      }, GIT_REFRESH_MS),
    );
  },

  refreshGit: async (projectId, root) => {
    if (get().gitLoading[projectId]) return;
    set((s) => ({ gitLoading: { ...s.gitLoading, [projectId]: true } }));
    try {
      const summary = await ipc.gitChanges(root);
      invalidateDiffs(projectId);
      set((s) => ({ gitByProject: { ...s.gitByProject, [projectId]: summary } }));
    } catch (e) {
      uiLog.warn(`git status falhou em ${root}: ${e}`);
    } finally {
      set((s) => ({ gitLoading: { ...s.gitLoading, [projectId]: false } }));
    }
  },

  clearLive: (projectId) => {
    set((s) => ({
      liveByProject: { ...s.liveByProject, [projectId]: [] },
      droppedByProject: { ...s.droppedByProject, [projectId]: 0 },
    }));
  },
}));
