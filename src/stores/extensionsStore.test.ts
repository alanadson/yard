/**
 * The switches survive a reload, so what comes back from `kv` has to be
 * checked — and an id that left the catalog must not come back from disk.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { parseEnabled, useExtensions } from "./extensionsStore";

beforeEach(() => {
  useExtensions.setState({ enabled: {} });
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
