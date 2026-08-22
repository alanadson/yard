/**
 * The find bar's counter (Ctrl+F) — "2 de 3" — is the only proof the user has
 * that the search found something, and of where they are inside it. The count
 * has to see the document exactly the way CodeMirror searches it (case, whole
 * word, regex), recognize which match is under the selection, stop counting
 * at a cap (a 20k-line file counts on every keystroke) and never blow up on a
 * half-written regex.
 */
import { describe, expect, it } from "vitest";
import { SearchQuery } from "@codemirror/search";
import { Text } from "@codemirror/state";

import { matchLabel, matchStats } from "./searchCore";

// "foo bar foo\nbaz foo" — matches at 0-3, 8-11 and 16-19.
const doc = Text.of(["foo bar foo", "baz foo"]);

describe("matchStats", () => {
  it("counts every match and says which one is selected", () => {
    const s = matchStats(doc, new SearchQuery({ search: "foo" }), { from: 8, to: 11 });
    expect(s).toMatchObject({ total: 3, current: 2, status: "ok" });
  });

  it("with no selection over a match, there is no current match", () => {
    const s = matchStats(doc, new SearchQuery({ search: "foo" }), { from: 0, to: 0 });
    expect(s).toMatchObject({ total: 3, current: 0 });
  });

  it("an empty search is 'idle' — a freshly opened bar does not report 'sem ocorrências'", () => {
    const s = matchStats(doc, new SearchQuery({ search: "" }), { from: 0, to: 0 });
    expect(s.status).toBe("idle");
  });

  it("a half-written regex neither counts nor blows up — the bar says it is broken", () => {
    const q = new SearchQuery({ search: "foo(", regexp: true });
    const s = matchStats(doc, q, { from: 0, to: 0 });
    expect(s).toMatchObject({ status: "invalid", total: 0 });
  });

  it("honors case, whole word and regex the same way CodeMirror itself does", () => {
    const caso = Text.of(["Foo foo foobar"]);
    expect(matchStats(caso, new SearchQuery({ search: "foo" }), { from: 0, to: 0 }).total).toBe(3);
    expect(
      matchStats(caso, new SearchQuery({ search: "foo", caseSensitive: true }), { from: 0, to: 0 })
        .total,
    ).toBe(2);
    expect(
      matchStats(caso, new SearchQuery({ search: "foo", wholeWord: true }), { from: 0, to: 0 })
        .total,
    ).toBe(2);
    expect(
      matchStats(caso, new SearchQuery({ search: "fo+bar", regexp: true }), { from: 0, to: 0 })
        .total,
    ).toBe(1);
  });

  it("stops at the cap instead of scanning the whole file, and admits it stopped", () => {
    const large = Text.of(["a a a a a a a a a a"]);
    const s = matchStats(large, new SearchQuery({ search: "a" }), { from: 0, to: 0 }, 4);
    expect(s).toMatchObject({ total: 4, capped: true });
  });
});

describe("matchLabel", () => {
  it("says nothing while nothing has been typed", () => {
    expect(matchLabel({ total: 0, current: 0, capped: false, status: "idle" })).toBe("");
  });

  it("reports the broken regex instead of pretending zero results", () => {
    expect(matchLabel({ total: 0, current: 0, capped: false, status: "invalid" })).toBe(
      "regex inválida",
    );
  });

  it("says 'sem ocorrências' when the search is valid and found nothing", () => {
    expect(matchLabel({ total: 0, current: 0, capped: false, status: "ok" })).toBe(
      "sem ocorrências",
    );
  });

  it("with a match under the cursor, shows the position within the total", () => {
    expect(matchLabel({ total: 12, current: 3, capped: false, status: "ok" })).toBe("3 de 12");
  });

  it("before the first Enter, shows only how many there are — singular when it is one", () => {
    expect(matchLabel({ total: 12, current: 0, capped: false, status: "ok" })).toBe(
      "12 ocorrências",
    );
    expect(matchLabel({ total: 1, current: 0, capped: false, status: "ok" })).toBe("1 ocorrência");
  });

  it("when the count stopped at the cap, the total gets a '+' — 12 is not 12+", () => {
    expect(matchLabel({ total: 1000, current: 3, capped: true, status: "ok" })).toBe("3 de 1000+");
    expect(matchLabel({ total: 1000, current: 0, capped: true, status: "ok" })).toBe(
      "1000+ ocorrências",
    );
  });
});
