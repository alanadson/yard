/**
 * The page on the other side of `eval` is not ours: whatever comes back has
 * to be checked, and whatever goes into the prompt has to survive Markdown.
 */
import { describe, expect, it } from "vitest";

import { formatGrab, grabLabel, parseGrab, type GrabPick } from "./grab";

const raw = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    url: "http://localhost:5173/settings",
    title: "Ajustes",
    viewport: { w: 1280, h: 800 },
    tag: "button",
    id: "salvar",
    classes: ["btn", "btn--primary"],
    selector: "#salvar",
    parent: "form.settings",
    text: "Salvar",
    attrs: { type: "submit", "aria-label": "Salvar ajustes" },
    rect: { x: 40, y: 620, w: 96, h: 32 },
    styles: { backgroundColor: "rgb(10, 132, 255)", fontSize: "13px" },
    html: '<button id="salvar" class="btn">Salvar</button>',
    ...patch,
  });

const picked = (patch: Record<string, unknown> = {}): GrabPick => {
  const result = parseGrab(raw(patch));
  if (result.kind !== "picked") throw new Error("expected a pick");
  return result.pick;
};

describe("parseGrab", () => {
  it("reads a full pick", () => {
    const result = parseGrab(raw());
    expect(result.kind).toBe("picked");
    if (result.kind !== "picked") return;
    expect(result.pick.selector).toBe("#salvar");
    expect(result.pick.classes).toEqual(["btn", "btn--primary"]);
    expect(result.pick.rect).toEqual({ x: 40, y: 620, w: 96, h: 32 });
  });

  it("says pending while nothing was picked", () => {
    expect(parseGrab("").kind).toBe("pending");
    expect(parseGrab("   ").kind).toBe("pending");
  });

  it("understands the escape hatch", () => {
    expect(parseGrab('{"cancelled":true}').kind).toBe("cancelled");
  });

  it("treats junk from the page as a cancel, never as a crash", () => {
    expect(parseGrab("não é json").kind).toBe("cancelled");
    expect(parseGrab("null").kind).toBe("cancelled");
    expect(parseGrab('{"tag":42}').kind).toBe("cancelled");
    expect(parseGrab("[]").kind).toBe("cancelled");
  });

  it("drops fields of the wrong type instead of trusting them", () => {
    const pick = picked({
      classes: ["ok", 7, null],
      attrs: { good: "sim", bad: 12 },
      rect: { x: "40", y: 620 },
    });
    expect(pick.classes).toEqual(["ok"]);
    expect(pick.attrs).toEqual({ good: "sim" });
    expect(pick.rect).toEqual({ x: 0, y: 620, w: 0, h: 0 });
  });

  it("caps a page that returns something enormous", () => {
    const pick = picked({ html: "x".repeat(9000), text: "y".repeat(9000) });
    expect(pick.html.length).toBe(1600);
    expect(pick.text.length).toBe(300);
  });
});

describe("grabLabel", () => {
  it("prefers the accessible name", () => {
    expect(grabLabel(picked())).toBe('button “Salvar ajustes”');
  });

  it("falls back to the text, then to the tag alone", () => {
    expect(grabLabel(picked({ attrs: {} }))).toBe('button “Salvar”');
    expect(grabLabel(picked({ attrs: {}, text: "" }))).toBe("button");
  });
});

describe("formatGrab", () => {
  it("leads with where and what", () => {
    const text = formatGrab(picked());
    expect(text.split("\n")[0]).toBe('Elemento apontado no portal — button “Salvar ajustes”');
    expect(text).toContain("**Página:** http://localhost:5173/settings");
    expect(text).toContain("**Seletor:** `#salvar`");
  });

  it("writes the styles the way CSS spells them", () => {
    expect(formatGrab(picked())).toContain("- background-color: rgb(10, 132, 255)");
  });

  it("carries the screenshot crop as a path the agent can open", () => {
    const text = formatGrab(picked(), "C:\\yard\\portals\\shots\\p1_9.png");
    expect(text).toContain("**Recorte da tela:** `C:\\yard\\portals\\shots\\p1_9.png`");
    // Right after the page line: the picture is the fastest way to see
    // "which element", so it comes before selector and styles.
    const lines = text.split("\n");
    expect(lines.indexOf(lines.find((l) => l.startsWith("**Recorte"))!)).toBe(
      lines.indexOf(lines.find((l) => l.startsWith("**Página"))!) + 1,
    );
  });

  it("says nothing about a screenshot when the capture failed", () => {
    expect(formatGrab(picked())).not.toContain("Recorte");
    expect(formatGrab(picked(), null)).not.toContain("Recorte");
  });

  it("does not repeat the accessible name among the attributes", () => {
    expect(formatGrab(picked())).not.toContain("aria-label=");
  });

  it("keeps markup with backticks from breaking the fence", () => {
    const text = formatGrab(picked({ html: '<code>``x``</code>' }));
    expect(text).toContain("```html");
    expect(text.split("\n").at(-3)).toBe("```");
  });

  it("ends on the line the user is about to fill in", () => {
    expect(formatGrab(picked()).endsWith("O que muda aqui: ")).toBe(true);
  });

  it("survives an element with nothing but a tag", () => {
    const text = formatGrab(
      picked({ id: "", classes: [], selector: "", parent: "", text: "", attrs: {}, styles: {}, html: "" }),
    );
    expect(text).toContain("**Seletor:** `button`");
  });
});
