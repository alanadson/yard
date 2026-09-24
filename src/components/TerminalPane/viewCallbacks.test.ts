/**
 * The callbacks a pane hands each of its terminals are made once per id, and
 * still act on the pane as it is when they fire.
 *
 * `XTermView` is memoized, and an arrow written inline in the pane's JSX is a
 * new prop on every render: each tick of the active tab's memory re-rendered
 * every terminal of the pane, and the inline `ref` detached and re-attached
 * every handle. Made once, though, a callback remembers the render that made
 * it, and a tab menu opened for another slot, or a handle registered under the
 * wrong terminal, would be the price. These rules hold both halves: the same
 * objects every time, and the pane of the moment when they run.
 */
import { describe, expect, it } from "vitest";

import type { XTermHandle } from "../XTermView";
import { paneViewCallbacks, type PaneNow } from "./viewCallbacks";

function setup() {
  const log: unknown[][] = [];
  const now: { current: PaneNow } = {
    current: {
      groupId: "g1",
      slot: 0,
      setActiveTab: (groupId, slot, id) => log.push(["setActiveTab", groupId, slot, id]),
      focusTerminal: (id, slot) => log.push(["focusTerminal", id, slot]),
      setTabMenu: (menu) => log.push(["setTabMenu", menu]),
    },
  };
  const handles: { current: Record<string, XTermHandle | null> } = { current: {} };
  return { log, now, handles, callbacks: paneViewCallbacks(now, handles) };
}

const click = (x: number, y: number) => ({ clientX: x, clientY: y }) as MouseEvent;

describe("paneViewCallbacks", () => {
  it("hands back the very same callbacks for the same terminal", () => {
    const { callbacks } = setup();
    const first = callbacks.of("t1");
    expect(callbacks.of("t1")).toBe(first);
    expect(callbacks.of("t1").onFocus).toBe(first.onFocus);
  });

  it("gives each terminal callbacks of its own", () => {
    const { callbacks, log } = setup();
    expect(callbacks.of("t2")).not.toBe(callbacks.of("t1"));
    callbacks.of("t2").onFocus();
    expect(log).toEqual([["focusTerminal", "t2", 0]]);
  });

  it("keeps the handle the terminal exposes under its id, and forgets it on detach", () => {
    const { callbacks, handles } = setup();
    const handle = { focus: () => {} } as unknown as XTermHandle;
    callbacks.of("t1").ref(handle);
    expect(handles.current.t1).toBe(handle);
    callbacks.of("t1").ref(null);
    expect(handles.current.t1).toBeNull();
  });

  it("focuses the terminal in the slot the pane has when the focus happens", () => {
    const { callbacks, now, log } = setup();
    const onFocus = callbacks.of("t1").onFocus;
    now.current = { ...now.current, slot: 3 };
    onFocus();
    expect(log).toEqual([["focusTerminal", "t1", 3]]);
  });

  it("on a right click selects the tab, focuses it and opens its menu at the pointer, in that order", () => {
    const { callbacks, now, log } = setup();
    const onContextMenu = callbacks.of("t1").onContextMenu;
    now.current = { ...now.current, groupId: "g2", slot: 1 };
    onContextMenu(click(40, 12));
    expect(log).toEqual([
      ["setActiveTab", "g2", 1, "t1"],
      ["focusTerminal", "t1", 1],
      ["setTabMenu", { id: "t1", anchor: { x: 40, y: 12 } }],
    ]);
  });

  it("lets go of the callbacks of terminals that left the pane", () => {
    const { callbacks } = setup();
    const kept = callbacks.of("t1");
    const gone = callbacks.of("t2");
    callbacks.retain(["t1"]);
    expect(callbacks.of("t1")).toBe(kept);
    expect(callbacks.of("t2")).not.toBe(gone);
  });
});
