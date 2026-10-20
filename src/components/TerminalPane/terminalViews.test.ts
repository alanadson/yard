/** Stopped tabs must not allocate terminal buffers for history nobody has opened. */
import { describe, expect, it } from "vitest";
import { retainedTerminalViews } from "./terminalViews";

describe("retainedTerminalViews", () => {
  // Regression: restoring twelve stopped tabs replayed every history into RAM.
  it("loads only the selected stopped tab instead of every saved history", () => {
    const tabs = ["one", "two", "three"].map((id) => ({ id, alive: false }));
    expect(retainedTerminalViews([], tabs, "one")).toEqual(["one"]);
  });

  it("keeps every live or auto-starting terminal mounted even behind another tab", () => {
    const tabs = [
      { id: "history", alive: false },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `running-${index}`, alive: true })),
    ];
    expect(retainedTerminalViews([], tabs, "history")).toEqual(tabs.map((tab) => tab.id));
  });

  it("evicts the oldest stopped view when a third history is selected", () => {
    const tabs = ["one", "two", "three"].map((id) => ({ id, alive: false }));
    expect(retainedTerminalViews(["two", "one"], tabs, "three")).toEqual(["three", "two"]);
  });

  it("does not publish another retention update when the mounted tabs are unchanged", () => {
    const tabs = [{ id: "one", alive: false }];
    const previous = ["one"];
    expect(retainedTerminalViews(previous, tabs, "one")).toBe(previous);
  });

  it("forgets closed tabs instead of keeping their histories in the pane cache", () => {
    expect(retainedTerminalViews(["closed", "one"], [{ id: "one", alive: false }], "one")).toEqual(["one"]);
  });

  it("keeps live terminals attached while a document covers the pane", () => {
    const tabs = [{ id: "one", alive: false }, { id: "live", alive: true }];
    expect(retainedTerminalViews(["one", "live"], tabs, null)).toEqual(["one", "live"]);
  });

  it("evicts excess formerly live views when their processes stop", () => {
    const tabs = ["one", "two", "three", "four"].map((id) => ({ id, alive: false }));
    expect(retainedTerminalViews(tabs.map((tab) => tab.id), tabs, "four")).toEqual(["four", "one"]);
  });
});
