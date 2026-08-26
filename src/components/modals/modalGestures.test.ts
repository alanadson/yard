/**
 * The rules that separate a dialog from a floating div: what each exit does
 * with a filled-in form, where Tab goes, and which press on the backdrop
 * counts as leaving.
 *
 * They were written inside the component, and that is why they diverged:
 *
 * - the backdrop click and Esc protected the filled form (flash, warn), and
 *   the header's × — which is one pixel away — discarded everything
 *   outright;
 * - Tab was only intercepted when focus was on the first or the last
 *   focusable. After clicking any text inside the dialog, focus goes to the
 *   `body`, neither condition matched, and the next Tab left the dialog for
 *   the title bar, behind the backdrop.
 */
import { describe, expect, it } from "vitest";

import { backdropPressExits, focusAfterTab, exitGesture } from "./modalGestures";

describe("exitGesture", () => {
  it("with the form empty, any exit closes", () => {
    expect(exitGesture({ dirty: false, warned: false })).toBe("close");
    expect(exitGesture({ dirty: false, warned: true })).toBe("close");
  });

  it("with something filled in, the first attempt warns", () => {
    expect(exitGesture({ dirty: true, warned: false })).toBe("warn");
  });

  it("warned once, the second attempt discards", () => {
    expect(exitGesture({ dirty: true, warned: true })).toBe("close");
  });
});

describe("focusAfterTab", () => {
  const items = ["a", "b", "c"];

  it("from the last goes back to the first, and from the first (with Shift) to the last", () => {
    expect(focusAfterTab(items, "c", false)).toBe("a");
    expect(focusAfterTab(items, "a", true)).toBe("c");
  });

  it("in the middle, lets the browser move on its own", () => {
    expect(focusAfterTab(items, "b", false)).toBeNull();
    expect(focusAfterTab(items, "b", true)).toBeNull();
  });

  /** The hole: focus on the `body` after clicking some text in the dialog. */
  it("with focus outside the list, brings it back inside", () => {
    expect(focusAfterTab(items, null, false)).toBe("a");
    expect(focusAfterTab(items, null, true)).toBe("c");
    expect(focusAfterTab(items, "outro-elemento", false)).toBe("a");
  });

  it("a dialog with nothing focusable traps nobody", () => {
    expect(focusAfterTab([], null, false)).toBeNull();
  });
});

/**
 * Two dialogs read the backdrop press — the frame in `Modal` and the
 * Settings window, which has a sidebar where `Modal` has a header — so the
 * rule lives in one place, or the day the Settings sheet closed under a
 * right-click would come.
 */
describe("backdropPressExits", () => {
  it("the primary button on the backdrop is an exit", () => {
    expect(backdropPressExits(0)).toBe(true);
  });

  it("the right button is not — that gesture is \"open the menu\", and closing the dialog from under it would be the wrong answer", () => {
    expect(backdropPressExits(2)).toBe(false);
  });

  it("nor the middle one", () => {
    expect(backdropPressExits(1)).toBe(false);
  });
});
