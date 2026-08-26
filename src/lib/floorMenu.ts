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
import { isIsolatedFloor, type FloorMeta } from "./floors";
import type { MenuEntry } from "../components/ContextMenu";
import { t } from "./i18n";

export interface FloorMenuActions {
  goTo: () => void;
  land: () => void;
  runHooks: () => void;
  unload: () => void;
  copy: (text: string) => void;
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
}

export function floorRowMenu(ctx: FloorMenuContext, act: FloorMenuActions): MenuEntry[] {
  const { floor } = ctx;
  const isFloor = !ctx.isGround && !!floor;
  const entries: MenuEntry[] = [
    { id: "ir", label: "Ir para este andar", onSelect: act.goTo },
  ];

  if (isFloor && isIsolatedFloor(floor)) {
    entries.push({
      id: "land",
      label: t("Aterrissar no chão…"),
      disabled: ctx.busy,
      onSelect: act.land,
    });
  }
  if (floor?.hooks?.run.length) {
    entries.push({
      id: "hooks",
      label: t("Rodar os hooks do andar"),
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
        label: t("Encerrar o andar…"),
        danger: true,
        disabled: ctx.busy,
        onSelect: act.close,
      },
    );
  }
  return entries;
}
