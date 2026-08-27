/**
 * `src/styles.css` is the only CSS `index.html` loads before the first pixel.
 * Every `import "./x.css"` that lives inside a `lazy()` module becomes a
 * separate `.css` in the build, downloaded along with the chunk — never on
 * boot.
 *
 * When a class of an **always mounted** component (the grid, the terminal
 * pane, the sidebar, the floors) is styled only in a lazy CSS, the app opens
 * with that element **raw** and fixes itself later, when the user opens the
 * panel that drags the chunk in. It happened with the "99+" badge (see
 * `TitleBar/styles.test.ts`, which locks the bar) and again with the
 * `.pane-empty-actions` of the "No terminal in this group" screen: the two
 * buttons were born stacked on the left, with no `flex` and no `gap`, until
 * someone opened the code editor for the first time.
 *
 * This test locks the regression for the surfaces that remain. The rule is
 * narrow on purpose: a class **styled somewhere** has to be styled in the CSS
 * the boot guarantees. A class with no rule at all (a semantic marker, a hook
 * nobody painted) is not this file's business — demanding a rule for it would
 * only produce CSS for show.
 */
import { describe, expect, it } from "vitest";

import { AA_MIN, passesAA, contrastRatio, blendOver, lightness } from "./lib/contrast";

// `?raw` instead of `fs`: it is the same loader the app uses, and the suite
// stays free of new dependencies (there is no `@types/node` here, on purpose).
import bootCss from "./styles.css?raw";
// These two arrive on boot because `WorkspaceGrid` imports `FloorsControl` and
// `FlowRunsBar` statically — the last test in this file is what locks that
// assumption.
import canvasCss from "./components/CanvasView/canvas.css?raw";
import floorsCss from "./components/Floors/floors.css?raw";

// The lazy ones, to know that a class is styled *somewhere*.
import benchCss from "./components/BenchPanel/bench.css?raw";
import canvasTailCss from "./components/CanvasView/canvas-tail.css?raw";
import changesCss from "./components/ChangesPanel/changes.css?raw";
import composerCss from "./components/Composer/composer.css?raw";
import costsCss from "./components/modals/costs.css?raw";
import editorCss from "./components/CodeEditor/editor.css?raw";
import liveCss from "./components/LiveView/live.css?raw";
import modalCss from "./components/modals/modal.css?raw";
import notesCss from "./components/NotesView/notes.css?raw";
import onboardingCss from "./components/modals/onboarding.css?raw";
import paletteCss from "./components/Palette/palette.css?raw";
import routinesCss from "./components/modals/routines.css?raw";
import scmCss from "./components/BenchPanel/scm.css?raw";
import scoresCss from "./components/modals/scores.css?raw";
import settingsCss from "./components/Settings/settings.css?raw";
import shoulderCss from "./components/modals/shoulder.css?raw";
import transcriptCss from "./components/modals/transcript.css?raw";

import designMd from "../docs/DESIGN.md?raw";
import appSrc from "./App.tsx?raw";
import floorsSrc from "./components/Floors/index.tsx?raw";
import gridSrc from "./components/WorkspaceGrid/index.tsx?raw";
import paneSrc from "./components/TerminalPane/index.tsx?raw";
import sidebarSrc from "./components/ProjectSidebar/index.tsx?raw";

/** The CSS that exists before the first pixel. */
const BOOT_CHUNK_CSS = [bootCss, canvasCss, floorsCss].join("\n");

/**
 * Every sheet the app has, named — the name is what a failure message
 * shows. The list has to stay level with the `.css` files on disk: a sheet
 * missing from here is a sheet no rule in this file ever reads.
 */
