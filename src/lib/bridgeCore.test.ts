/**
 * The rules the `yard` CLI promises to agents. They are a contract, not
 * a detail: changing name dedup or note reach breaks agent scripts that
 * are already written, and that has to show up here before it shows up in
 * production.
 */
import { describe, expect, it } from "vitest";

import {
  connectedAgents,
  parseFlags,
  connectedNotes,
  connectedPortals,
  decodeEscapes,
  findAgent,
  findAny,
  findMentions,
  findPortal,
  makeCtx,
  reaches,
  stripAnsi,
  uniqueNames,
} from "./bridgeCore";
import { EMPTY_CANVAS, noteName, type CanvasData, type CanvasItem } from "./canvas";
import { hostnameOf, normalizePortalUrl, uniquePortalNames } from "./portals";
import type { TerminalRow } from "./ipc";

let clock = 1_000;

function term(id: string, title: string | null, program = "claude.cmd"): TerminalRow {
  return {
    id,
    groupId: "g1",
    slot: 0,
    title,
    kind: "agent",
    agentId: "claude",
    program,
    args: [],
    cwd: "C:/proj",
    resume: null,
    sort: 0,
    alive: true,
    createdAt: clock++,
  };
}

function note(id: string, text: string, extra: Partial<Extract<CanvasItem, { type: "note" }>> = {}) {
  return {
    id,
    type: "note" as const,
    x: 0,
    y: 0,
    w: 200,
    h: 150,
    text,
    color: "#f5f5f5",
    ...extra,
  };
}

function portal(
  id: string,
  url: string,
  extra: Partial<Extract<CanvasItem, { type: "portal" }>> = {},
): Extract<CanvasItem, { type: "portal" }> {
  return {
    id,
    type: "portal",
    x: 0,
    y: 0,
    w: 720,
    h: 480,
    url,
    color: "#f5f5f5",
    ...extra,
  };
}

function conn(from: string, to: string): CanvasItem {
  return { id: `c-${from}-${to}`, type: "connection", from, to, color: "#6b6b6b" };
}

function canvasWith(items: CanvasItem[]): CanvasData {
  return { ...EMPTY_CANVAS, viewport: { ...EMPTY_CANVAS.viewport }, items };
}

/**
 * `connect` is the only command that can widen an agent's reach, so it is where
 * the gate has to hold. Without this rule, an isolated agent wired itself to
 * everything and talked to the whole group — while the manual it reads promises
 * that the user is the one who draws the connections.
 */
describe("reaches — the anchor of `yard connect`", () => {
  const me = term("t1", "eu");
  const neighbor = term("t2", "vizinho");
  const stranger = term("t3", "estranho");
  const myNote = note("n1", "briefing");
  const farNote = note("n2", "de outro agente");
  const myPortal = portal("p1", "https://exemplo.com");

  const ctx = makeCtx(
    me,
    "g1",
    canvasWith([
      myNote,
      farNote,
      myPortal,
      conn("t1", "t2"),
      conn("t1", "n1"),
      conn("n1", "p1"),
      conn("t3", "n2"),
    ]),
    [me, neighbor, stranger],
  );

  it("reaches itself, the direct neighbor and the chain of notes", () => {
    expect(reaches(ctx, "t1")).toBe(true);
    expect(reaches(ctx, "t2")).toBe(true);
    expect(reaches(ctx, "n1")).toBe(true);
    // A portal hanging off my note comes in through the same chain.
    expect(reaches(ctx, "p1")).toBe(true);
  });

  it("does not reach whoever is on the other side of the canvas", () => {
    expect(reaches(ctx, "t3")).toBe(false);
    expect(reaches(ctx, "n2")).toBe(false);
  });

  it("passing through an agent does not open up its notes", () => {
    // t2 is a direct neighbor, but whatever hangs off it does not become mine.
    const withNeighborNote = makeCtx(
      me,
      "g1",
      canvasWith([note("n3", "do vizinho"), conn("t1", "t2"), conn("t2", "n3")]),
      [me, neighbor],
    );
    expect(reaches(withNeighborNote, "t2")).toBe(true);
    expect(reaches(withNeighborNote, "n3")).toBe(false);
  });
});

