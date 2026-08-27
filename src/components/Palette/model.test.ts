/**
 * The Busca's two structural rules: a prefix narrows the hunt, and a section
 * never outranks a better row from another section.
 */
import { describe, expect, it } from "vitest";

import {
  emptyReason,
  fieldsOf,
  parseQuery,
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
