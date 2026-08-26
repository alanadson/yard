/**
 * The editor opened raw — line numbers stacked *above* the text, the UI font
 * instead of the mono one, no colors — and only in the installed app; in
 * `npm run dev` it was always fine. What broke was not the editor: it was the
 * Content-Security-Policy of the packaged build refusing the `<style>`
 * element CodeMirror writes at runtime.
 *
 * The trap has two halves, and neither is visible from the file you edit:
 * `index.html` gained one inline `<style>` (the ground painted before the
 * sheets arrive), and Tauri answers any `<style>` in the packaged HTML by
 * stamping a nonce on it and adding `'nonce-…'` to `style-src` — which, per
 * CSP Level 3, makes the browser **ignore the `'unsafe-inline'`** that was
 * written right next to it. See `lib/csp.ts` for the whole chain.
 *
 * These tests lock the invariant on the two real files, so the next `<style>`
 * anyone adds to the page cannot silently take the editor's CSS away again.
 */
import { describe, expect, it } from "vitest";

import { inlineStyleTags, rewritesStyleSrc, runtimeStylesAllowed } from "./csp";

// The same `?raw` loader `styles.test.ts` uses: no `fs`, no new dependency.
import indexHtml from "../../index.html?raw";
import tauriConfJson from "../../src-tauri/tauri.conf.json?raw";

const security = JSON.parse(tauriConfJson).app.security as {
  csp: string;
  devCsp?: string;
  dangerousDisableAssetCspModification?: boolean | string[];
};

describe("inlineStyleTags", () => {
  it("counts the <style> elements Tauri would stamp with a nonce", () => {
    expect(inlineStyleTags("<head><style>a{}</style><style>b{}</style></head>")).toBe(2);
    expect(inlineStyleTags("<head><link rel=stylesheet href=x.css></head>")).toBe(0);
  });

  it("does not count a <style> only named inside an HTML comment", () => {
    // `index.html` explains itself in comments that mention the tags it uses;
    // a rule that reads those would fire on prose and never on the page.
    expect(inlineStyleTags("<!-- the <style> below is the ground -->")).toBe(0);
  });
});

describe("rewritesStyleSrc", () => {
  it("is true by default — Tauri owns the directive unless told otherwise", () => {
    expect(rewritesStyleSrc({ csp: "" })).toBe(true);
  });

  it("is false when the directive is named in dangerousDisableAssetCspModification", () => {
    expect(rewritesStyleSrc({ csp: "", dangerousDisableAssetCspModification: ["style-src"] })).toBe(
      false,
    );
    expect(rewritesStyleSrc({ csp: "", dangerousDisableAssetCspModification: true })).toBe(false);
  });

  it("stays true when the list names another directive", () => {
    // Disabling `script-src` says nothing about styles: this one is still
    // Tauri's to rewrite, and the nonce still lands.
    expect(rewritesStyleSrc({ csp: "", dangerousDisableAssetCspModification: ["script-src"] })).toBe(
      true,
    );
  });
});

describe("runtimeStylesAllowed", () => {
  const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'";

  it("a page with no <style> keeps its 'unsafe-inline' — nothing to stamp", () => {
    expect(runtimeStylesAllowed("<head><title>x</title></head>", { csp })).toBe(true);
  });

  it("one <style> in the page turns the policy nonce-only and refuses the editor's sheet", () => {
    // The regression itself: the file says `'unsafe-inline'` and the browser
    // ignores it, because Tauri put a nonce beside it.
    expect(runtimeStylesAllowed("<head><style>html{}</style></head>", { csp })).toBe(false);
  });

  it("the same page is fine once Tauri is told to leave style-src alone", () => {
    expect(
      runtimeStylesAllowed("<head><style>html{}</style></head>", {
        csp,
        dangerousDisableAssetCspModification: ["style-src"],
      }),
    ).toBe(true);
  });

  it("without 'unsafe-inline' nothing written at runtime applies, stamp or no stamp", () => {
    expect(
      runtimeStylesAllowed("<head></head>", {
        csp: "style-src 'self'",
        dangerousDisableAssetCspModification: ["style-src"],
      }),
    ).toBe(false);
  });

  it("a hash or nonce written by hand kills 'unsafe-inline' just the same", () => {
    expect(
      runtimeStylesAllowed("<head></head>", {
        csp: "style-src 'self' 'unsafe-inline' 'sha256-abc'",
        dangerousDisableAssetCspModification: ["style-src"],
      }),
    ).toBe(false);
  });

  it("falls back to default-src when there is no style-src", () => {
    expect(runtimeStylesAllowed("<head></head>", { csp: "default-src 'self' 'unsafe-inline'" })).toBe(
      true,
    );
    expect(runtimeStylesAllowed("<head></head>", { csp: "default-src 'self'" })).toBe(false);
  });
});

describe("the app as it ships", () => {
  it("lets CodeMirror's runtime stylesheet through in the packaged build", () => {
    expect(runtimeStylesAllowed(indexHtml, security)).toBe(true);
  });
});
