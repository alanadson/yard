/**
 * Name dedup and lookup — the address `yard ask "Nome"` accepts.
 *
 * These used to be three copies (terminals, notes, portals); the point of the
 * shared version is that the numbering and the case rules can no longer
 * differ between them.
 */
import { describe, expect, it } from "vitest";

import { byName, uniqueLabels } from "./names";

const item = (id: string, name: string) => ({ id, name });

describe("uniqueLabels", () => {
  it("leaves a unique name alone", () => {
    const m = uniqueLabels([item("1", "claude")], (i) => i.name);
    expect(m.get("1")).toBe("claude");
  });

  it("numbers duplicates from the second one, in list order", () => {
    const m = uniqueLabels(
      [item("1", "claude"), item("2", "claude"), item("3", "claude")],
      (i) => i.name,
    );
    expect([...m.values()]).toEqual(["claude", "claude (2)", "claude (3)"]);
  });

  it("collides case-insensitively but keeps the original casing", () => {
    const m = uniqueLabels([item("1", "Claude"), item("2", "claude")], (i) => i.name);
    expect(m.get("1")).toBe("Claude");
    expect(m.get("2")).toBe("claude (2)");
  });

  it("handles an empty list", () => {
    expect(uniqueLabels([], (i: { id: string }) => i.id).size).toBe(0);
  });
});

describe("byName", () => {
  const list = [item("1", "claude"), item("2", "codex")];
  const labels = uniqueLabels(list, (i) => i.name);

  it("matches ignoring case and surrounding spaces", () => {
    expect(byName(list, labels, "  CLAUDE ")?.id).toBe("1");
  });

  it("returns null when nothing matches", () => {
    expect(byName(list, labels, "gemini")).toBeNull();
  });

  it("matches the suffixed label, not the base name", () => {
    const dupes = [item("1", "claude"), item("2", "claude")];
    const m = uniqueLabels(dupes, (i) => i.name);
    expect(byName(dupes, m, "claude (2)")?.id).toBe("2");
    expect(byName(dupes, m, "claude")?.id).toBe("1");
  });
});
