import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown, type Block } from "./markdown";

describe("parseMarkdown", () => {
  it("recognizes heading, list and quote", () => {
    const b = parseMarkdown("# Plano\n- um\n2. dois\n> nota");
    expect(b[0]).toMatchObject({ t: "h", level: 1 });
    expect(b[1]).toMatchObject({ t: "li", ordered: false, marker: "•" });
    expect(b[2]).toMatchObject({ t: "li", ordered: true, marker: "2." });
    expect(b[3]).toMatchObject({ t: "quote" });
  });

  it("a fenced block comes out literal", () => {
    const b = parseMarkdown("```\n# nao e titulo\n**nao e negrito**\n```");
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ t: "pre", v: "# nao e titulo\n**nao e negrito**", line: 0 });
  });

  it("the word after the fence becomes the language label", () => {
    expect(parseMarkdown("```ts\nx\n```")[0]).toMatchObject({ t: "pre", lang: "ts" });
  });

  it("a blank line becomes a spacer, it does not vanish", () => {
    expect(parseMarkdown("a\n\nb").map((x) => x.t)).toEqual(["p", "blank", "p"]);
  });

  it("an unclosed fence does not silently eat the rest of the file", () => {
    const b = parseMarkdown("```\nsobrou");
    expect(b).toEqual([{ t: "pre", v: "sobrou", line: 0 }]);
  });

  it("task and plain list are not confused", () => {
    const b = parseMarkdown("- [ ] aberta\n- [x] feita\n- comum");
    expect(b[0]).toMatchObject({ t: "li", task: "todo" });
    expect(b[1]).toMatchObject({ t: "li", task: "done" });
    expect(b[2]).toMatchObject({ t: "li", marker: "•" });
    expect(b[2]).not.toHaveProperty("task");
  });

  it("every block knows which line it came from, even after a fence", () => {
    const b = parseMarkdown("# a\n```\nx\ny\n```\n- [ ] z");
    expect(b.map((x) => x.line)).toEqual([0, 1, 5]);
  });

  it("list indentation becomes depth", () => {
    const b = parseMarkdown("- raiz\n  - filho\n    - neto");
    expect(b.map((x) => (x.t === "li" ? x.depth : -1))).toEqual([0, 1, 2]);
  });
});

describe("parseInline", () => {
  it("splits bold, italic and code", () => {
    expect(parseInline("um **dois** _tres_ `quatro`")).toEqual([
      { t: "text", v: "um " },
      { t: "strong", v: "dois" },
      { t: "text", v: " " },
      { t: "em", v: "tres" },
      { t: "text", v: " " },
      { t: "code", v: "quatro" },
    ]);
  });

  it("what sits between backticks does not become formatting", () => {
    expect(parseInline("`**literal**`")).toEqual([{ t: "code", v: "**literal**" }]);
  });

  it("text without markup passes through whole", () => {
    expect(parseInline("nada aqui")).toEqual([{ t: "text", v: "nada aqui" }]);
  });

  it("strikethrough and highlight", () => {
    expect(parseInline("~~fora~~ e ==aqui==")).toEqual([
      { t: "strike", v: "fora" },
      { t: "text", v: " e " },
      { t: "mark", v: "aqui" },
    ]);
  });

  it("a link with a label, and without one shows the address", () => {
    expect(parseInline("[docs](https://a.dev)")).toEqual([
      { t: "link", v: "docs", href: "https://a.dev" },
    ]);
    expect(parseInline("[](localhost:5173)")).toEqual([
      { t: "link", v: "localhost:5173", href: "localhost:5173" },
    ]);
  });

  it("the underscore in a url does not become italics", () => {
    expect(parseInline("[a](https://x.dev/a_b_c)")).toEqual([
      { t: "link", v: "a", href: "https://x.dev/a_b_c" },
    ]);
  });

  it("a dangerous scheme does not become a link — it comes out as text", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { t: "text", v: "[x](javascript:alert(1)" },
      { t: "text", v: ")" },
    ]);
    expect(parseInline("[x](data:text/html,oi)")).toEqual([
      { t: "text", v: "[x](data:text/html,oi)" },
    ]);
  });
});

/**
 * Tables and images (§12.2/12.3). Both were in the spec's list of what a
 * rendered note has to show and in neither the parser nor the body — a note
 * pasted with a table read as three lines of pipes.
 */
describe("tables", () => {
  const src = ["| a | b |", "| --- | ---: |", "| 1 | 2 |"].join("\n");

  it("reads the header, the alignment row and the body", () => {
    const [block] = parseMarkdown(src);
    expect(block).toMatchObject({
      t: "table",
      align: ["left", "right"],
      line: 0,
    });
  });

  it("keeps each cell as inline parts, so **bold** works inside one", () => {
    const [block] = parseMarkdown("| **a** |\n| --- |\n| b |");
    const table = block as Extract<Block, { t: "table" }>;
    expect(table.head[0]).toEqual([{ t: "strong", v: "a" }]);
  });

  it("swallows the whole table in one block", () => {
    // The alignment row must never survive as a paragraph of dashes, and the
    // body rows must not each become their own block.
    expect(parseMarkdown(src)).toHaveLength(1);
  });

  it("pads a short row instead of dropping the cell", () => {
    const table = parseMarkdown("| a | b |\n| --- | --- |\n| 1 |")[0] as Extract<
      Block,
      { t: "table" }
    >;
    expect(table.rows[0]).toHaveLength(2);
  });

  it("leaves a lone pipe line as a paragraph", () => {
    // Without the alignment row underneath it, `| not a table |` is text
    // someone wrote — turning it into a one-cell table would be a surprise.
    expect(parseMarkdown("| not a table |")[0].t).toBe("p");
  });
});

describe("images", () => {
  it("reads an image as its own inline part, not as a link", () => {
    expect(parseInline("veja ![alt](shot.png) aqui")).toEqual([
      { t: "text", v: "veja " },
      { t: "img", alt: "alt", src: "shot.png" },
      { t: "text", v: " aqui" },
    ]);
  });

  it("accepts a relative path — a note points into the project", () => {
    expect(parseInline("![](docs/a.png)")).toEqual([
      { t: "img", alt: "", src: "docs/a.png" },
    ]);
  });

  it("accepts an embedded data: URL", () => {
    // What a screenshot pasted into a note becomes. It is the one long src
    // that must survive: refusing it would break paste-a-print entirely.
    const src = "data:image/png;base64,iVBOR";
    expect(parseInline(`![p](${src})`)).toEqual([{ t: "img", alt: "p", src }]);
  });

  it("refuses a src with a scheme that is not http(s) or data", () => {
    // Note text comes from agents through the CLI. A `javascript:` or a
    // `file:` src is untrusted input, and it falls back to plain text.
    expect(parseInline("![x](javascript:boom)")).toEqual([
      { t: "text", v: "![x](javascript:boom)" },
    ]);
  });

  it("leaves the refused source visible, character for character", () => {
    // Asserted on what the note *shows*, not on how many text parts it took
    // to say it: `[^)\s]*` stops at the first `)`, so a src with parentheses
    // comes back split — which renders identically and is not a defect.
    const src = "![x](javascript:alert(1))";
    const parts = parseInline(src);
    expect(parts.every((p) => p.t === "text")).toBe(true);
    expect(parts.map((p) => (p.t === "text" ? p.v : "")).join("")).toBe(src);
  });
});
