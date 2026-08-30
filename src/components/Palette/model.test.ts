/**
 * The Busca's two structural rules: a prefix narrows the hunt, and a section
 * never outranks a better row from another section.
 */
import { describe, expect, it } from "vitest";

import {
  emptyReason,
  fieldsOf,
  KIND_LABEL,
  parseQuery,
  RANKED_SCOPES,
  SCOPES,
  restingOrder,
  sectionsOf,
  type PaletteEntry,
} from "./model";

const entry = (
  id: string,
  kind: PaletteEntry["kind"],
  title: string,
  extra: Partial<PaletteEntry> = {},
): PaletteEntry => ({ id, kind, title, run: () => {}, ...extra });

describe("parseQuery", () => {
  it("reads a scope prefix and hands back the rest", () => {
    const parsed = parseQuery(">novo term");
    expect(parsed.scope?.kinds).toEqual(["action"]);
    expect(parsed.text).toBe("novo term");
  });

  it("treats a path as a file filter, not as a path", () => {
    const parsed = parseQuery("/src/lib");
    expect(parsed.scope?.kinds).toEqual(["file"]);
    expect(parsed.text).toBe("src/lib");
  });

  it("only honours the prefix at the start", () => {
    const parsed = parseQuery("nota > coisa");
    expect(parsed.scope).toBeNull();
    expect(parsed.text).toBe("nota > coisa");
  });

  it("takes a bare prefix as an empty search inside the scope", () => {
    const parsed = parseQuery("@");
    expect(parsed.scope?.kinds).toEqual(["terminal"]);
    expect(parsed.text).toBe("");
  });

  it("ignores leading spaces before the prefix", () => {
    expect(parseQuery("  #nota").scope?.prefix).toBe("#");
    expect(parseQuery("  #nota").text).toBe("nota");
  });
});

describe("the canvas scope", () => {
  it("covers every kind of node the board can hold", () => {
    // §66 asks the same question of each new node type, and this is the one
    // it is easiest to forget: a fichário or an árvore that the Busca cannot
    // reach is invisible the moment the camera is somewhere else.
    const canvas = SCOPES.find((s) => s.prefix === "#")!;
    expect(canvas.kinds).toEqual(
      expect.arrayContaining(["note", "portal", "frame", "media", "binder", "tree"]),
    );
  });

  it("covers the frames drawn on the board", () => {
    // `#` is "what is on the canvas". A frame (§5.4) is on the canvas and
    // carries the only name the user gave that region — leaving it out of the
    // scope makes the one thing they named the one thing they cannot find.
    const canvas = SCOPES.find((s) => s.prefix === "#")!;
    expect(canvas.kinds).toContain("frame");
  });
});

describe("sectionsOf", () => {
  it("places a section where its best row landed", () => {
    // Ranked list: a file beat every action, so "Arquivos" comes first even
    // though actions normally sit above files.
    const sections = sectionsOf([
      entry("f1", "file", "search.ts"),
      entry("a1", "action", "Novo terminal"),
      entry("f2", "file", "search.test.ts"),
    ]);
    expect(sections.map((s) => s.kind)).toEqual(["file", "action"]);
    expect(sections[0].entries.map((e) => e.id)).toEqual(["f1", "f2"]);
  });

  it("returns nothing for an empty list", () => {
    expect(sectionsOf([])).toEqual([]);
  });
});

