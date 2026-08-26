/**
 * The notebook's domain: notes, notebooks, labels — and the search engine.
 *
 * Everything here is pure (data in, data out) so the store stays thin and the
 * rules are testable without a DOM. The search understands qualifiers the way
 * a person types them mid-thought:
 *
 *   parser caderno:Trabalho tag:rust -status:concluida "frase exata" -rascunho
 *
 * Qualifiers come in Portuguese and English (`caderno:`/`book:`, `titulo:`/
 * `title:`, `etiqueta:`/`tag:`), any of them negatable with `-`. Plain terms
 * match title and body, accent-insensitive and partial ("estim" finds
 * "estimativa") — deliberately looser than an FTS engine would be, because a
 * personal notebook is small enough to afford it.
 */

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

// i18n-scan: tables
import { activeLang, t } from "./i18n";

export type NoteStatus = "none" | "active" | "paused" | "done" | "dropped";

export interface Note {
  id: string;
  title: string;
  body: string;
  notebookId: string | null;
  /** Tag ids — the names live on the tags themselves. */
  tags: string[];
  status: NoteStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set = in the trash. */
  deletedAt: number | null;
}

export interface Notebook {
  id: string;
  name: string;
  parentId: string | null;
  /** Emoji picked by the user; `null` = the default book glyph. */
  icon: string | null;
  sort: number;
}

export interface NoteTag {
  id: string;
  name: string;
  color: string;
  sort: number;
}

/** What the list pane is looking at — one row of the rail. */
export type Collection =
  | { kind: "all" }
  | { kind: "book"; id: string }
  | { kind: "status"; status: NoteStatus }
  | { kind: "tag"; id: string }
  | { kind: "trash" };

export type NoteSort = "updated" | "created" | "title";

export const NOTE_SORTS: NoteSort[] = ["updated", "created", "title"];

export const STATUSES: NoteStatus[] = ["none", "active", "paused", "done", "dropped"];

/**
 * Labels and the dot each status wears. The chroma is *content* state — the
 * same license the diffs and the task deadlines already have — never chrome.
 */
export const STATUS_META: Record<
  NoteStatus,
  { label: string; dot: string | null }
> = {
  none: { label: "Sem status", dot: null },
  active: { label: "Ativa", dot: "var(--accent-bright)" },
  paused: { label: "Em espera", dot: "var(--yellow)" },
  done: { label: "Concluída", dot: "var(--green)" },
  dropped: { label: "Descartada", dot: "var(--text-dim)" },
};

/**
 * Fixed palette for labels — the canvas swatches' family, tuned for a 10px
 * dot over the dark panels. User-picked color on user data is content, not
 * chrome, so the semantic-chroma rule does not apply here.
 */
export const TAG_COLORS = [
  "#5fa8ff",
  "#5ecfbb",
  "#40d16e",
  "#f0c33c",
  "#ff9f5a",
  "#ff6961",
  "#ff8fb8",
  "#c98bf2",
  "#a3a3a3",
  "#f5f5f5",
] as const;

