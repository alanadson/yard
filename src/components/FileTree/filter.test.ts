/**
 * The tree's filter.
 *
 * The previous version decided visibility by looking only at the item's own
 * name, and the decision happened before the children were drawn: a directory
 * that did not match took the whole subtree with it. In practice the "Filter
 * by name" field only found what was at the root — typing `editorStore` with
 * `src/stores` open gave back an empty tree.
 */
import { describe, expect, it } from "vitest";

import { visiblePaths } from "./index";
import type { DirEntryInfo } from "../../lib/ipc";

const theFile = (path: string): DirEntryInfo => ({
  name: path.split("/").pop()!,
  path,
  dir: false,
  size: 0,
  modifiedAt: 0,
  symlink: false,
});

const folder = (path: string): DirEntryInfo => ({ ...theFile(path), dir: true });

/** `src/` with `stores/` inside — the shape that reproduced the bug. */
const DIRS: Record<string, DirEntryInfo[]> = {
  "": [folder("src"), theFile("README.md")],
  src: [folder("src/stores"), theFile("src/App.tsx")],
  "src/stores": [theFile("src/stores/editorStore.ts"), theFile("src/stores/uiStore.ts")],
};

describe("visiblePaths", () => {
  it("with no filter, hides nothing", () => {
    expect(visiblePaths(DIRS, "")).toBeNull();
    expect(visiblePaths(DIRS, "   ")).toBeNull();
  });

  it("finds a deep file and keeps the lineage that leads to it", () => {
    const visible = visiblePaths(DIRS, "editorStore");
    expect(visible).not.toBeNull();
    expect(visible!.has("src/stores/editorStore.ts")).toBe(true);
    // Without the ancestors the matched item would exist with no way to reach it.
    expect(visible!.has("src")).toBe(true);
    expect(visible!.has("src/stores")).toBe(true);
    // What neither matches nor leads to a match stays out.
    expect(visible!.has("src/App.tsx")).toBe(false);
    expect(visible!.has("README.md")).toBe(false);
  });

  it("is case-insensitive", () => {
    const visible = visiblePaths(DIRS, "EDITORSTORE");
    expect(visible!.has("src/stores/editorStore.ts")).toBe(true);
  });

  it("a matching folder stays navigable from within", () => {
    const visible = visiblePaths(DIRS, "stores");
    expect(visible!.has("src/stores")).toBe(true);
    // The children do not match by name, but hiding them would make the
    // result useless: you found the directory, you want to see what is in it.
    expect(visible!.has("src/stores/editorStore.ts")).toBe(true);
    expect(visible!.has("src/stores/uiStore.ts")).toBe(true);
    expect(visible!.has("src/App.tsx")).toBe(false);
  });

  it("no match returns an empty set, not the whole tree", () => {
    const visible = visiblePaths(DIRS, "zzz");
    expect(visible).not.toBeNull();
    expect(visible!.size).toBe(0);
  });
});
