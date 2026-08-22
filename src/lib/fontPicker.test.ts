/**
 * What a font picker offers.
 *
 * The rule lived inside the Preferences JSX, untested, and it has three cases
 * that are easy to confuse: the scan still running (`null`), the scan that
 * came back without the chosen family, and the scan that came back with it.
 * The middle case is the one that hurts: the font saved in `kv` may have been
 * uninstalled — if it vanishes from the list, the picker swaps the user's
 * choice for another without warning, and the app changes its face on its
 * own at the next boot.
 */
import { describe, expect, it } from "vitest";

import type { FontFamilyInfo } from "./ipc";
import { fontOptions } from "./fontPicker";

const theFont = (family: string, mono: boolean): FontFamilyInfo => ({
  family,
  mono,
  ligatures: false,
});

const INSTALLED = [
  theFont("Cascadia Mono", true),
  theFont("Segoe UI", false),
  theFont("Fira Code", true),
];

describe("options of a font picker", () => {
  it("while the scan runs, only the current choice is offered", () => {
    expect(fontOptions(null, false, "Cascadia Mono")).toEqual([
      { value: "Cascadia Mono", label: "Cascadia Mono" },
    ]);
  });

  it("scan running and nothing chosen: empty list, no judgement", () => {
    // Nothing has been searched yet — saying "não encontrada" here would be a lie.
    expect(fontOptions(null, false, "")).toEqual([]);
  });

  it("a chosen font the machine lacks stays selectable, and says so", () => {
    const opts = fontOptions(INSTALLED, true, "Operator Mono");
    expect(opts[0]).toEqual({
      value: "Operator Mono",
      label: "Operator Mono (não encontrada)",
    });
  });

  it("only monospaced when the picker is for code", () => {
    expect(fontOptions(INSTALLED, true, "Cascadia Mono").map((o) => o.value)).toEqual([
      "Cascadia Mono",
      "Fira Code",
    ]);
    expect(fontOptions(INSTALLED, false, "Segoe UI").map((o) => o.value)).toEqual([
      "Cascadia Mono",
      "Segoe UI",
      "Fira Code",
    ]);
  });

  it("Yard's default, when present, is the first row", () => {
    const opts = fontOptions(INSTALLED, false, "", "Padrão do Yard");
    expect(opts[0]).toEqual({ value: "", label: "Padrão do Yard" });
    // And it does not repeat as "não encontrada": the empty choice is the default itself.
    expect(opts.filter((o) => o.value === "")).toHaveLength(1);
  });
});
