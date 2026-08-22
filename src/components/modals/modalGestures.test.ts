/**
 * The two rules that separate a dialog from a floating div: what each exit
 * does with a filled-in form, and where Tab goes.
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

import { focusAfterTab, exitGesture } from "./modalGestures";

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
