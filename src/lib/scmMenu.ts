/**
 * The context menus of the Source Control tab — file row, group header,
 * branch, commit and stash.
 *
 * The rule this module carries is the same as `changesMenu`'s: **do not
 * promise the impossible, and still do not move the menu around**. The entry
 * that cannot be used stays there, greyed out, because vanishing shifts its
 * neighbours' positions and the hand already knows where they are. Every
 * greyed-out entry carries its reason in the label or the tooltip — a grey
 * item with no explanation is worse than no item.
 *
 * What decides what is greyed out is almost always the same pair of facts:
 * which group the row is in, and whether the repository is midway through
 * something.
 */
import { toOsPath } from "./paths";
import type { ScmGroupId, ScmRow } from "./scmGroups";
import type { ScmBranch, ScmCommit, ScmInfo, ScmStash } from "./ipc";
import type { MenuEntry } from "../components/ContextMenu";
import { t } from "./i18n";

export interface ScmRowActions {
  openDiff: (row: ScmRow) => void;
  /** The same diff, as a tab beside the CLIs (VS Code's diff editor). */
  openDiffTab: (row: ScmRow) => void;
  openInEditor: (path: string) => void;
  stage: (path: string) => void;
  unstage: (path: string) => void;
  discard: (path: string) => void;
  resolve: (path: string, side: "ours" | "theirs") => void;
  fileHistory: (path: string) => void;
  copyText: (text: string) => void;
  reveal: (osPath: string) => void;
}

export interface ScmRowContext {
  /** The repository root — without it the full path cannot be built. */
  root: string | null;
  info: ScmInfo | null;
}

/** Does it exist on disk right now? Deleted neither opens in the editor nor shows in the folder. */
function onDisk(row: ScmRow): boolean {
  return row.status !== "deleted";
}

export function scmRowMenu(
  row: ScmRow,
  ctx: ScmRowContext,
  act: ScmRowActions,
): MenuEntry[] {
  const absolutePath = ctx.root ? toOsPath(ctx.root, row.path) : null;
  const entries: MenuEntry[] = [
    { id: "diff", label: t("Abrir o diff"), onSelect: () => act.openDiff(row) },
    // The row goes whole: its `side` is which comparison the tab shows.
    { id: "diff-tab", label: t("Abrir o diff numa aba"), onSelect: () => act.openDiffTab(row) },
    {
      id: "editor",
      label: t("Abrir no editor"),
      disabled: !onDisk(row) || row.binary,
      onSelect: () => act.openInEditor(row.path),
    },
    { kind: "sep" },
  ];

  if (row.group === "conflicts") {
    entries.push(
      {
        id: "ours",
        label: t("Ficar com o meu lado"),
        onSelect: () => act.resolve(row.path, "ours"),
      },
      {
        id: "theirs",
        label: t("Ficar com o lado deles"),
        onSelect: () => act.resolve(row.path, "theirs"),
      },
      {
        id: "stage",
        label: t("Marcar como resolvido"),
        onSelect: () => act.stage(row.path),
      },
      { kind: "sep" },
    );
  } else if (row.canStage) {
    entries.push({
      id: "stage",
      label: t("Preparar"),
      onSelect: () => act.stage(row.path),
    });
    if (row.canDiscard) {
      entries.push({
        id: "discard",
        label: row.untracked ? t("Excluir o arquivo") : t("Descartar as alterações"),
        danger: true,
        onSelect: () => act.discard(row.path),
      });
    }
    entries.push({ kind: "sep" });
  } else {
    // Staged. "Discard" here would be two gestures under one name
    // (unstage *and* drop the change); whoever wants that does both.
    entries.push(
      { id: "unstage", label: t("Despreparar"), onSelect: () => act.unstage(row.path) },
      { kind: "sep" },
    );
  }

  entries.push({
    id: "history",
    label: t("Histórico deste arquivo"),
    disabled: !ctx.info?.hasHead,
    onSelect: () => act.fileHistory(row.path),
  });
  entries.push({ kind: "sep" });
  entries.push({
    id: "copy",
    // The relative one is how the repository (and the agent) refer to the file.
    label: t("Copiar caminho"),
    onSelect: () => act.copyText(row.path),
  });
  entries.push({
    id: "copy-abs",
    label: t("Copiar caminho completo"),
    disabled: absolutePath === null,
    onSelect: () => absolutePath && act.copyText(absolutePath),
  });
  if (row.origPath) {
    entries.push({
      id: "copy-orig",
      label: t("Copiar o caminho de origem"),
      onSelect: () => act.copyText(row.origPath!),
    });
  }
  entries.push({
    id: "reveal",
    label: t("Mostrar na pasta"),
    disabled: !onDisk(row) || absolutePath === null,
    onSelect: () => absolutePath && act.reveal(absolutePath),
  });
  return entries;
}

