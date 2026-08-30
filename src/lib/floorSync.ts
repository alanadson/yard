/**
 * What the server knows about a front's branch, the one fact the fronts
 * never showed.
 *
 * A front is born with `git worktree add --no-track -b`, which is a branch on
 * this disk and nowhere else. Nothing in the creation, the landing or the
 * closing of a front talks to the server, and that is deliberate: the Yard
 * does not push on anybody's behalf. What was missing is the other half of
 * that honesty: *saying* so, where the fronts are, instead of leaving the
 * fact in the Controle tab of whichever repository the bench points at.
 *
 * Every rule here reads one listing (`scm_branches`, a single
 * `git for-each-ref`) and decides. The screens render the decision.
 */
import { t } from "./i18n";
import type { ScmBranch } from "./ipc";

/**
 * - `unknown`: no listing yet, or no remote to publish to. Say nothing.
 * - `local`: the branch has no upstream, so it exists only on this machine.
 * - `ahead`: published, and holding commits the server has not seen.
 * - `published`: the server has everything this branch has.
 * - `gone`: it had an upstream and the server no longer has it.
 */
export type PublishKind = "unknown" | "local" | "ahead" | "published" | "gone";

export interface PublishState {
  kind: PublishKind;
  /** Commits the server does not have. Only meaningful for `ahead`. */
  ahead: number;
  /** `origin/yard/login`, when there is an upstream. */
  upstream: string | null;
}

const UNKNOWN: PublishState = { kind: "unknown", ahead: 0, upstream: null };

/**
 * The publish state of `branch`, from a `scm_branches` listing.
 *
 * `hasRemote` is separate on purpose: a repository with no remote cannot
 * publish anything, and painting every front "só aqui" there would be a
 * warning about a decision nobody made.
 */
export function publishStateOf(
  branches: readonly ScmBranch[] | null | undefined,
  branch: string | null | undefined,
  hasRemote: boolean,
): PublishState {
  const name = branch?.trim();
  if (!name || !hasRemote || !branches?.length) return UNKNOWN;
  // Only local refs answer: `origin/yard/login` is a legal local branch name,
  // and the remote copy of the same name always carries an upstream.
  const found = branches.find((b) => !b.remote && b.name === name);
  if (!found) return UNKNOWN;
  if (!found.upstream) return { kind: "local", ahead: 0, upstream: null };
  if (found.gone) return { kind: "gone", ahead: found.ahead, upstream: found.upstream };
  if (found.ahead > 0) {
    return { kind: "ahead", ahead: found.ahead, upstream: found.upstream };
  }
  return { kind: "published", ahead: 0, upstream: found.upstream };
}

/** The CSS modifier the badge asks for: `.floors-badge--<tone>`. */
export type PublishTone = "local" | "ahead" | "published" | "gone";

export interface PublishBadge {
  label: string;
  tip: string;
  tone: PublishTone;
}

/**
 * The badge for a front's row, or `null` when there is nothing to say.
 *
 * The label is short because it shares a row with the name and the branch;
 * the tip is where the sentence goes. Both name the ref they are about, because a
 * badge reading "só aqui" with no branch in the tooltip is a fact the person
 * cannot act on.
 */
export function publishBadge(state: PublishState, branch: string): PublishBadge | null {
  switch (state.kind) {
    case "local":
      return {
        label: t("só aqui"),
        tip: t("A branch {branch} nunca foi publicada: ela existe só neste computador.", {
          branch,
        }),
        tone: "local",
      };
    case "ahead":
      return {
        label: t("{n} por enviar", { n: state.ahead }),
        tip: t("{n} commit(s) desta frente ainda não estão em {upstream}.", {
          n: state.ahead,
          upstream: state.upstream ?? "",
        }),
        tone: "ahead",
      };
    case "published":
      return {
        label: t("publicada"),
        tip: t("Publicada em {upstream}, sem nada por enviar.", {
          upstream: state.upstream ?? "",
        }),
        tone: "published",
      };
    case "gone":
      return {
        label: t("sumiu do servidor"),
        tip: t("{upstream} não existe mais no servidor: alguém apagou a branch publicada.", {
          upstream: state.upstream ?? "",
        }),
        tone: "gone",
      };
    default:
      return null;
  }
}

/** The remote and the branch **on the server**, out of `origin/yard/login`. */
export interface RemoteBranch {
  remote: string;
  branch: string;
}

/**
 * Splits an upstream into the two arguments `git push <remote> --delete
 * <branch>` wants.
 *
 * The seam is the first slash: `scm.rs` refuses a remote name containing one,
 * so everything after it is the branch, and here that is almost always
 * `yard/<slug>`, which has a slash of its own and must survive whole.
 *
 * The branch on the server is read from the upstream rather than assumed
 * equal to the local name: `git branch -u` can point a local branch at a ref
 * with a different name, and deleting the name we happen to have locally
 * would delete the wrong branch on the server.
 */
export function splitUpstream(upstream: string | null | undefined): RemoteBranch | null {
  const text = upstream?.trim();
  if (!text) return null;
  const cut = text.indexOf("/");
  if (cut <= 0 || cut === text.length - 1) return null;
  return { remote: text.slice(0, cut), branch: text.slice(cut + 1) };
}

/**
 * How new the base of a new front is, relative to the server.
 *
 * - `behind`: a local branch whose upstream has commits it does not;
 * - `mirror`: a remote-tracking ref, exactly as new as the last `fetch`
 *   and not one commit newer;
 * - `none`: up to date, unknown, or not a branch at all (a hash, a tag).
 */
export type BaseWarning =
  | { kind: "none" }
  | { kind: "behind"; behind: number; base: string; upstream: string }
  | { kind: "mirror"; base: string };

const NO_WARNING: BaseWarning = { kind: "none" };

export function baseWarningOf(
  branches: readonly ScmBranch[] | null | undefined,
  baseRef: string | null | undefined,
  hasRemote: boolean,
): BaseWarning {
  const base = baseRef?.trim();
  if (!base || !hasRemote || !branches?.length) return NO_WARNING;
  const found = branches.find((b) => b.name === base);
  if (!found) return NO_WARNING;
  if (found.remote) return { kind: "mirror", base };
  if (found.upstream && found.behind > 0) {
    return { kind: "behind", behind: found.behind, base, upstream: found.upstream };
  }
  return NO_WARNING;
}

/** The sentence the dialog shows beside "Buscar do servidor". `""` for none. */
export function baseWarningText(warning: BaseWarning): string {
  switch (warning.kind) {
    case "behind":
      return t(
        "{base} está {n} commit(s) atrás de {upstream}: a frente nasce atrasada. Buscar do servidor primeiro?",
        { base: warning.base, n: warning.behind, upstream: warning.upstream },
      );
    case "mirror":
      return t(
        "{base} é a cópia local do servidor, tão nova quanto o último “buscar”. Buscar de novo antes de abrir?",
        { base: warning.base },
      );
    default:
      return "";
  }
}

/**
 * The branch on the server that closing this front may offer to delete, or
 * `null` when there is none to delete.
 *
 * `gone` is deliberately excluded: the ref is still here, the branch it names
 * is not, and offering the checkbox there promises a `git push --delete` that
 * can only come back as an error.
 */
export function remoteToDelete(state: PublishState): RemoteBranch | null {
  if (state.kind !== "published" && state.kind !== "ahead") return null;
  return splitUpstream(state.upstream);
}
