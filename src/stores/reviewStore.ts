/**
 * Diff annotations, per project.
 *
 * Persisted in `kv` because a review is work: writing four comments, having
 * the app reload (HMR, F5, a crash) and losing them would teach the user to
 * never use the feature again. The anchor is the line number at the time of
 * writing — once the agent edits the file the numbers move, which is why the
 * comment carries the **text** of the line with it: the quote is what
 * survives, the number is only a hint.
 *
 * Two things a comment is scoped by, not one: the project **and the worktree**.
 * A floor is the same project with its own copy of `src/a.ts`, so keying by
 * project alone put the notes written on the floor on top of the ground's
 * diff, and cleared both together.
 */
import { create } from "zustand";
import { nanoid } from "nanoid";

import { persistJsonPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";
import { anchorKey, type ReviewComment } from "../lib/review";
import { sameRoot } from "../lib/roots";

const KV_COMMENTS = "review.comments";

/**
 * Beyond this a review stopped being a review — and `kv` holds text.
 *
 * Counted **per worktree** and enforced by refusing the new note instead of
 * dropping the oldest: silently eating the first comment of a long review (and
 * a global count meant one project could eat another's) is the one thing this
 * feature exists to prevent.
 */
const CAP = 400;

const persist = (comments: ReviewComment[]) =>
  persistJsonPref(KV_COMMENTS, comments, (error) =>
    console.warn("[yard] não consegui gravar as anotações", error),
  );

/** Never trust the saved format: a crooked row disappears, the rest lives. */
export function parseComments(raw: string | undefined): ReviewComment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const c = item as Partial<ReviewComment>;
      if (typeof c?.id !== "string" || typeof c.path !== "string") return [];
      if (typeof c.projectId !== "string" || typeof c.body !== "string") return [];
      if (!c.body.trim()) return [];
      return [
        {
          id: c.id,
          projectId: c.projectId,
          // Written before the field existed: it belongs to "any root of this
          // project", which is exactly how it behaved back then.
          root: typeof c.root === "string" ? c.root : "",
          path: c.path,
          line: typeof c.line === "number" && Number.isFinite(c.line) ? c.line : null,
          onOld: c.onOld === true,
          code: typeof c.code === "string" ? c.code : "",
          body: c.body,
          createdAt:
            typeof c.createdAt === "number" && Number.isFinite(c.createdAt)
              ? c.createdAt
              : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Is this comment part of the review being written in that worktree? */
function inRoot(c: ReviewComment, projectId: string, root: string): boolean {
  if (c.projectId !== projectId) return false;
  return c.root === "" || sameRoot(c.root, root);
}

/**
 * What `add` says when the review is already at the cap. A constant, so the
 * caller shows it with `t(REVIEW_FULL)` — the English line in
 * `i18n/en/stores.ts` is keyed by this exact sentence, cap included.
 */
export const REVIEW_FULL =
  `A revisão já tem ${CAP} anotações neste worktree — envie ou limpe antes de anotar mais.`; // i18n-ok

interface ReviewState {
  comments: ReviewComment[];
  load: (prefs?: PrefsSnapshot) => Promise<void>;
  /**
   * Records one annotation. Returns its id, or `null` when the review is at
   * the cap — the caller shows `REVIEW_FULL` instead of pretending it worked.
   */
  add: (input: Omit<ReviewComment, "id" | "createdAt">) => string | null;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
  /**
   * Deletes exactly these annotations — what sending uses.
   *
   * It used to be `clearScope` (the whole worktree), and the text sent is what
   * was captured before `injectAndConfirm`, which waits up to 6 s for the
   * confirmation: an annotation written in that window went away without
   * ever having been sent.
   */
  removeMany: (ids: Iterable<string>) => void;
  /** Everything annotated in one worktree (used when abandoning a review). */
  clearScope: (projectId: string, root: string) => void;
  /** Everything of a project, whatever the worktree — it left the workspace. */
  clearProject: (projectId: string) => void;
  ofScope: (projectId: string, root: string) => ReviewComment[];
  ofFile: (projectId: string, root: string, path: string) => ReviewComment[];
}

export const useReview = create<ReviewState>((set, get) => ({
  comments: [],

  load: async (prefs) => {
    try {
      const raw = prefs ?? (await readPrefs());
      set({ comments: parseComments(raw[KV_COMMENTS]) });
    } catch (e) {
      console.warn("[yard] não consegui carregar as anotações", e);
    }
  },

  add: (input) => {
    if (get().ofScope(input.projectId, input.root).length >= CAP) return null;
    const id = nanoid(10);
    const next = [...get().comments, { ...input, id, createdAt: Date.now() }];
    set({ comments: next });
    persist(next);
    return id;
  },

  edit: (id, body) => {
    const trimmed = body.trim();
    // An emptied comment is a deleted comment: nobody types a blank note.
    const next = trimmed
      ? get().comments.map((c) => (c.id === id ? { ...c, body: trimmed } : c))
      : get().comments.filter((c) => c.id !== id);
    set({ comments: next });
    persist(next);
  },

  remove: (id) => {
    const next = get().comments.filter((c) => c.id !== id);
    set({ comments: next });
    persist(next);
  },

  removeMany: (ids) => {
    const target = new Set(ids);
    if (target.size === 0) return;
    const next = get().comments.filter((c) => !target.has(c.id));
    if (next.length === get().comments.length) return;
    set({ comments: next });
    persist(next);
  },

  clearScope: (projectId, root) => {
    const next = get().comments.filter((c) => !inRoot(c, projectId, root));
    if (next.length === get().comments.length) return;
    set({ comments: next });
    persist(next);
  },

  clearProject: (projectId) => {
    const next = get().comments.filter((c) => c.projectId !== projectId);
    if (next.length === get().comments.length) return;
    set({ comments: next });
    persist(next);
  },

  ofScope: (projectId, root) =>
    get().comments.filter((c) => inRoot(c, projectId, root)),
  ofFile: (projectId, root, path) =>
    get().comments.filter((c) => inRoot(c, projectId, root) && c.path === path),
}));

/** Comments of one file indexed by anchor — what the diff rows look up. */
export function byAnchor(comments: readonly ReviewComment[]): Map<string, ReviewComment[]> {
  const map = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const key = anchorKey(comment.line, comment.onOld);
    const list = map.get(key);
    if (list) list.push(comment);
    else map.set(key, [comment]);
  }
  return map;
}
