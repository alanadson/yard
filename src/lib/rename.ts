/**
 * Renaming a card from its header, whatever kind of card it is.
 *
 * Each type spells its name differently (a note and a portal pin one over a
 * derived name, a file card over the file's own, a flow and a group *are*
 * their name), and the menu, the F2 shortcut and the inline field all need
 * the same answer. One function, one set of ceilings, one test.
 */
import { BINDER_NAME_MAX } from "./binder";
import { FLOW_NAME_MAX, type CanvasData, type CanvasItem } from "./canvas";
import { GROUP_DEFAULT_NAME, GROUP_NAME_MAX } from "./canvasGroups";
import { DOC_NAME_MAX } from "./docNode";
import { t } from "./i18n";
import { MEDIA_NAME_MAX } from "./mediaNode";
import { TREE_NAME_MAX } from "./treeNode";

/** Longest pinned name of a note or a portal, the width of a header. */
const PINNED_NAME_MAX = 48;

/** Does this item carry a header a person can retitle? */
export function canRename(it: CanvasItem): boolean {
  switch (it.type) {
    case "note":
    case "portal":
    case "media":
    case "doc":
    case "tree":
    case "binder":
    case "flow":
    case "group":
      return true;
    default:
      return false;
  }
}

/**
 * Sets (or, with a blank, clears) the pinned name of an item that derives
 * one when it has none: clearing hands the header back to the first line,
 * the hostname or the file name instead of leaving it empty.
 */
function pinned<T extends { name?: string }>(it: T, name: string, max: number): T {
  if (!name) {
    if (!("name" in it)) return it;
    const { name: _old, ...rest } = it;
    return rest as T;
  }
  return { ...it, name: name.slice(0, max) };
}

function renamed(it: CanvasItem, raw: string): CanvasItem | null {
  const name = raw.trim();
  switch (it.type) {
    case "note":
    case "portal":
      return pinned(it, name, PINNED_NAME_MAX);
    case "media":
      return pinned(it, name, MEDIA_NAME_MAX);
    case "doc":
      return pinned(it, name, DOC_NAME_MAX);
    case "tree":
      return pinned(it, name, TREE_NAME_MAX);
    case "binder":
      return pinned(it, name, BINDER_NAME_MAX);
    case "flow":
      // A flow is addressed by name (`yard flow run "Nome"`): blank keeps the old one.
      return name ? { ...it, name: name.slice(0, FLOW_NAME_MAX) } : it;
    case "group":
      // A frame with no name is a bar with nothing on it: the default steps in.
      return { ...it, name: name.slice(0, GROUP_NAME_MAX) || t(GROUP_DEFAULT_NAME) };
    default:
      return null;
  }
}

/** The canvas with the item renamed; the same canvas when nothing changes. */
export function renameItem(c: CanvasData, id: string, name: string): CanvasData {
  const idx = c.items.findIndex((i) => i.id === id);
  if (idx < 0) return c;
  const next = renamed(c.items[idx], name);
  if (!next || next === c.items[idx]) return c;
  const items = c.items.slice();
  items[idx] = next;
  return { ...c, items };
}
