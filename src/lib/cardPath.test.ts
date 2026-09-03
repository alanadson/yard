/**
 * "Copiar caminho" on a card has to produce the path the OS understands: the
 * card stores a `/`-separated relative path (portable across checkouts), and
 * the clipboard wants the absolute one, in the project's own separators.
 */
import { describe, expect, it } from "vitest";

import type { CanvasItem } from "./canvas";
import { itemAbsolutePath, joinPath } from "./cardPath";

describe("joinPath", () => {
  it("uses the root's separator, whichever it is", () => {
    expect(joinPath("C:\\Workspace\\yard", "docs/shot.png")).toBe(
      "C:\\Workspace\\yard\\docs\\shot.png",
    );
    expect(joinPath("/home/ana/yard", "docs/shot.png")).toBe("/home/ana/yard/docs/shot.png");
  });

  it("tolerates a trailing separator on the root and an empty path", () => {
    expect(joinPath("C:\\Workspace\\yard\\", "a.png")).toBe("C:\\Workspace\\yard\\a.png");
    expect(joinPath("C:\\Workspace\\yard", "")).toBe("C:\\Workspace\\yard");
  });
});

describe("itemAbsolutePath", () => {
  const root = "C:\\Workspace\\yard";

  it("resolves a project file against the project root", () => {
    const it: CanvasItem = {
      id: "m",
      type: "media",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      path: "docs/shot.png",
      color: "#fff",
    };
    expect(itemAbsolutePath(it, root)).toBe("C:\\Workspace\\yard\\docs\\shot.png");
  });

  it("prefers the card's own root when it carries one", () => {
    const it: CanvasItem = {
      id: "m",
      type: "media",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      path: "ref.png",
      root: "D:/refs",
      color: "#fff",
    };
    expect(itemAbsolutePath(it, root)).toBe("D:/refs/ref.png");
  });

  it("a tree at the project root is the root itself", () => {
    const it: CanvasItem = {
      id: "t",
      type: "tree",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      path: "",
      mode: "list",
      color: "#fff",
    };
    expect(itemAbsolutePath(it, root)).toBe(root);
  });

  it("has no answer on a board with no project and no root on the card", () => {
    const it: CanvasItem = {
      id: "m",
      type: "media",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      path: "a.png",
      color: "#fff",
    };
    expect(itemAbsolutePath(it, "")).toBeNull();
  });

  it("has no answer for a card that is not a file", () => {
    const it: CanvasItem = { id: "n", type: "note", x: 0, y: 0, w: 1, h: 1, text: "", color: "#fff" };
    expect(itemAbsolutePath(it, root)).toBeNull();
  });
});
