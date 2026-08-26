/**
 * The light appearance is a second set of values for the same tokens, in a
 * sheet of its own (`theme-light.css`) so the dark contract in `styles.css`
 * stays byte-identical for whoever never opens the setting. Two things can
 * rot silently: the sheet stops loading on boot (the app would open dark and
 * flip later), and a token slips below the 4.5:1 floor PRODUCT.md commits to.
 * Both become assertions here, against the real CSS.
 */
import { describe, expect, it } from "vitest";

import { AA_MIN, blendOver, contrastRatio } from "./lib/contrast";
import appSource from "./App.tsx?raw";
import darkCss from "./styles.css?raw";
import lightCss from "./theme-light.css?raw";

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
