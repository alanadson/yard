/**
 * Renaming from the card is the same promise on every type of card: the name
 * the header shows is the name `yard` addresses, and clearing it goes back to
 * the derived one (first line, hostname, file name) instead of leaving an
 * empty header. A flow and a group never go blank, because the CLI and the
 * band read them by name.
 */
import { describe, expect, it } from "vitest";

import { EMPTY_CANVAS, type CanvasData, type CanvasItem } from "./canvas";
import { canRename, renameItem } from "./rename";

const items: CanvasItem[] = [
  { id: "n", type: "note", x: 0, y: 0, w: 1, h: 1, text: "# Plano\n", color: "#fff" },
  { id: "p", type: "portal", x: 0, y: 0, w: 1, h: 1, url: "https://a.dev", color: "#fff" },
  { id: "m", type: "media", x: 0, y: 0, w: 1, h: 1, path: "docs/a.png", color: "#fff" },
  { id: "t", type: "tree", x: 0, y: 0, w: 1, h: 1, path: "", mode: "list", color: "#fff" },
  { id: "b", type: "binder", x: 0, y: 0, w: 1, h: 1, notes: [], color: "#fff" },
  { id: "f", type: "flow", x: 0, y: 0, w: 1, h: 1, name: "Revisão", stages: [], color: "#fff" },
  { id: "g", type: "group", x: 0, y: 0, w: 1, h: 1, name: "Time A", color: "#fff" },
  { id: "s", type: "stroke", points: [0, 0, 1, 1], size: "m", color: "#fff" },
  { id: "c", type: "connection", from: "n", to: "p", color: "#fff" },
];

const canvas = (): CanvasData => ({ ...EMPTY_CANVAS, items });

const find = (c: CanvasData, id: string) => c.items.find((i) => i.id === id)!;

describe("renameItem", () => {
  it("pins a name on a note, a portal, a file, a tree and a binder", () => {
    let c = canvas();
    for (const id of ["n", "p", "m", "t", "b"]) c = renameItem(c, id, `  Novo ${id}  `);
    for (const id of ["n", "p", "m", "t", "b"]) {
      expect((find(c, id) as { name?: string }).name).toBe(`Novo ${id}`);
    }
  });

  it("clearing the name drops the field, so the derived name comes back", () => {
    const c = renameItem(renameItem(canvas(), "p", "Docs"), "p", "   ");
    expect("name" in find(c, "p")).toBe(false);
  });

  it("a flow keeps its old name when handed a blank one", () => {
    const c = renameItem(canvas(), "f", "");
    expect((find(c, "f") as { name: string }).name).toBe("Revisão");
  });

  it("a group falls back to the default name instead of an empty band", () => {
    const c = renameItem(canvas(), "g", "");
    expect((find(c, "g") as { name: string }).name).not.toBe("");
  });

  it("cuts a name that would never fit on the header", () => {
    const c = renameItem(canvas(), "m", "x".repeat(200));
    expect((find(c, "m") as { name?: string }).name!.length).toBeLessThan(200);
  });

  it("leaves a stroke, a wire and an unknown id alone", () => {
    const c = canvas();
    expect(renameItem(c, "s", "Risco")).toBe(c);
    expect(renameItem(c, "c", "Fio")).toBe(c);
    expect(renameItem(c, "nope", "Nada")).toBe(c);
  });
});

describe("canRename", () => {
  it("says yes to the cards with a header and no to drawings and wires", () => {
    const c = canvas();
    expect(["n", "p", "m", "t", "b", "f", "g"].every((id) => canRename(find(c, id)))).toBe(true);
    expect(canRename(find(c, "s"))).toBe(false);
    expect(canRename(find(c, "c"))).toBe(false);
  });
});
