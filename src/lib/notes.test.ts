import { describe, expect, it } from "vitest";

import {
  descendantsOf,
  fallbackTitle,
  fold,
  matchNote,
  nextTagColor,
  notebookPath,
  parseNotesQuery,
  railCounts,
  snippetFor,
  stripMd,
  TAG_COLORS,
  taskProgress,
  visibleNotes,
  whenLabel,
  type Note,
  type Notebook,
  type NoteTag,
} from "./notes";

const note = (extra: Partial<Note>): Note => ({
  id: "n1",
  title: "Plano do parser",
  body: "Reescrever a *estimativa* do lexer.\n- [ ] casos de borda\n- [x] tokens",
  notebookId: null,
  tags: [],
  status: "none",
  pinned: false,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  ...extra,
});

const NOTEBOOKS: Notebook[] = [
  { id: "trab", name: "Trabalho", parentId: null, icon: null, sort: 0 },
  { id: "yard", name: "Yard", parentId: "trab", icon: null, sort: 0 },
  { id: "casa", name: "Casa", parentId: null, icon: null, sort: 1 },
];

const TAGS: NoteTag[] = [
  { id: "t-rust", name: "Rust", color: "#5fa8ff", sort: 0 },
  { id: "t-ideia", name: "Ideia", color: "#f0c33c", sort: 1 },
];

const ctx = { notebooks: NOTEBOOKS, tags: TAGS };

describe("fold", () => {
  it("strips accents without changing the length", () => {
    expect(fold("Anotação")).toBe("anotacao");
    expect(fold("Anotação").length).toBe("Anotação".length);
    expect(fold("ESTIMATIVA")).toBe("estimativa");
  });
});

describe("parseNotesQuery", () => {
  it("splits terms, phrases and qualifiers", () => {
    const q = parseNotesQuery('caderno:Trabalho tag:rust "frase exata" solto');
    expect(q.books).toEqual([{ text: "trabalho", not: false }]);
    expect(q.tags).toEqual([{ text: "rust", not: false }]);
    expect(q.terms).toEqual([
      { text: "frase exata", not: false },
      { text: "solto", not: false },
    ]);
  });

  it("accepts negation and English aliases", () => {
    const q = parseNotesQuery("-book:Casa -titulo:velho -status:done status:ativa");
    expect(q.books).toEqual([{ text: "casa", not: true }]);
    expect(q.titles).toEqual([{ text: "velho", not: true }]);
    expect(q.statuses).toEqual([
      { status: "done", not: true },
      { status: "active", not: false },
    ]);
  });

  it("an unknown prefix is a plain term (addresses with colons)", () => {
    const q = parseNotesQuery("http://exemplo.com");
    expect(q.terms[0].text).toContain("http://exemplo.com");
    expect(q.books).toHaveLength(0);
  });

  it("an unknown status becomes a term instead of hiding everything", () => {
    const q = parseNotesQuery("status:qualquercoisa");
    expect(q.statuses).toHaveLength(0);
    expect(q.terms).toEqual([{ text: "qualquercoisa", not: false }]);
  });
});

describe("matchNote", () => {
  it("partial, accent-insensitive search in the body", () => {
    const q = parseNotesQuery("estim");
    expect(matchNote(note({}), q, ctx)).toBe(true);
  });

  it("caderno: reaches the notes of sub-notebooks", () => {
    const q = parseNotesQuery("caderno:Trabalho");
    expect(matchNote(note({ notebookId: "yard" }), q, ctx)).toBe(true);
    expect(matchNote(note({ notebookId: "casa" }), q, ctx)).toBe(false);
    expect(matchNote(note({ notebookId: null }), q, ctx)).toBe(false);
  });

  it("-tag: excludes whoever has the tag", () => {
    const q = parseNotesQuery("-tag:rust");
    expect(matchNote(note({ tags: ["t-rust"] }), q, ctx)).toBe(false);
    expect(matchNote(note({ tags: ["t-ideia"] }), q, ctx)).toBe(true);
  });

  it("titulo: only looks at the title", () => {
    const q = parseNotesQuery("titulo:lexer");
    expect(matchNote(note({}), q, ctx)).toBe(false);
    expect(matchNote(note({ title: "Lexer novo" }), q, ctx)).toBe(true);
  });
});