describe("restingOrder", () => {
  it("uses the fixed section order when nothing was typed", () => {
    const ordered = restingOrder([
      entry("p", "project", "Yard"),
      entry("a", "action", "Novo terminal"),
      entry("t", "terminal", "claude"),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["t", "a", "p"]);
  });

  it("puts the heavier row first inside a section", () => {
    const ordered = restingOrder([
      entry("far", "terminal", "codex", { weight: 0 }),
      entry("near", "terminal", "claude", { weight: 50 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["near", "far"]);
  });

  it("keeps the input order when kind and weight tie", () => {
    const ordered = restingOrder([
      entry("1", "terminal", "a"),
      entry("2", "terminal", "b"),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["1", "2"]);
  });
});

describe("fieldsOf", () => {
  it("searches the title, the subtitle and the hidden keywords", () => {
    const fields = fieldsOf(
      entry("a", "action", "Novo terminal", {
        subtitle: "no grupo ativo",
        keywords: ["ctrl+t", "shell"],
      }),
    );
    expect(fields).toEqual(["Novo terminal", "no grupo ativo", "ctrl+t", "shell"]);
  });

  it("skips what is not there", () => {
    expect(fieldsOf(entry("a", "action", "Só o título"))).toEqual(["Só o título"]);
  });
});

/**
 * The empty list has three different things to say, and it used to say the
 * wrong one at the worst moment.
 *
 * `editorStore.fileIndex` is `string[] | null`, and `null` means "not walked
 * yet" — the index is built off the critical path when a project opens. The
 * Busca did `if (world.fileIndex)`, contributed no rows, and fell through to
 * "Nada encontrado para X". So right after adding a project, searching for a
 * file that is plainly there answered that it is not there. That is the
 * search saying "no" about the only navigation this app has, on the one
 * occasion it does not know yet.
 */
describe("the output scope", () => {
  /**
   * The `$` prefix is the only source that costs disk: it reads every
   * terminal's `.bin`. It must therefore be reachable *only* by its prefix,
   * an unprefixed "erro" has to stay the in-memory hunt it always was.
   */
  it("has a prefix of its own and covers only the output rows", () => {
    const output = SCOPES.find((s) => s.prefix === "$")!;
    expect(output).toBeDefined();
    expect(output.kinds).toEqual(["output"]);
  });

  it("reads the prefix off and hands back what to look for", () => {
    const parsed = parseQuery("$erro de build");
    expect(parsed.scope?.kinds).toEqual(["output"]);
    expect(parsed.text).toBe("erro de build");
  });

  /**
   * The regression this guards: a hit row's title is the terminal line
   * itself, and ranking it against the query a second time dropped long
   * lines below short ones. The backend already decided these rows match.
   */
  it("is a scope the ranking must not re-order", () => {
    expect(RANKED_SCOPES).not.toContain("output");
  });
});

describe("emptyReason under the output scope", () => {
  const out = SCOPES.find((s) => s.prefix === "$")!;

  /**
   * The `$` scope is the only asynchronous one: the rows arrive from the
   * backend after the keystroke. Saying "nada encontrado" while the sweep is
   * still running is the search denying a line that is about to appear,
   * the same defect the "indexando" answer exists to avoid for files.
   */
  it("says it is still looking while the sweep runs", () => {
    expect(
      emptyReason({ text: "erro", scope: out, indexed: true, searching: true }),
    ).toBe("buscando");
  });

  it("asks for one more letter instead of sweeping every .bin", () => {
    expect(emptyReason({ text: "e", scope: out, indexed: true })).toBe("curto");
  });

  it("answers nothing-found once the sweep is over", () => {
    expect(
      emptyReason({ text: "erro", scope: out, indexed: true, searching: false }),
    ).toBe("nada-encontrado");
  });

  it("still says sem-busca on a bare prefix", () => {
    expect(emptyReason({ text: "", scope: out, indexed: true })).toBe("sem-busca");
  });

  /** A short query is only short for the scope that pays for the sweep. */
  it("does not shorten anyone else's query", () => {
    expect(emptyReason({ text: "e", scope: null, indexed: true })).toBe(
      "nada-encontrado",
    );
  });
});

describe("emptyReason", () => {
  const files = SCOPES.find((s) => s.prefix === "/")!;
  const actions = SCOPES.find((s) => s.prefix === ">")!;

  it("says nothing was typed when nothing was typed", () => {
    expect(emptyReason({ text: "", scope: null, indexed: false })).toBe("sem-busca");
    expect(emptyReason({ text: "  ", scope: files, indexed: false })).toBe("sem-busca");
  });

  it("owns up to the index still being built instead of denying the file", () => {
    expect(emptyReason({ text: "App", scope: files, indexed: false })).toBe("indexando");
    // No prefix: files are in the mix too, so the same caveat holds.
    expect(emptyReason({ text: "App", scope: null, indexed: false })).toBe("indexando");
  });

  it("does not blame the index for a search that never touched files", () => {
    expect(emptyReason({ text: "novo", scope: actions, indexed: false })).toBe(
      "nada-encontrado",
    );
  });

  it("with the index built, an empty list really is an empty list", () => {
    expect(emptyReason({ text: "App", scope: files, indexed: true })).toBe(
      "nada-encontrado",
    );
    expect(emptyReason({ text: "App", scope: null, indexed: true })).toBe(
      "nada-encontrado",
    );
  });
});


/**
 * The symbol scope (`:`).
 *
 * `Ctrl+P` finds a file by name, which stops helping the moment the thing you
 * want is a function and you do not remember which file holds it. `:` asks
 * the language server instead, and like `$` it is answered by something that
 * has already done the matching, so the rows must not be re-ranked here.
 */
describe("the symbol scope", () => {
  it("has a prefix of its own that does not collide with the canvas", () => {
    // `#` was taken by the canvas long before symbols existed.
    const canvas = SCOPES.find((s) => s.prefix === "#");
    const symbols = SCOPES.find((s) => s.kinds.includes("symbol"));

    expect(symbols).toBeDefined();
    expect(symbols!.prefix).not.toBe(canvas!.prefix);
    expect(symbols!.prefix).toHaveLength(1);
  });

  it("takes the prefix off the query", () => {
    const parsed = parseQuery(":parseStored");

    expect(parsed.scope?.kinds).toEqual(["symbol"]);
    expect(parsed.text).toBe("parseStored");
  });

  it("is not re-ranked, the server already matched and ordered the rows", () => {
    expect(RANKED_SCOPES).not.toContain("symbol");
  });

  it("has a section heading, like every other kind", () => {
    // A kind with no label renders a section with an empty title.
    expect(KIND_LABEL.symbol).toBeTruthy();
  });
});

describe("emptyReason under the symbol scope", () => {
  const base = { indexed: true, scope: SCOPES.find((s) => s.kinds.includes("symbol"))! };

  it("asks for more than one letter", () => {
    // A one-letter `workspace/symbol` asks every running server for every
    // declaration it has.
    expect(emptyReason({ ...base, text: "p" })).toBe("curto");
  });

  it("says it is still asking while the servers answer", () => {
    expect(emptyReason({ ...base, text: "parse", searching: true })).toBe("buscando");
  });

  it("says nothing was found once they have", () => {
    expect(emptyReason({ ...base, text: "parse", searching: false })).toBe("nada-encontrado");
  });

  it("does not blame the file index for a symbol search", () => {
    // The regression this prevents: "indexando" is about the *file* walk, and
    // showing it here sends the reader to wait for the wrong thing.
    expect(emptyReason({ ...base, text: "parse", indexed: false })).toBe("nada-encontrado");
  });
});