/** The least-used color of the palette — what a brand-new label wears. */
export function nextTagColor(tags: readonly NoteTag[]): string {
  const usage = new Map<string, number>(TAG_COLORS.map((c) => [c, 0]));
  for (const t of tags) usage.set(t.color, (usage.get(t.color) ?? 0) + 1);
  let best: string = TAG_COLORS[0];
  let lowest = Infinity;
  for (const c of TAG_COLORS) {
    const n = usage.get(c) ?? 0;
    if (n < lowest) {
      lowest = n;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// folding — accent-insensitive matching that keeps every index aligned
// ---------------------------------------------------------------------------

const FOLD_CACHE = new Map<string, string>();

/**
 * Lowercases and drops the accent of each character **without changing the
 * string's length**, so a match found in the folded text highlights the right
 * span of the original. `normalize("NFD")` alone would shift every index
 * after the first "ç".
 */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const cached = FOLD_CACHE.get(ch);
    if (cached !== undefined) {
      out += cached;
      continue;
    }
    let f = ch.toLowerCase();
    if (f.length === 1 && f.charCodeAt(0) > 127) {
      const base = f.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (base.length === 1) f = base;
    }
    // Multi-unit lowercases (İ → i̇) would shift indexes; keep the original.
    if (f.length !== ch.length) f = ch.toLowerCase().slice(0, ch.length);
    if (FOLD_CACHE.size < 4096) FOLD_CACHE.set(ch, f);
    out += f;
  }
  return out;
}

// ---------------------------------------------------------------------------
// query — qualifiers, quoted phrases, `-` negation
// ---------------------------------------------------------------------------

interface Term {
  text: string;
  not: boolean;
}

export interface NotesQuery {
  empty: boolean;
  /** Plain terms and quoted phrases — matched on title + body. */
  terms: Term[];
  titles: Term[];
  books: Term[];
  tags: Term[];
  statuses: { status: NoteStatus; not: boolean }[];
}

const OPS: Record<string, "book" | "tag" | "status" | "title"> = {
  caderno: "book",
  book: "book",
  tag: "tag",
  etiqueta: "tag",
  status: "status",
  titulo: "title",
  título: "title",
  title: "title",
};

const STATUS_ALIAS: Record<string, NoteStatus> = {
  nenhum: "none",
  sem: "none",
  none: "none",
  ativa: "active",
  ativo: "active",
  active: "active",
  espera: "paused",
  pausada: "paused",
  onhold: "paused",
  hold: "paused",
  paused: "paused",
  concluida: "done",
  concluído: "done",
  concluido: "done",
  feita: "done",
  done: "done",
  completed: "done",
  descartada: "dropped",
  descartado: "dropped",
  dropped: "dropped",
};

const TOKEN = /(-?)(?:([\p{L}]+):)?("[^"]*"|[^\s"]+)/gu;

export function parseNotesQuery(raw: string): NotesQuery {
  const q: NotesQuery = {
    empty: true,
    terms: [],
    titles: [],
    books: [],
    tags: [],
    statuses: [],
  };
  for (const m of raw.matchAll(TOKEN)) {
    const not = m[1] === "-";
    const opWord = m[2] ? fold(m[2]) : null;
    const op = opWord ? OPS[opWord] : undefined;
    let value = m[3];
    if (value.startsWith('"')) value = value.slice(1, -1);
    // Unknown prefix (`http:`, `c:`): the whole token is an ordinary term —
    // whoever pastes an address is searching for it, not operating on it.
    if (opWord && !op) value = `${m[2]}:${value}`;
    const text = fold(value.trim());
    if (!text) continue;
    q.empty = false;
    if (op === "book") q.books.push({ text, not });
    else if (op === "tag") q.tags.push({ text, not });
    else if (op === "title") q.titles.push({ text, not });
    else if (op === "status") {
      const status = STATUS_ALIAS[text];
      // An unknown status is kept as a plain term: silently matching
      // nothing would read as "my notes are gone".
      if (status) q.statuses.push({ status, not });
      else q.terms.push({ text, not });
    } else q.terms.push({ text, not });
  }
  return q;
}

/** Does the query explicitly ask about statuses? (Turns off the resolved-notes filter.) */
export function queryTouchesStatus(q: NotesQuery): boolean {
  return q.statuses.length > 0;
}

// ---------------------------------------------------------------------------
// notebook tree
// ---------------------------------------------------------------------------

/** Direct children, in rail order. */
export function childrenOf(
  notebooks: readonly Notebook[],
  parentId: string | null,
): Notebook[] {
  return notebooks
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "pt-BR"));
}

