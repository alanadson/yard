/**
 * The isolated worktree of a task used to be called an "andar" (a floor of a
 * building). It is a "frente" now — a work front, feminine, opened and closed
 * — because the old word was, before anything else, the most common verb in
 * the language (`src/lib/search.ts` documents what that cost the search) and
 * because floors stack vertically in a product whose board is flat.
 *
 * A rename spread over a dozen files fails in two ways that never reach the
 * screen as a bug report. One sentence keeps the old noun and the interface
 * quietly speaks two vocabularies for the same object. Or a `t()` key is
 * renamed and its line in this dictionary is not, and `t()` falls back to the
 * key — the English interface goes back to Portuguese, in one tooltip, and
 * nobody notices. This walks the whole surface and locks both.
 *
 * The surface comes from a glob, not a list, so a modal added to
 * `components/Floors/` tomorrow is covered without anyone remembering to come
 * back here.
 */
import { describe, expect, it } from "vitest";

import EN from "./index";

/** Every file that writes a sentence about a front, by its own source. */
const SURFACE: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob(["../../components/Floors/*.tsx", "../../lib/floor*.ts"], {
      query: "?raw",
      eager: true,
      import: "default",
    }) as Record<string, string>,
  )
    .filter(([path]) => !path.includes(".test."))
    .map(([path, text]) => [path.replace("../../", "src/"), text]),
);

/** The old noun. `\b` keeps it off "mandar", "comandar" and "standard". */
const OLD_NOUN = /\bandar(es)?\b/i;

/**
 * A `t("…")` / `t('…')` key, including the calls broken across lines. The
 * key is always a literal — that is what makes the dictionary greppable.
 */
const CALL = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

const unslash = (s: string): string =>
  s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(text))) out.push(unslash(m[1] ?? m[2]));
  return out;
}

describe("the vocabulary of the fronts", () => {
  it("finds the surface — a moved file must not silence the two rules below", () => {
    expect(Object.keys(SURFACE)).toContain("src/components/Floors/NewFloorModal.tsx");
    expect(Object.keys(SURFACE)).toContain("src/lib/floorClose.ts");
    expect(Object.keys(SURFACE).length).toBeGreaterThanOrEqual(12);
  });

  it("nothing on the surface still says andar — copy, ids and comments alike", () => {
    for (const [file, text] of Object.entries(SURFACE)) {
      const stale = text
        .split(/\r?\n/)
        .map((line, i): [number, string] => [i + 1, line])
        .filter(([, line]) => OLD_NOUN.test(line))
        .map(([n, line]) => `${file}:${n}: ${line.trim()}`);
      expect(stale).toEqual([]);
    }
  });

  it("every sentence the surface shows has its English line", () => {
    for (const [file, text] of Object.entries(SURFACE)) {
      for (const sentence of sentencesOf(text)) {
        expect(EN[sentence as keyof typeof EN], `${file}: "${sentence}"`).toBeTruthy();
      }
    }
  });
});
