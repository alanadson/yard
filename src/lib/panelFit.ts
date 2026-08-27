/**
 * Whether the workspace still has room to be a workspace.
 *
 * The three lateral panels declare their own minimum (`SIDEBAR_MIN`,
 * `CHANGES_MIN`, `BENCH_MIN` in `stores/uiStore.ts`) and the window is
 * allowed down to 900 px, so the arithmetic decides who stays. It lived
 * inline in `App.tsx`'s resize effect, where no test could see the boundary —
 * and the boundary is the part that is easy to get wrong by one pixel.
 *
 * See `panelFit.test.ts` for the behaviour this locks down.
 */

/** What is left for the workspace once every open panel takes its minimum. */
export function leftover(width: number, openCosts: readonly number[]): number {
  return openCosts.reduce((left, cost) => left - cost, width);
}

/**
 * True while the workspace still has its floor. The floor is a width that
 * works, so equality passes.
 */
export function fits(
  width: number,
  openCosts: readonly number[],
  workspaceMin: number,
): boolean {
  return leftover(width, openCosts) >= workspaceMin;
}
