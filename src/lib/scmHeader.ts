/**
 * What the top of the Source Control tab says about the repository: the branch
 * label, the single remote button and the banner saying an operation is
 * stopped midway.
 *
 * It lives outside the JSX because it is a decision, not drawing — and because
 * it is the kind of decision that fails silently. A "Sync" that only fetches,
 * a "Publish" in a repository with no remote, a `2↓` that stayed on screen
 * after the pull: none of that breaks anything, it just makes you trust the
 * wrong number at commit time.
 */
import type { ScmInfo } from "./ipc";

export type SyncKind = "none" | "publish" | "sync" | "fetch";

export interface SyncState {
  kind: SyncKind;
  /** What is written on the button. Short: it shares the line with the rest. */
  label: string;
  /** The full sentence, in the tooltip — where the upstream's name fits. */
  tip: string;
  disabled: boolean;
}

export function syncState(info: ScmInfo | null | undefined): SyncState {
  if (!info?.isRepo) {
    return { kind: "none", label: "", tip: "", disabled: true };
  }
  if (info.remotes.length === 0) {
    return {
      kind: "none",
      label: "",
      tip: "Este repositório não tem remoto configurado",
      disabled: true,
    };
  }
  if (info.detached) {
    return {
      kind: "none",
      label: "",
      tip: "HEAD solto: não há branch para publicar nem para sincronizar",
      disabled: true,
    };
  }
  if (!info.hasHead) {
    return {
      kind: "publish",
      label: "Publicar branch",
      tip: "Faça o primeiro commit antes de publicar",
      disabled: true,
    };
  }
  // Finishing what is midway comes before talking to the server — a pull
  // during a merge is the recipe for a second conflict on top of the first.
  const halted = info.state !== "clean";
  if (!info.upstream) {
    return {
      kind: "publish",
      label: "Publicar branch",
      tip: halted
        ? `Termine ${STATE_NOUN[info.state]} antes`
        : `Publicar “${info.branch ?? ""}” em ${info.remotes[0].name}`,
      disabled: halted,
    };
  }
  if (info.ahead === 0 && info.behind === 0) {
    return {
      kind: "fetch",
      label: "Buscar",
      tip: halted
        ? `Termine ${STATE_NOUN[info.state]} antes`
        : `Em dia com ${info.upstream} — buscar novidades`,
      disabled: halted,
    };
  }
  const parts: string[] = [];
  if (info.behind > 0) parts.push(`${info.behind}↓`);
  if (info.ahead > 0) parts.push(`${info.ahead}↑`);
  return {
    kind: "sync",
    label: parts.join(" "),
    tip: halted
      ? `Termine ${STATE_NOUN[info.state]} antes`
      : `Sincronizar com ${info.upstream}: ${describeGap(info.ahead, info.behind)}`,
    disabled: halted,
  };
}

function describeGap(ahead: number, behind: number): string {
  const snippets: string[] = [];
  if (behind > 0) {
    snippets.push(`${behind} ${behind === 1 ? "commit para trazer" : "commits para trazer"}`);
  }
  if (ahead > 0) {
    snippets.push(`${ahead} ${ahead === 1 ? "commit para enviar" : "commits para enviar"}`);
  }
  return snippets.join(", ");
}

const STATE_NOUN: Record<ScmInfo["state"], string> = {
  clean: "",
  merging: "o merge",
  rebasing: "o rebase",
  "cherry-picking": "o cherry-pick",
  reverting: "o revert",
  bisecting: "a bissecção",
};

export interface StateBanner {
  title: string;
  detail: string;
  /** There is a `--continue` for this state. Merge has none: it ends in the commit. */
  canContinue: boolean;
  canAbort: boolean;
  /** Tells the red banner (stopped midway) from the yellow one (detached HEAD). */
  tone: "warn" | "danger";
}

export function stateBanner(info: ScmInfo | null | undefined): StateBanner | null {
  if (!info?.isRepo) return null;
  switch (info.state) {
    case "merging":
      return {
        title: "Merge em andamento",
        detail: "Resolva os conflitos, prepare os arquivos e finalize com um commit.",
        canContinue: false,
        canAbort: true,
        tone: "danger",
      };
    case "rebasing":
      return {
        title: "Rebase em andamento",
        detail: "Resolva o commit atual e continue, ou aborte para voltar ao que era.",
        canContinue: true,
        canAbort: true,
        tone: "danger",
      };
    case "cherry-picking":
      return {
        title: "Cherry-pick em andamento",
        detail: "Resolva o que colidiu e continue, ou aborte.",
        canContinue: true,
        canAbort: true,
        tone: "danger",
      };
    case "reverting":
      return {
        title: "Revert em andamento",
        detail: "Resolva o que colidiu e continue, ou aborte.",
        canContinue: true,
        canAbort: true,
        tone: "danger",
      };
    case "bisecting":
      return {
        title: "Bissecção em andamento",
        detail: "O repositório está num commit escolhido pelo `git bisect`.",
        canContinue: false,
        canAbort: true,
        tone: "warn",
      };
    default:
      break;
  }
  if (info.detached) {
    return {
      title: "HEAD solto",
      detail:
        "Você não está em nenhuma branch. Um commit feito aqui não pertence a lugar nenhum — crie uma branch antes.",
      canContinue: false,
      canAbort: false,
      tone: "warn",
    };
  }
  return null;
}

/** What goes on the branch button: the name, or the commit when there is no name. */
export function branchLabel(info: ScmInfo | null | undefined): string {
  if (!info?.isRepo) return "";
  if (info.branch) return info.branch;
  return info.head ?? "";
}

/**
 * The title of a stash, without the prefix git stuffs into the message.
 *
 * Git writes "On main: draft" or "WIP on feature/x: 1234abc tweaks". The list
 * already shows the branch in a column of its own, so the prefix spends half
 * the width repeating what is right next to it — and eats the part the person
 * wrote, which is the only thing that tells that stash apart from the others.
 *
 * Only strips the prefix of the branch **the row is showing**: a stash made on
 * another branch keeps its "On other:", because there the information is real.
 */
export function stashTitle(message: string, branch: string | null): string {
  if (!branch) return message;
  for (const prefix of [`WIP on ${branch}: `, `On ${branch}: `]) {
    if (!message.startsWith(prefix)) continue;
    let rest = message.slice(prefix.length).trim();
    // "WIP on" comes with the hash of the commit you were on; it says nothing
    // about the stash's contents.
    // The `$` matters: in a "WIP on main: 1234abc" the hash is all that is
    // left, and without it the row would show a stray hash as if it were the title.
    if (prefix.startsWith("WIP")) {
      rest = rest.replace(/^[0-9a-f]{7,40}(\s+|$)/, "");
    }
    // If the cut left nothing, the whole message is still better than a blank
    // line.
    return rest || message;
  }
  return message;
}
