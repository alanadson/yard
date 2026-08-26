/**
 * The first-run sheet has exactly one chance to be right: shown to a fresh
 * install and never again, and never to someone who already has projects
 * (an upgrade from a build that had no onboarding must not be greeted like a
 * newcomer). The decision is pure so the boot hook only has to wire it.
 */
import { describe, expect, it } from "vitest";

import { FIRST_RUN_SHORTCUTS, agentRows, firstRunDecision, needsOnboarding } from "./onboarding";

describe("firstRunDecision", () => {
  it("shows the sheet to a fresh install — no key in kv and no project", () => {
    expect(firstRunDecision({ done: undefined, projects: 0 })).toBe("show");
    expect(needsOnboarding({ done: undefined, projects: 0 })).toBe(true);
  });

  it("adopts silently an install that already has projects — an upgrade is not a first run", () => {
    expect(firstRunDecision({ done: undefined, projects: 2 })).toBe("adopt");
    expect(needsOnboarding({ done: undefined, projects: 2 })).toBe(false);
  });

  it("never shows again once the key is written, even with zero projects", () => {
    expect(firstRunDecision({ done: "1", projects: 0 })).toBe("done");
    expect(needsOnboarding({ done: "1", projects: 0 })).toBe(false);
  });
});

describe("agentRows", () => {
  const catalog = [
    { id: "gemini", name: "Gemini CLI", installed: false, version: null },
    { id: "codex", name: "Codex CLI", installed: true, version: "0.42.0" },
    { id: "claude", name: "Claude Code", installed: true, version: "2.1.0" },
  ];

  it("lists the installed CLIs first, by name, and the missing ones after", () => {
    expect(agentRows(catalog).map((r) => r.id)).toEqual(["claude", "codex", "gemini"]);
  });

  it("carries the version of what was found and marks what was not", () => {
    const rows = agentRows(catalog);
    expect(rows[0]).toEqual({ id: "claude", name: "Claude Code", found: true, version: "2.1.0" });
    expect(rows[2]).toEqual({ id: "gemini", name: "Gemini CLI", found: false, version: null });
  });
});

describe("FIRST_RUN_SHORTCUTS", () => {
  it("teaches the six gestures that matter, each spelled as keys plus a sentence", () => {
    expect(FIRST_RUN_SHORTCUTS).toHaveLength(6);
    for (const [keys, description] of FIRST_RUN_SHORTCUTS) {
      expect(keys.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(5);
    }
    expect(FIRST_RUN_SHORTCUTS.map(([keys]) => keys.join("+"))).toEqual([
      "Ctrl+T",
      "Ctrl+P",
      "Ctrl+Enter",
      "Ctrl+Shift+A",
      "Ctrl+Shift+B",
      "Ctrl+Shift+N",
    ]);
  });
});
