/**
 * The status bar mounts with `App`, like the title bar — it is on screen
 * before any lazy chunk arrives. A class of its styled only in a panel's CSS
 * would leave the footer raw until the user happened to open that panel (the
 * "99+" badge did exactly that; see `TitleBar/styles.test.ts`).
 *
 * Same lock, same rule: every class written literally in the bar's JSX has to
 * exist in `src/styles.css`, the only CSS the boot guarantees.
 */
import { describe, expect, it } from "vitest";

import bootCss from "../../styles.css?raw";
import statusBarSrc from "./index.tsx?raw";
import statusChipSrc from "./StatusChip.tsx?raw";

/** Marks the place of a `${…}`: whatever was glued to it is not a literal class. */
const INTERPOLATION = "§";

/**
 * Classes written by hand in a `className` — in quotes or in a template. A
 * piece glued to an interpolation (`sb-dot--${tone}`) is left out: that name
 * only exists at runtime, and demanding it here would be demanding a class
 * that does not exist. The same rule `src/styles.test.ts` applies.
 */
function classesInJsx(font: string): string[] {
  const collected = new Set<string>();
  for (const m of font.matchAll(/className=(?:"([^"]*)"|\{`([\s\S]*?)`\})/g)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, INTERPOLATION);
    for (const c of raw.split(/\s+/)) {
      if (c && !c.includes(INTERPOLATION)) collected.add(c);
    }
  }
  return [...collected].sort();
}

/** `.foo` counts; `.zz-foo` and `.foo-bar` do not. */
function definedIn(css: string, className: string): boolean {
  return new RegExp(String.raw`(?<![\w-])\.${className}(?![\w-])`).test(css);
}

describe("status bar styling", () => {
  it("ignores the piece glued to an interpolation, but keeps the rest of the template", () => {
    const font = 'a <b className={`sb-dot sb-dot--${s.tone} ${on ? "is-on" : ""}`} />';
    expect(classesInJsx(font)).toEqual(["sb-dot"]);
  });

  it("every class in StatusBar/index.tsx is in the CSS that loads at boot", () => {
    const orphans = classesInJsx(statusBarSrc).filter((c) => !definedIn(bootCss, c));
    expect(orphans).toEqual([]);
  });

  /* The usage chip is part of the footer now, and it is not lazy either: it
     mounts with the bar. Its popover is a body portal, so a class of it
     missing from the boot CSS opens raw over everything. */
  it("every class in StatusBar/StatusChip.tsx is in the CSS that loads at boot", () => {
    const orphans = classesInJsx(statusChipSrc).filter((c) => !definedIn(bootCss, c));
    expect(orphans).toEqual([]);
  });
});