export interface ScmGroupActions {
  stageAll: () => void;
  unstageAll: () => void;
  discardAll: () => void;
}

export function scmGroupMenu(
  group: ScmGroupId,
  ctx: { count: number },
  act: ScmGroupActions,
): MenuEntry[] {
  const empty = ctx.count === 0;
  if (group === "staged") {
    return [
      {
        id: "unstage-all",
        label: t("Despreparar tudo"),
        disabled: empty,
        onSelect: act.unstageAll,
      },
    ];
  }
  if (group === "conflicts") {
    return [
      {
        id: "stage-all",
        label: t("Marcar todos como resolvidos"),
        disabled: empty,
        onSelect: act.stageAll,
      },
    ];
  }
  return [
    { id: "stage-all", label: t("Preparar tudo"), disabled: empty, onSelect: act.stageAll },
    {
      id: "discard-all",
      label: t("Descartar tudo"),
      disabled: empty,
      danger: true,
      onSelect: act.discardAll,
    },
  ];
}

export interface ScmBranchActions {
  checkout: (name: string) => void;
  createFrom: (start: string) => void;
  merge: (name: string) => void;
  rebase: (name: string) => void;
  rename: (name: string) => void;
  deleteBranch: (name: string, force: boolean) => void;
  deleteRemote: (name: string) => void;
  copyText: (text: string) => void;
}

export function scmBranchMenu(
  branch: ScmBranch,
  ctx: { info: ScmInfo | null },
  act: ScmBranchActions,
): MenuEntry[] {
  const halted = (ctx.info?.state ?? "clean") !== "clean";
  const entries: MenuEntry[] = [];

  if (branch.remote) {
    // Checking out a remote branch detaches HEAD. What the person wants is a
    // local one that tracks it — and that is what the entry offers, by that name.
    entries.push({
      id: "create-from",
      label: t("Criar uma branch local a partir dela"),
      disabled: halted,
      onSelect: () => act.createFrom(branch.name),
    });
  } else {
    entries.push({
      id: "checkout",
      label: t("Trocar para esta branch"),
      disabled: branch.current || halted,
      onSelect: () => act.checkout(branch.name),
    });
    entries.push({
      id: "create-from",
      label: t("Criar uma branch a partir dela"),
      disabled: halted,
      onSelect: () => act.createFrom(branch.name),
    });
  }

  entries.push({ kind: "sep" });
  entries.push({
    id: "merge",
    label: t("Trazer para {branch} (merge)", { branch: ctx.info?.branch ?? t("a atual") }),
    disabled: branch.current || halted,
    onSelect: () => act.merge(branch.name),
  });
  entries.push({
    id: "rebase",
    label: t("Reaplicar a atual em cima dela (rebase)"),
    disabled: branch.current || halted,
    onSelect: () => act.rebase(branch.name),
  });

  entries.push({ kind: "sep" });
  if (!branch.remote) {
    entries.push({
      id: "rename",
      label: t("Renomear…"),
      onSelect: () => act.rename(branch.name),
    });
    // The upstream vanished (`gone`) = already merged and deleted on the
    // server. It is the only case where deleting without `-D` is safe *and* obvious.
    const safe = branch.gone || branch.behind === 0;
    entries.push({
      id: "delete",
      label: safe ? t("Apagar a branch") : t("Apagar a branch (forçar)"),
      disabled: branch.current,
      danger: true,
      onSelect: () => act.deleteBranch(branch.name, !safe),
    });
  }
  entries.push({
    id: "delete-remote",
    label: t("Apagar no servidor"),
    disabled: (ctx.info?.remotes.length ?? 0) === 0,
    danger: true,
    onSelect: () => act.deleteRemote(branch.name),
  });

  entries.push({ kind: "sep" });
  entries.push({
    id: "copy-name",
    label: t("Copiar o nome"),
    onSelect: () => act.copyText(branch.name),
  });

  return entries;
}