describe("visibleNotes", () => {
  const all = [
    note({ id: "a", updatedAt: 10 }),
    note({ id: "b", updatedAt: 20, pinned: true }),
    note({ id: "c", updatedAt: 30, status: "done" }),
    note({ id: "d", updatedAt: 40, deletedAt: 99 }),
  ];
  const base = {
    notes: all,
    ctx,
    query: parseNotesQuery(""),
    sort: "updated" as const,
    showResolved: false,
  };

  it("hides trash and resolved; pinned comes first", () => {
    const vis = visibleNotes({ ...base, collection: { kind: "all" } });
    expect(vis.map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("the eye shows the resolved ones again", () => {
    const vis = visibleNotes({ ...base, collection: { kind: "all" }, showResolved: true });
    expect(vis.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("the status collection shows its own even when resolved", () => {
    const vis = visibleNotes({
      ...base,
      collection: { kind: "status", status: "done" },
    });
    expect(vis.map((n) => n.id)).toEqual(["c"]);
  });

  it("the trash only has what was deleted", () => {
    const vis = visibleNotes({ ...base, collection: { kind: "trash" } });
    expect(vis.map((n) => n.id)).toEqual(["d"]);
  });

  it("searching by status: reveals resolved ones without the eye", () => {
    const vis = visibleNotes({
      ...base,
      collection: { kind: "all" },
      query: parseNotesQuery("status:concluida"),
    });
    expect(vis.map((n) => n.id)).toEqual(["c"]);
  });
});

describe("notebook tree", () => {
  it("descendantsOf includes itself and the children", () => {
    expect([...descendantsOf(NOTEBOOKS, "trab")].sort()).toEqual(["trab", "yard"]);
  });

  it("survives a cycle saved by mistake", () => {
    const cycle: Notebook[] = [
      { id: "a", name: "A", parentId: "b", icon: null, sort: 0 },
      { id: "b", name: "B", parentId: "a", icon: null, sort: 0 },
    ];
    expect(descendantsOf(cycle, "a").size).toBe(2);
    expect(notebookPath(cycle, "a").length).toBeGreaterThan(0);
  });

  it("notebookPath builds the full path", () => {
    expect(notebookPath(NOTEBOOKS, "yard")).toBe("Trabalho / Yard");
  });
});

describe("railCounts", () => {
  it("counts by status, notebook (with the whole branch) and tag", () => {
    const counts = railCounts(
      [
        note({ id: "a", notebookId: "yard", tags: ["t-rust"], status: "active" }),
        note({ id: "b", notebookId: "trab" }),
        note({ id: "c", deletedAt: 1 }),
      ],
      NOTEBOOKS,
    );
    expect(counts.all).toBe(2);
    expect(counts.trash).toBe(1);
    expect(counts.byStatus.active).toBe(1);
    expect(counts.byBook.get("trab")).toBe(2);
    expect(counts.byBook.get("yard")).toBe(1);
    expect(counts.byTag.get("t-rust")).toBe(1);
  });
});

describe("preview", () => {
  it("stripMd removes fences, markers and links", () => {
    const s = stripMd("# Título\n```js\ncode()\n```\n- [x] feito\n[link](http://x)");
    expect(s).toBe("Título  ☑ feito  link");
  });

  it("snippetFor centres on the first hit and marks the matches", () => {
    const body = `${"x".repeat(200)} um achado especial aqui`;
    const snip = snippetFor(body, parseNotesQuery("achado"));
    expect(snip.text).toContain("achado");
    expect(snip.hits.length).toBeGreaterThan(0);
    const [s, e] = snip.hits[0];
    expect(snip.text.slice(s, e).toLowerCase()).toBe("achado");
  });

  it("taskProgress counts the checkboxes", () => {
    expect(taskProgress("- [ ] a\n- [x] b\n  - [X] c\ntexto")).toEqual({
      done: 2,
      total: 3,
    });
  });

  it("fallbackTitle uses the first readable line", () => {
    expect(fallbackTitle("# Minha ideia\ncorpo")).toBe("Minha ideia");
    expect(fallbackTitle("")).toBe("Sem título");
  });
});

describe("whenLabel", () => {
  const now = new Date(2026, 7, 18, 15, 0, 0).getTime();
  it("scales from now up to a date with year", () => {
    expect(whenLabel(now - 30_000, now)).toBe("agora");
    expect(whenLabel(now - 5 * 60_000, now)).toBe("há 5 min");
    expect(whenLabel(now - 2 * 3_600_000, now)).toBe("há 2 h");
    expect(whenLabel(new Date(2026, 7, 17, 20, 0).getTime(), now)).toBe("ontem");
    expect(whenLabel(new Date(2026, 4, 12).getTime(), now)).toBe("12/mai");
    expect(whenLabel(new Date(2025, 1, 3).getTime(), now)).toBe("3/fev/25");
  });
});

describe("nextTagColor", () => {
  it("picks the least used colour of the palette", () => {
    const used: NoteTag[] = TAG_COLORS.slice(0, 3).map((c, i) => ({
      id: String(i),
      name: String(i),
      color: c,
      sort: i,
    }));
    expect(nextTagColor(used)).toBe(TAG_COLORS[3]);
    expect(nextTagColor([])).toBe(TAG_COLORS[0]);
  });
});
