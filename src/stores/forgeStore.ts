/**
 * What the forge (`lib/forge.ts`, `src-tauri/src/forge.rs`) knows about each
 * repository folder.
 *
 * In memory only. Everything in here belongs to GitHub, and a PR read at
 * midnight is not a fact worth restoring at nine — `shouldRefresh` decides
 * when to ask again, and the answer at boot is "ask".
 *
 * Keyed by **root**, not by project: a front is its own worktree with its own
 * branch, and the whole point of the feature is that each front has its own
 * pull request.
 */
import { create } from "zustand";

import { shouldRefresh } from "../lib/forge";
import { ipc, type ForgeStatus, type PullRequest } from "../lib/ipc";
import { uiLog } from "../lib/log";

export interface ForgeEntry {
  pr: PullRequest | null;
  checkedAt: number;
  loading: boolean;
  /** What `gh` said when it refused. Empty when all is well. */
  error: string;
}

interface ForgeState {
  /** `gh --version` + auth, per root. Absent means "not asked yet". */
  status: Record<string, ForgeStatus>;
  byRoot: Record<string, ForgeEntry>;
  /** Reads `gh`'s availability once per root. */
  ensureStatus: (root: string) => void;
  /** Reads the PR of `branch`, unless a fresh answer is already in hand. */
  refresh: (root: string, branch: string, force?: boolean) => Promise<void>;
  entry: (root: string) => ForgeEntry | undefined;
  forget: (root: string) => void;
}

export const useForge = create<ForgeState>((set, get) => ({
  status: {},
  byRoot: {},

  ensureStatus: (root) => {
    if (!root || get().status[root]) return;
    void ipc
      .forgeStatus(root)
      .then((status) => set((s) => ({ status: { ...s.status, [root]: status } })))
      .catch(() => {
        // A machine without `gh` is a normal machine: remember the "no" so
        // the panel stops asking, and never say a word about it.
        set((s) => ({
          status: { ...s.status, [root]: { version: "", authenticated: false } },
        }));
      });
  },

  refresh: async (root, branch, force = false) => {
    if (!root || !branch) return;
    const current = get().byRoot[root];
    if (!force && !shouldRefresh(current, Date.now())) return;
    const gh = get().status[root];
    if (gh && !gh.version) return;

    set((s) => ({
      byRoot: {
        ...s.byRoot,
        [root]: {
          pr: current?.pr ?? null,
          checkedAt: current?.checkedAt ?? 0,
          error: "",
          loading: true,
        },
      },
    }));
    try {
      const pr = await ipc.forgePr(root, branch);
      set((s) => ({
        byRoot: {
          ...s.byRoot,
          [root]: { pr, checkedAt: Date.now(), loading: false, error: "" },
        },
      }));
    } catch (e) {
      // The failure is kept but not shouted: a repository with no remote, a
      // `gh` that is not logged in, an offline machine — none of those are
      // things the Controle tab should interrupt anyone about.
      uiLog.warn(`forge: não consegui ler o PR de ${branch}: ${e}`);
      set((s) => ({
        byRoot: {
          ...s.byRoot,
          [root]: {
            pr: null,
            checkedAt: Date.now(),
            loading: false,
            error: String(e),
          },
        },
      }));
    }
  },

  entry: (root) => get().byRoot[root],

  forget: (root) =>
    set((s) => {
      const byRoot = { ...s.byRoot };
      delete byRoot[root];
      return { byRoot };
    }),
}));