export interface ScmCommitActions {
  checkout: (rev: string) => void;
  createFrom: (start: string) => void;
  revert: (hash: string) => void;
  reset: (hash: string, mode: "soft" | "mixed" | "hard") => void;
  tag: (hash: string) => void;
  copyText: (text: string) => void;
}

export function scmCommitMenu(
  commit: ScmCommit,
  ctx: { info: ScmInfo | null },
  act: ScmCommitActions,
): MenuEntry[] {
  const halted = (ctx.info?.state ?? "clean") !== "clean";
  return [
    {
      id: "branch-here",
      label: t("Criar uma branch aqui…"),
      disabled: halted,
      onSelect: () => act.createFrom(commit.hash),
    },
    {
      id: "tag-here",
      label: t("Criar uma etiqueta aqui…"),
      disabled: halted,
      onSelect: () => act.tag(commit.hash),
    },
    {
      id: "checkout",
      label: t("Ir para este commit (HEAD solto)"),
      disabled: halted,
      onSelect: () => act.checkout(commit.hash),
    },
    { kind: "sep" },
    {
      id: "revert",
      // Revert records the opposite: it is the only safe undo on a branch
      // other people have already pulled.
      label: t("Reverter este commit"),
      disabled: halted,
      onSelect: () => act.revert(commit.hash),
    },
    {
      id: "reset-soft",
      label: t("Voltar até aqui, mantendo tudo preparado"),
      disabled: halted,
      onSelect: () => act.reset(commit.hash, "soft"),
    },
    {
      id: "reset-mixed",
      label: t("Voltar até aqui, mantendo os arquivos"),
      disabled: halted,
      onSelect: () => act.reset(commit.hash, "mixed"),
    },
    {
      id: "reset-hard",
      label: t("Voltar até aqui, jogando fora o resto"),
      disabled: halted,
      danger: true,
      onSelect: () => act.reset(commit.hash, "hard"),
    },
    { kind: "sep" },
    {
      id: "copy-hash",
      // The full hash, not the abbreviated one on screen: it is what gets
      // pasted into a command or a PR comment.
      label: t("Copiar o hash"),
      onSelect: () => act.copyText(commit.hash),
    },
    {
      id: "copy-subject",
      label: t("Copiar a mensagem"),
      onSelect: () =>
        act.copyText(commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject),
    },
  ];
}

export interface ScmStashActions {
  stashApply: (index: number, pop: boolean) => void;
  stashDrop: (index: number) => void;
  stashShow: (index: number) => void;
}

export function scmStashMenu(stash: ScmStash, act: ScmStashActions): MenuEntry[] {
  return [
    {
      id: "pop",
      label: t("Aplicar e remover"),
      onSelect: () => act.stashApply(stash.index, true),
    },
    {
      id: "apply",
      label: t("Aplicar mantendo o guardado"),
      onSelect: () => act.stashApply(stash.index, false),
    },
    { id: "show", label: t("Ver o que tem dentro"), onSelect: () => act.stashShow(stash.index) },
    { kind: "sep" },
    {
      id: "drop",
      // There is no way to bring it back from the screen: the `stash@{n}` leaves the list.
      label: t("Descartar o guardado"),
      danger: true,
      onSelect: () => act.stashDrop(stash.index),
    },
  ];
}