/** The notebook and everything nested under it. */
export function descendantsOf(
  notebooks: readonly Notebook[],
  id: string,
): Set<string> {
  const out = new Set<string>([id]);
  // By id, not by object: a cycle written by a buggy save must not hang the UI.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of notebooks) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/** "Trabalho / Projetos / Yard" — for subtitles and the move menu. */
export function notebookPath(
  notebooks: readonly Notebook[],
  id: string | null,
): string {
  if (!id) return "";
  const byId = new Map(notebooks.map((n) => [n.id, n]));
  const parts: string[] = [];
  let current = byId.get(id);
  let fuse = 0;
  while (current && fuse < 32) {
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    fuse += 1;
  }
  return parts.join(" / ");
}

// ---------------------------------------------------------------------------
// matching and the visible list
// ---------------------------------------------------------------------------

export interface QueryContext {
  notebooks: readonly Notebook[];
  tags: readonly NoteTag[];
}

/** Notebook ids whose (folded) name contains the term, plus their descendants. */
function booksMatching(ctx: QueryContext, term: string): Set<string> {
  const out = new Set<string>();
  for (const nb of ctx.notebooks) {
    if (fold(nb.name).includes(term)) {
      for (const id of descendantsOf(ctx.notebooks, nb.id)) out.add(id);
    }
  }
  return out;
}

function tagsMatching(ctx: QueryContext, term: string): Set<string> {
  const out = new Set<string>();
  for (const t of ctx.tags) if (fold(t.name).includes(term)) out.add(t.id);
  return out;
}

export function matchNote(note: Note, q: NotesQuery, ctx: QueryContext): boolean {
  if (q.empty) return true;
  const theTitle = fold(note.title);
  let body: string | null = null;
  const theText = () => {
    if (body === null) body = `${theTitle}\n${fold(note.body)}`;
    return body;
  };

  for (const t of q.terms) {
    if (theText().includes(t.text) === t.not) return false;
  }
  for (const t of q.titles) {
    if (theTitle.includes(t.text) === t.not) return false;
  }
  for (const b of q.books) {
    const inside = note.notebookId !== null && booksMatching(ctx, b.text).has(note.notebookId);
    if (inside === b.not) return false;
  }
  for (const t of q.tags) {
    const ids = tagsMatching(ctx, t.text);
    const hasTag = note.tags.some((id) => ids.has(id));
    if (hasTag === t.not) return false;
  }
  for (const s of q.statuses) {
    if ((note.status === s.status) === s.not) return false;
  }
  return true;
}

export interface ListArgs {
  notes: readonly Note[];
  collection: Collection;
  query: NotesQuery;
  ctx: QueryContext;
  sort: NoteSort;
  /** Show notes already resolved (concluída/descartada) in normal collections. */
  showResolved: boolean;
}

/**
 * The rows of the list pane, in final order: pinned first, then the sort.
 *
 * Resolved notes (concluída/descartada) hide from the everyday collections —
 * they are finished business — and reappear in their own status rows, in the
 * trash, when the eye toggle asks for them, or when the query itself mentions
 * a status.
 */
export function visibleNotes(args: ListArgs): Note[] {
  const { notes, collection, query, ctx, sort, showResolved } = args;
  const inTrash = collection.kind === "trash";
  const hideResolved =
    !inTrash &&
    collection.kind !== "status" &&
    !showResolved &&
    !queryTouchesStatus(query);
  const ofNotebook =
    collection.kind === "book" ? descendantsOf(ctx.notebooks, collection.id) : null;

  const out = notes.filter((n) => {
    if ((n.deletedAt !== null) !== inTrash) return false;
    if (ofNotebook && (n.notebookId === null || !ofNotebook.has(n.notebookId))) return false;
    if (collection.kind === "status" && n.status !== collection.status) return false;
    if (collection.kind === "tag" && !n.tags.includes(collection.id)) return false;
    if (hideResolved && (n.status === "done" || n.status === "dropped")) return false;
    return matchNote(n, query, ctx);
  });

  out.sort((a, b) => {
    if (!inTrash && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === "title") {
      return a.title.localeCompare(b.title, "pt-BR") || b.updatedAt - a.updatedAt;
    }
    if (sort === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

/** Counters for the rail, all computed in one pass over the notes. */
export interface RailCounts {
  all: number;
  trash: number;
  byStatus: Record<NoteStatus, number>;
  /** Note count per notebook, descendants included. */
  byBook: Map<string, number>;
  byTag: Map<string, number>;
}

export function railCounts(
  notes: readonly Note[],
  notebooks: readonly Notebook[],
): RailCounts {
  const byStatus: Record<NoteStatus, number> = {
    none: 0,
    active: 0,
    paused: 0,
    done: 0,
    dropped: 0,
  };
  const byBook = new Map<string, number>();
  const byTag = new Map<string, number>();
  const parentOf = new Map(notebooks.map((n) => [n.id, n.parentId]));
  let all = 0;
  let trash = 0;

  for (const n of notes) {
    if (n.deletedAt !== null) {
      trash += 1;
      continue;
    }
    all += 1;
    byStatus[n.status] += 1;
    for (const t of n.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
    // The note counts for its notebook and every ancestor, so a parent's
    // number is the whole branch. The fuse caps a cyclic chain.
    let currentValue = n.notebookId;
    let fuse = 0;
    while (currentValue && fuse < 32) {
      byBook.set(currentValue, (byBook.get(currentValue) ?? 0) + 1);
      currentValue = parentOf.get(currentValue) ?? null;
      fuse += 1;
    }
  }
  return { all, trash, byStatus, byBook, byTag };
}

// ---------------------------------------------------------------------------
// list previews — snippet, highlight spans, task progress, dates
// ---------------------------------------------------------------------------

/** Markdown stripped down to readable prose, for the two-line preview. */
export function stripMd(body: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    let s = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*+]\s+\[[xX]\]\s+/, "☑ ")
      .replace(/^[-*+]\s+\[\s?\]\s+/, "☐ ")
      .replace(/^[-*+]\s+/, "• ")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|==|`)/g, "");
    s = s.trim();
    if (s === "---" || s === "***") continue;
    if (s) lines.push(s);
  }
  return lines.join("  ");
}

export interface Snippet {
  text: string;
  /** Spans of `text` to paint as hits, already merged and ordered. */
  hits: [number, number][];
}

const SNIPPET_LEN = 150;

/**
 * The preview under a title: around the first search hit when there is one,
 * from the top when there is not. Hits are computed against the folded text
 * so "Estimativa" lights up for "estim".
 */
export function snippetFor(body: string, q: NotesQuery): Snippet {
  const text = stripMd(body);
  const folded = fold(text);
  const terms = [...q.terms, ...q.titles].filter((t) => !t.not).map((t) => t.text);

  let start = 0;
  let firstOne = -1;
  for (const t of terms) {
    const at = folded.indexOf(t);
    if (at >= 0 && (firstOne < 0 || at < firstOne)) firstOne = at;
  }
  if (firstOne > 40) start = Math.max(0, firstOne - 40);

  let clip = text.slice(start, start + SNIPPET_LEN);
  if (start > 0) clip = `…${clip}`;
  if (start + SNIPPET_LEN < text.length) clip = `${clip}…`;

  const base = fold(clip);
  const rawSpans: [number, number][] = [];
  for (const t of terms) {
    let at = base.indexOf(t);
    let fuse = 0;
    while (at >= 0 && fuse < 20) {
      rawSpans.push([at, at + t.length]);
      at = base.indexOf(t, at + 1);
      fuse += 1;
    }
  }
  rawSpans.sort((a, b) => a[0] - b[0]);
  const hits: [number, number][] = [];
  for (const [s, e] of rawSpans) {
    const last = hits[hits.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else hits.push([s, e]);
  }
  return { text: clip, hits };
}

/** `- [ ]` / `- [x]` checkboxes in the body — the list's progress chip. */
export function taskProgress(body: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const m of body.matchAll(/^[ \t]*[-*+]\s+\[([ xX])\]/gm)) {
    total += 1;
    if (m[1] !== " ") done += 1;
  }
  return { done, total };
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]; // i18n-ok
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; // i18n-ok

/**
 * "agora" · "há 12 min" · "há 3 h" · "ontem" · "há 5 dias" · "12/mai" · "3/fev/25".
 * In English the date reads the other way round ("May 12", "Feb 3, 25").
 */
export function whenLabel(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return t("agora");
  if (delta < 3_600_000) return t("há {n} min", { n: Math.floor(delta / 60_000) });
  if (delta < 86_400_000 && new Date(ts).getDate() === new Date(now).getDate()) {
    return t("há {n} h", { n: Math.floor(delta / 3_600_000) });
  }
  const d = new Date(ts);
  const n = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear()) {
    return t("ontem");
  }
  if (delta < 7 * 86_400_000) return t("há {n} dias", { n: Math.round(delta / 86_400_000) });
  const sameYear = d.getFullYear() === n.getFullYear();
  if (activeLang() === "en") {
    const md = `${MONTHS_EN[d.getMonth()]} ${d.getDate()}`;
    return sameYear ? md : `${md}, ${String(d.getFullYear()).slice(2)}`;
  }
  if (sameYear) return `${d.getDate()}/${MONTHS[d.getMonth()]}`;
  return `${d.getDate()}/${MONTHS[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`;
}

/** First readable line of the body — the fallback name of an untitled note. */
export function fallbackTitle(body: string): string {
  for (const raw of body.split("\n")) {
    const s = stripMd(raw);
    if (s) return s.slice(0, 80);
  }
  return t("Sem título");
}
