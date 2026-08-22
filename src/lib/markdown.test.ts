import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown";

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