describe("addressing names", () => {
  it("breaks ties between duplicates in creation order", () => {
    const a = term("t1", "claude");
    const b = term("t2", "claude");
    const c = term("t3", "claude");
    const names = uniqueNames([c, a, b]); // out of order on purpose
    expect(names.get("t1")).toBe("claude");
    expect(names.get("t2")).toBe("claude (2)");
    expect(names.get("t3")).toBe("claude (3)");
  });

  it("falls back to the executable when the terminal has no title", () => {
    const names = uniqueNames([term("t1", null, "C:/tools/codex.cmd")]);
    expect(names.get("t1")).toBe("codex.cmd");
  });

  it("ignores case when comparing", () => {
    const names = uniqueNames([term("t1", "Claude"), term("t2", "claude")]);
    expect(names.get("t2")).toBe("claude (2)");
  });
});

describe("the connections gate", () => {
  it("only sees agents with a direct connection", () => {
    const [a, b, c] = [term("t1", "a"), term("t2", "b"), term("t3", "c")];
    // a—b, b—c: for "a", "c" is two hops away and does not count.
    const ctx = makeCtx(a, "g1", canvasWith([conn("t1", "t2"), conn("t2", "t3")]), [a, b, c]);
    expect(connectedAgents(ctx).map((t) => t.id)).toEqual(["t2"]);
    expect(findAgent(ctx, "c")).toBeNull();
    expect(findAgent(ctx, "b")?.id).toBe("t2");
  });

  it("with no connection at all, nobody is reachable", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const ctx = makeCtx(a, "g1", canvasWith([]), [a, b]);
    expect(connectedAgents(ctx)).toHaveLength(0);
    expect(findAgent(ctx, "b")).toBeNull();
  });

  it("`connect` finds anyone in the group, even disconnected", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const ctx = makeCtx(a, "g1", canvasWith([]), [a, b]);
    expect(findAny(ctx, "b")).toEqual({ kind: "terminal", id: "t2" });
  });
});

describe("chain of notes", () => {
  it("reaches notes wired to other notes", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "primeira"),
      note("n2", "segunda"),
      note("n3", "terceira"),
      conn("t1", "n1"),
      conn("n1", "n2"),
      conn("n2", "n3"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(connectedNotes(ctx).map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("does not cross an agent to get to its notes", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const canvas = canvasWith([
      note("n1", "minha"),
      note("n2", "dele"),
      conn("t1", "n1"),
      conn("t1", "t2"),
      conn("t2", "n2"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a, b]);
    expect(connectedNotes(ctx).map((n) => n.id)).toEqual(["n1"]);
  });

  it("does not loop when notes are wired in a cycle", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "um"),
      note("n2", "dois"),
      conn("t1", "n1"),
      conn("n1", "n2"),
      conn("n2", "n1"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(connectedNotes(ctx)).toHaveLength(2);
  });
});

describe("note name", () => {
  it("derives from the first line and ignores the heading #", () => {
    expect(noteName(note("n1", "# Plano de ataque\nlinha 2"))).toBe("Plano de ataque");
  });

  it("the pinned name beats the first line", () => {
    expect(noteName(note("n1", "# Plano", { name: "briefing" }))).toBe("briefing");
  });

  it("renames itself when the first line changes", () => {
    const before = note("n1", "rascunho");
    const after = { ...before, text: "# Resultado final\ndetalhes" };
    expect(noteName(before)).not.toBe(noteName(after));
    expect(noteName(after)).toBe("Resultado final");
  });

  it("two notes with the same title get a suffix", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "tarefas"),
      note("n2", "tarefas"),
      conn("t1", "n1"),
      conn("t1", "n2"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(ctx.noteNameOf.get("n2")).toBe("tarefas (2)");
  });
});

