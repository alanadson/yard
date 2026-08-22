/**
 * The menu that shows up when no surface claimed the click.
 *
 * Yard suppresses WebView2's native menu (the terminal needs that: the host's
 * "Paste" wrote straight into the PTY). The price is that any place without
 * a menu of its own went **mute** on right-click — no copy, no paste,
 * nothing. This module is the floor: given what is under the cursor, it says
 * which actions fit there.
 *
 * Only the decision lives here. Reading the DOM and executing is the
 * `GlobalMenu`'s job — which is what lets the whole rule be tested without a
 * browser.
 */

export interface MenuTarget {
  /** The click landed somewhere typing is possible (input, textarea, editor). */
  editable: boolean;
  /** A text surface that does not accept editing (viewer, preview, diff). */
  readOnly: boolean;
  /** The text selected at the moment of the click, as it came from the screen. */
  selection: string;
  /** Address of the link under the cursor, when there is one. */
  link: string | null;
  /** There is an open project — without it, "search the project" leads nowhere. */
  hasProject: boolean;
}

export type SystemMenuId =
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "copy-link"
  | "search-selection"
  | "palette"
  | "prefs";

export interface SystemMenuAction {
  id: SystemMenuId;
  /** Present and greyed out, never absent: an entry vanishing from the spot the hand memorised. */
  disabled?: boolean;
  /** The snippet that goes into the "Search «…»" label. */
  term?: string;
}

/** How much of the selected snippet fits in a label before it stretches the menu. */
const TERM_MAX = 24;

/** The selected snippet as a label: a single line, short enough to fit. */
export function menuTerm(selection: string): string {
  const one = selection.replace(/\s+/g, " ").trim();
  return one.length > TERM_MAX ? `${one.slice(0, TERM_MAX)}…` : one;
}

/**
 * The menu plan, in groups — the menu puts a separator between them.
 *
 * An empty group never leaves here: a separator with nothing around it is
 * clutter the user reads as "something is missing".
 */
export function systemMenuGroups(t: MenuTarget): SystemMenuAction[][] {
  const selected = t.selection.trim();
  const hasSelection = selected.length > 0;
  const groups: SystemMenuAction[][] = [];

  // The link is what is literally under the cursor: it comes first.
  if (t.link) groups.push([{ id: "copy-link" }]);

  const theText: SystemMenuAction[] = [];
  if (t.editable) {
    theText.push(
      { id: "cut", disabled: !hasSelection },
      { id: "copy", disabled: !hasSelection },
      { id: "paste" },
      { id: "select-all" },
    );
  } else if (hasSelection || t.readOnly) {
    // With no field to write in, what is left is what one does with someone
    // else's text: take it away. "Paste" here would be an entry that never works.
    theText.push({ id: "copy", disabled: !hasSelection });
  }
  if (hasSelection && t.hasProject) {
    theText.push({ id: "search-selection", term: menuTerm(selected) });
  }
  if (theText.length > 0) groups.push(theText);

  // The usual footer — it is what guarantees the menu never comes out empty.
  groups.push([{ id: "palette" }, { id: "prefs" }]);
  return groups;
}
