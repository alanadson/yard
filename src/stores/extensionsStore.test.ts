/**
 * The switches survive a reload, so what comes back from `kv` has to be
 * checked — and an id that left the catalog must not come back from disk.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { setPrefsTransport } from "../lib/prefs";
import { NO_SCHEME } from "../lib/schemeChoice";
import { parseEnabled, useExtensions } from "./extensionsStore";

beforeEach(() => {
  useExtensions.setState({ enabled: {}, scheme: NO_SCHEME });
});

describe("parseEnabled", () => {
  it("returns nothing for junk", () => {
    expect(parseEnabled(undefined)).toEqual({});
    expect(parseEnabled("")).toEqual({});
    expect(parseEnabled("não é json")).toEqual({});
    expect(parseEnabled("[1,2]")).toEqual({});
    expect(parseEnabled('"symbols"')).toEqual({});
  });

  it("keeps only known ids that are literally true", () => {
    const raw = JSON.stringify({
      symbols: true,
      fantasma: true,
      outra: "true",
    });
    expect(parseEnabled(raw)).toEqual({ symbols: true });
  });

  it("treats anything but true as off", () => {
    expect(parseEnabled(JSON.stringify({ symbols: false }))).toEqual({});
    expect(parseEnabled(JSON.stringify({ symbols: 1 }))).toEqual({});
  });
});

describe("setEnabled", () => {
  it("turns on, and off is absence — not false", () => {
    useExtensions.getState().setEnabled("symbols", true);
    expect(useExtensions.getState().enabled.symbols).toBe(true);
    useExtensions.getState().setEnabled("symbols", false);
    expect("symbols" in useExtensions.getState().enabled).toBe(false);
  });

  it("icon themes are a radio: turning one on retires the other", () => {
    useExtensions.getState().setEnabled("symbols", true);
    useExtensions.getState().setEnabled("material-icons", true);
    expect(useExtensions.getState().enabled["material-icons"]).toBe(true);
    expect("symbols" in useExtensions.getState().enabled).toBe(false);
  });

  it("categoryless switches do not interfere with each other", () => {
    useExtensions.getState().setEnabled("code-fonts", true);
    useExtensions.getState().setEnabled("rainbow-brackets", true);
    expect(useExtensions.getState().enabled["code-fonts"]).toBe(true);
    expect(useExtensions.getState().enabled["rainbow-brackets"]).toBe(true);
  });
});

describe("parseEnabled + categories", () => {
  it("a kv with both icon themes keeps only the first of the catalog", () => {
    const raw = JSON.stringify({ symbols: true, "material-icons": true });
    expect(parseEnabled(raw)).toEqual({ symbols: true });
  });
});

/**
 * The colour schemes stopped being switches: they are two slots now, one per
 * surface, in a key of their own (`ext.scheme`). What is worth a test is the
 * seam between the two keys — every profile that exists holds the *old* shape,
 * one boolean in `ext.enabled`, and a first launch that reads the new key,
 * finds nothing and shrugs would quietly un-theme all of them. The rules
 * themselves live in `lib/schemeChoice.ts`; this is the store honouring them
 * on the way in and on the way out.
 */
describe("the scheme slots", () => {
  const withPrefs = async (prefs: Record<string, string>) => {
    const written: Record<string, string> = {};
    const restore = setPrefsTransport({
      readPrefs: () => Promise.resolve(prefs),
      writePref: (key, value) => {
        written[key] = value;
        return Promise.resolve();
      },
    });
    await useExtensions.getState().load();
    return { written, restore };
  };

  it("starts on the Yard's own palette on both surfaces", () => {
    expect(useExtensions.getState().scheme).toEqual(NO_SCHEME);
  });

  it("reads the two slots a split profile saved", async () => {
    const { restore } = await withPrefs({
      "ext.scheme": JSON.stringify({ terminal: "theme-nord", code: "theme-ayu" }),
    });
    expect(useExtensions.getState().scheme).toEqual({
      terminal: "theme-nord",
      code: "theme-ayu",
    });
    restore();
  });

  it("carries an old profile's single switch across to both slots", async () => {
    const { restore } = await withPrefs({
      "ext.enabled": JSON.stringify({ "theme-ayu": true, minimap: true }),
    });
    expect(useExtensions.getState().scheme).toEqual({
      terminal: "theme-ayu",
      code: "theme-ayu",
    });
    restore();
  });

  /**
   * The migration reads the old key; it must not leave it *also* answering.
   * A scheme left sitting in `enabled` is a second source of truth for the
   * same colour, and the store's own "one category at a time" rule would
   * still be enforcing a rule that no longer exists.
   */
  it("leaves no scheme behind among the switches", async () => {
    const { restore } = await withPrefs({
      "ext.enabled": JSON.stringify({ "theme-ayu": true, minimap: true }),
    });
    const { enabled } = useExtensions.getState();
    expect(enabled.minimap).toBe(true);
    expect("theme-ayu" in enabled).toBe(false);
    restore();
  });

  it("writes the choice under its own key, not among the switches", async () => {
    const { written, restore } = await withPrefs({});
    useExtensions.getState().setScheme({ terminal: "theme-nord", code: "theme-ayu" });
    expect(JSON.parse(written["ext.scheme"])).toEqual({
      terminal: "theme-nord",
      code: "theme-ayu",
    });
    expect(written["ext.enabled"]).toBeUndefined();
    restore();
  });

  it("keeps the Yard's own palette on a surface the user cleared", async () => {
    const { written, restore } = await withPrefs({});
    useExtensions.getState().setScheme({ terminal: undefined, code: "theme-ayu" });
    expect(useExtensions.getState().scheme.terminal).toBeUndefined();
    // Written, and written as a *choice* — an absent key means "look in the
    // old place", and that is not what the user just said.
    expect(written["ext.scheme"]).toBeDefined();
    restore();
  });
});
