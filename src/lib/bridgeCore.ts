/**
 * Pure core of the `yard` CLI: addressing names, reach through canvas
 * connections and cleanup of terminal output.
 *
 * Nothing here touches store, IPC or DOM. It was split from `bridge.ts` for
 * two reasons: the prompt composer needs the same connected list the CLI
 * sees, and these rules (name dedup, note chain, connection gate) are
 * exactly the ones worth locking down in tests.
 */
import { noteName, type CanvasData, type CanvasItem } from "./canvas";
import { byName, uniqueLabels } from "./names";
import { uniquePortalNames } from "./portals";
import { baseName } from "./terminals";
import type { TerminalRow } from "./ipc";

export { baseName, byName, uniqueLabels };

export type NoteItem = Extract<CanvasItem, { type: "note" }>;
export type PortalItem = Extract<CanvasItem, { type: "portal" }>;

export interface Ctx {
  caller: TerminalRow;
  groupId: string;
  canvas: CanvasData;
  /** All terminals in the group. */
  terminals: TerminalRow[];
  /** Unique display name per terminal. */
  nameOf: Map<string, string>;
  notes: NoteItem[];
  noteNameOf: Map<string, string>;
  portals: PortalItem[];
  portalNameOf: Map<string, string>;
  /** Adjacency (undirected) of the canvas connections. */
  edges: Map<string, Set<string>>;
}

/** Unique names per terminal. Numbering follows creation order. */
export function uniqueNames(terminals: TerminalRow[]): Map<string, string> {
  return uniqueLabels(
    [...terminals].sort((a, b) => a.createdAt - b.createdAt),
    baseName,
  );
}

/** Same dedup rule for notes — the name comes from the 1st line or `--name`. */
export function uniqueNoteNames(notes: NoteItem[]): Map<string, string> {
  return uniqueLabels(notes, noteName);
}

export function buildEdges(items: CanvasItem[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const it of items) {
    if (it.type !== "connection") continue;
    if (!edges.has(it.from)) edges.set(it.from, new Set());
    if (!edges.has(it.to)) edges.set(it.to, new Set());
    edges.get(it.from)!.add(it.to);
    edges.get(it.to)!.add(it.from);
  }
  return edges;
}

export function makeCtx(
  caller: TerminalRow,
  groupId: string,
  canvas: CanvasData,
  terminals: TerminalRow[],
): Ctx {
  const notes = canvas.items.filter((i): i is NoteItem => i.type === "note");
  const portals = canvas.items.filter((i): i is PortalItem => i.type === "portal");
  return {
    caller,
    groupId,
    canvas,
    terminals,
    nameOf: uniqueNames(terminals),
    notes,
    noteNameOf: uniqueNoteNames(notes),
    portals,
    portalNameOf: uniquePortalNames(portals),
    edges: buildEdges(canvas.items),
  };
}

/** Agents with a direct connection to the caller. */
export function connectedAgents(ctx: Ctx): TerminalRow[] {
  const direct = ctx.edges.get(ctx.caller.id) ?? new Set<string>();
  return ctx.terminals.filter((t) => direct.has(t.id));
}

/**
 * Notes reachable from the caller traveling **only through notes**: a note
 * linked to another note enters the context, but passing through an agent
 * does not open access to that agent's notes.
 */
function hopIds(ctx: Ctx): Set<string> {
  return new Set([...ctx.notes.map((n) => n.id), ...ctx.portals.map((p) => p.id)]);
}

/**
 * Breadth-first walk from the caller through hop nodes, returning the
 * elements of `pool` it reaches, in the order it found them.
 *
 * Notes and portals are the only hops: this is what makes a note chain work
 * while passing *through* an agent still gives no access to that agent's
 * notes. The two callers below differ only in which pool they collect.
 */
function reachable<T extends { id: string }>(ctx: Ctx, pool: T[]): T[] {
  const wanted = new Set(pool.map((x) => x.id));
  const hops = hopIds(ctx);
  const order = new Map<string, number>();
  const visited = new Set<string>([ctx.caller.id]);
  const queue = [...(ctx.edges.get(ctx.caller.id) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id) || !hops.has(id)) continue;
    visited.add(id);
    if (wanted.has(id)) order.set(id, order.size);
    for (const next of ctx.edges.get(id) ?? []) queue.push(next);
  }
  return pool
    .filter((x) => order.has(x.id))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function connectedNotes(ctx: Ctx): NoteItem[] {
  return reachable(ctx, ctx.notes);
}

/** Portals reachable from the caller traveling only through notes and portals. */
export function connectedPortals(ctx: Ctx): PortalItem[] {
  return reachable(ctx, ctx.portals);
}

