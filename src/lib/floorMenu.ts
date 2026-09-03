/**
 * The context menu of a row in the floor list.
 *
 * The row carries three or four cramped icon buttons, each explained only by
 * a tooltip, and did not respond to the right button. Here the same actions
 * get a full name — plus the two that would never fit in the row: copy the
 * branch and copy the worktree path.
 *
 * The rule that runs through everything: **the ground is not a floor**. It
 * does not land (onto what?), does not close (it would take the project with
 * it) and has no worktree of its own. A floor without git (`plain`) has a
 * worktree but no branch, so it does not land either.
 */
import { FRONT_HUES } from "./floorColor";
import { isIsolatedFloor, type FloorMeta } from "./floors";
import type { MenuEntry } from "../components/ContextMenu";
import { t } from "./i18n";

export interface FloorMenuActions {
  goTo: () => void;
  land: () => void;
  /** Merges the ground's branch into the floor: the road back, before the road forward. */
  updateFromGround: () => void;
  runHooks: () => void;
  unload: () => void;
  copy: (text: string) => void;
  /** The colour the floor's cards wear on a board; `null` = the automatic one. */
  setColor: (color: string | null) => void;
  close: () => void;
}

export interface FloorMenuContext {
  /** The first row, with no floor metadata — the project itself. */
  isGround: boolean;
  floor: FloorMeta | undefined;
  /** Live terminals on this floor — what "unload" has to suspend. */
  liveCount: number;
  /** A slow operation is already in progress on this list. */
  busy: boolean;
  /** The branch checked out at the project root, when git says which. */
  groundBranch?: string;
  /** The colour chosen for this floor, if any. */
  color?: string;
}

export function floorRowMenu(ctx: FloorMenuContext, act: FloorMenuActions): MenuEntry[] {
  const { floor } = ctx;
  const isFloor = !ctx.isGround && !!floor;
  const entries: MenuEntry[] = [
    { id: "ir", label: t("Ir para esta frente"), onSelect: act.goTo },
  ];

  if (isFloor && isIsolatedFloor(floor)) {
    entries.push({
      id: "land",
      label: t("Aterrissar no chão…"),
      disabled: ctx.busy,
      onSelect: act.land,
    });
    // A front that grew old while the ground moved on lands with conflicts.
    // Pulling the ground in first is the cheap half of that merge.
    if (ctx.groundBranch) {
      entries.push({
        id: "update",
        label: t("Atualizar a partir do chão (merge de {branch})", { branch: ctx.groundBranch }),
        disabled: ctx.busy,
        onSelect: act.updateFromGround,
      });
    }
  }
  if (isFloor) {
    entries.push({ kind: "sep" }, {
      kind: "swatches",
      label: t("Cor da frente nos quadros"),
      colors: FRONT_HUES,
      active: ctx.color,
      onPick: (c) => act.setColor(c),
      onClear: () => act.setColor(null),
    });
  }
  if (floor?.hooks?.run.length) {
    entries.push({
      id: "hooks",
      label: t("Rodar os hooks da frente"),
      disabled: ctx.busy,
      onSelect: act.runHooks,
    });
  }
  entries.push({
    id: "unload",
    label: t("Descarregar — suspende os terminais"),
    // With nothing alive, suspending sends `suspend` to processes that have
    // already exited, and that comes back as a "failure".
    disabled: ctx.busy || ctx.liveCount === 0,
    onSelect: act.unload,
  });

  const copies: MenuEntry[] = [];
  if (floor?.branch) {
    copies.push({
      id: "copy-branch",
      label: t("Copiar a branch"),
      onSelect: () => act.copy(floor.branch!),
    });
  }
  if (floor?.worktreePath) {
    copies.push({
      id: "copy-path",
      label: t("Copiar o caminho do worktree"),
      onSelect: () => act.copy(floor.worktreePath!),
    });
  }
  if (copies.length > 0) entries.push({ kind: "sep" }, ...copies);

  if (isFloor) {
    entries.push(
      { kind: "sep" },
      {
        id: "close",
        label: t("Encerrar a frente…"),
        danger: true,
        disabled: ctx.busy,
        onSelect: act.close,
      },
    );
  }
  return entries;
}
