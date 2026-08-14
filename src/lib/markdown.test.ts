import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("reconhece titulo, lista e citacao", () => {
    const b = parseMarkdown("# Plano\n- um\n2. dois\n> nota");
    expect(b[0]).toMatchObject({ t: "h", level: 1 });
    expect(b[1]).toMatchObject({ t: "li", ordered: false, marker: "•" });
    expect(b[2]).toMatchObject({ t: "li", ordered: true, marker: "2." });
    expect(b[3]).toMatchObject({ t: "quote" });
  });

  it("bloco cercado sai literal", () => {
    const b = parseMarkdown("```\n# nao e titulo\n**nao e negrito**\n```");
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ t: "pre", v: "# nao e titulo\n**nao e negrito**" });
  });

  it("linha em branco vira espacador, nao some", () => {
    expect(parseMarkdown("a\n\nb").map((x) => x.t)).toEqual(["p", "blank", "p"]);
  });

  it("cerca sem fechamento nao come o resto do arquivo em silencio", () => {
    const b = parseMarkdown("```\nsobrou");
    expect(b).toEqual([{ t: "pre", v: "sobrou" }]);
  });
});

describe("parseInline", () => {
  it("separa negrito, italico e codigo", () => {
    expect(parseInline("um **dois** _tres_ `quatro`")).toEqual([
      { t: "text", v: "um " },
      { t: "strong", v: "dois" },
      { t: "text", v: " " },
      { t: "em", v: "tres" },
      { t: "text", v: " " },
      { t: "code", v: "quatro" },
    ]);
  });

  it("o que esta entre crases nao vira formatacao", () => {
    expect(parseInline("`**literal**`")).toEqual([{ t: "code", v: "**literal**" }]);
  });

  it("texto sem marcacao passa inteiro", () => {
    expect(parseInline("nada aqui")).toEqual([{ t: "text", v: "nada aqui" }]);
  });
});