const SHEETS = [
  ["styles.css", bootCss],
  ["CanvasView/canvas.css", canvasCss],
  ["Floors/floors.css", floorsCss],
  ["BenchPanel/bench.css", benchCss],
  ["BenchPanel/scm.css", scmCss],
  ["CanvasView/canvas-tail.css", canvasTailCss],
  ["ChangesPanel/changes.css", changesCss],
  ["CodeEditor/editor.css", editorCss],
  ["Composer/composer.css", composerCss],
  ["LiveView/live.css", liveCss],
  ["NotesView/notes.css", notesCss],
  ["Palette/palette.css", paletteCss],
  ["Settings/settings.css", settingsCss],
  ["modals/costs.css", costsCss],
  ["modals/modal.css", modalCss],
  ["modals/onboarding.css", onboardingCss],
  ["modals/routines.css", routinesCss],
  ["modals/scores.css", scoresCss],
  ["modals/shoulder.css", shoulderCss],
  ["modals/transcript.css", transcriptCss],
] as const;

/** All of the app's CSS — to tell "not styled" from "styled late". */
const ALL_CSS = SHEETS.map(([, css]) => css).join("\n");

/** Marks the place of a `${…}`: whatever was glued to it is not a literal class. */
const INTERPOLATION = "\u0000";

/**
 * Reads a template literal starting at the character after the opening
 * backtick and returns only the level-zero text, with each `${…}` (even
 * nested, even with another template inside) reduced to a marker.
 */
function templateBody(theFont: string, begin: number): string {
  let i = begin;
  let depth = 0;
  let body = "";
  while (i < theFont.length) {
    const c = theFont[i];
    if (c === "\\") {
      if (depth === 0) body += INTERPOLATION;
      i += 2;
      continue;
    }
    if (c === "$" && theFont[i + 1] === "{") {
      if (depth === 0) body += INTERPOLATION;
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
      continue;
    }
    if (c === "`") return body;
    body += c;
    i++;
  }
  return body;
}

/**
 * Classes written by hand in a `className` — in quotes or in a template. A
 * piece glued to an interpolation (`dot--${kind}`) is left out: that name only
 * exists at runtime, and demanding it here would be demanding a class that
 * does not exist.
 */
