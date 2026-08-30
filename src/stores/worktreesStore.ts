/**
 * `git worktree list`, per project, cached.
 *
 * A project's children are branches and worktrees now, and three screens ask
 * the same question about them: the tree prints the branch of each row, "Nova
 * aba" needs to know where a CLI would run, and "Abrir frente" needs the
 * worktrees that are still free to adopt. One listing answers all three,
 * including the branch checked out at the project's own root, which git
 * reports on the same wire (`lib/destination.ts`, `groundBranchOf`).
 *
 * Nothing here decides anything: the rules that read this list are pure and
 * live in `lib/destination.ts`. This is the cache and the refresh, only.
 */
import { create } from "zustand";

import { ipc, type WorktreeEntry } from "../lib/ipc";
import { uiLog } from "../lib/log";

/** One frozen empty list: a fresh `[]` per call re-renders every subscriber. */
export const NO_WORKTREES: readonly WorktreeEntry[] = Object.freeze([]);

/** What makes two listings the same listing, in the order git printed them. */
function fingerprint(list: readonly WorktreeEntry[]): string {
  return list.map((w) => `${w.path}|${w.branch ?? ""}|${w.bare}`).join("~");
}

interface WorktreesState {
  byProject: Record<string, readonly WorktreeEntry[]>;
  of: (projectId: string) => readonly WorktreeEntry[];
  /**
   * Has git answered for this project yet?
   *
   * `of` returns the same empty list for "not asked yet" and for "asked, and
   * this folder is not a repository", and the tree needs to tell them apart:
   * one is a row that has nothing to say yet, the other is a row that has to
   * say the project has no git.
   */
  listed: (projectId: string) => boolean;
  refresh: (projectId: string, projectPath: string) => Promise<void>;
  forget: (projectId: string) => void;
}

export const useWorktrees = create<WorktreesState>((set, get) => ({
  byProject: {},

  of: (projectId) => get().byProject[projectId] ?? NO_WORKTREES,

  listed: (projectId) => projectId in get().byProject,

  refresh: async (projectId, projectPath) => {
    try {
      const list = await ipc.worktreeList(projectPath);
      // The tree refreshes every project on every group born or closed; an
      // equal list written back would hand each subscriber a new identity and
      // repaint the sidebar for nothing.
      const current = get().byProject[projectId];
      if (current && fingerprint(current) === fingerprint(list)) return;
      // An empty list is a real answer, not a missing one: it is what git
      // says about a folder with no repository. It gets written like any
      // other, which is what lets `listed` tell that apart from silence.
      set((s) => ({ byProject: { ...s.byProject, [projectId]: Object.freeze(list) } }));
    } catch (e) {
      // The last good answer stays. Emptying the cache here would take the
      // branch off every row of the tree and read as "this project has no
      // branches", which is not what a failed `git worktree list` means.
      uiLog.warn(`git worktree list falhou em ${projectPath}: ${e}`);
    }
  },

  forget: (projectId) => {
    if (!(projectId in get().byProject)) return;
    set((s) => {
      const byProject = { ...s.byProject };
      delete byProject[projectId];
      return { byProject };
    });
  },
}));
