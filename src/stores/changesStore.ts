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
import { rootKey, sameRoot } from "../lib/roots";

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

const gitTimers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; root: string }
>();

// Diff cache shared by peek, inline expand, and the
// viewer. Invalidated per project on every new `git status` — if the summary
// changed, any stored diff may be stale.
const diffCache = new Lru<string, FileDiff>(120);
const diffInFlight = new Map<string, Promise<FileDiff>>();
const diffVersions = new Map<string, number>();

const watchDesired = new Map<string, string>();
const watchInFlight = new Map<string, Promise<void>>();
const gitRequests = new Map<string, { root: string; rerun: boolean }>();
const gitInFlight = new Map<string, Promise<void>>();

function invalidateDiffs(projectId: string) {
  diffVersions.set(projectId, (diffVersions.get(projectId) ?? 0) + 1);
  diffCache.prune((key) => key.startsWith(`${projectId}|`));
}

/**
 * What makes a `git status` count as new state.
 *
 * It has to include **both sides** (index and disk) and the conflict pair,
 * not only the summarised `status`: staging a hunk of an already modified
 * file takes `.M` to `MM` without touching anything else — same path, same
 * `status` ("modified") and the same +/-, which is counted against `HEAD`,
 * and `HEAD` did not move. With both sides left out, the Source Control tab
 * kept drawing the file in the group it was in before the click.
 */
function summaryFingerprint(summary: ChangesSummary | undefined): string {
  if (!summary) return "";
  return `${summary.isRepo}|${summary.branch ?? ""}|${summary.additions}|${summary.deletions}|${summary.files
    .map(
      (f) =>
        `${f.path}\u0000${f.origPath ?? ""}\u0000${f.status}\u0000${f.index}\u0000${f.worktree}\u0000${f.conflict ?? ""}\u0000${f.additions ?? ""}\u0000${f.deletions ?? ""}\u0000${f.binary}`,
    )
    .join("\u0001")}`;
}

