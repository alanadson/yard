/**
 * The tables that stay in Portuguese in the code and are translated where
 * they are rendered (`t(row.label)`): shortcuts, the extension catalog, the
 * cache choices, the first-run shortcuts, the UA picker… Their sentences are
 * never inside a `t("…")` literal, so nothing else notices when one of them
 * has no English line — the English interface would show Portuguese in the
 * middle of a settings card. This test walks every such table and asks the
 * merged dictionary for each sentence.
 */
import { describe, expect, it } from "vitest";

import EN from "./index";
import { cacheChoicesOf, cacheNoteOf } from "../../lib/agentDefaults";
import { RANGE_LABELS } from "../../lib/costs";
import { ICON_THEMES } from "../../lib/iconTheme";
import { FLOW_PRESETS } from "../../lib/flow";
import { STATUS_META } from "../../lib/notes";
import { FIRST_RUN_SHORTCUTS } from "../../lib/onboarding";
import { UA_CHOICES } from "../../lib/portals";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";
import { skipFlagOf } from "../../lib/termArgs";
import { TREE_MODE_LABEL } from "../../lib/treeNode";
import { TRIGGER_EVENT_OPTIONS } from "../../lib/triggers";

const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "grok",
  "cursor-agent",
  "aider",
  "goose",
  "gh-copilot",
];

/** Key tokens and words that read the same in English — no line expected. */
const SAME_IN_ENGLISH = new Set([
  "Ctrl",
  "Shift",
  "Alt",
  "Esc",
  "Enter",
  "Tab",
  "Delete",
  "Space",
  "Insert",
  "Backspace",
  "Home",
  "End",
  "↑",
  "↓",
  "←",
  "→",
  "Editor",
  "Terminal",
  "Fontes",
  "Markdown",
  "Executor",
  // Extension names are brands: the same word in every language.
  "Symbols",
  "Material Icon Theme",
  "Dracula",
  "Nord",
  "Catppuccin Mocha",
  "Tokyo Night",
  "Rosé Pine",
  "Solarized Dark",
  "One Dark",
  "Ayu Dark",
  "GitHub Dark",
  "Min Dark",
  "Prettier",
  "Mermaid",
  "KaTeX",
  "Firefox (Android)",
  "Safari (iPhone)",
  "Chrome (Android)",
  "Microsoft Edge (Android)",
  "Chrome",
  "Firefox",
  "Safari",
  "Total",
  "Auto",
]);

function needsLine(text: string): boolean {
  if (SAME_IN_ENGLISH.has(text)) return false;
  // Single keys (`P`, `F2`, `1`), numbers and symbols carry nothing to translate.
  if (/^[A-Za-z0-9]{1,3}$/.test(text)) return false;
  if (!/[A-Za-zÀ-ÿ]{3,}/.test(text)) return false;
  return true;
}

function missing(sentences: readonly string[]): string[] {
  return sentences.filter((s) => needsLine(s) && !EN[s]);
}

describe("tables rendered through t() have their English lines", () => {
  it("the shortcut groups — titles, descriptions and gesture tokens", () => {
    const all = SHORTCUT_GROUPS.flatMap((g) => [
      g.title,
      ...g.items.flatMap(([keys, description]) => [...keys, description]),
    ]);
    expect(missing(all)).toEqual([]);
  });

  /**
   * The catalog of bundled features used to be a table of prose — a name, a
   * sentence and a paragraph per card on the store shelf. The shelf is gone
   * and each feature's words are written inside `t("…")` where its row is
   * drawn, so the ordinary scan covers them. What is still a table is the
   * icon themes' names, and they are brands: the guard is that a new one is
   * either the same word in English or has a line of its own.
   */
  it("the icon themes' names", () => {
    expect(missing(ICON_THEMES.map((theme) => theme.name))).toEqual([]);
  });

  it("each CLI's cache choices, cache note and skip-flag hint", () => {
    const all: string[] = [];
    for (const id of AGENT_IDS) {
      for (const c of cacheChoicesOf(id) ?? []) all.push(c.label, c.hint);
      all.push(cacheNoteOf(id));
      const skip = skipFlagOf("agent", id);
      if (skip) all.push(skip.hint);
    }
    expect(missing(all.filter(Boolean))).toEqual([]);
  });

  it("the first-run shortcuts, trigger events, flow presets, UA choices and labels", () => {
    const all = [
      ...FIRST_RUN_SHORTCUTS.flatMap(([keys, description]) => [...keys, description]),
      ...TRIGGER_EVENT_OPTIONS.map((o) => o.label),
      ...FLOW_PRESETS.map((p) => p.name),
      ...UA_CHOICES.map((u) => u.label),
      ...Object.values(RANGE_LABELS),
      ...Object.values(TREE_MODE_LABEL),
      ...Object.values(STATUS_META).map((s) => s.label),
    ];
    expect(missing(all)).toEqual([]);
  });
});
