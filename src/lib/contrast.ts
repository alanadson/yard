/**
 * The WCAG 2.1 contrast math, so this app's CSS can be held to it by a test
 * instead of by a comment.
 *
 * The product promises 4.5:1 on chrome text (PRODUCT.md), and the `:root` of
 * `styles.css` already explained why `--accent-fill` exists besides
 * `--accent`. Two screens still ended up on the wrong token. With the formula
 * here, the contract becomes an assertion — see `src/styles.test.ts`.
 *
 * Understands the two forms this repository's CSS uses: `#rgb`/`#rrggbb` and
 * `rgb(r g b)` / `rgb(r g b / a%)`.
 */

interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 to 1. */
  readonly a: number;
}

function parseColor(css: string): Color {
  const theText = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(theText);
  if (hex) {
    const d = hex[1].length === 3 ? [...hex[1]].map((c) => c + c) : hex[1].match(/../g)!;
    const [r, g, b] = d.map((p) => parseInt(p, 16));
    return { r, g, b, a: 1 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(theText);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const [r, g, b] = parts.slice(0, 3).map(Number);
    const raw = parts[3];
    const a =
      raw === undefined
        ? 1
        : raw.endsWith("%")
          ? Number(raw.slice(0, -1)) / 100
          : Number(raw);
    return { r, g, b, a };
  }
  throw new Error(`cor que não sei ler: ${css}`);
}

function toHex({ r, g, b }: Color): string {
  const p = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

/**
 * Flattens a translucent color against whatever is behind it.
 *
 * It is the step that was missing to measure the app's state backgrounds:
 * `--red-bg` and `--accent-dim` are whites/reds at 13% and 20%, and the real
 * contrast of the text is against the blend, not against the nominal color.
 */
export function blendOver(foreground: string, background: string): string {
  const f = parseColor(foreground);
  const t = parseColor(background);
  return toHex({
    r: f.r * f.a + t.r * (1 - f.a),
    g: f.g * f.a + t.g * (1 - f.a),
    b: f.b * f.a + t.b * (1 - f.a),
    a: 1,
  });
}

function linearChannel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(theColor: Color): number {
  return (
    0.2126 * linearChannel(theColor.r) + 0.7152 * linearChannel(theColor.g) + 0.0722 * linearChannel(theColor.b)
  );
}

/**
 * The ratio between two **opaque** colors, from 1 (equal) to 21 (black and
 * white). A color with alpha has to go through `sobrepor` first: contrast is
 * measured against what the eye sees, not against what the CSS wrote.
 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseColor(a));
  const lb = luminance(parseColor(b));
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** The WCAG AA floor for normal text. */
export const AA_MIN = 4.5;

export function passesAA(ratio: number): boolean {
  return ratio >= AA_MIN;
}
