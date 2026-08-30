/**
 * Pinned tabs and the preview tab.
 *
 * Browsing a tree of four thousand files used to cost one tab per file
 * looked at, and the file you were actually working on drifted off the left
 * edge of the bar. Two rules fix that, and they are opposites of each other:
 * a **preview** tab is the one the next glance replaces, and a **pinned** tab
 * is the one nothing replaces or closes by accident.
 *
 * They meet in the "close the others" commands, which is where the damage
 * would be: a pin that does not survive "fechar as outras" is not a pin.
 */
import { describe, expect, it } from "vitest";

import {
  closesWith,
  orderTabs,
  previewToReplace,
  type TabInfo,
} from "./tabRules";

const tab = (over: Partial<TabInfo> & { id: string }): TabInfo => ({
  groupId: "g1",
  slot: 0,
  pinned: false,
  preview: false,
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

describe("previewToReplace", () => {
  it("finds the preview tab of the pane a new file would land in", () => {
    const docs = [
      tab({ id: "a" }),
      tab({ id: "b", preview: true }),
      tab({ id: "c", slot: 1, preview: true }),
    ];

    expect(previewToReplace(docs, "g1", 0)).toBe("b");
  });

  it("has nothing to replace when the pane holds no preview", () => {
    expect(previewToReplace([tab({ id: "a" })], "g1", 0)).toBeNull();
  });

  it("never replaces a preview that has unsaved text in it", () => {
    // The tab is still a preview, but it is holding work now, and the whole
    // gesture is meant to be free.
    const docs = [tab({ id: "b", preview: true, dirty: true })];

    expect(previewToReplace(docs, "g1", 0)).toBeNull();
  });

  it("never replaces a pinned tab, whatever else it is", () => {
    const docs = [tab({ id: "b", preview: true, pinned: true })];

    expect(previewToReplace(docs, "g1", 0)).toBeNull();
  });

  it("looks only at the pane the file is opening into", () => {
    const docs = [tab({ id: "c", slot: 1, preview: true })];

    expect(previewToReplace(docs, "g1", 0)).toBeNull();
  });
});
