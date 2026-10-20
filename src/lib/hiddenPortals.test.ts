/**
 * A portal card that leaves the screen (another group, the grid, a closed
 * pane tab) only hides its WebView2, so a page being watched survives a
 * round trip. Every hidden engine still costs a browser renderer, and a long
 * session collected dozens. The four hidden most recently stay alive; past
 * that the one hidden the longest is closed. Its card keeps the address and
 * its profile folder stays on disk, so showing it again re-opens the page
 * with the same logins.
 */
import { describe, expect, it } from "vitest";

import { createHiddenPortals, KEEP_HIDDEN_PORTALS } from "./hiddenPortals";

function line() {
  const closed: string[] = [];
  return { closed, portals: createHiddenPortals((id) => closed.push(id)) };
}

describe("createHiddenPortals", () => {
  it("keeps the engines of the four portals hidden most recently", () => {
    const { closed, portals } = line();
    for (const id of ["a", "b", "c", "d"]) portals.hidden(id);
    expect(KEEP_HIDDEN_PORTALS).toBe(4);
    expect(closed).toEqual([]);
  });

  it("closes the engine hidden the longest when a fifth portal is hidden", () => {
    const { closed, portals } = line();
    for (const id of ["a", "b", "c", "d", "e"]) portals.hidden(id);
    expect(closed).toEqual(["a"]);
  });

  it("a portal back on screen leaves the line, and hiding it again puts it at the back", () => {
    const { closed, portals } = line();
    for (const id of ["a", "b", "c", "d"]) portals.hidden(id);
    portals.shown("a");
    portals.hidden("e");
    expect(closed).toEqual([]);
    portals.hidden("a");
    expect(closed).toEqual(["b"]);
  });

  it("forgets a closed engine, so it is not closed twice", () => {
    const { closed, portals } = line();
    for (const id of ["a", "b", "c", "d", "e", "f"]) portals.hidden(id);
    portals.shown("a");
    portals.hidden("g");
    expect(closed).toEqual(["a", "b", "c"]);
  });
});
