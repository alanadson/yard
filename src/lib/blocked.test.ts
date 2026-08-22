/**
 * The two halves of this detector are tested against each other on purpose:
 * every "it fires" case is paired with the nearest thing that must **not**
 * fire. A blocked badge that lies is worse than no badge, so the negatives
 * carry as much weight here as the positives.
 */
import { describe, expect, it } from "vitest";

import { appendTail, classifyPrompt, visibleLines } from "./blocked";

/** Claude Code's permission prompt, boxed and with the cursor on option 1. */
const PERMISSION_BOX = [
  "╭─────────────────────────────────────────────────────╮",
  "│ Edit file                                           │",
  "│                                                     │",
  "│ src/lib/blocked.ts                                  │",
  "│                                                     │",
  "│ Do you want to make this edit to blocked.ts?        │",
  "│ ❯ 1. Yes                                            │",
  "│   2. Yes, allow all edits during this session       │",
  "│   3. No, and tell Claude what to do differently     │",
  "╰─────────────────────────────────────────────────────╯",
].join("\r\n");

/** The same CLI with nothing to ask: the input box it always draws. */
const IDLE_BOX = [
  "  Wrote src/lib/blocked.ts (168 lines)",
  "",
  "╭─────────────────────────────────────────────────────╮",
  '│ > Try "edit <filepath> to..."                       │',
  "╰─────────────────────────────────────────────────────╯",
  "  ? for shortcuts",
].join("\r\n");

describe("appendTail", () => {
  it("keeps only the last bytes", () => {
    let tail = "";
    for (let i = 0; i < 4000; i++) tail = appendTail(tail, "0123456789");
    expect(tail.length).toBe(16 * 1024);
    expect(tail.endsWith("0123456789")).toBe(true);
  });

  it("ignores an empty chunk without copying", () => {
    const tail = "abc";
    expect(appendTail(tail, "")).toBe(tail);
  });
});

describe("visibleLines", () => {
  it("drops the frame and keeps the content", () => {
    expect(visibleLines(PERMISSION_BOX)).toEqual([
      "Edit file",
      "src/lib/blocked.ts",
      "Do you want to make this edit to blocked.ts?",
      "❯ 1. Yes",
      "2. Yes, allow all edits during this session",
      "3. No, and tell Claude what to do differently",
    ]);
  });

  it("keeps only the last pass of a line rewritten in place", () => {
    const spinner = "Building... 10%\rBuilding... 60%\rBuilding... 100%\r\n";
    expect(visibleLines(spinner)).toEqual(["Building... 100%"]);
  });

  it("strips colour before anything else looks at the text", () => {
    expect(visibleLines("\x1b[1mProceed? (y/N)\x1b[0m\n")).toEqual([
      "Proceed? (y/N)",
    ]);
  });

  it("returns the tail, not the head", () => {
    const many = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join("\n");
    const seen = visibleLines(many);
    expect(seen).toHaveLength(14);
    expect(seen[13]).toBe("linha 39");
  });
});

describe("classifyPrompt — a menu the user is standing in", () => {
  it("reads the question out of a boxed permission prompt", () => {
    const found = classifyPrompt(PERMISSION_BOX);
    expect(found).toEqual({
      ask: "Do you want to make this edit to blocked.ts?",
      rule: "choices",
    });
  });

  it("takes the nearest question when a preamble also ends in one", () => {
    const raw = [
      "Should I refactor this?  I think so, and here is why.",
      "",
      "Apply the rename to 12 files?",
      "❯ 1. Sim",
      "  2. Não",
    ].join("\n");
    expect(classifyPrompt(raw)?.ask).toBe("Apply the rename to 12 files?");
  });

  it("reads radio buttons too", () => {
    const raw = ["Apply this change?", "● Yes", "○ No", "○ Always"].join("\n");
    expect(classifyPrompt(raw)).toEqual({ ask: "Apply this change?", rule: "choices" });
  });

  it("stays quiet on the idle input box", () => {
    expect(classifyPrompt(IDLE_BOX)).toBeNull();
  });

  it("stays quiet on a plan the agent wrote as a numbered list", () => {
    const raw = [
      "Here is what I am going to do:",
      "1. Read the reader to find the idle threshold",
      "2. Write the classifier with tests",
      "3. Wire the badge into the three panes",
      "",
      "Starting now.",
    ].join("\n");
    expect(classifyPrompt(raw)).toBeNull();
  });

  it("stays quiet on a numbered list quoted in markdown", () => {
    const raw = [
      "The docs say:",
      "> 1. Install the binary",
      "> 2. Run it where the work lives",
    ].join("\n");
    expect(classifyPrompt(raw)).toBeNull();
  });

  it("stays quiet on a menu with no question above it", () => {
    const raw = ["Arquivos alterados", "❯ 1. src/App.tsx", "  2. src/lib/ipc.ts"].join(
      "\n",
    );
    expect(classifyPrompt(raw)).toBeNull();
  });

  it("stays quiet on a single option", () => {
    expect(classifyPrompt("Proceed?\n❯ 1. Yes")).toBeNull();
  });

  it("does not lend one shape's cursor to the other", () => {
    // One marked numbered line and two unmarked radio lines: neither shape is
    // a menu on its own, and counting them together would call it one.
    const raw = ["Rodar agora?", "> 1. contexto", "○ opção", "○ outra"].join("\n");
    expect(classifyPrompt(raw)).toBeNull();
  });
});

describe("classifyPrompt — one-line prompts", () => {
  it("catches the y/n shapes", () => {
    for (const line of [
      "Overwrite src/App.tsx? (y/N)",
      "Proceed? [Y/n]",
      "Continue? (yes/no)",
      "Sobrescrever? (s/n)",
    ]) {
      expect(classifyPrompt(`trabalho anterior\n${line}`)?.rule).toBe("yes-no");
    }
  });

  it("catches a secret being asked for", () => {
    expect(classifyPrompt("git push\nPassword for 'https://github.com':")).toEqual({
      ask: "Password for 'https://github.com':",
      rule: "secret",
    });
    expect(classifyPrompt("Enter your API key:")?.rule).toBe("secret");
  });

  it("catches a pager and a keypress", () => {
    expect(classifyPrompt("...\n(END)")?.rule).toBe("press-key");
    expect(classifyPrompt("Press Enter to continue")?.rule).toBe("press-key");
    expect(classifyPrompt("Pressione qualquer tecla")?.rule).toBe("press-key");
  });

  it("ignores a y/n that scrolled away", () => {
    const raw = [
      "Overwrite? (y/N)",
      "y",
      "escrevendo…",
      "pronto: 4 arquivos",
      "tudo certo",
      "",
      "done",
    ].join("\n");
    expect(classifyPrompt(raw)).toBeNull();
  });

  it("ignores the word password in the middle of a sentence", () => {
    expect(classifyPrompt("O campo de password foi validado com sucesso.")).toBeNull();
  });

  it("has nothing to say about an ordinary end of turn", () => {
    const raw = [
      "  Wrote src/lib/blocked.ts (168 lines)",
      "  Wrote src/lib/blocked.test.ts (140 lines)",
      "",
      "Pronto — o detector está no lugar.",
    ].join("\n");
    expect(classifyPrompt(raw)).toBeNull();
  });

  it("answers null for an empty tail", () => {
    expect(classifyPrompt("")).toBeNull();
    expect(classifyPrompt("\n\n\n")).toBeNull();
  });
});
