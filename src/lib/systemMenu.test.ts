/**
 * The right-click safety net.
 *
 * The rule these assertions lock in is a single one: **no right-click may do
 * nothing**. Before this the app had a menu on about ten surfaces and silence
 * everywhere else — and silence, in an app that suppresses WebView2's native
 * menu, is worse than having no menu: the user loses "copy" and "paste"
 * without getting anything in return.
 *
 * What this module decides is only *which actions fit here*; executing them
 * is the `GlobalMenu`'s job. Separating the two is what keeps the decision
 * testable without a DOM — the suite runs in a node environment, on purpose.
 */
import { describe, expect, it } from "vitest";

import { menuTerm, systemMenuGroups, type MenuTarget } from "./systemMenu";

const target = (over: Partial<MenuTarget> = {}): MenuTarget => ({
  editable: false,
  readOnly: false,
  selection: "",
  link: null,
  hasProject: true,
  ...over,
});

/** Every id in the plan, flattened — group order is preserved. */
const ids = (t: MenuTarget) => systemMenuGroups(t).flat().map((a) => a.id);

describe("systemMenuGroups", () => {
  it("a click on nothing still returns the application actions — an empty menu is forbidden", () => {
    const groups = systemMenuGroups(target());
    expect(groups.flat().length).toBeGreaterThan(0);
    expect(ids(target())).toContain("palette");
  });

  it("a text field offers paste and select all even with nothing selected", () => {
    const flattened = systemMenuGroups(target({ editable: true })).flat();
    const paste = flattened.find((a) => a.id === "paste");
    const all = flattened.find((a) => a.id === "select-all");
    expect(paste?.disabled).toBeFalsy();
    expect(all?.disabled).toBeFalsy();
  });

  it("with no selection, cut and copy show greyed out — they do not vanish from their spot", () => {
    const flattened = systemMenuGroups(target({ editable: true })).flat();
    expect(flattened.find((a) => a.id === "cut")?.disabled).toBe(true);
    expect(flattened.find((a) => a.id === "copy")?.disabled).toBe(true);
  });

  it("with a selection in the field, cut and copy wake up", () => {
    const flattened = systemMenuGroups(target({ editable: true, selection: "abc" })).flat();
    expect(flattened.find((a) => a.id === "cut")?.disabled).toBeFalsy();
    expect(flattened.find((a) => a.id === "copy")?.disabled).toBeFalsy();
  });

  it("a read-only field copies, but neither cuts nor pastes", () => {
    const flattened = ids(target({ editable: false, readOnly: true, selection: "abc" }));
    expect(flattened).toContain("copy");
    expect(flattened).not.toContain("cut");
    expect(flattened).not.toContain("paste");
  });

  it("text selected outside any field only copies and searches", () => {
    const flattened = ids(target({ selection: "engine_tests" }));
    expect(flattened).toContain("copy");
    expect(flattened).toContain("search-selection");
    expect(flattened).not.toContain("cut");
    expect(flattened).not.toContain("paste");
  });

  it("copy shows up only once — an editable field with a selection does not duplicate the entry", () => {
    const flattened = ids(target({ editable: true, selection: "abc" }));
    expect(flattened.filter((id) => id === "copy")).toHaveLength(1);
  });

  it("search the project vanishes when no project is open — it would lead nowhere", () => {
    expect(ids(target({ selection: "abc", hasProject: false }))).not.toContain(
      "search-selection",
    );
  });

  it("a whitespace selection does not count as a selection", () => {
    const flattened = systemMenuGroups(target({ editable: true, selection: "   \n " })).flat();
    expect(flattened.find((a) => a.id === "copy")?.disabled).toBe(true);
    expect(ids(target({ selection: "  " }))).not.toContain("search-selection");
  });

  it("the link comes before the text actions — it is what is under the cursor", () => {
    const flattened = ids(target({ link: "https://exemplo.dev", selection: "abc" }));
    expect(flattened.indexOf("copy-link")).toBeLessThan(flattened.indexOf("copy"));
  });

  it("the search carries the term that goes in the label, already trimmed", () => {
    const flattened = systemMenuGroups(target({ selection: "  fluxo  " })).flat();
    expect(flattened.find((a) => a.id === "search-selection")?.term).toBe("fluxo");
  });

  it("the application actions sit in a separate group, at the end", () => {
    const groups = systemMenuGroups(target({ editable: true, selection: "abc" }));
    expect(groups.length).toBeGreaterThan(1);
    expect(groups[groups.length - 1].map((a) => a.id)).toEqual(["palette", "prefs"]);
  });

  it("no empty group reaches the menu — a stray separator is clutter on screen", () => {
    for (const t of [
      target(),
      target({ editable: true }),
      target({ readOnly: true }),
      target({ link: "x" }),
      target({ selection: "a", hasProject: false }),
    ]) {
      expect(systemMenuGroups(t).every((g) => g.length > 0)).toBe(true);
    }
  });
});

describe("menuTerm", () => {
  it("shrinks a long snippet with an ellipsis — the label must not break the menu", () => {
    const label = menuTerm("a".repeat(80));
    expect(label.length).toBeLessThanOrEqual(25);
    expect(label.endsWith("…")).toBe(true);
  });

  it("flattens line breaks into a single line", () => {
    expect(menuTerm("abre\no arquivo")).toBe("abre o arquivo");
  });

  it("leaves a short snippet exactly as it is", () => {
    expect(menuTerm("flow.ts")).toBe("flow.ts");
  });
});
