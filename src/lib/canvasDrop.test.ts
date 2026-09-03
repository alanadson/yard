/**
 * What a drop on the board becomes. A picture is a picture, a source file is
 * a document, a folder is a tree, and three files dropped together must not
 * land on one pile. The path pasted into a terminal has to survive a space.
 */
import { describe, expect, it } from "vitest";

import {
  DRAG_PATHS_MIME,
  dropItems,
  dropPlan,
  hasDragPaths,
  isMediaPath,
  readDragPaths,
  shellQuote,
  writeDragPaths,
} from "./canvasDrop";

const root = "C:\\Workspace\\yard";

describe("dropPlan", () => {
  it("tells a picture from a source file from a folder", () => {
    const plan = dropPlan(
      [
        { path: "C:\\Workspace\\yard\\docs\\shot.png" },
        { path: "C:\\Workspace\\yard\\src\\main.ts" },
        { path: "C:\\Workspace\\yard\\src", dir: true },
      ],
      root,
    );
    expect(plan.map((p) => p.kind)).toEqual(["media", "doc", "tree"]);
  });

  it("keeps a project file relative and gives an outside file its own root", () => {
    const plan = dropPlan(
      [{ path: "C:\\Workspace\\yard\\docs\\shot.png" }, { path: "D:\\refs\\a.png" }],
      root,
    );
    expect(plan[0]).toEqual({ kind: "media", path: "docs/shot.png" });
    expect(plan[1]).toEqual({ kind: "media", path: "a.png", root: "D:/refs" });
  });

  it("a folder becomes a tree rooted at itself", () => {
    const plan = dropPlan([{ path: "C:\\Workspace\\yard\\src", dir: true }], root);
    expect(plan[0]).toEqual({ kind: "tree", root: "C:/Workspace/yard/src" });
  });
});

describe("dropItems", () => {
  it("spreads several drops so none hides another", () => {
    const items = dropItems(
      [
        { path: "C:\\Workspace\\yard\\a.png" },
        { path: "C:\\Workspace\\yard\\b.ts" },
        { path: "C:\\Workspace\\yard\\src", dir: true },
      ],
      { x: 100, y: 100 },
      root,
    );
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.type)).toEqual(["media", "doc", "tree"]);
    const xs = items.map((i) => ("x" in i ? i.x : 0));
    expect(new Set(xs).size).toBe(3);
    expect(xs[1] - xs[0]).toBe(40);
  });

  it("gives every item a fresh id", () => {
    const items = dropItems(
      [{ path: "C:\\a.png" }, { path: "C:\\b.png" }],
      { x: 0, y: 0 },
      root,
    );
    expect(items[0].id).not.toBe(items[1].id);
  });
});

describe("isMediaPath", () => {
  it("knows the drawn kinds by extension, whatever the case", () => {
    expect(isMediaPath("x.PNG")).toBe(true);
    expect(isMediaPath("clip.mp4")).toBe(true);
    expect(isMediaPath("song.flac")).toBe(true);
    expect(isMediaPath("spec.pdf")).toBe(true);
    expect(isMediaPath("main.rs")).toBe(false);
    expect(isMediaPath("README")).toBe(false);
  });
});

describe("the drag payload", () => {
  it("round-trips through a DataTransfer, dropping junk on the way back", () => {
    const store = new Map<string, string>();
    const dt = {
      types: [] as string[],
      effectAllowed: "none",
      setData(type: string, data: string) {
        store.set(type, data);
        this.types.push(type);
      },
      getData: (type: string) => store.get(type) ?? "",
    };
    writeDragPaths(dt, [{ path: "C:\\a.png" }, { path: "C:\\src", dir: true }]);
    expect(dt.effectAllowed).toBe("copy");
    expect(hasDragPaths(dt)).toBe(true);
    expect(readDragPaths(dt)).toEqual([{ path: "C:\\a.png" }, { path: "C:\\src", dir: true }]);
    expect(dt.getData("text/plain")).toContain("C:\\a.png");
  });

  it("reads nothing from a drag that is not ours, or from broken JSON", () => {
    expect(readDragPaths({ types: ["text/plain"], getData: () => "x" })).toEqual([]);
    expect(readDragPaths({ types: [DRAG_PATHS_MIME], getData: () => "{" })).toEqual([]);
    expect(readDragPaths({ types: [DRAG_PATHS_MIME], getData: () => "[1, {\"dir\": true}]" })).toEqual([]);
    expect(hasDragPaths(null)).toBe(false);
  });
});

describe("shellQuote", () => {
  it("leaves a plain path alone", () => {
    expect(shellQuote("C:\\Workspace\\yard\\src\\main.ts")).toBe("C:\\Workspace\\yard\\src\\main.ts");
  });

  it("wraps a path with a space, and escapes a quote inside it", () => {
    expect(shellQuote("C:\\Users\\Ana Maria\\a.png")).toBe('"C:\\Users\\Ana Maria\\a.png"');
    expect(shellQuote('C:\\odd"name.txt')).toBe('"C:\\odd\\"name.txt"');
  });
});