/** Fetch (with cache) the diff of a project file. */
export async function fetchDiff(
  projectId: string,
  root: string,
  file: { path: string; untracked: boolean; origPath?: string | null },
  whole: boolean,
): Promise<FileDiff> {
  const key = `${projectId}|${rootKey(root)}|${file.path}|${file.origPath ?? ""}|${file.untracked ? "u" : "t"}|${whole ? "w" : "n"}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const pending = diffInFlight.get(key);
  if (pending) return pending;
  const version = diffVersions.get(projectId) ?? 0;
  const request = ipc
    .gitFileDiff(
      root,
      file.path,
      file.untracked,
      file.origPath ?? null,
      whole ? WHOLE_FILE_CONTEXT : null,
    )
    .then((diff) => {
      if ((diffVersions.get(projectId) ?? 0) === version) diffCache.set(key, diff);
      return diff;
    })
    .finally(() => diffInFlight.delete(key));
  diffInFlight.set(key, request);
  return request;
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
  /** Everything this store holds about a project that left the workspace. */
  dropProject: (projectId: string) => void;
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
    watchDesired.set(projectId, root);
    if (sameRoot(get().watched[projectId], root) && !watchInFlight.has(projectId)) return;
    const running = watchInFlight.get(projectId);
    if (running) return running;

    const task = (async () => {
      while (true) {
        const target = watchDesired.get(projectId);
        if (!target || sameRoot(get().watched[projectId], target)) return;
        try {
          await ipc.watchProject(projectId, target);
        } catch (e) {
          if (sameRoot(watchDesired.get(projectId), target)) {
            uiLog.warn(`nao consegui observar ${target}: ${e}`);
            return;
          }
          continue;
        }

        const latest = watchDesired.get(projectId);
        if (!latest) {
          await ipc.unwatchProject(projectId).catch(() => {});
          return;
        }
        if (!sameRoot(latest, target)) continue;

        invalidateDiffs(projectId);
        set((s) => {
          const gitByProject = { ...s.gitByProject };
          delete gitByProject[projectId];
          return {
            watched: { ...s.watched, [projectId]: target },
            gitByProject,
            liveByProject: { ...s.liveByProject, [projectId]: [] },
            droppedByProject: { ...s.droppedByProject, [projectId]: 0 },
          };
        });
        // First git snapshot already on entry — the badge does not wait for activity.
        void get().refreshGit(projectId, target);
        return;
      }
    })().finally(() => watchInFlight.delete(projectId));
    watchInFlight.set(projectId, task);
    return task;
  },

  syncWatches: (projects) => {
    const { watched } = get();
    const keep = new Set(projects.map((p) => p.id));
    const watchedNext = { ...watched };
    let changed = false;
    // Include registrations that are still awaiting the backend. Otherwise a
    // project removed during `watchProject` could become watched after this
    // cleanup and remain orphaned for the rest of the session.
    const known = new Set([...Object.keys(watched), ...watchDesired.keys()]);
    for (const id of known) {
      if (keep.has(id)) continue;
      watchDesired.delete(id);
      const scheduled = gitTimers.get(id);
      if (scheduled) clearTimeout(scheduled.timer);
      gitTimers.delete(id);
      void ipc.unwatchProject(id).catch(() => {});
      delete watchedNext[id];
      changed = true;
    }
    if (changed) set({ watched: watchedNext });
  },

  applyActivity: (p) => {
    // No root wanted for this id = the project left the workspace (or never
    // entered it). `ensureWatch` registers `watchDesired` *before* asking the
    // backend, so there is no honest window where a watched project has none —
    // and accepting the batch used to rebuild the feed of a project nobody can
    // see and schedule `git status` on a folder that is no longer ours.
    const expectedRoot = watchDesired.get(p.projectId) ?? get().watched[p.projectId];
    if (!expectedRoot || !sameRoot(expectedRoot, p.root)) return;
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
    const existing = gitTimers.get(projectId);
    if (existing) {
      existing.root = root;
      return;
    }
    const entry = {
      root,
      timer: setTimeout(() => {
        const latest = gitTimers.get(projectId);
        gitTimers.delete(projectId);
        if (latest) void get().refreshGit(projectId, latest.root);
      }, GIT_REFRESH_MS),
    };
    gitTimers.set(projectId, entry);
  },

  refreshGit: async (projectId, root) => {
    const queued = gitRequests.get(projectId);
    if (queued) {
      queued.root = root;
      queued.rerun = true;
      return gitInFlight.get(projectId);
    }

    const request = { root, rerun: true };
    gitRequests.set(projectId, request);
    set((s) => ({ gitLoading: { ...s.gitLoading, [projectId]: true } }));

    const task = (async () => {
      while (request.rerun) {
        request.rerun = false;
        const target = request.root;
        try {
          const summary = await ipc.gitChanges(target);
          const expectedRoot = watchDesired.get(projectId) ?? get().watched[projectId];
          if (!sameRoot(request.root, target) || (expectedRoot && !sameRoot(expectedRoot, target))) {
            continue;
          }
          const previous = get().gitByProject[projectId];
          if (summaryFingerprint(previous) === summaryFingerprint(summary)) continue;
          invalidateDiffs(projectId);
          set((s) => ({ gitByProject: { ...s.gitByProject, [projectId]: summary } }));
        } catch (e) {
          if (sameRoot(request.root, target)) uiLog.warn(`git status falhou em ${target}: ${e}`);
        }
      }
    })().finally(() => {
      gitRequests.delete(projectId);
      gitInFlight.delete(projectId);
      set((s) => ({ gitLoading: { ...s.gitLoading, [projectId]: false } }));
    });
    gitInFlight.set(projectId, task);
    return task;
  },

  clearLive: (projectId) => {
    set((s) => ({
      liveByProject: { ...s.liveByProject, [projectId]: [] },
      droppedByProject: { ...s.droppedByProject, [projectId]: 0 },
    }));
  },

  /**
   * Everything this store holds about a project that left the workspace: feed,
   * summary, loading flag, diff cache, pending git timer — all keyed by an id
   * nothing will resolve again.
   *
   * **And the watcher itself.** This used to lean on `syncWatches` (the App
   * effect that runs when the project list changes), but the two run in the
   * wrong order: `closeProject` calls this synchronously, and by the time the
   * effect fires the id is no longer in `watched`/`watchDesired`, so the
   * cleanup skipped it and the backend went on watching the folder for the
   * rest of the session.
   *
   * The in-flight request is cancelled by dropping its entry: `refreshGit`
   * checks the watched root before writing, and there is none any more.
   */
  dropProject: (projectId) => {
    const scheduled = gitTimers.get(projectId);
    if (scheduled) clearTimeout(scheduled.timer);
    gitTimers.delete(projectId);
    watchDesired.delete(projectId);
    void ipc
      .unwatchProject(projectId)
      .catch((e) => uiLog.warn(`nao consegui parar de observar ${projectId}: ${e}`));
    gitRequests.delete(projectId);
    gitInFlight.delete(projectId);
    diffVersions.delete(projectId);
    diffCache.prune((key) => key.startsWith(`${projectId}|`));
    set((s) => {
      const drop = <T,>(record: Record<string, T>): Record<string, T> => {
        if (!(projectId in record)) return record;
        const next = { ...record };
        delete next[projectId];
        return next;
      };
      return {
        watched: drop(s.watched),
        liveByProject: drop(s.liveByProject),
        droppedByProject: drop(s.droppedByProject),
        gitByProject: drop(s.gitByProject),
        gitLoading: drop(s.gitLoading),
        viewer: s.viewer?.projectId === projectId ? null : s.viewer,
      };
    });
  },
}));
