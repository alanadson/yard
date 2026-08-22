/**
 * The board is the only surface in the app that claims `Tab` for itself: with
 * focus on it, `Tab` cycles through the items (the gesture of a drawing app,
 * not of a form). The price of that, when poorly bounded, is a **keyboard
 * trap** — the most serious accessibility violation there is (WCAG 2.1.2,
 * level A): whoever enters the canvas without a mouse never gets out.
 *
 * That is what used to happen. The shortcut guard accepted any focus inside
 * `.cv` — including the real buttons inside terminal cards — and also
 * `document.body`, which is where focus sits right after the window opens.
 * `Escape` cleared selection and tool, but never gave focus back. There was
 * no key at all that led back to the sidebar.
 *
 * The three rules here are the contract that closes the exit:
 *   1. `Tab` only cycles the board when focus is on the board **itself**;
 *   2. `Escape`, when there is nothing left to cancel, **releases** the board;
 *   3. what the cycle selected is said out loud — selection is not focus, and
 *      without that a screen reader has no way to know something changed.
 */
import { describe, expect, it } from "vitest";

import { tabAction, selectionAnnouncement, itemName, escStep } from "./canvasKeys";

describe("what the Tab key means on the board", () => {
  it("cycles through the items when focus is on the board itself", () => {
    expect(tabAction({ isBoard: true, insideBoard: true })).toBe("percorre");
  });

  it("navigates when focus is on a control inside a card — otherwise the keyboard never leaves the canvas", () => {
    expect(tabAction({ isBoard: false, insideBoard: true })).toBe("navega");
  });

  it("navigates when nothing has focus: right after opening, Tab has to reach the sidebar", () => {
    // `document.body` counts as "no focus". The arrows and the tool keys
    // still apply in that state — `Tab` does not.
    expect(tabAction({ isBoard: false, insideBoard: false })).toBe("navega");
  });
});

describe("the Escape chain", () => {
  const halted = {
    strokeDraft: false,
    connecting: false,
    selectedCount: 0,
    activeTool: "select" as const,
  };

  it("the stroke draft comes before everything else", () => {
    expect(
      escStep({ ...halted, strokeDraft: true, connecting: true, selectedCount: 3 }),
    ).toBe("limpa-rascunho");
  });

  it("after the draft, cancels the connection in progress", () => {
    expect(escStep({ ...halted, connecting: true, selectedCount: 3 })).toBe(
      "cancela-conexao",
    );
  });

  it("after the connection, clears the selection", () => {
    expect(escStep({ ...halted, selectedCount: 3 })).toBe("limpa-selecao");
  });

  it("with nothing to cancel, goes back to the select tool", () => {
    expect(escStep({ ...halted, activeTool: "note" })).toBe("volta-para-selecionar");
  });

  it("already on select and with nothing to cancel, releases the board — that is the keyboard exit", () => {
    expect(escStep(halted)).toBe("solta-o-tabuleiro");
  });
});

describe("what gets announced when the cycle switches item", () => {
  it("says the kind, the name and the position in the round", () => {
    expect(selectionAnnouncement({ kind: "terminal", name: "claude" }, 1, 12)).toBe(
      "Terminal claude, 2 de 12",
    );
  });

  it("translates the item type and uses the name when there is one", () => {
    expect(selectionAnnouncement({ kind: "item", type: "note", name: "Briefing" }, 4, 12)).toBe(
      "Nota Briefing, 5 de 12",
    );
  });

  it("an unnamed item is announced by its kind alone", () => {
    expect(selectionAnnouncement({ kind: "item", type: "stroke" }, 0, 3)).toBe(
      "Desenho, 1 de 3",
    );
  });

  it("a blank name does not become a dangling space in the announcement", () => {
    expect(selectionAnnouncement({ kind: "item", type: "portal", name: "  " }, 0, 1)).toBe(
      "Portal, 1 de 1",
    );
  });
});

describe("the name a drawn item introduces itself with", () => {
  const base = { id: "x", at: 0, color: "#fff" } as const;

  it("the note uses the pinned name, or the first line when there is none", () => {
    expect(
      itemName({ ...base, type: "note", x: 0, y: 0, w: 1, h: 1, text: "# Briefing\nresto" }),
    ).toBe("Briefing");
  });

  it("the portal uses the hostname when nobody named it", () => {
    expect(
      itemName({ ...base, type: "portal", x: 0, y: 0, w: 1, h: 1, url: "https://exemplo.com/a" }),
    ).toBe("exemplo.com");
  });

  it("a loose text announces itself by its own content, trimmed", () => {
    expect(
      itemName({ ...base, type: "text", x: 0, y: 0, text: "  combinar o deploy  ", fontSize: 13 }),
    ).toBe("combinar o deploy");
  });

  it("a stroke has no name — the kind alone is enough", () => {
    expect(
      itemName({ ...base, type: "stroke", points: [0, 0], size: "m" }),
    ).toBeUndefined();
  });
});
