/**
 * The promises the Busca makes: accents never matter, more words never make
 * the list worse, and an acronym can never beat a real word match.
 */
import { describe, expect, it } from "vitest";

import { fold, matchScore, rank, subsequenceScore, tokenize, wordScore } from "./search";

describe("fold", () => {
  it("strips accents and case", () => {
    expect(fold("Português")).toBe("portugues");
    expect(fold("AÇÃO")).toBe("acao");
    expect(fold("Àéîõü")).toBe("aeiou");
  });

  it("collapses whitespace and trims", () => {
    expect(fold("  novo   terminal \n")).toBe("novo terminal");
  });
});

describe("tokenize", () => {
  it("splits on anything that is not a letter or digit", () => {
    expect(tokenize("src/components/CanvasView/index.tsx")).toEqual([
      "src",
      "components",
      "canvasview",
      "index",
      "tsx",
    ]);
  });

  it("keeps digits and folds accents", () => {
    expect(tokenize("Andar 2 — API")).toEqual(["andar", "2", "api"]);
  });
});

describe("wordScore", () => {
  it("ranks exact above prefix above substring", () => {
    const exact = wordScore("nota", ["nota"]);
    const prefix = wordScore("nota", ["notas"]);
    const inside = wordScore("nota", ["anotacao"]);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inside);
  });

  it("refuses a candidate that covers less than half of what was typed", () => {
    // "andar" hits, "api" does not: one of two meaningful words is not enough.
    expect(wordScore("andar api", ["Andar do checkout"])).toBe(0);
    expect(wordScore("andar api", ["Andar da api"])).toBeGreaterThan(0);
  });

  it("does not count filler words against a candidate", () => {
    expect(wordScore("abrir o andar", ["Andar da api"])).toBeGreaterThan(0);
  });

  it("ignores accents on both sides", () => {
    expect(wordScore("partitura", ["Partituras…"])).toBeGreaterThan(0);
    expect(wordScore("preferencias", ["Preferências"])).toBeGreaterThan(0);
  });

  it("is 0 with no fields", () => {
    expect(wordScore("nota", [])).toBe(0);
  });
});

describe("subsequenceScore", () => {
  it("matches an acronym spread across the string", () => {
    expect(subsequenceScore("ctc", "CanvasView/TerminalCard.tsx")).toBeGreaterThan(0);
  });

  it("is 0 when a character is missing or out of order", () => {
    expect(subsequenceScore("xyz", "CanvasView")).toBe(0);
    expect(subsequenceScore("cba", "abc")).toBe(0);
  });

  it("rewards word starts over a match buried mid-word", () => {
    const starts = subsequenceScore("nt", "novo terminal");
    const buried = subsequenceScore("nt", "instante");
    expect(starts).toBeGreaterThan(buried);
  });

  it("rewards a consecutive run", () => {
    expect(subsequenceScore("term", "terminal")).toBeGreaterThan(
      subsequenceScore("term", "t e r m"),
    );
  });

  it("cannot match more characters than the text has", () => {
    expect(subsequenceScore("terminal", "term")).toBe(0);
  });
});

describe("matchScore", () => {
  it("puts any word match above the best acronym", () => {
    const word = matchScore("nota", ["Nota do briefing"]);
    const acronym = matchScore("nota", ["Novo Objeto: Tudo Aqui"]);
    expect(acronym).toBeGreaterThan(0);
    expect(word).toBeGreaterThan(acronym);
  });

  it("is 0 when neither matcher lands", () => {
    expect(matchScore("zzz", ["Novo terminal", "ctrl+t"])).toBe(0);
  });

  it("sees every field, not just the title", () => {
    expect(matchScore("ctrl t", ["Novo terminal", "ctrl+t"])).toBeGreaterThan(0);
  });
});

describe("rank", () => {
  const rows = [
    { id: "a", title: "Novo terminal" },
    { id: "b", title: "Novo portal" },
    { id: "c", title: "Nova nota" },
    { id: "d", title: "Preferências" },
  ];
  const fields = (r: { title: string }) => [r.title];

  it("keeps the given order when nothing was typed", () => {
    expect(rank("", rows, fields).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("honours the limit with an empty query", () => {
    expect(rank("", rows, fields, { limit: 2 }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sorts an empty query by weight, so the box opens on what matters", () => {
    const resting = rank("", rows, fields, {
      weightOf: (r) => (r.id === "d" ? 5 : 0),
    });
    expect(resting.map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("drops what does not match", () => {
    expect(rank("portal", rows, fields).map((r) => r.id)).toEqual(["b"]);
  });

  it("breaks ties by input order, so the list does not shuffle", () => {
    // "Nova nota" is in there too — `novo` is a subsequence of it — but the
    // two real word matches come first, in the order they were given.
    expect(rank("novo", rows, fields).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("lets the weight lift a row above an equal score", () => {
    const lifted = rank("novo", rows, fields, {
      weightOf: (r) => (r.id === "b" ? 10 : 0),
    });
    expect(lifted.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});
