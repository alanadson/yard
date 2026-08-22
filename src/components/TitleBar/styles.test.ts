/**
 * The title bar is the only surface already mounted when the window opens —
 * it is not lazy, it comes along with `App`. If one of its classes lives in a
 * CSS file that only reaches the bundle of a panel loaded on demand, the app
 * opens with the element **raw** and fixes itself later, when the user opens
 * that panel. That is exactly what happened with the count badge:
 * `.changes-toggle-badge` lived in `ChangesPanel/changes.css`, downloaded
 * only when the changes panel opened — the "99+" was born as loose text under
 * the icon and only became a blue pill afterwards.
 *
 * This test locks the regression for the whole bar: every class written
 * literally in the bar's JSX has to exist in `src/styles.css`, the only CSS
 * the boot guarantees.
 */
import { describe, expect, it } from "vitest";

// `?raw` instead of `fs`: it is the same loader the app uses, and the suite
// stays free of new dependencies (there is no `@types/node` here, on purpose).
import bootCss from "../../styles.css?raw";
import statusChipSrc from "./StatusChip.tsx?raw";
import titleBarSrc from "./index.tsx?raw";

/**
 * Classes written by hand in a `className` — in quotes or in a template. The
 * inside of `${…}` is left out: that is a runtime decision, not a literal class.
 */
function classesInJsx(font: string): string[] {
  const collected = new Set<string>();
  for (const m of font.matchAll(/className=(?:"([^"]*)"|\{`([\s\S]*?)`\})/g)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const c of raw.split(/\s+/)) if (c) collected.add(c);
  }
  return [...collected].sort();
}

/** `.foo` counts; `.zz-foo` and `.foo-bar` do not. */
function definedIn(css: string, className: string): boolean {
  return new RegExp(String.raw`(?<![\w-])\.${className}(?![\w-])`).test(css);
}

describe("title bar styling", () => {
  const sources = [
    ["TitleBar/index.tsx", titleBarSrc],
    ["TitleBar/StatusChip.tsx", statusChipSrc],
  ] as const;

  it("extracts the classes from the JSX, including those inside a template", () => {
    const theFont = 'a <b className="um dois" /> <i className={`tres ${x ? "nao" : ""}`} />';
    expect(classesInJsx(theFont)).toEqual(["dois", "tres", "um"]);
  });

  it("a look-alike class does not pass as defined", () => {
    expect(definedIn(".zz-crumb { color: red }", "crumb")).toBe(false);
    expect(definedIn(".crumb-branch { color: red }", "crumb")).toBe(false);
    expect(definedIn(".crumb.is-active { color: red }", "crumb")).toBe(true);
  });

  for (const [name, font] of sources) {
    it(`every class in ${name} is in the CSS that loads at boot`, () => {
      const orphans = classesInJsx(font).filter((c) => !definedIn(bootCss, c));
      expect(orphans).toEqual([]);
    });
  }
});
