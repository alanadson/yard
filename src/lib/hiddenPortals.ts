/**
 * Hidden portal engines, oldest first, and the cap on how many stay alive.
 *
 * A card that leaves the screen only hides its WebView2 (so a page being
 * watched survives a group switch); a long session collected dozens of
 * hidden renderers. The four hidden most recently are kept; the one hidden
 * the longest beyond that is closed. Nothing is lost with it: the card keeps
 * the address and the profile folder stays on disk, so the next mount
 * (`usePortalSurface`) or the next `yard portal` command re-opens the page
 * with the same logins. Only the page's in-memory state (scroll, a half
 * filled form) goes.
 */
import { ipc } from "./ipc";

export const KEEP_HIDDEN_PORTALS = 4;

export interface HiddenPortals {
  /** The engine was hidden: it joins the back of the line. */
  hidden(id: string): void;
  /** The engine is on screen (or opening) again: it leaves the line. */
  shown(id: string): void;
}

export function createHiddenPortals(close: (id: string) => void, keep = KEEP_HIDDEN_PORTALS): HiddenPortals {
  const line: string[] = [];
  const leave = (id: string) => {
    const at = line.indexOf(id);
    if (at >= 0) line.splice(at, 1);
  };
  return {
    hidden(id) {
      leave(id);
      line.push(id);
      while (line.length > keep) close(line.shift()!);
    },
    shown: leave,
  };
}

/** The app's line: closing goes through the backend registry. */
export const hiddenPortals = createHiddenPortals((id) => {
  void ipc.portalClose(id).catch(() => {});
});
