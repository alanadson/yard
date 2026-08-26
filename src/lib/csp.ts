/**
 * Does a stylesheet written by JavaScript still apply in the installed app?
 *
 * CodeMirror ships no `.css` file. `style-mod` builds a `<style>` element at
 * runtime and inserts it in `<head>`: the base theme
 * (`.cm-scroller { display: flex !important }`, `.cm-content`'s padding, the
 * right-aligned line numbers), the editor's own theme (`cm.ts`) and every
 * syntax color live only there. Refuse that element and the editor is left
 * with bare markup — the numbers column falls **above** the text, the mono
 * font goes back to the UI's, nothing is colored and Chromium draws its own
 * focus ring around the content. Nothing throws; there is no error to find.
 *
 * What refuses it is not what the config says. `tauri.conf.json` declares
 * `style-src 'self' 'unsafe-inline'`, which allows it. But when the assets
 * are **embedded** (any packaged build — `npm run app`, the installer) Tauri
 * parses the HTML at compile time and stamps `nonce="…"` on *every* `<style>`
 * element it finds, then adds `'nonce-<random>'` to `style-src` at runtime
 * (`tauri-codegen`'s `inject_nonce_token` and `tauri`'s `replace_csp_nonce`).
 * And per CSP Level 3 a nonce in a directive makes the browser **ignore
 * `'unsafe-inline'`** — so one inline `<style>` in `index.html` silently turns
 * the whole app's style policy into nonce-only, and everything injected at
 * runtime is dropped on the floor.
 *
 * In `npm run dev` the page comes from vite and Tauri never touches it: no
 * nonce, no problem. That asymmetry is why the bug read as "sometimes".
 *
 * The carve-out is `dangerousDisableAssetCspModification: ["style-src"]`,
 * which asks Tauri to leave that one directive alone. It loosens nothing that
 * was not already written down: the policy that runs becomes the policy in
 * the config, `'unsafe-inline'` included — which the editor needs either way.
 *
 * The rule is here, and not in a comment on `index.html`, so `csp.test.ts`
 * can hold it: the next `<style>` added to the page fails the suite instead
 * of the editor.
 */

/** The slice of `app.security` this rule reads. */
export interface CspSecurity {
  csp: string;
  dangerousDisableAssetCspModification?: boolean | string[];
}

/** Anything that makes the browser drop `'unsafe-inline'` from a directive. */
const NONCE_OR_HASH = /^'(nonce|sha256|sha384|sha512)-/;

/**
 * How many `<style>` elements the packaged HTML has — one nonce each.
 *
 * Comments are stripped first: `index.html` explains itself in prose that
 * names the very tags it uses, and a rule that read those would fire on the
 * explanation and never on the page.
 */
export function inlineStyleTags(html: string): number {
  const page = html.replace(/<!--[\s\S]*?-->/g, "");
  return (page.match(/<style[\s>]/gi) ?? []).length;
}

/** Whether Tauri is still allowed to rewrite `style-src` in the built page. */
export function rewritesStyleSrc(security: CspSecurity): boolean {
  const disabled = security.dangerousDisableAssetCspModification;
  if (disabled === true) return false;
  if (Array.isArray(disabled)) return !disabled.includes("style-src");
  return true;
}

/** The sources of one directive, or `null` when the policy does not name it. */
function sources(csp: string, directive: string): string[] | null {
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === directive) return tokens.slice(1);
  }
  return null;
}

/**
 * The verdict the editor depends on: `true` when a `<style>` created by
 * JavaScript at runtime is still honoured by the app as it ships.
 */
export function runtimeStylesAllowed(html: string, security: CspSecurity): boolean {
  const csp = security.csp ?? "";
  const src = sources(csp, "style-src") ?? sources(csp, "default-src") ?? [];
  if (!src.includes("'unsafe-inline'")) return false;
  // A nonce or hash written by hand does the same damage as the one Tauri
  // stamps: `'unsafe-inline'` stops counting the moment either appears.
  if (src.some((s) => NONCE_OR_HASH.test(s))) return false;
  return inlineStyleTags(html) === 0 || !rewritesStyleSrc(security);
}
