/**
 * The two grammars this app kept answering the same question with.
 *
 * **How a form refuses.** The good one is inline: the primary stays
 * pressable, the press explains what is missing, and the field carries
 * `aria-invalid` + `role="alert"` (`NewFloorModal`, `NewProjectModal`). The
 * weak one is the `disabled` gate, and where the two crossed, the second
 * cancelled the first: `OnboardingModal` wrote `setErr("Escolha uma pasta.")`
 * and then disabled the very button that would have shown it — dead code for
 * exactly the user it existed for, on the first screen of a fresh install.
 * `ScoresModal` did the same to `showToast("Escolha um projeto antes de
 * aplicar a partitura.")`, a sentence it no longer needs at all: a score
 * lands on a board, made on the spot when there is none.
 *
 * **How a panel says it is working.** The good one names the action in flight
 * (`{busy ? t("Aterrissando…") : …}` + `aria-busy`, `lib/busy.ts`). The weak
 * one was a shared boolean that greyed every button at once, which is how
 * writing an MCP server — seconds of CLI — came out looking like a freeze.
 *
 * These are source guards, not behaviour tests: the behaviour lives in
 * `lib/busy.test.ts` and the gate modules. What is locked here is that the
 * weak grammar does not creep back into the four files that were converted.
 *
 * Not in scope, on purpose: a primary disabled by an *empty field whose
 * emptiness is the whole answer* — "Enviar" with no draft, "Criar rotina"
 * with no prompt, "Commit" with no message. Nothing to explain there. The
 * gate is a defect only when the form knows something the button will not say.
 */
import { describe, expect, it } from "vitest";

import mcpSrc from "./Settings/sections/Mcp.tsx?raw";
import onboardingSrc from "./modals/OnboardingModal.tsx?raw";
import scoresSrc from "./modals/ScoresModal.tsx?raw";

/** Every `disabled={…}` expression in a source, brace-balanced. */
function disabledExpressions(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/disabled=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
    }
    out.push(source.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

describe("how a form refuses", () => {
  it("reads the expressions and not the word `disabled` in a comment", () => {
    expect(disabledExpressions('<button disabled={a || b(c)}>')).toEqual(["a || b(c)"]);
    expect(disabledExpressions("nada aqui")).toEqual([]);
  });

  const GATED = [
    ["OnboardingModal", onboardingSrc],
    ["ScoresModal", scoresSrc],
  ] as const;

  for (const [name, source] of GATED) {
    it(`${name} never disables a button because a field is empty`, () => {
      const guilty = disabledExpressions(source).filter((e) => e.includes(".trim()"));
      expect(guilty, `${name} still gates on an empty field`).toEqual([]);
    });
  }

  it("the onboarding still knows how to ask for the folder it needs", () => {
    // Removing the gate is only half the fix; the sentence has to survive and
    // be reachable, wired to the field that is wrong.
    expect(onboardingSrc).toContain("Escolha uma pasta.");
    expect(onboardingSrc).toContain("aria-invalid");
    expect(onboardingSrc).toContain('role="alert"');
  });

  /**
   * The contract that changed: the dialog used to refuse with "Escolha um
   * projeto antes de aplicar a partitura." A score is an arrangement of the
   * canvas, and the canvas is the boards, so there is no project to ask for:
   * applying makes a board when there is none, and nothing is gated.
   */
  it("Partituras has nothing left to refuse: a score lands on a board, made on the spot", () => {
    expect(scoresSrc).not.toContain("Escolha um projeto");
    expect(scoresSrc).toContain("addBoard(");
    const guilty = disabledExpressions(scoresSrc).filter(
      (e) => e.includes("projectId") || e.includes("board"),
    );
    expect(guilty, "a button is holding the apply shut").toEqual([]);
  });
});

describe("how a panel says it is working", () => {
  const CONVERTED = [
    ["Mcp", mcpSrc],
    ["ScoresModal", scoresSrc],
  ] as const;

  for (const [name, source] of CONVERTED) {
    it(`${name} names the action in flight instead of greying everything`, () => {
      expect(source, `${name} does not use the shared vocabulary`).toContain(
        "refusesClick(",
      );
      expect(source, `${name} refuses clicks without announcing the work`).toContain(
        "aria-busy",
      );
    });

    it(`${name} keeps no bare boolean gate behind`, () => {
      const bare = disabledExpressions(source).filter((e) => /^\s*busy\s*$/.test(e));
      expect(bare, `${name} still has a mute \`disabled={busy}\``).toEqual([]);
    });
  }
});
