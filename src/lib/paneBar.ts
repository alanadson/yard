/**
 * The order of one pane's tab bar.
 *
 * `TerminalPane` paints one bar out of four kinds of tab — the CLIs, the open
 * files, the browsers, the notebook — and the keyboard (Ctrl+Tab, Ctrl+1..9)
 * has to walk exactly what is on screen. Keeping that in one function is the
 * point: two lists that are supposed to agree and are built in two places do
 * not stay in agreement.
 *
 * The bar takes a drop anywhere, so the kinds are no longer sections: a CLI
 * can sit between two files. That order cannot come from the stores — each
 * holds one kind and none of them can see the other two — so it is saved with
 * the group's layout as a plain list of ids (`GroupLayout.tabOrder`), and this
 * module is what turns that list back into a bar:
 *
 * - an id the list names and the pane holds keeps the place the list gives it;
 * - a tab the list never heard of (just opened) goes to the end, after
 *   everything the user arranged, in the default order of the kinds;
 * - an id the list names and the pane no longer holds is ignored, which is
 *   what lets a closed tab leave nothing behind to clean up;
 * - the pinned tabs come first, always. That is the one rule the manual order
 *   cannot bend: a pin means "at the front of the bar", and with the sections
 *   gone there is no smaller front left for it to mean.
 */
import { orderTabs, type TabPlace } from "./tabRules";

/** The four kinds of tab a bar paints. Same words as `data-tab-kind`. */
export type TabKind = "terminal" | "doc" | "browser" | "notes";

/** One tab of a bar, and which store it came from. */
export interface TabRef {
  id: string;
  kind: TabKind;
  pinned: boolean;
}

export interface BarInput {
  groupId: string;
  slot: number;
  /** The group's CLIs on the grid — a board's cards are not tabs. */
  terminals: readonly TabPlace[];
  docs: readonly TabPlace[];
  browsers: readonly TabPlace[];
  /**
   * The notebook's tab id when it is docked in this very pane, `null`
   * otherwise. An id rather than a flag so this module never has to import
   * the notes store to know what the tab is called.
   */
  notesId: string | null;
  /** What the user arranged by hand: ids in bar order. */
  order?: readonly string[];
}

/**
 * Pinned first, order preserved inside each half. Every answer this module
 * gives goes through it, so what is saved is what will be painted.
 */
function pinFirst(tabs: readonly TabRef[]): TabRef[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/** Every tab of one pane, in the order its bar paints them. */
export function barOrder(bar: BarInput): TabRef[] {
  const here = (t: TabPlace) => t.groupId === bar.groupId && t.slot === bar.slot;
  const section = (rows: readonly TabPlace[], kind: TabKind): TabRef[] =>
    orderTabs(rows.filter(here)).map((t) => ({
      id: t.id,
      kind,
      pinned: t.pinned === true,
    }));
  const fallback: TabRef[] = [
    ...section(bar.terminals, "terminal"),
    ...section(bar.docs, "doc"),
    ...section(bar.browsers, "browser"),
    ...(bar.notesId
      ? [{ id: bar.notesId, kind: "notes" as const, pinned: false }]
      : []),
  ];
  const manual = bar.order ?? [];
  const rank = new Map(manual.map((id, i) => [id, i]));
  // The fallback position is the tie-break *and* the answer for a tab nobody
  // placed — pushed past the whole manual list so a new tab lands at the end.
  const seq = fallback.map((tab, i) => ({
    tab,
    at: rank.get(tab.id) ?? manual.length + i,
  }));
  seq.sort((a, b) => a.at - b.at);
  return pinFirst(seq.map((s) => s.tab));
}

/**
 * The bar as it will look once `moved` is let go in front of `beforeId` — or
 * at the end of the bar, when the drop landed on nothing. `moved` may already
 * be in `bar` (a reorder inside one pane) or not (it came from another).
 */
export function placeInBar(
  bar: readonly TabRef[],
  moved: TabRef,
  beforeId: string | null,
): TabRef[] {
  const rest = bar.filter((t) => t.id !== moved.id);
  const i = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
  const next = i < 0 ? [...rest, moved] : [...rest.slice(0, i), moved, ...rest.slice(i)];
  return pinFirst(next);
}

/**
 * Where a tab lands after walking one place toward `dir` in its own bar.
 *
 * The answer speaks the language every move already takes: a `beforeId` to be
 * put in front of, or `null` for the end of the bar. `null` as the whole
 * answer means the tab is not going anywhere, which is what the menu greys
 * out — the ends of the bar are walls, and so is the line between the pinned
 * half and the loose one (a step across it would be undone by the next
 * render, and a command that pretends to work is worse than one that says no).
 */
export function stepInBar(
  bar: readonly TabRef[],
  id: string,
  dir: -1 | 1,
): { beforeId: string | null } | null {
  const at = bar.findIndex((t) => t.id === id);
  if (at < 0) return null;
  const neighbor = bar[at + dir];
  if (!neighbor || neighbor.pinned !== bar[at].pinned) return null;
  // Leftward the tab takes the neighbour's place; rightward it has to clear
  // the neighbour first, which means landing in front of whatever came after
  // it, and nothing there is the end of the bar.
  return { beforeId: dir === -1 ? neighbor.id : (bar[at + 2]?.id ?? null) };
}

/** One list of ids per pane of the group, keyed by slot. */
export type TabOrder = Record<number, string[]>;

/**
 * What comes back from the layout JSON, filtered down to what a bar can use.
 *
 * The field is written by hand-arranged bars only, so most groups never have
 * it: `undefined` — not an empty object — is the answer for a group with
 * nothing to say, which is what keeps the field out of their JSON.
 */
export function normalizeTabOrder(raw: unknown): TabOrder | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: TabOrder = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || slot < 0 || !Array.isArray(value)) continue;
    const ids = value.filter((id): id is string => typeof id === "string" && !!id);
    if (ids.length > 0) out[slot] = ids;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
