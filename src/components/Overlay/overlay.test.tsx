/**
 * The regression this locks in: the overlays (editor, diff, notebook, Search,
 * every dialog) shared a single `Suspense` and **no** error boundary all the
 * way up to the root — a render error in any of them swapped the whole window
 * for the crash screen. Pane and canvas already had a boundary; the most
 * complex screens in the app did not.
 *
 * The suite runs without a DOM on purpose (that is what keeps it in seconds),
 * so the test does not render: it calls the component and checks the tree it
 * returns. That is enough to lock the contract — whoever removes the boundary
 * from here sees red.
 */
import { describe, expect, it } from "vitest";
import { Suspense, isValidElement, type ReactElement } from "react";

import { Overlay } from "./index";
import { ErrorBoundary } from "../ErrorBoundary";

describe("Overlay", () => {
  it("wraps the surface in its own error boundary, with the Suspense inside", () => {
    const tree = Overlay({
      where: "o editor",
      fallback: "carregando",
      children: "conteúdo",
    }) as ReactElement<{ where: string; children: ReactElement }>;

    expect(isValidElement(tree)).toBe(true);
    expect(tree.type).toBe(ErrorBoundary);
    expect(tree.props.where).toBe("o editor");

    // The Suspense sits INSIDE the boundary: a chunk that fails to download
    // arrives as a render error, and the one that has to catch it is this
    // surface's boundary — not the root's.
    const inside = tree.props.children;
    expect(inside.type).toBe(Suspense);
  });
});
