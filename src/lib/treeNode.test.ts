/**
 * The two rules a tree card carries that are not just constants: what it is
 * called, and which folders it has open.
 *
 * The open set is the one that matters, and §14.1 is the reason: several cards
 * may sit on the same board and **each keeps its own**. The moment this became
 * a shared structure — the side panel's, say — expanding `src` on one card
 * would expand it on all of them.
 */
import { describe, expect, it } from "vitest";

import { isOpen, toggled, treeNodeName } from "./treeNode";
import type { TreeItem } from "./treeNode";

const tree = (patch: Partial<TreeItem> = {}): TreeItem => ({
  id: "t1",
  type: "tree",
  x: 0,
  y: 0,
  w: 320,
  h: 420,
  path: "",
  mode: "list",
  color: "#fff",
  ...patch,
});

describe("treeNodeName", () => {
  it("calls a card at the project root 'Arquivos'", () => {
    // `path` is `""` there, and a blank header reads as a bug.
    expect(treeNodeName(tree())).toBe("Arquivos");
  });

  it("uses the folder's own name, not the whole path", () => {
    expect(treeNodeName(tree({ path: "src/components/CanvasView" }))).toBe("CanvasView");
  });

  it("prefers the name the user pinned", () => {
    expect(treeNodeName(tree({ path: "src", name: "Fonte" }))).toBe("Fonte");
  });
});

describe("toggled", () => {
  it("opens a folder that was closed", () => {
    expect(toggled(tree(), "src")).toEqual(["src"]);
  });

  it("closes a folder that was open", () => {
    expect(toggled(tree({ expanded: ["src", "docs"] }), "src")).toEqual(["docs"]);
  });

  it("leaves the other folders of the card alone", () => {
    expect(toggled(tree({ expanded: ["docs"] }), "src")).toEqual(["docs", "src"]);
  });

  it("reads as closed when the card has never opened anything", () => {
    expect(isOpen(tree(), "src")).toBe(false);
  });
});
