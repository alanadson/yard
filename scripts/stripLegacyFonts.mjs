/**
 * Drops the legacy font formats (`.woff`, `.ttf`, ...) from the `@font-face`
 * rules of the font packages, before Vite turns every `url()` into an emitted
 * asset. WebView2 is evergreen Chromium and always takes the woff2 entry, so
 * the rest is installer weight no user can ever load. A face with no woff2
 * entry keeps its list as is: removing its only files would break the font.
 */

/** A `src` declaration: the property name must stand alone, so `--img-src` does not count. */
const SRC_DECLARATION = /(^|[{;\s])src\s*:/g;

/** The font packages whose stylesheets list legacy formats after woff2. */
const FONT_PACKAGE_CSS = /[\\/]node_modules[\\/](?:@fontsource[^\\/]*|katex)[\\/][^?]*\.css(?:\?|$)/;

/**
 * Indices where `text` splits at `stop` characters that sit outside quotes
 * and parentheses, so a data URI's own `;` and `,` never count. Scanning ends
 * at the first character in `end`, whose index is returned as `end`.
 */
function scan(text, from, stops, ends) {
  const splits = [];
  let depth = 0;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ends.includes(ch)) return { splits, end: i };
    else if (depth === 0 && stops.includes(ch)) splits.push(i);
  }
  return { splits, end: text.length };
}

function isWoff2Source(entry) {
  const format = /format\(\s*["']?([\w-]+)/i.exec(entry);
  if (format) return format[1].toLowerCase().startsWith("woff2");
  const url = /url\(\s*["']?([^"')]*)/i.exec(entry);
  return url !== null && /\.woff2(?:[?#]|$)/i.test(url[1]);
}

/** The `src` value with its non-woff2 `url()` entries removed, or as is when it has no woff2. */
function keepWoff2(value) {
  const { splits } = scan(value, 0, ",", "");
  const bounds = [-1, ...splits, value.length];
  const entries = bounds.slice(1).map((end, i) => value.slice(bounds[i] + 1, end));
  if (!entries.some(isWoff2Source)) return value;
  const kept = entries.filter((entry) => isWoff2Source(entry) || !/^\s*url\(/i.test(entry));
  return kept.join(",");
}

/** `css` with every `@font-face` `src` list reduced to its woff2 (and `local()`) entries. */
export function stripLegacyFontSources(css) {
  let out = "";
  let cursor = 0;
  SRC_DECLARATION.lastIndex = 0;
  for (let match; (match = SRC_DECLARATION.exec(css)) !== null; ) {
    const valueStart = match.index + match[0].length;
    const { end } = scan(css, valueStart, "", ";}");
    out += css.slice(cursor, valueStart) + keepWoff2(css.slice(valueStart, end));
    cursor = end;
    SRC_DECLARATION.lastIndex = end;
  }
  return out + css.slice(cursor);
}

/**
 * The Vite plugin. `enforce: "pre"` is the whole point: it has to run before
 * `vite:css` resolves the `url()`s, or the legacy files are emitted anyway.
 * @returns {import("vite").Plugin}
 */
export function legacyFontsPlugin() {
  return {
    name: "yard:strip-legacy-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!FONT_PACKAGE_CSS.test(id)) return null;
      const stripped = stripLegacyFontSources(code);
      return stripped === code ? null : stripped;
    },
  };
}
