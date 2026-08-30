/**
 * The pull request, as the interface talks about it (`src-tauri/src/forge.rs`
 * runs `gh`).
 *
 * Two rules live here, and both exist because this is other people's state
 * being summarised into one chip:
 *
 * - **an absent fact is never good news.** A repository with no CI has no
 *   checks, and painting that green says something GitHub never said. Neutral
 *   is the honest answer, and "0 checks" is not worth the pixels;
 * - **the worst thing wins.** One failed check decides against nine passes,
 *   and a reviewer asking for changes decides against a green build — that is
 *   the order in which a person would want to hear it.
 *
 * And the piece that makes the round trip worth building: `reviewFromNotes`
 * turns a reviewer's comment into exactly the row `lib/review.ts` already
 * knows how to group by file, quote and hand to an agent. The feature is not
 * "show the PR"; it is "the comments come back as work".
 */
import { t } from "./i18n";
import type { PullRequest, ReviewNote } from "./ipc";
import type { ReviewComment } from "./review";

export type BadgeTone = "green" | "yellow" | "red" | "neutral";

export interface PrBadge {
  label: string;
  tone: BadgeTone;
}

export function prBadge(pr: PullRequest): PrBadge {
  if (pr.state === "MERGED") {
    return { label: t("mergeado"), tone: "neutral" };
  }
  if (pr.state === "CLOSED") {
    return { label: t("fechado"), tone: "neutral" };
  }
  if (pr.draft) {
    return { label: t("rascunho"), tone: "neutral" };
  }
  const { passed, failed, pending } = pr.checks;
  if (failed > 0) {
    return { label: t("{n} falhando", { n: failed }), tone: "red" };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { label: t("mudanças pedidas"), tone: "yellow" };
  }
  if (pending > 0) {
    return { label: t("{n} rodando", { n: pending }), tone: "yellow" };
  }
  if (passed > 0) {
    return {
      label:
        pr.reviewDecision === "APPROVED"
          ? t("aprovado · {n} ok", { n: passed })
          : t("{n} ok", { n: passed }),
      tone: "green",
    };
  }
  if (pr.reviewDecision === "APPROVED") {
    return { label: t("aprovado"), tone: "green" };
  }
  return { label: t("aberto"), tone: "neutral" };
}

/**
 * The title a PR is born with. The front's name is what the user typed and
 * beats anything derived; the branch is the fallback, cleaned up into a
 * sentence rather than offered as `yard/busca-no-scrollback`.
 */
export function prTitleFor(branch: string, frontName?: string): string {
  if (frontName?.trim()) return frontName.trim();
  const tail = branch.split("/").filter(Boolean).pop() ?? "";
  const words = tail.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * Review comments → annotation rows.
 *
 * `onOld` is false and `code` is empty on purpose: GitHub gives the comment
 * and the line, not the line's text at the time it was written, and inventing
 * a quote from the current file would put words in the reviewer's mouth. The
 * author's name goes into the body because these rows sit next to the user's
 * own comments in the same list, and the agent receiving them needs to know
 * which is which.
 */
export function reviewFromNotes(
  notes: readonly ReviewNote[],
  projectId: string,
  root: string,
  now: number,
): Omit<ReviewComment, "id">[] {
  return notes.map((note) => ({
    projectId,
    root,
    path: note.path,
    // 0 is `forge.rs` saying "GitHub gave no line", not the zeroth line.
    line: note.line > 0 ? note.line : null,
    onOld: false,
    code: "",
    body: note.author ? `@${note.author}: ${note.body}` : note.body,
    createdAt: now,
  }));
}

/** How long a read of the PR is trusted before asking `gh` again. */
export const FRESH_MS = 30_000;

/**
 * Whether it is worth asking `gh` again. The panel re-renders on every
 * keystroke of a commit message; each of those must not become a subprocess
 * and a network round trip.
 */
export function shouldRefresh(
  entry: { checkedAt: number; loading: boolean } | undefined,
  now: number,
  freshMs = FRESH_MS,
): boolean {
  if (!entry) return true;
  if (entry.loading) return false;
  return now - entry.checkedAt >= freshMs;
}
