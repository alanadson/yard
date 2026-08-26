/**
 * The English dictionary is written by hand, area by area, with the PT-BR
 * text as the key. Three mistakes are cheap to make and invisible on screen
 * until an English user hits them: a line left equal to its key (nothing
 * translated), an empty line (a blank button), and the same sentence
 * translated two different ways in two areas (the UI flickers between them
 * depending on who rendered it). This locks all three.
 */
import { describe, expect, it } from "vitest";

import EN, { AREAS } from "./index";

describe("the English dictionary", () => {
  it("has no line equal to its key and no empty line", () => {
    for (const [area, dict] of Object.entries(AREAS)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${area}: "${key}"`).not.toBe("");
        expect(value, `${area}: "${key}"`).not.toBe(key);
      }
    }
  });

  it("every key carries at least one letter — a bare symbol needs no translation", () => {
    for (const [area, dict] of Object.entries(AREAS)) {
      for (const key of Object.keys(dict)) {
        expect(/\p{L}/u.test(key), `${area}: "${key}"`).toBe(true);
      }
    }
  });

  it("the same key in two areas carries the same line", () => {
    const seen = new Map<string, { area: string; value: string }>();
    for (const [area, dict] of Object.entries(AREAS)) {
      for (const [key, value] of Object.entries(dict)) {
        const prior = seen.get(key);
        if (prior) {
          expect(value, `"${key}" differs between ${prior.area} and ${area}`).toBe(prior.value);
        } else {
          seen.set(key, { area, value });
        }
      }
    }
  });

  it("the merged dictionary is the union of the areas", () => {
    const total = Object.values(AREAS).reduce<number>((n, d) => n + Object.keys(d).length, 0);
    const distinct = new Set(Object.values(AREAS).flatMap((d) => Object.keys(d))).size;
    expect(Object.keys(EN).length).toBe(distinct);
    expect(distinct).toBeLessThanOrEqual(total);
  });
});
