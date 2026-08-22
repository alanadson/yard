import { describe, expect, it } from "vitest";

import { outline, parseDoc, parseInline, plain, stats, type Block } from "./mddoc";

/** The kinds in reading order — the shape of the document, without the text. */
function kinds(blocks: Block[]): string[] {
  return blocks.map((b) => b.t);
}

function text(blocks: Block[], i: number): string {
  const b = blocks[i];
  if (b.t === "p" || b.t === "h") return plain(b.parts);
  if (b.t === "code") return b.text;
  return "";
}

describe("blocks", () => {
  it("joins the lines of a paragraph and splits on a blank", () => {
    const doc = parseDoc("uma linha\ne a continuacao\n\noutro paragrafo");
    expect(kinds(doc)).toEqual(["p", "p"]);
    expect(text(doc, 0)).toBe("uma linha e a continuacao");
  });

  it("reads headings both ways and keeps the source line", () => {
    const doc = parseDoc("# um\n\ntexto\n\nDois\n----\n\n###### seis");
    expect(kinds(doc)).toEqual(["h", "p", "h", "h"]);
    expect(doc[0]).toMatchObject({ level: 1, line: 0 });
    expect(doc[2]).toMatchObject({ level: 2, line: 4 });
    expect(doc[3]).toMatchObject({ level: 6, line: 7 });
  });

  it("does not confuse a rule with an underlined heading", () => {
    expect(kinds(parseDoc("***"))).toEqual(["hr"]);
    expect(kinds(parseDoc("\n---\n"))).toEqual(["hr"]);
  });

  it("keeps fenced code with its language, without interpreting the content", () => {
    const doc = parseDoc("```ts\nconst a = **1**;\n```");
    expect(doc[0]).toMatchObject({ t: "code", lang: "ts", text: "const a = **1**;" });
  });

  it("front matter becomes a single block, instead of two rules", () => {
    const doc = parseDoc("---\ntitle: Yard\n---\n\n# depois");
    expect(kinds(doc)).toEqual(["code", "h"]);
    expect(doc[0]).toMatchObject({ lang: "yaml", text: "title: Yard" });
  });

  it("block quotes, with lazy continuation", () => {
    const doc = parseDoc("> alguem disse\nque isso continua\n\nfora");
    expect(kinds(doc)).toEqual(["quote", "p"]);
    const quote = doc[0];
    if (quote.t !== "quote") throw new Error("expected a quote");
    const inside = quote.blocks[0];
    if (inside.t !== "p") throw new Error("expected a paragraph inside the quote");
    expect(plain(inside.parts)).toBe("alguem disse que isso continua");
  });

  it("raw html shows up as source, never executed", () => {
    const doc = parseDoc('<div onclick="x">oi</div>');
    expect(doc[0]).toMatchObject({ t: "html" });
  });
});