export function classesInJsx(font: string): string[] {
  const collected = new Set<string>();
  const save = (raw: string) => {
    for (const c of raw.split(/\s+/)) {
      if (c && !c.includes(INTERPOLATION)) collected.add(c);
    }
  };
  for (const m of font.matchAll(/className="([^"]*)"/g)) save(m[1]);
  for (const m of font.matchAll(/className=\{`/g)) {
    save(templateBody(font, (m.index ?? 0) + m[0].length));
  }
  return [...collected].sort();
}

/** `.foo` counts; `.zz-foo` and `.foo-bar` do not. */
function definedIn(css: string, className: string): boolean {
  return new RegExp(String.raw`(?<![\w-])\.${className}(?![\w-])`).test(css);
}

describe("CSS the boot guarantees", () => {
  it("ignores the piece glued to an interpolation, but keeps the rest of the line", () => {
    const font = 'a <b className={`dot dot--${kind} ${on ? "is-on" : ""}`} />';
    expect(classesInJsx(font)).toEqual(["dot"]);
  });

  it("walks through a template nested inside the interpolation without getting lost", () => {
    const font = "<b className={`fim ${a ? `${b}-x` : \"\"} pos`} />";
    expect(classesInJsx(font)).toEqual(["fim", "pos"]);
  });

  it("a look-alike class does not pass as defined", () => {
    expect(definedIn(".zz-crumb { color: red }", "crumb")).toBe(false);
    expect(definedIn(".crumb-branch { color: red }", "crumb")).toBe(false);
    expect(definedIn(".crumb.is-active { color: red }", "crumb")).toBe(true);
  });

  const alwaysMounted = [
    ["App", appSrc],
    ["WorkspaceGrid", gridSrc],
    ["TerminalPane", paneSrc],
    ["ProjectSidebar", sidebarSrc],
    ["Floors", floorsSrc],
  ] as const;

  for (const [itemName, font] of alwaysMounted) {
    it(`no class of ${itemName} waits for a lazy chunk to get its style`, () => {
      const lateClasses = classesInJsx(font).filter(
        (c) => definedIn(ALL_CSS, c) && !definedIn(BOOT_CHUNK_CSS, c),
      );
      expect(lateClasses).toEqual([]);
    });
  }

  it("the grid imports floors and the flow bar without `lazy` — it is what puts both CSS files in the boot", () => {
    // If one of these becomes `lazy()`, `floors.css`/`canvas.css` leave the
    // entry bundle and this file's `CSS_DO_BOOT` list starts to lie.
    expect(gridSrc).toMatch(/^import \{ FloorsControl \} from "\.\.\/Floors";$/m);
    expect(gridSrc).toMatch(/^import \{ FlowRunsBar \} from "\.\.\/CanvasView\/FlowHud";$/m);
  });
});

/**
 * The `:root` already explained, in a comment, that white over `--accent`
 * measures 3.65:1 and that is why `--accent-fill` exists. A comment holds
 * nothing: two screens slipped to the wrong token after that. Here the
 * PRODUCT.md promise — 4.5:1 on chrome text — becomes an assertion over the
 * real CSS.
 */
describe("chrome contrast", () => {
  /** Every `--token: value` declared in `:root`. */
  const tokens = new Map<string, string>();
  for (const m of bootCss.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens.set(m[1], m[2].trim());
  }

  /**
   * `var(--x)` → the final value; `#fff`/`rgb(…)` → itself; anything else →
   * null.
   *
   * A colour can also be a *channel* token plus an alpha of its own —
   * `rgb(var(--veil) / 9%)` — which is how relief and recess are written now
   * that they have to flip with the appearance (see the note in the `:root`
   * of `styles.css`). So the substitution happens inside `rgb()` too, not
   * only when the whole value is one reference.
   */
  function resolveVar(theValue: string, hop = 0): string | null {
    const v = theValue.trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) {
      const target = tokens.get(ref[1]);
      return target && hop < 5 ? resolveVar(target, hop + 1) : null;
    }
    if (v.includes("var(") && hop < 5) {
      const filled = v.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => tokens.get(name) ?? whole);
      if (filled !== v) return resolveVar(filled, hop + 1);
    }
    return /^(#|rgba?\()/.test(v) ? v : null;
  }

  const CSS = [
    ["styles.css", bootCss],
    ["canvas.css", canvasCss],
    ["canvas-tail.css", canvasTailCss],
    ["floors.css", floorsCss],
    ["bench.css", benchCss],
    ["changes.css", changesCss],
    ["composer.css", composerCss],
    ["editor.css", editorCss],
    ["live.css", liveCss],
    ["modal.css", modalCss],
    ["notes.css", notesCss],
    ["palette.css", paletteCss],
    ["routines.css", routinesCss],
    ["scores.css", scoresCss],
    ["settings.css", settingsCss],
  ] as const;

  /**
   * Reference background for flattening a translucent color. Most of the
   * chrome lives over the panel; where it does not (the board's floor is
   * darker), the real number is *better* than this one. It is a floor, not a
   * proof — but a floor that catches the mistake actually made: swapping in
   * the token of the day.
   */
  const BASE = tokens.get("--bg-panel")!;

  it("resolves a chained token and ignores what is not a color", () => {
    expect(resolveVar("var(--accent-fill)")).toBe("#0f6fd6");
    expect(resolveVar("#fff")).toBe("#fff");
    expect(resolveVar("var(--accent-grad)")).toBeNull();
    expect(resolveVar("transparent")).toBeNull();
  });

  it("no rule paints text over its own background below 4.5:1", () => {
    const failures: string[] = [];
    for (const [name, css] of CSS) {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const block of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1].trim().replace(/\s+/g, " ");
        const body = block[2];
        const c = /(?:^|;)\s*color:\s*([^;]+)/.exec(body);
        const b = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(body);
        if (!c || !b) continue;
        const theText = resolveVar(c[1]);
        const background = resolveVar(b[1]);
        if (!theText || !background) continue;
        const flatBackground = blendOver(background, BASE);
        const ratio = contrastRatio(blendOver(theText, flatBackground), flatBackground);
        if (!passesAA(ratio)) {
          failures.push(`${name} · ${selector} — ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The sweeper above only sees color and background declared in the **same**
   * block. The file tree's recovery link inherits the parent's background, and
   * that is precisely where an `--accent` measuring 3.97:1 was left — on the
   * "try again" button of a directory that failed to open, that is, on the
   * control the user needs most at the worst moment.
   */
  it("the link inside an error surface is readable over it", () => {
    const rule = /\.ftree-fail button \{([^}]*)\}/.exec(editorCss);
    expect(rule, "the .ftree-fail button rule is gone").not.toBeNull();
    const theColor = resolveVar(/color:\s*([^;]+)/.exec(rule![1])![1]);
    const background = blendOver(resolveVar("var(--red-bg)")!, BASE);
    expect(contrastRatio(theColor!, background)).toBeGreaterThanOrEqual(AA_MIN);
  });
});

/**
 * The dark appearance's elevation ladder, as a number instead of an intention.
 *
 * `docs/DESIGN.md` promises "instrument windows over a deep ambient ground":
 * mini-windows that lift off a desktop, lateral glass you can see through,
 * wells that sink. Every one of those readings is a *difference between two
 * surfaces*, and for a long time the tokens did not carry one. The whole
 * chrome sat between L* 4 and L* 15 with 3 points between neighbouring
 * steps — the ground, the sidebar, the status bar and the terminal well all
 * measured within two points of each other, `--material-thin` composited to
 * within half a point of the floor behind it (glass over its own value shows
 * nothing), and the shadows had no ground bright enough to fall on. The
 * window read as one flat slab of near-black.
 *
 * Why L* and not the contrast ratio the rest of this file uses: the ratio is
 * a ratio of luminances, and luminance is crushed at the dark end. Down here
 * a step the eye reads and a step it does not are both about 1.2:1. L* is
 * spaced the way the eye is — see `lib/contrast.ts`.
 *
 * The floors below are deliberately floors and not targets: the design has
 * room above them, and the test only refuses the collapse.
 */
describe("dark elevation ladder", () => {
  const tokens = new Map<string, string>();
  for (const m of bootCss.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());

  const value = (name: string) => tokens.get(name)!;

  /**
   * The ground is one flat colour, so its floor is that colour — there is no
   * darkest stop to hunt for any more. Kept as "every hex in `--ambient`" so
   * the moment someone puts a gradient back, the two tests below say so
   * instead of quietly measuring the first stop.
   */
  const ambientHexes = [...value("--ambient").matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
  const ambientFloor = ambientHexes[0];

  /**
   * The ground was a three-stop gradient with a blue bloom top-left, a second
   * blue one bottom-left and a violet one in the far corner — "two cold,
   * almost subliminal glows behind the glass". On the graphite it was drawn
   * for they were subliminal. Dropped to black they stopped being: the same
   * alphas over L* 0 read as a wash of navy across the top of the sidebar and
   * a visible fall down its height, which is what the author saw and called
   * out. On a black ground there is no such thing as a subliminal glow, so the
   * ground gives up light altogether and relief moves entirely onto the
   * surfaces — see `docs/DESIGN.md`.
   */
  it("the ground is one flat colour — no gradient, no bloom", () => {
    expect(value("--ambient")).not.toMatch(/gradient/);
    expect(ambientHexes).toHaveLength(1);
  });

  it("and the ground is the same colour `--bg` names", () => {
    expect(ambientFloor.toLowerCase()).toBe(value("--bg").toLowerCase());
  });

  /**
   * No cast. Every neutral in the dark used to carry `b ≈ r × 1.16`, a cold
   * graphite rather than a grey — which is a good idea over an ambient with
   * blue in it and a residue once the ambient is black. It is also the last
   * thing standing between this palette and the neutral one the author asked
   * for.
   */
  it.each(["--bg", "--bg-panel", "--bg-raised", "--bg-overlay", "--well-code", "--well-stage"])(
    "`%s` is achromatic — grey has no hue to leak",
    (name) => {
      const [r, g, b] = /^#(..)(..)(..)$/.exec(value(name))!.slice(1).map((h) => parseInt(h, 16));
      expect([g, b]).toEqual([r, r]);
    },
  );

  const LADDER = ["--bg", "--bg-panel", "--bg-raised", "--bg-overlay"] as const;

  /**
   * Four surfaces the user is meant to tell apart at a glance — the ground, a
   * pane's body, a pane's header, a note on the board — stacked in that order.
   */
  it.each(LADDER.slice(1).map((step, i) => [LADDER[i], step] as const))(
    "`%s` and `%s` are far enough apart to be seen as two surfaces",
    (below, above) => {
      const step = lightness(value(above)) - lightness(value(below));
      expect(step).toBeGreaterThanOrEqual(4);
    },
  );

  it("a mini-window lifts off the desktop it floats on", () => {
    expect(lightness(value("--bg-panel")) - lightness(ambientFloor)).toBeGreaterThanOrEqual(4);
  });

  it("the lateral glass is not the floor behind it, repainted", () => {
    const glass = blendOver(value("--material-thin"), ambientFloor);
    expect(lightness(glass) - lightness(ambientFloor)).toBeGreaterThanOrEqual(3);
  });

  /**
   * This one used to demand two points of *sink*, and it was right to: a well
   * level with the ground is a well nobody can see. The contract changed when
   * the ground went to black — there is nothing under black, so the well
   * cannot sink and the two are the same colour by construction. What is left
   * to refuse is a well that floats *above* its ground, and the separation the
   * sink used to provide is now the frame's job: the pane draws a border and a
   * hairline around whatever holds a well.
   */
  it.each(["--well-code", "--well-stage"])("`%s` never sits above the ground the chrome stands on", (well) => {
    expect(lightness(value(well))).toBeLessThanOrEqual(lightness(ambientFloor));
  });

  it("and the pane that holds one draws the edge the sink no longer draws", () => {
    const pane = /\.pane \{([^}]*)\}/.exec(bootCss);
    expect(pane, "the .pane rule is gone").not.toBeNull();
    expect(pane![1]).toMatch(/border:\s*1px solid/);
  });

  it("the hairline draws a line on the surface it edges", () => {
    const surface = value("--bg-panel");
    expect(lightness(blendOver(value("--border"), surface)) - lightness(surface)).toBeGreaterThanOrEqual(6);
  });
});

/**
 * `prefers-reduced-motion` asks for **reduced** motion, not removed. The
 * global block in `styles.css` killed everything with
 * `animation-iteration-count: 1`, and in the middle of "everything" went the
 * spinners — the only sign that a read is in progress. A stopped spinner does
 * not read as "loading": it reads as "hung".
 *
 * The rest of the motion stays tamed, and whatever has a real static
 * alternative (the blocked agent's yellow dot stays yellow and glowing; the
 * skeleton is still a gray block in the content's place) stays still on
 * purpose. The exception is only for what *only* exists as rotation.
 */
describe("reduced motion", () => {
  /** The inside of each `@media (prefers-reduced-motion: reduce)`, in file order. */
  function reducedMotionBlocks(css: string): string[] {
    const outside: string[] = [];
    const opens = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = opens.exec(css))) {
      let i = m.index + m[0].length;
      let level = 1;
      const start = i;
      while (i < css.length && level > 0) {
        if (css[i] === "{") level++;
        else if (css[i] === "}") level--;
        i++;
      }
      outside.push(css.slice(start, i - 1));
    }
    return outside;
  }

  /** The last declaration that applies to `seletor`, in cascade order. */
  function lastRule(blocks: string[], selector: string): string | null {
    let found: string | null = null;
    for (const block of blocks) {
      for (const r of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = r[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
        if (selectors.includes(selector)) found = r[2];
      }
    }
    return found;
  }

  const blocks = reducedMotionBlocks(bootCss.replace(/\/\*[\s\S]*?\*\//g, ""));

  it("finds the inside of the block even with rules nested within", () => {
    const css = "@media (prefers-reduced-motion: reduce) { .a { animation: none } }";
    expect(reducedMotionBlocks(css)[0]).toContain(".a { animation: none }");
  });

  it("decorative motion stays tamed by the general rule", () => {
    const universal = lastRule(blocks, "*");
    expect(universal).toContain("animation-iteration-count: 1");
  });

  /** What only communicates by spinning: if it stops, no signal is left. */
  const SPINNERS = [".spin", ".usage-refresh.is-spinning svg"];

  for (const selector of SPINNERS) {
    it(`\`${selector}\` keeps spinning under reduced motion`, () => {
      const body = lastRule(blocks, selector);
      expect(body, `${selector} is not handled in the reduced-motion block`).not.toBeNull();
      expect(body).toMatch(/animation-iteration-count:\s*infinite\s*!important/);
      // Has to beat the general rule's `animation-duration: 1ms !important`.
      expect(body).toMatch(/animation-duration:\s*[^;]*!important/);
    });
  }
});

/**
 * The global focus ring (`:focus-visible`, 3px) is beaten by any class rule
 * that says `outline: none` — same specificity, declared later. Several fields
 * do that on purpose, because the app has a better signal for them: blue
 * border and halo, in `input:focus, select:focus`.
 *
 * Except `textarea` had been left out of that rule. The four that drop the
 * outline — the note written on the board, the board's loose text, the prompt
 * composer and the review annotation — got nothing in its place: the blinking
 * cursor was the only sign that focus was there.
 */
describe("focus signal on fields", () => {
  const stripped = bootCss.replace(/\/\*[\s\S]*?\*\//g, "");

  /** The blue halo rule: the one the app uses as "this field has focus". */
  const halo = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((r) =>
    /box-shadow:\s*0 0 0 3\.5px/.test(r[2]),
  );

  it("a halo rule exists, and it is a focus rule", () => {
    expect(halo, "the blue halo rule is gone from styles.css").toBeDefined();
    expect(halo![1]).toMatch(/:focus/);
  });

  for (const control of ["input", "select", "textarea"]) {
    it(`the focus halo covers \`${control}\``, () => {
      const selectors = halo![1].split(",").map((s) => s.trim());
      expect(selectors).toContain(`${control}:focus`);
    });
  }

  /**
   * A `box-shadow: none` in the base rule has lower specificity than the halo
   * and loses on focus — but an `!important` there, or a `:focus` rule of its
   * own zeroing the shadow, would erase the only signal left. That is what
   * this test watches in the fields that already give up the outline.
   */
  it("no field that drops the outline also forces the shadow away", () => {
    const STRIPPED_CSS = [ALL_CSS].join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const r of STRIPPED_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(?:^|;)\s*outline:\s*none/.test(r[2])) continue;
      if (/box-shadow:\s*none\s*!important/.test(r[2])) {
        offenders.push(r[1].trim().replace(/\s+/g, " "));
      }
    }
    expect(offenders).toEqual([]);
  });

  /** Every `selector { body }` of a sheet, comments already stripped. */
  function rulesOf(css: string) {
    return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
      (r) => ({ selector: r[1].trim().replace(/\s+/g, " "), body: r[2] }),
    );
  }

  /**
   * The browser traces `outline` along the `border-radius` the element
   * already has: the ring is drawn around a shape, it does not choose one.
   * A focus rule that sets `border-radius` therefore stops describing a state
   * and starts redefining the geometry — and it wins, because
   * `:focus-visible` (0,1,0) beats the `input, select` that rounds every
   * field (0,0,1). That is how each field in the app narrowed from `--r-md`
   * to `--r-sm` the moment it took focus, with the ring tracing the smaller
   * shape around a well that stayed the bigger one.
   *
   * A rounding *fallback* for what nobody rounded is still fair — but only
   * at zero specificity (`:where(...)`), where it can never beat the shape
   * the element declares for itself.
   */
  it("the ring traces the shape it circles — no focus rule redraws the radius", () => {
    const offenders = SHEETS.flatMap(([name, css]) =>
      rulesOf(css)
        .filter((r) => /:focus(-visible|-within)?(?![\w-])/.test(r.selector))
        .filter((r) => /(?:^|;)\s*border-radius:/.test(r.body))
        .filter((r) => !r.selector.startsWith(":where("))
        .map((r) => `${name}: ${r.selector}`),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * A field inside a well — the file filter and the new-task capsule on the
   * bench, the transcript search, the palette, the notebook — gives up its
   * own frame: no border, no background, no shadow. The well around it is
   * what draws the box and what lights up blue on `:focus-within`.
   *
   * The global ring on the bare input drew a *second* frame inside the first,
   * and with the input's own radius — zero — so a hard rectangle appeared
   * inside a 9px well and inside a 999px capsule. Every such field says
   * `outline: none`; two on the bench had been forgotten.
   */
  it("a field with no frame of its own draws no ring — the well around it is the signal", () => {
    const offenders = SHEETS.flatMap(([name, css]) => {
      const rules = rulesOf(css);
      /** Selectors this sheet already strips the ring from, focus state aside. */
      const ringless = new Set<string>();
      for (const r of rules) {
        if (!/(?:^|;)\s*outline:\s*(none|0)(?![\w-])/.test(r.body)) continue;
        for (const s of r.selector.split(",")) {
          ringless.add(s.trim().replace(/\s+/g, " ").replace(/:focus(-visible|-within)?/g, ""));
        }
      }
      const bare: string[] = [];
      for (const r of rules) {
        if (!/(?:^|;)\s*border:\s*(none|0)(?![\w-])/.test(r.body)) continue;
        for (const s of r.selector.split(",")) {
          const selector = s.trim().replace(/\s+/g, " ");
          if (!/(\binput\b|\btextarea\b|-input(?![\w-]))/.test(selector)) continue;
          if (ringless.has(selector.replace(/:focus(-visible|-within)?/g, ""))) continue;
          bare.push(`${name}: ${selector}`);
        }
      }
      return bare;
    });
    expect([...new Set(offenders)]).toEqual([]);
  });
});

/**
 * WCAG 1.4.13 (content on hover/focus) asks three things of the tooltip
 * balloon: that it can be **dismissed** without moving the pointer, that it
 * **persists** until focus or the pointer leave, and that the pointer can be
 * **moved over it**.
 *
 * The first two were already in place (`body.tips-off` via Esc, and the
 * balloon only leaves when hover/focus leave). The third was missing: the
 * balloon was always `pointer-events: none`, so the pointer passed through it
 * and the hover dropped before reaching it — the case of whoever uses screen
 * magnification and needs to drag the pointer to the text to read it.
 *
 * Invisible, it **has** to stay transparent to the pointer: a balloon of up to
 * 240px hanging 8px below the control would eat the click of whoever sat
 * underneath.
 */
describe("tooltip balloon", () => {
  const stripped = bootCss.replace(/\/\*[\s\S]*?\*\//g, "");

  function ruleBody(selector: string): string {
    for (const r of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = r[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
      if (selectors.includes(selector)) return r[2];
    }
    return "";
  }

  it("at rest, the balloon does not intercept the pointer", () => {
    expect(ruleBody("[data-tip]::after")).toMatch(/pointer-events:\s*none/);
  });

  for (const trigger of [":hover", ":focus-visible"]) {
    it(`opened by \`${trigger}\`, the balloon can receive the pointer`, () => {
      expect(ruleBody(`[data-tip]${trigger}::after`)).toMatch(
        /pointer-events:\s*auto/,
      );
    });
  }

  it("there is no dead gap between the control and the balloon", () => {
    // The offset has to come from a transparent border, not from a `top` that
    // leaves 8px of nothing in between: crossing a gap drops the `:hover`
    // before the pointer reaches the text.
    const bubble = ruleBody("[data-tip]::after");
    expect(bubble).toMatch(/top:\s*100%/);
    expect(bubble).toMatch(/border-top:\s*8px solid transparent/);
    expect(bubble).toMatch(/background-clip:\s*padding-box/);
  });

  /**
   * The bridge **cannot** be a `::before` of the control: `data-tip` sits on
   * 101 classes of this app and `.crumb::before` is already the breadcrumb
   * separator — the bridge would have yanked it out of the flow and dropped it
   * 8px down. It is locked here because it is the solution that looks obvious
   * and breaks silently.
   */
  it("the bridge does not use the control's `::before`", () => {
    expect(stripped).not.toMatch(/\[data-tip\][^{,]*::before/);
  });
});

/**
 * The trap in the fix above: by giving the open balloon `pointer-events: auto`,
 * `Esc` (which only lowered the opacity) would start leaving on screen an
 * **invisible, clickable** rectangle of up to 240px, eating the click of
 * whoever sat underneath.
 */
describe("balloon dismissed by Esc", () => {
  it("goes back to being transparent to the pointer, not just invisible", () => {
    const stripped = bootCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /body\.tips-off[^{]*\{([^}]*)\}/.exec(stripped);
    expect(rule, "the tips-off rule is gone").not.toBeNull();
    expect(rule![1]).toMatch(/opacity:\s*0/);
    expect(rule![1]).toMatch(/pointer-events:\s*none/);
  });
});

/**
 * `docs/DESIGN.md` is the source the design detector reads and the next
 * component copies from. When it lies, the error propagates: the radius scale
 * there was still the one from before the "glass" refresh (5/6/7/8/10/12/14),
 * while the `:root` already lived at 6/9/14/20 — hence the dozens of "radius
 * off the scale" the detector flags in CSS that is, in fact, right.
 *
 * The same goes for the menu highlight: the doc recorded `{colors.accent}`,
 * which fails AA with white text (3.65:1), while the CSS has used
 * `--accent-fill` for a long time. Copying from the doc would reintroduce the
 * defect.
 */
describe("docs/DESIGN.md keeps up with the tokens", () => {
  // The doc is read as raw text: `\r?\n` because the repository runs with
  // `core.autocrlf`, and the test cannot depend on which of the two forms the
  // file is in on this machine's disk.
  const NEWLINE = String.raw`\r?\n`;

  /** The block of a frontmatter field: the lines indented deeper than it. */
  function block(key: string, indent: number): string | null {
    const parent = " ".repeat(indent);
    const child = " ".repeat(indent + 2);
    const re = new RegExp(
      `^${parent}${key}:${NEWLINE}((?:${child}\\S.*(?:${NEWLINE}|$))+)`,
      "m",
    );
    return re.exec(designMd)?.[1] ?? null;
  }

  const written = new Set(
    [...(block("rounded", 0) ?? "").matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  const fromCss = [...bootCss.matchAll(/--r-[\w-]+:\s*([^;]+);/g)].map((m) => m[1].trim());

  it("found both lists", () => {
    expect(written.size).toBeGreaterThan(3);
    expect(fromCss.length).toBeGreaterThan(3);
  });

  it("every radius in `:root` is registered in the doc's scale", () => {
    expect(fromCss.filter((r) => !written.has(r))).toEqual([]);
  });

  /**
   * The same story in typography: the ramp stopped at 14px, and screen and
   * panel titles lived on loose literals (15px on the crash screen, 16px on the
   * boot-failure one, 17px on the welcome screen, the bench and the notebook)
   * — three sizes for the same role, none of them registered.
   */
  it("every font size in `:root` is in the doc's ramp", () => {
    const inDoc = new Set(
      [...designMd.matchAll(/fontSize:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    const noCss = [...bootCss.matchAll(/--fs-[\w-]+:\s*([^;]+);/g)].map((m) =>
      m[1].trim(),
    );
    expect(noCss.length).toBeGreaterThan(3);
    expect(noCss.filter((t) => !inDoc.has(t))).toEqual([]);
  });

  it("the menu highlight in the doc is the blue that passes AA, not the surface blue", () => {
    const highlight = block("menu-item-hover", 2);
    expect(highlight, "the menu-item-hover entry is gone from the doc").not.toBeNull();
    expect(highlight).toContain("{colors.accent-fill}");
  });
});
