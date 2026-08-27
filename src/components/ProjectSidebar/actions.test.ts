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

import { notesAction, settingsAction } from "./actions";

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
