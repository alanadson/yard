/**
 * Whether a terminal is on screen decides whether the user gets a
 * notification for it. Before the surfaces were split there was one rule for
 * the whole group — "on the canvas every card is on the board" — and it is
 * now wrong in both directions: a card is behind the panes while the group is
 * showing the grid, and a tab is behind the board while it is showing the
 * canvas. Notifying for what is right in front is noise; staying quiet about
 * what is hidden loses the message.
 */
import { describe, expect, it } from "vitest";

import { isFrontOnScreen } from "./frontTab";

const card = { id: "c1", slot: 0, surface: "canvas" as const };
const tab = { id: "t1", slot: 0, surface: "grid" as const };
const other = { id: "t2", slot: 0, surface: "grid" as const };

describe("isFrontOnScreen", () => {
  it("a card is in front while the group is showing the canvas", () => {
    expect(
      isFrontOnScreen({ surface: "canvas", activeBySlot: {} }, card, []),
    ).toBe(true);
  });

  it("a card is out of view while the group is showing the panes", () => {
    expect(isFrontOnScreen({ surface: "grid", activeBySlot: {} }, card, [])).toBe(
      false,
    );
  });

  it("a tab is out of view while the group is showing the canvas", () => {
    expect(
      isFrontOnScreen({ surface: "canvas", activeBySlot: { 0: "t1" } }, tab, [tab]),
    ).toBe(false);
  });

  it("on the grid, only the tab in front of its pane counts", () => {
    const layout = { surface: "grid" as const, activeBySlot: { 0: "t2" } };
    expect(isFrontOnScreen(layout, tab, [tab, other])).toBe(false);
    expect(isFrontOnScreen(layout, other, [tab, other])).toBe(true);
  });

  it("with no tab pinned, the pane shows its first — and that is the one in front", () => {
    const layout = { surface: "grid" as const, activeBySlot: {} };
    expect(isFrontOnScreen(layout, tab, [tab, other])).toBe(true);
    expect(isFrontOnScreen(layout, other, [tab, other])).toBe(false);
  });

  /** A tab pinned in `activeBySlot` that has already been closed decides nothing. */
  it("a pinned tab that no longer exists gives way to the pane's first", () => {
    const layout = { surface: "grid" as const, activeBySlot: { 0: "fechada" } };
    expect(isFrontOnScreen(layout, tab, [tab, other])).toBe(true);
  });
});
