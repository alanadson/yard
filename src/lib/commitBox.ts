/**
 * The commit button's rule: one button, three behaviors, and the order in
 * which the blockers are checked.
 *
 * The order matters as much as the cases. An open conflict comes before a
 * blank message, because resolving the conflict is the real next step; the
 * message comes before "nothing staged", because with the box empty the
 * person has not even gotten there yet. A disabled button that does not give
 * the right reason is a dead end.
 */
import type { ScmCounts } from "./scmGroups";
import type { ScmInfo } from "./ipc";

export interface CommitAction {
  /** "Commit", "Commit de tudo" or "Emendar". */
  label: string;
  tip: string;
  disabled: boolean;
  /** Why it is disabled — goes in the tooltip and the `aria-label`. */
  reason: string | null;
  /** Stages everything before recording (the "nothing staged, everything touched" path). */
  stageAll: boolean;
  /** Committing is possible, but somebody has to be warned (detached HEAD). */
  warning: string | null;
}

export function commitAction(
  info: ScmInfo | null | undefined,
  counts: ScmCounts,
  message: string,
  amend: boolean,
): CommitAction {
  const base = {
    label: amend ? "Emendar" : "Commit",
    stageAll: false,
    warning: null as string | null,
  };
  const refused = (reason: string): CommitAction => ({
    ...base,
    tip: reason,
    disabled: true,
    reason,
  });

  if (!info?.isRepo) return refused("Esta pasta não é um repositório git");
  if (amend && !info.hasHead) return refused("Ainda não há commit para emendar");
  if (counts.conflicts > 0) {
    return refused(
      counts.conflicts === 1
        ? "Resolva o conflito antes de commitar"
        : `Resolva os ${counts.conflicts} conflitos antes de commitar`,
    );
  }
  if (!message.trim()) return refused("Escreva a mensagem do commit");

  const stageAll = !amend && counts.staged === 0 && counts.changes > 0;
  if (!amend && counts.staged === 0 && counts.changes === 0) {
    return refused("Não há nada para commitar");
  }

  const warning = info.detached
    ? "HEAD solto: este commit não vai pertencer a nenhuma branch"
    : null;

  if (amend) {
    return {
      label: "Emendar",
      tip:
        counts.staged > 0
          ? `Reescreve o último commit, levando junto ${plural(counts.staged, "arquivo preparado", "arquivos preparados")}`
          : "Reescreve o último commit (só a mensagem)",
      disabled: false,
      reason: null,
      stageAll: false,
      warning,
    };
  }
  if (stageAll) {
    return {
      label: "Commit de tudo",
      tip: `Prepara e grava ${plural(counts.changes, "alteração", "alterações")}`,
      disabled: false,
      reason: null,
      stageAll: true,
      warning,
    };
  }
  return {
    label: "Commit",
    tip: `Grava ${plural(counts.staged, "arquivo preparado", "arquivos preparados")}`,
    disabled: false,
    reason: null,
    stageAll: false,
    warning,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Where the subject stops fitting in a `git log --oneline` and a PR title. */
const SUBJECT_MAX = 72;

/**
 * A hint about the message's shape — never a blocker. The two things git
 * actually treats differently are these: the first line is the subject (and
 * gets truncated everywhere it is shown), and the second has to be blank, or
 * git takes both as a two-line subject.
 */
export function messageHint(message: string): string | null {
  const lines = message.split("\n");
  if (lines[0].length > SUBJECT_MAX) {
    return `O assunto tem ${lines[0].length} caracteres — acima de ${SUBJECT_MAX} ele sai cortado no histórico`;
  }
  if (lines.length > 1 && lines[1].trim() !== "") {
    return "Deixe uma linha em branco entre o assunto e o corpo";
  }
  return null;
}
