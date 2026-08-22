/**
 * A surface that rises on top of the app — the editor, the diff, the
 * notebook, Search, every dialog — with the safety net under it.
 *
 * Why it exists: `WorkspaceGrid` already isolated pane and canvas, but every
 * overlay shared **one** `Suspense` and no `ErrorBoundary` all the way up to
 * the root. A render error in any of them — and that is where the most
 * complicated code in the app lives — swapped the whole window for the crash
 * screen, which is exactly the damage the boundary exists to contain.
 * Splitting the `Suspense` along with it fixes the other effect of the
 * grouping: opening Search with the diff open swapped the diff for the
 * "carregando" while the chunk downloaded.
 *
 * `where` is the name in the user's voice ("o editor", "esta janela") — it is
 * what the boundary shows and what goes to `yard.log`.
 */
import { Suspense, type ReactNode } from "react";

import { ErrorBoundary } from "../ErrorBoundary";

export function Overlay({
  where,
  fallback,
  children,
}: {
  where: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary where={where}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ErrorBoundary>
  );
}