export function findAgent(ctx: Ctx, name: string): TerminalRow | null {
  return byName(connectedAgents(ctx), ctx.nameOf, name);
}

export function findNote(ctx: Ctx, name: string): NoteItem | null {
  return byName(connectedNotes(ctx), ctx.noteNameOf, name);
}

export function findPortal(ctx: Ctx, name: string): PortalItem | null {
  return byName(connectedPortals(ctx), ctx.portalNameOf, name);
}

/** Any entity in the group by name (for `connect`, which ignores the gate). */
export function findAny(
  ctx: Ctx,
  name: string,
): { kind: "terminal" | "note" | "portal"; id: string } | null {
  const t = byName(ctx.terminals, ctx.nameOf, name);
  if (t) return { kind: "terminal", id: t.id };
  const n = byName(ctx.notes, ctx.noteNameOf, name);
  if (n) return { kind: "note", id: n.id };
  const p = byName(ctx.portals, ctx.portalNameOf, name);
  if (p) return { kind: "portal", id: p.id };
  return null;
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * Kind of each flag a command accepts.
 *
 * `stdin` is the odd one and the reason this exists: `cmd.exe` eats line
 * breaks in `%*`, so a multi-line prompt cannot travel in `argv` at all. The
 * shim reads the file and re-writes `--file X` as `--stdin`, and every
 * command that takes long text has to accept both spellings — six hand-rolled
 * `for` loops used to do that, one of them subtly differently.
 */
export type FlagKind = "bool" | "string" | "number" | "stdin";

export type FlagSpec = Record<string, FlagKind>;

export interface ParsedArgs {
  /** Everything that was not a flag or a flag's value, in order. */
  positional: string[];
  bool: Record<string, boolean>;
  string: Record<string, string | undefined>;
  number: Record<string, number | undefined>;
  /** True when any `stdin`-kind flag was present. */
  fromStdin: boolean;
}

/**
 * Splits `argv` into flags and positionals according to `spec`.
 *
 * Unknown tokens are positional — the CLI is spoken by agents, and swallowing
 * a mistyped flag as text is friendlier than an error that stops the task.
 * A `number` flag with junk after it is ignored rather than becoming `NaN`.
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedArgs {
  const out: ParsedArgs = {
    positional: [],
    bool: {},
    string: {},
    number: {},
    fromStdin: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const kind = spec[a];
    if (!kind) {
      out.positional.push(a);
      continue;
    }
    const key = a.replace(/^--?/, "");
    switch (kind) {
      case "bool":
        out.bool[key] = true;
        break;
      case "string":
        out.string[key] = args[++i];
        break;
      case "number": {
        const v = Number(args[++i]);
        if (Number.isFinite(v)) out.number[key] = v;
        break;
      }
      case "stdin":
        out.fromStdin = true;
        // `--file <path>` carries a value the shim already consumed; `--stdin`
        // does not. Skipping a token only when one follows keeps both working.
        if (a === "--file") i++;
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// terminal output
// ---------------------------------------------------------------------------

/** Strips ANSI/OSC escapes and controls so the text becomes a readable reply. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : `…(cortado)…\n${s.slice(s.length - max)}`;
}

/** `--raw`: `\n` `\t` `\e` `\xNN` become real bytes. */
export function decodeEscapes(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, code: string) => {
    if (code.startsWith("x")) return String.fromCharCode(parseInt(code.slice(1), 16));
    switch (code) {
      case "n":
        return "\r";
      case "t":
        return "\t";
      case "e":
        return "\x1b";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      default:
        return code;
    }
  });
}

// ---------------------------------------------------------------------------
// mentions (@Nome) — used by the composer and by `ask`
// ---------------------------------------------------------------------------

/**
 * Finds `@Nome` in the text against a known list of names.
 *
 * Two non-obvious rules:
 *
 * 1. Longer names first, and the matched span is **reserved**. Agent names
 *    have a space and suffix ("claude (2)"), so without this a `@claude (2)`
 *    would also fire a mention of "claude" — and the prompt would go to two
 *    terminals when the user asked for one.
 * 2. The `@` must open a word, otherwise `alan@claude.com` would become a mention.
 */
export function findMentions(text: string, names: string[]): string[] {
  const ordered = [...names].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const tomados: [number, number][] = [];
  const hit: string[] = [];
  for (const name of ordered) {
    const needle = `@${name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const fim = at + needle.length;
      const before = at === 0 ? " " : text[at - 1];
      const colide = tomados.some(([s, e]) => at < e && fim > s);
      if (!colide && /\s|[([{,;]/.test(before)) {
        tomados.push([at, fim]);
        hit.push(name);
        break;
      }
      from = at + 1;
    }
  }
  return hit;
}
