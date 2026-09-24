/**
 * The callbacks a pane hands each of its terminals: one set per terminal id,
 * the same objects from one render to the next.
 *
 * `XTermView` is memoized so that a parent re-rendering with the same props
 * leaves the terminal alone. Written inline in the pane's JSX, the `ref`, the
 * focus and the right click were new functions on every render (every tick
 * of the active tab's memory, every keystroke in the search box), so every
 * terminal of the pane re-rendered anyway and React detached and re-attached
 * each handle. Made here once per id, they read the pane when they fire, from
 * `now`, which the pane keeps pointed at its latest render: the same values
 * the inline arrows closed over.
 */
import type { MenuAnchor } from "../ContextMenu";
import type { XTermHandle } from "../XTermView";

/** What the callbacks read from the pane at the moment they run. */
export interface PaneNow {
  groupId: string;
  slot: number;
  setActiveTab: (groupId: string, slot: number, id: string) => void;
  focusTerminal: (id: string, slot: number) => void;
  setTabMenu: (menu: { id: string; anchor: MenuAnchor }) => void;
}

export interface TerminalViewCallbacks {
  ref: (handle: XTermHandle | null) => void;
  onFocus: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export interface PaneViewCallbacks {
  /** The callbacks of terminal `id`: made on the first ask, the same after. */
  of: (id: string) => TerminalViewCallbacks;
  /** Forgets every terminal not in `ids` (the ones that left the pane). */
  retain: (ids: readonly string[]) => void;
}

export function paneViewCallbacks(
  now: { readonly current: PaneNow },
  handles: { readonly current: Record<string, XTermHandle | null> },
): PaneViewCallbacks {
  const byId = new Map<string, TerminalViewCallbacks>();
  const make = (id: string): TerminalViewCallbacks => ({
    ref: (handle) => {
      handles.current[id] = handle;
    },
    onFocus: () => now.current.focusTerminal(id, now.current.slot),
    // Over the terminal itself the right click never becomes a React event
    // (it is stopped before xterm can act on it), so the panel's own handler
    // only covers the frame and this one covers the body.
    onContextMenu: (e) => {
      const { groupId, slot, setActiveTab, focusTerminal, setTabMenu } = now.current;
      setActiveTab(groupId, slot, id);
      focusTerminal(id, slot);
      setTabMenu({ id, anchor: { x: e.clientX, y: e.clientY } });
    },
  });
  return {
    of: (id) => {
      let callbacks = byId.get(id);
      if (!callbacks) {
        callbacks = make(id);
        byId.set(id, callbacks);
      }
      return callbacks;
    },
    retain: (ids) => {
      const live = new Set(ids);
      for (const id of [...byId.keys()]) if (!live.has(id)) byId.delete(id);
    },
  };
}