describe("portals on the canvas", () => {
  it("the default name is the hostname; --name wins", () => {
    expect(hostnameOf("https://www.example.com/app")).toBe("example.com");
    expect(uniquePortalNames([portal("p1", "https://localhost:5173", { name: "App" })]).get("p1")).toBe(
      "App",
    );
  });

  it("breaks the tie between two portals on the same host", () => {
    const names = uniquePortalNames([
      portal("p1", "https://example.com/a"),
      portal("p2", "https://example.com/b"),
    ]);
    expect(names.get("p1")).toBe("example.com");
    expect(names.get("p2")).toBe("example.com (2)");
  });

  it("reaches a portal wired directly and through a note", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([
      note("n1", "brief"),
      portal("p1", "https://app.local"),
      portal("p2", "https://other.local"),
      conn("t1", "n1"),
      conn("n1", "p1"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(connectedPortals(ctx).map((p) => p.id)).toEqual(["p1"]);
    expect(findPortal(ctx, "app.local")?.id).toBe("p1");
    expect(findPortal(ctx, "other.local")).toBeNull();
  });

  it("does not cross another agent to get to its portal", () => {
    const a = term("t1", "a");
    const b = term("t2", "b");
    const canvas = canvasWith([
      portal("p1", "https://a.local"),
      portal("p2", "https://b.local"),
      conn("t1", "p1"),
      conn("t1", "t2"),
      conn("t2", "p2"),
    ]);
    const ctx = makeCtx(a, "g1", canvas, [a, b]);
    expect(connectedPortals(ctx).map((p) => p.id)).toEqual(["p1"]);
  });

  it("`connect` finds a portal by hostname", () => {
    const a = term("t1", "a");
    const canvas = canvasWith([portal("p1", "https://docs.dev")]);
    const ctx = makeCtx(a, "g1", canvas, [a]);
    expect(findAny(ctx, "docs.dev")).toEqual({ kind: "portal", id: "p1" });
  });

  it("normalizes a URL without a scheme", () => {
    expect(normalizePortalUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizePortalUrl("example.com")).toBe("https://example.com");
  });
});

describe("terminal output", () => {
  it("strips ANSI and OSC escapes", () => {
    const raw = "\x1b]0;titulo\x07\x1b[32mok\x1b[0m\r\nfim";
    expect(stripAnsi(raw)).toBe("ok\nfim");
  });

  it("collapses excess blank lines", () => {
    expect(stripAnsi("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("decodes --raw escapes", () => {
    expect(decodeEscapes("2\\n")).toBe("2\r");
    expect(decodeEscapes("\\e[A")).toBe("\x1b[A");
    expect(decodeEscapes("\\x41")).toBe("A");
  });
});

describe("@ mentions", () => {
  it("matches the longest name first", () => {
    expect(findMentions("pergunte ao @claude (2) agora", ["claude", "claude (2)"])).toEqual([
      "claude (2)",
    ]);
  });

  it("ignores @ in the middle of a word (e-mail)", () => {
    expect(findMentions("mande para alan@claude.com", ["claude"])).toEqual([]);
  });

  it("finds several mentions", () => {
    expect(findMentions("@ana e @beto revisem", ["ana", "beto"]).sort()).toEqual([
      "ana",
      "beto",
    ]);
  });
});

describe("parseFlags — text that looks like a flag", () => {
  const SPEC = {
    "--raw": "bool",
    "--name": "string",
    "--timeout": "number",
    "--stdin": "stdin",
    "--file": "stdin",
  } as const;

  it("`--` ends the flags and the rest becomes text", () => {
    // Without this there was no way at all to send a prompt starting with `-`:
    // `ask "A" "--raw"` switched the flag on and lost the prompt, and the CLI
    // answered with the usage text as if the command were malformed.
    const p = parseFlags(["Agente", "--", "--raw", "--name"], SPEC);
    expect(p.positional).toEqual(["Agente", "--raw", "--name"]);
    expect(p.bool.raw).toBeUndefined();
    expect(p.string.name).toBeUndefined();
  });

  it("a flag never swallows another as its value", () => {
    // `--name --raw` stored "--raw" as the name and lost the `--raw`.
    const p = parseFlags(["--name", "--raw", "Nota"], SPEC);
    expect(p.string.name).toBeUndefined();
    expect(p.bool.raw).toBe(true);
    expect(p.positional).toEqual(["Nota"]);
  });

  it("a value flag at the end neither consumes the void nor breaks", () => {
    const p = parseFlags(["Agente", "--name"], SPEC);
    expect(p.string.name).toBeUndefined();
    expect(p.positional).toEqual(["Agente"]);
  });

  it("the normal path stays the same", () => {
    const p = parseFlags(["Agente", "--name", "Plano", "--timeout", "30", "--raw"], SPEC);
    expect(p.positional).toEqual(["Agente"]);
    expect(p.string.name).toBe("Plano");
    expect(p.number.timeout).toBe(30);
    expect(p.bool.raw).toBe(true);
  });

  it("--file without a value still marks stdin (the shim already consumed the path)", () => {
    expect(parseFlags(["Nota", "--file"], SPEC).fromStdin).toBe(true);
    expect(parseFlags(["Nota", "--stdin"], SPEC).positional).toEqual(["Nota"]);
  });
});
