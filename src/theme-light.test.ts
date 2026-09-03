/**
 * The light appearance is a second set of values for the same tokens, in a
 * sheet of its own (`theme-light.css`) so the dark contract in `styles.css`
 * stays byte-identical for whoever never opens the setting. Two things can
 * rot silently: the sheet stops loading on boot (the app would open dark and
 * flip later), and a token slips below the 4.5:1 floor PRODUCT.md commits to.
 * Both become assertions here, against the real CSS.
 *
 * And one thing the sheet cannot do at all: re-value a colour a component
 * wrote as a literal. The app has twenty sheets and the light appearance
 * shipped broken because of it — a ground pinned dark by an inline attribute,
 * panels that stayed dark under ink that had turned dark, hover states painted
 * in white on paper. The last three suites are what caught that.
 */
import { describe, expect, it } from "vitest";

import { AA_MIN, blendOver, contrastRatio, lightness } from "./lib/contrast";
import appSource from "./App.tsx?raw";
import darkCss from "./styles.css?raw";
import lightCss from "./theme-light.css?raw";
import indexHtml from "../index.html?raw";

import benchCss from "./components/BenchPanel/bench.css?raw";
import canvasCss from "./components/CanvasView/canvas.css?raw";
import canvasTailCss from "./components/CanvasView/canvas-tail.css?raw";
import changesCss from "./components/ChangesPanel/changes.css?raw";
import composerCss from "./components/Composer/composer.css?raw";
import costsCss from "./components/modals/costs.css?raw";
import editorCss from "./components/CodeEditor/editor.css?raw";
import floorsCss from "./components/Floors/floors.css?raw";
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