describe("lists", () => {
  it("nests by indentation", () => {
    const doc = parseDoc("- pai\n  - filho\n- outro pai");
    const list = doc[0];
    if (list.t !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(2);
    expect(kinds(list.items[0].blocks)).toEqual(["p", "list"]);
    expect(list.tight).toBe(true);
  });

  it("marks the task and the line a click has to flip", () => {
    const doc = parseDoc("# t\n\n- [ ] fazer\n- [x] feito");
    const list = doc[1];
    if (list.t !== "list") throw new Error("expected a list");
    expect(list.items.map((i) => i.task)).toEqual(["todo", "done"]);
    expect(list.items.map((i) => i.line)).toEqual([2, 3]);
  });

  it("a numbered list starts where the author said", () => {
    const doc = parseDoc("3. tres\n4. quatro");
    expect(doc[0]).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  it("a blank line between items makes the list loose", () => {
    const doc = parseDoc("- um\n\n- dois");
    const list = doc[0];
    if (list.t !== "list") throw new Error("expected a list");
    expect(list.tight).toBe(false);
    expect(list.items).toHaveLength(2);
  });

  it("bullet and numbered are different lists", () => {
    expect(kinds(parseDoc("- um\n1. dois"))).toEqual(["list", "list"]);
  });
});

describe("table", () => {
  it("reads header, alignment and cells", () => {
    const doc = parseDoc("| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |");
    const table = doc[0];
    if (table.t !== "table") throw new Error("expected a table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.head.map((c) => plain(c.parts))).toEqual(["a", "b"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1].map((c) => plain(c.parts))).toEqual(["3", "4"]);
  });

  it("pads the short row instead of misaligning the column", () => {
    const doc = parseDoc("| a | b |\n| --- | --- |\n| so um |");
    const table = doc[0];
    if (table.t !== "table") throw new Error("expected a table");
    expect(table.rows[0]).toHaveLength(2);
  });

  it("a paragraph before the table does not swallow it", () => {
    expect(kinds(parseDoc("texto\n\n| a |\n| --- |\n| 1 |"))).toEqual(["p", "table"]);
    expect(kinds(parseDoc("texto\n| a |\n| --- |\n| 1 |"))).toEqual(["p", "table"]);
  });
});

describe("inline", () => {
  it("nests emphasis inside bold", () => {
    const parts = parseInline("**forte _e torto_**");
    expect(parts[0].t).toBe("strong");
    expect(plain(parts)).toBe("forte e torto");
  });

  it("does not read an underscore in the middle of a word", () => {
    expect(plain(parseInline("nome_de_variavel"))).toBe("nome_de_variavel");
    expect(parseInline("nome_de_variavel").every((p) => p.t === "text")).toBe(true);
  });

  it("code protects the markers inside it", () => {
    const parts = parseInline("`a ** b`");
    expect(parts).toEqual([{ t: "code", v: "a ** b" }]);
  });

  it("link, image and reference", () => {
    const doc = parseDoc("[texto](./a.md) ![alt](img.png)\n\n[ref]: https://exemplo.dev\n\n[ref]");
    const first = doc[0];
    if (first.t !== "p") throw new Error("expected a paragraph");
    expect(first.parts[0]).toMatchObject({ t: "link", href: "./a.md" });
    expect(first.parts.find((p) => p.t === "image")).toMatchObject({
      src: "img.png",
      alt: "alt",
    });
    const last = doc[doc.length - 1];
    if (last.t !== "p") throw new Error("expected a paragraph");
    expect(last.parts[0]).toMatchObject({ t: "link", href: "https://exemplo.dev" });
  });

  it("refuses an address with a strange scheme", () => {
    const parts = parseInline("[clique](javascript:alert(1))");
    expect(parts.some((p) => p.t === "link")).toBe(false);
  });

  it("a bare address becomes a link", () => {
    const parts = parseInline("veja https://exemplo.dev/a, depois");
    expect(parts.find((p) => p.t === "link")).toMatchObject({
      href: "https://exemplo.dev/a",
    });
  });

  it("hard break with two spaces, soft without them", () => {
    expect(parseInline("um  \ndois").some((p) => p.t === "br")).toBe(true);
    expect(plain(parseInline("um\ndois"))).toBe("um dois");
  });

  it("a footnote becomes a numbered reference", () => {
    const doc = parseDoc("texto[^1]\n\n[^1]: a explicacao");
    const p = doc[0];
    if (p.t !== "p") throw new Error("expected a paragraph");
    expect(p.parts[1]).toMatchObject({ t: "noteref", id: "1" });
    expect(doc[1]).toMatchObject({ t: "note", id: "1" });
  });

  it("strikethrough, highlight, sub and superscript", () => {
    expect(parseInline("~~fora~~")[0].t).toBe("strike");
    expect(parseInline("==aqui==")[0].t).toBe("mark");
    expect(parseInline("H~2~O")[1].t).toBe("sub");
    expect(parseInline("x^2^")[1].t).toBe("sup");
  });

  it("an escape leaves the marker literal", () => {
    expect(plain(parseInline("\\*nao e enfase\\*"))).toBe("*nao e enfase*");
  });
});

describe("outline and counting", () => {
  it("numbers repeated anchors", () => {
    const doc = parseDoc("# Instalação\n\n## Instalacao\n\n### Outro");
    expect(outline(doc).map((h) => h.slug)).toEqual(["instalacao", "instalacao-1", "outro"]);
    expect(outline(doc).map((h) => h.level)).toEqual([1, 2, 3]);
  });

  it("finds a heading inside a quote", () => {
    expect(outline(parseDoc("> # dentro")).map((h) => h.text)).toEqual(["dentro"]);
  });

  it("counts words without the code and without the markers", () => {
    const s = stats("# um dois\n\n```\nisso nao conta nada aqui\n```\n\n- [x] feito\n- [ ] falta");
    expect(s.words).toBe(4);
    expect(s.tasks).toEqual({ done: 1, total: 2 });
    expect(s.minutes).toBe(1);
  });

  it("an empty file has no reading time", () => {
    expect(stats("").minutes).toBe(0);
  });
});
