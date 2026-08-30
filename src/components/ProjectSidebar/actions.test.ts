/**
 * The notebook's row at the top of the sidebar. It used to be a square in the
 * top-right corner, where an icon with no name had to carry both what it
 * opens and the shortcut inside the balloon.
 *
 * The row prints the name, and only the name: a key spelled out next to it is
 * a second piece of chrome to read on every glance, for something the user
 * learns once. So the shortcut goes back where every other door in the app
 * keeps it, in the balloon, one hover away.
 */
import { describe, expect, it } from "vitest";

import { canvasAction, notesAction, searchAction, settingsAction } from "./actions";

describe("the sidebar's notes row", () => {
  it("keeps the same name open or closed, only the balloon flips", () => {
    expect(notesAction({ open: false }).label).toBe("Anotações");
    expect(notesAction({ open: true }).label).toBe("Anotações");
    expect(notesAction({ open: false }).tip).not.toBe(notesAction({ open: true }).tip);
  });

  it("says what it opens while closed and what it closes while open", () => {
    expect(notesAction({ open: false }).tip).toBe(
      "Mostrar as anotações, o caderno markdown (Ctrl+Shift+N)",
    );
    expect(notesAction({ open: true }).tip).toBe("Esconder as anotações (Ctrl+Shift+N)");
  });

  it("the balloon carries the shortcut, which the row itself does not print", () => {
    expect(notesAction({ open: false }).tip).toContain("(Ctrl+Shift+N)");
    expect(notesAction({ open: true }).tip).toContain("(Ctrl+Shift+N)");
  });
});

/**
 * Settings is the other door that belongs to no project. It used to be the
 * last square of the title bar, next to the panel toggles: the same shape and
 * the same 26px as a control that opens a *panel*, for the one that opens a
 * *window*, and in the strip of the bar the eye scans most. It sits in the
 * corner of the sidebar's footer now, icon only, where every app of this kind
 * keeps it: out of the way of the things used all day, and still somewhere
 * nobody has to hunt for. Icon only means the name is spoken, not printed,
 * which is why the label still has to exist and still has to be stable.
 */
describe("the sidebar's settings door", () => {
  it("names the door for a screen reader and leaves the shortcut to the balloon", () => {
    expect(settingsAction().label).toBe("Configurações");
    expect(settingsAction().tip).toBe("Abrir as configurações (Ctrl+Shift+P)");
  });

  it("the balloon adds something the row does not already say", () => {
    const row = settingsAction();
    expect(row.tip).not.toBe(row.label);
    expect(row.tip).toContain("(Ctrl+Shift+P)");
  });
});

/**
 * The Busca is the third door that belongs to no project, and it moved into
 * the same stack, above the notebook: it was a 13px magnifier in the corner
 * of the status bar, an anonymous glyph for the one way into everything the
 * app holds. As a named row it says what it is without a hover, and the
 * balloon keeps carrying what the name cannot: what the field finds, and the
 * shortcut.
 */
describe("the sidebar's search row", () => {
  it("prints the name and leaves what it finds, plus the shortcut, to the balloon", () => {
    expect(searchAction().label).toBe("Busca");
    expect(searchAction().tip).toBe("Buscar agentes, arquivos, notas e ações (Ctrl+P)");
  });

  it("the balloon adds something the row does not already say", () => {
    const row = searchAction();
    expect(row.tip).not.toBe(row.label);
    expect(row.tip).toContain("(Ctrl+P)");
  });
});

/**
 * The canvas used to be a button in the title bar, beside the pane switch,
 * where it read as a fourth shape of the grid it is not: it is the group's
 * other surface, with its own cards and its own CLIs. It belongs with the
 * other doors of the sidebar, which is already the list of places to go, and
 * it is a toggle, so the row that takes the user there is also the way back.
 */
describe("the sidebar's canvas row", () => {
  it("keeps the same name on both surfaces, only the balloon flips", () => {
    expect(canvasAction({ open: false }).label).toBe("Canvas");
    expect(canvasAction({ open: true }).label).toBe("Canvas");
    expect(canvasAction({ open: false }).tip).not.toBe(canvasAction({ open: true }).tip);
  });

  it("offers the board from the panes and the panes from the board", () => {
    expect(canvasAction({ open: false }).tip).toBe(
      "Ir para o canvas: cartões soltos, desenho à mão, notas e conexões, com as CLIs de lá",
    );
    expect(canvasAction({ open: true }).tip).toBe(
      "Voltar aos painéis: as abas e a grade do grupo",
    );
  });

  it("the balloon says something the name does not already say", () => {
    const row = canvasAction({ open: false });
    expect(row.tip).not.toBe(row.label);
  });
});
