/**
 * Pinned tabs, and what a close command takes.
 *
 * Opening a file never takes another tab's place, so the only tab rule left
 * is the pin: a tab kept at the front of its own bar that nothing closes by
 * accident. It meets the "close the others" commands, which is where the
 * damage would be: a pin that does not survive "fechar as outras" is not a
 * pin.
 */
import { describe, expect, it } from "vitest";

import { closesWith, moveOnePlace, orderTabs, type TabInfo } from "./tabRules";

const tab = (over: Partial<TabInfo> & { id: string }): TabInfo => ({
  groupId: "g1",
  slot: 0,
  pinned: false,
  dirty: false,
  ...over,
});

describe("orderTabs", () => {
  it("puts the pinned tabs first, keeping the order inside each half", () => {
    const docs = [
      tab({ id: "a" }),
      tab({ id: "b", pinned: true }),
      tab({ id: "c" }),
      tab({ id: "d", pinned: true }),
    ];

    expect(orderTabs(docs).map((t) => t.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("orders each pane on its own", () => {
    // The bar is per pane; a pin in pane 1 must not jump a tab in pane 0.
    const docs = [
      tab({ id: "a", slot: 0 }),
      tab({ id: "b", slot: 1, pinned: true }),
      tab({ id: "c", slot: 0, pinned: true }),
    ];

    expect(orderTabs(docs).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("leaves a bar with no pins exactly as it was", () => {
    const docs = [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })];

    expect(orderTabs(docs).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("closesWith", () => {
  const bar = [
    tab({ id: "a" }),
    tab({ id: "b", pinned: true }),
    tab({ id: "c" }),
    tab({ id: "d", dirty: true }),
    tab({ id: "e" }),
  ];

  it("closes everything but the target, and never a pinned tab", () => {
    // A pin that does not survive this command is not a pin.
    expect(closesWith(bar, "c", "others")).toEqual(["a", "d", "e"]);
  });

  it("closes what is to the right of the target, pins excepted", () => {
    expect(closesWith(bar, "a", "right")).toEqual(["c", "d", "e"]);
  });

  it("has nothing to the right of the last tab", () => {
    expect(closesWith(bar, "e", "right")).toEqual([]);
  });

  it("closes the tabs with nothing unsaved in them", () => {
    // The one command whose whole point is to leave your work alone.
    expect(closesWith(bar, "a", "saved")).toEqual(["a", "c", "e"]);
  });

  it("stays inside the pane the target lives in", () => {
    const two = [
      tab({ id: "a", slot: 0 }),
      tab({ id: "b", slot: 1 }),
      tab({ id: "c", slot: 0 }),
    ];

    expect(closesWith(two, "a", "others")).toEqual(["c"]);
  });

  it("has nothing to do for a tab that is not there", () => {
    expect(closesWith(bar, "nope", "others")).toEqual([]);
  });
});

/**
 * "Mover para a esquerda/direita": the tab walks one place in its own bar,
 * by menu or by Ctrl+Shift+arrow, instead of only by dragging.
 *
 * The answer is a `beforeId` because that is what every store's move takes
 * (`moveTerminal`, `moveDoc`, `browsers.move`): the tab is pulled out of the
 * list and put back in front of that one, or at the end when it is `null`.
 * `null` as the whole answer means the tab cannot go that way.
 */
describe("moveOnePlace", () => {
  it("moving left lands the tab in front of the neighbour it passed", () => {
    const tabs = [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })];

    expect(moveOnePlace(tabs, "b", -1)).toEqual({ beforeId: "a" });
  });

  it("moving right lands the tab in front of the one after the neighbour", () => {
    const tabs = [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })];

    expect(moveOnePlace(tabs, "a", 1)).toEqual({ beforeId: "c" });
  });

  it("moving right from the second-to-last means the end of the bar", () => {
    const tabs = [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })];

    expect(moveOnePlace(tabs, "b", 1)).toEqual({ beforeId: null });
  });

  it("the tab at either end of the bar has nowhere to go", () => {
    const tabs = [tab({ id: "a" }), tab({ id: "b" })];

    expect(moveOnePlace(tabs, "a", -1)).toBeNull();
    expect(moveOnePlace(tabs, "b", 1)).toBeNull();
  });

  /**
   * The whole point of a pin is a front half that stays the front half. A
   * pinned tab that could walk backwards into the loose ones would be undone
   * by `orderTabs` on the next render, so the command has to refuse instead
   * of pretending to work.
   */
  it("a pinned tab does not trade places with a loose one, in either direction", () => {
    const tabs = [
      tab({ id: "p1", pinned: true }),
      tab({ id: "p2", pinned: true }),
      tab({ id: "a" }),
      tab({ id: "b" }),
    ];

    expect(moveOnePlace(tabs, "p2", 1)).toBeNull();
    expect(moveOnePlace(tabs, "a", -1)).toBeNull();
    // Inside each half it still walks.
    expect(moveOnePlace(tabs, "p2", -1)).toEqual({ beforeId: "p1" });
    expect(moveOnePlace(tabs, "a", 1)).toEqual({ beforeId: null });
  });

  it("reads the bar the way it is painted, not the way the store stored it", () => {
    // The store's list is not sorted; `orderTabs` is what the bar shows, and
    // the move has to agree with the bar or the tab jumps somewhere else.
    const tabs = [tab({ id: "a" }), tab({ id: "p", pinned: true }), tab({ id: "b" })];

    expect(moveOnePlace(tabs, "b", -1)).toEqual({ beforeId: "a" });
  });

  it("only the tabs of the same pane count", () => {
    const tabs = [
      tab({ id: "other", slot: 1 }),
      tab({ id: "a", slot: 0 }),
      tab({ id: "b", slot: 0 }),
    ];

    expect(moveOnePlace(tabs, "a", -1)).toBeNull();
    expect(moveOnePlace(tabs, "b", -1)).toEqual({ beforeId: "a" });
  });

  it("a tab nobody knows moves nowhere", () => {
    expect(moveOnePlace([tab({ id: "a" })], "ghost", 1)).toBeNull();
  });
});