/** `--token: value` pairs of one CSS block, the last declaration winning. */
function tokensOf(css: string, block: RegExp): Map<string, string> {
  const body = block.exec(css)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const dark = tokensOf(darkCss, /:root\s*\{([\s\S]*?)\n\}/);
const light = tokensOf(lightCss, /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);

/** The light value, or the dark one where the light sheet leaves it alone. */
function token(name: string): string {
  const v = light.get(name) ?? dark.get(name);
  if (!v) throw new Error(`token ${name} declared nowhere`);
  return v;
}

describe("theme-light.css", () => {
  it("loads on boot, right after the dark sheet — the shell must never paint dark and flip", () => {
    const order = [appSource.indexOf('import "./styles.css";'), appSource.indexOf('import "./theme-light.css";')];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
  });

  it("overrides the ambient, the surfaces and the text — the tokens the chrome is built from", () => {
    for (const name of ["--ambient", "--bg", "--bg-panel", "--bg-raised", "--bg-overlay", "--text", "--text-dim", "--text-bright", "--border", "--material-menu", "--material-sheet", "--shadow-2"]) {
      expect(light.has(name), name).toBe(true);
    }
  });

  it("keeps the system blue and the radii — the light theme changes the paper, not the language", () => {
    for (const name of ["--accent", "--accent-fill", "--r-md", "--r-lg", "--r-xl"]) {
      expect(light.has(name), `${name} must not be redefined`).toBe(false);
    }
  });

  it("text reads at 4.5:1 over every opaque surface, like the dark side promises", () => {
    for (const surface of ["--bg", "--bg-panel", "--bg-raised", "--bg-overlay"]) {
      for (const ink of ["--text", "--text-dim", "--text-bright"]) {
        const ratio = contrastRatio(token(ink), token(surface));
        expect(ratio, `${ink} over ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_MIN);
      }
    }
  });

  it("blue text and the semantic inks read over the panel; white reads over the blue fill", () => {
    const panel = token("--bg-panel");
    for (const ink of ["--accent-text", "--green", "--red"]) {
      const ratio = contrastRatio(token(ink), panel);
      expect(ratio, `${ink} over --bg-panel = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_MIN);
    }
    // Yellow is the hard one on paper; the floor for a state color is 3:1.
    expect(contrastRatio(token("--yellow"), panel)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token("--on-accent"), token("--accent-fill"))).toBeGreaterThanOrEqual(AA_MIN);
  });

  it("the interaction veils are dark ink over light paper (white veils would vanish)", () => {
    const hover = blendOver(token("--bg-hover"), token("--bg-panel"));
    expect(contrastRatio(hover, token("--bg-panel"))).toBeGreaterThan(1.05);
    expect(token("--border")).toMatch(/^rgb\(0 0 0/);
  });
});

/**
 * The regression the headless lab caught: `:root[data-theme="light"] .btn`
 * outranks `.btn--primary` (attribute + class beats class), so a plain
 * override painted the blue and the red buttons white — white text on white.
 * Every `.btn` rule in the light sheet has to step aside for the two fills.
 */
describe("the light sheet's button overrides", () => {
  it("never repaint the primary or the danger fill", () => {
    const rules = [...lightCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map((m) => m[1].trim())
      .filter((sel) => /\.btn(?![-\w])/.test(sel));
    expect(rules.length).toBeGreaterThan(0);
    for (const sel of rules) {
      expect(sel, sel).toMatch(/\.btn:not\(\.btn--primary, \.btn--danger\)/);
    }
  });
});

/* ------------------------------------------------------------------------
   Everything below reads the app's *other* nineteen sheets. A literal colour
   in one of them survives the appearance switch untouched: the light sheet
   can only re-value what the CSS asked for through a token.
   ------------------------------------------------------------------------ */

/** Every sheet the app ships, by the name a failure should name. */
const SHEETS: ReadonlyArray<readonly [string, string]> = [
  ["styles.css", darkCss],
  ["BenchPanel/bench.css", benchCss],
  ["BenchPanel/scm.css", scmCss],
  ["CanvasView/canvas.css", canvasCss],
  ["CanvasView/canvas-tail.css", canvasTailCss],
  ["ChangesPanel/changes.css", changesCss],
  ["CodeEditor/editor.css", editorCss],
  ["Composer/composer.css", composerCss],
  ["Floors/floors.css", floorsCss],
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
];

interface Decl {
  readonly sheet: string;
  readonly sel: string;
  readonly prop: string;
  readonly value: string;
}

/** Flat list of declarations, in source order — enough CSS to reason about colour. */
function declarations(sheet: string, css: string): Decl[] {
  const out: Decl[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const rule of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = rule[1].trim().replace(/\s+/g, " ");
    if (sel.startsWith("@")) continue;
    for (const decl of rule[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      out.push({ sheet, sel, prop: decl.slice(0, at).trim(), value: decl.slice(at + 1).trim() });
    }
  }
  return out;
}

const APP_DECLS = SHEETS.flatMap(([name, css]) => declarations(name, css));
const LIGHT_DECLS = declarations("theme-light.css", lightCss);

/** Replaces `var(--x)` / `var(--x, fallback)` with the light appearance's value. */
function expand(value: string, depth = 0): string {
  if (depth > 6 || !value.includes("var(")) return value;
  const next = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g,
    (whole: string, name: string, fallback?: string) => {
      const resolved = light.get(name) ?? dark.get(name);
      if (resolved) return resolved;
      return fallback?.trim() || whole;
    },
  );
  return next === value ? value : expand(next, depth + 1);
}

/** The first colour in a declaration's value, once the tokens are resolved. */
function firstColor(value: string): string | undefined {
  return /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(expand(value))?.[0];
}

const isBackground = (prop: string): boolean => prop === "background" || prop === "background-color";

const listed = (selectorList: string, want: string): boolean =>
  selectorList.split(",").some((one) => one.trim() === want);

/**
 * What a selector's background really is once the light sheet has had its
 * say: the sheet's own override if it wrote one, otherwise the literal the
 * component sheet painted.
 */
function lightSurface(selector: string): string | undefined {
  const fromLight = LIGHT_DECLS.filter(
    (d) => isBackground(d.prop) && listed(d.sel, `:root[data-theme="light"] ${selector}`),
  );
  const pool = fromLight.length
    ? fromLight
    : APP_DECLS.filter((d) => isBackground(d.prop) && listed(d.sel, selector));
  for (let i = pool.length - 1; i >= 0; i--) {
    const color = firstColor(pool[i].value);
    if (color) return color;
  }
  return undefined;
}

describe("the shell's first paint", () => {
  /**
   * The regression this locks: `<body style="background: #131316">` was there
   * to keep the window from flashing white before the CSS arrived — but an
   * inline style outranks every sheet, so the app's ground stayed that dark
   * literal forever. Every translucent material then composited 38% of a black
   * floor into itself and the light appearance came out as grey mud.
   */
  it("never pins the ground with an inline style — it outranks both sheets, for good", () => {
    const body = /<body([^>]*)>/i.exec(indexHtml)?.[1] ?? "";
    expect(body).not.toMatch(/style\s*=/i);
  });

  it("still paints a ground before the sheets arrive, one per appearance", () => {
    const head = /<head>([\s\S]*?)<\/head>/i.exec(indexHtml)?.[1] ?? "";
    expect(head, "the pre-paint has to be inline in <head>, or it arrives too late").toMatch(/<style>/);
    expect(head).toMatch(/prefers-color-scheme/);
    expect(head).toMatch(/data-theme="light"/);
  });

  /**
   * And it has to be the *same* ground. The page can only guess an appearance
   * from `prefers-color-scheme`; what it must not do is guess a colour. When
   * the dark ladder was re-graded (`--bg` #131316 → #19191d) this file kept
   * the old literal, and every launch opened three points too dark and
   * stepped up the instant `styles.css` landed — a flash in the one place the
   * pre-paint exists to prevent one.
   */
  const preground = (selector: RegExp): string | undefined => {
    const head = /<head>([\s\S]*?)<\/head>/i.exec(indexHtml)?.[1] ?? "";
    return selector.exec(head)?.[1]?.trim().toLowerCase();
  };

  it.each([
    ["with nothing to key on", /html\s*\{\s*background:\s*([^;}]+)/],
    ["with the attribute stamped", /html\[data-theme="dark"\]\s*\{\s*background:\s*([^;}]+)/],
  ])("opens on the dark appearance's own ground, %s", (_when, selector) => {
    expect(preground(selector)).toBe(dark.get("--bg"));
  });

  it("opens on the light appearance's own ground once the attribute is there", () => {
    expect(preground(/html\[data-theme="light"\]\s*\{\s*background:\s*([^;}]+)/)).toBe(light.get("--bg"));
  });
});

/**
 * A surface that carries chrome text. `--text` is dark ink on the light side,
 * so any panel that stayed dark turns its own label invisible — which is
 * exactly how the bench, the tooltips and the canvas nodes shipped.
 */
const CHROME_SURFACES: ReadonlyArray<{ sel: string; over: string; what: string }> = [
  { sel: ".bench-glass", over: "--bg", what: "the bench" },
  { sel: ".tip-layer", over: "--bg-panel", what: "every tooltip in the app" },
  { sel: ".editor", over: "--bg", what: "the code editor" },
  { sel: ".viewer", over: "--bg", what: "the diff viewer" },
  { sel: ".notes", over: "--bg", what: "the notebook" },
  { sel: ".cv-card", over: "--bg", what: "a terminal card on the board" },
  { sel: ".cv-flowcard", over: "--bg", what: "a flow card on the board" },
  { sel: ".cv-media", over: "--bg", what: "a media node on the board" },
  { sel: ".cv-binder", over: "--bg", what: "a binder on the board" },
  { sel: ".cv-tree", over: "--bg", what: "a tree node on the board" },
  { sel: ".pane--empty", over: "--bg", what: "the empty pane" },
  { sel: ".floors-btn:hover", over: "--bg-panel", what: "a floor button under the pointer" },
];

describe("every surface that carries chrome text, on paper", () => {
  it.each(CHROME_SURFACES)("$what ($sel) reads at 4.5:1", ({ sel, over }) => {
    const painted = lightSurface(sel);
    expect(painted, `${sel} paints no background anywhere`).toBeDefined();
    const flat = blendOver(painted as string, token(over));
    const ratio = contrastRatio(token("--text"), flat);
    expect(ratio, `--text over ${sel} (${flat}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_MIN);
  });
});

/**
 * The mirror of `styles.test.ts`'s sweeper, with the light table in hand:
 * every rule that declares both its ink and its ground has to clear 4.5:1
 * once the appearance has re-valued the tokens. Same heuristic, same limits —
 * it only sees the two declared in the *same* block, and it flattens over the
 * panel because that is where most of the chrome lives.
 */
describe("the light appearance's chrome contrast", () => {
  /** The last value the light sheet gives `prop` for any selector in the list. */
  function overridden(selectorList: string, prop: (p: string) => boolean): string | undefined {
    const wanted = selectorList.split(",").map((one) => `:root[data-theme="light"] ${one.trim()}`);
    const pool = LIGHT_DECLS.filter((d) => prop(d.prop) && wanted.some((w) => listed(d.sel, w)));
    for (let i = pool.length - 1; i >= 0; i--) {
      const color = firstColor(pool[i].value);
      if (color) return color;
    }
    return undefined;
  }

  /** The last declaration of `prop` on exactly this rule, in its own sheet. */
  function declared(d: Decl, prop: (p: string) => boolean): string | undefined {
    const pool = APP_DECLS.filter((o) => o.sheet === d.sheet && o.sel === d.sel && prop(o.prop));
    for (let i = pool.length - 1; i >= 0; i--) {
      const color = firstColor(pool[i].value);
      if (color) return color;
    }
    return undefined;
  }

  it("no rule paints text over its own background below 4.5:1 on paper", () => {
    const panel = token("--bg-panel");
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const d of APP_DECLS) {
      if (d.prop !== "color") continue;
      // WCAG 1.4.3 exempts an inactive control on purpose: a disabled button
      // that reads as crisply as a live one is a worse button.
      if (d.sel.includes(":disabled")) continue;
      const key = `${d.sheet} ${d.sel}`;
      if (seen.has(key)) continue;
      const painted = overridden(d.sel, isBackground) ?? declared(d, isBackground);
      const ink = overridden(d.sel, (p) => p === "color") ?? declared(d, (p) => p === "color");
      if (!painted || !ink) continue;
      seen.add(key);
      const ground = blendOver(painted, panel);
      const ratio = contrastRatio(blendOver(ink, ground), ground);
      if (ratio < AA_MIN) failures.push(`${d.sheet} · ${d.sel} — ${ratio.toFixed(2)}:1`);
    }
    expect(failures, `${failures.length} unreadable pairs:\n${failures.join("\n")}`).toEqual([]);
  });
});

/**
 * Relief and recess are the two neutral gestures the whole app is built from:
 * a white veil to lift a surface off a dark ground, a black veil to sink one
 * into it. Written as literals they cannot flip, and `theme-light.css` cannot
 * chase them — there are hundreds, in twenty sheets. They go through `--veil`
 * and `--well`, channels the appearance re-values once.
 *
 * The exceptions are real and few: a veil painted *on* a chromatic fill — the
 * inner light of the blue button, a glow around a status dot, a note in the
 * colour its author picked — is not neutral, and stays white in both.
 */
const CHROMATIC_VEILS: readonly RegExp[] = [
  /^\.btn--primary$/,
  /^\.btn--danger$/,
  /icon-btn\.is-active$/,
  /^\.live-follow$/,
  /^\.cv-note-md \.cv-md-check/,
  /^\.cv-card-head \.(dot|badge-blocked)$/,
  /^\.cv-note(\.|:|$| )/,
  /^\.cv-ink$/,
  /^\.cv-swatch$/,
  /^\.task-scope(:hover)?$/,
  /^\.color-dot$/,
];

/** A dark ink that has to stay dark: it rides on a fill the user chose. */
const INK_ON_FILL: readonly RegExp[] = [/^\.cv-(media|binder|tree|doc)-head$/, /^\.cv-card-front$/];

/**
 * Every opaque hex in a value that lands inside the dark ladder's range —
 * between the content wells below it and the tooltip above.
 */
function darkSurfaceLiterals(value: string): string[] {
  return [...value.matchAll(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi)]
    .map((m) => m[0])
    .filter((hex) => {
      const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
      return lightness(full) > 5 && lightness(full) < 30;
    });
}

describe("relief and recess flip with the appearance", () => {
  const literals = (channel: RegExp, allowed: readonly RegExp[]): string[] =>
    APP_DECLS.filter(
      (d) =>
        channel.test(d.value) &&
        !d.prop.startsWith("--") &&
        !d.sel.split(",").every((one) => allowed.some((a) => a.test(one.trim()))),
    ).map((d) => `${d.sheet} | ${d.sel} | ${d.prop}: ${d.value.slice(0, 56)}`);

  it("no rule lifts a neutral surface with a literal white — it vanishes on paper", () => {
    const offenders = literals(/rgba?\(\s*255[ ,]+255[ ,]+255\s*\//, CHROMATIC_VEILS);
    expect(offenders, `${offenders.length} literal white veils:\n${offenders.slice(0, 12).join("\n")}`).toEqual([]);
  });

  it("no rule sinks a neutral surface with a literal black — it turns into a hole on paper", () => {
    const offenders = literals(/rgba?\(\s*0[ ,]+0[ ,]+0\s*\//, INK_ON_FILL);
    expect(offenders, `${offenders.length} literal black veils:\n${offenders.slice(0, 12).join("\n")}`).toEqual([]);
  });

  /**
   * And the third literal, the one neither channel catches: an **opaque** hex
   * in the range the dark ladder occupies. `#1d1d22` for a card header,
   * `#24242b` for a focused pane header, `#202027` for a sticky hunk — each
   * was a surface hand-placed a step above or below a token, and each is a
   * promise to keep two numbers in sync from memory.
   *
   * The promise broke twice. On paper they never flipped at all — a literal
   * is exactly what `theme-light.css` cannot re-value. And when the dark
   * ladder was re-graded on 2026-08-26 they stayed where they were:
   * `--bg-raised` climbed from L* 12.4 to 19.2 and `.pane--focused
   * .pane-header`, still at 14.5, went from a whisper lighter than the
   * resting header to visibly *darker* than it — the focus state inverted, in
   * silence.
   *
   * So a surface in the chrome's range goes through a token, or through a
   * `--veil` on one. Below the range there is no rule to break: the content
   * wells are near-black in the dark and near-white on paper, they are named
   * as wells, and the re-grade left them where they were.
   */
  it("finds the hexes inside a layered background, not only a bare one", () => {
    expect(darkSurfaceLiterals("linear-gradient(180deg, #ffffff, #eee), #1d1d22")).toEqual(["#1d1d22"]);
  });

  it("no rule paints a chrome surface with an opaque literal instead of a token", () => {
    const offenders = APP_DECLS.filter(
      (d) => !d.prop.startsWith("--") && isBackground(d.prop) && darkSurfaceLiterals(d.value).length,
    ).map((d) => `${d.sheet} | ${d.sel} | ${d.prop}: ${d.value.slice(0, 60)}`);
    expect(offenders, `${offenders.length} hard-coded surfaces:\n${offenders.join("\n")}`).toEqual([]);
  });
});
