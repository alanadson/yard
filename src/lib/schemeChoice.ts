/**
 * Which colour scheme paints which surface.
 *
 * A scheme carries two palettes (`lib/colorSchemes.ts`): the sixteen ANSI
 * tones a CLI draws its own output in, and the handful of roles a grammar
 * hands the editor. Those are two different jobs, and for a while one switch
 * did both — so wanting Ayu under an agent and GitHub Dark under the code was
 * not sayable. Two slots now, one per surface.
 *
 * "Linked" is not a third field: it is `terminal === code`, read off the two
 * slots. A stored flag saying they are equal is a flag that can disagree with
 * them, and then the switch on screen and the colours on screen tell different
 * stories. Everything here is a pure function over the pair — the store keeps
 * it, the components read it, nobody else gets to decide.
 */
import {
  enabledScheme,
  SCHEMES,
  SCHEME_IDS,
  schemeFor,
  SYNTAX_VARS,
  syntaxVars,
} from "./colorSchemes";
import type { ThemeRoot } from "./theme";

/** The two surfaces a scheme can paint, apart from each other. */
export type SchemeSurface = "terminal" | "code";

/** One scheme id per surface; `undefined` is the Yard's own palette. */
export interface SchemeChoice {
  terminal: string | undefined;
  code: string | undefined;
}

/** Both surfaces on the Yard's own palette — a fresh profile, and the floor. */
export const NO_SCHEME: SchemeChoice = { terminal: undefined, code: undefined };

/** Both surfaces on the same scheme: what the link switch reads. */
export function isLinked(choice: SchemeChoice): boolean {
  return choice.terminal === choice.code;
}

/** Moves one surface, leaving the other exactly where it was. */
export function setSurface(
  choice: SchemeChoice,
  surface: SchemeSurface,
  id: string | undefined,
): SchemeChoice {
  return { ...choice, [surface]: id };
}

/** Moves both — what a click on a card does while the link is on. */
export function setBoth(id: string | undefined): SchemeChoice {
  return { terminal: id, code: id };
}

/**
 * Turning the link back on. Two schemes have to collapse into one and only
 * the user knows which they meant, so the rule is stated where they can read
 * it (the store's hint under the section): the terminal's is the one that
 * survives. It is the surface this app is built around — the panes are full
 * of agents, and the editor is the tab you open on top of them.
 */
export function relink(choice: SchemeChoice): SchemeChoice {
  return setBoth(choice.terminal);
}

/** A scheme id the catalog still ships, or `undefined` for anything else. */
function known(value: unknown): string | undefined {
  return typeof value === "string" && SCHEME_IDS.includes(value) ? value : undefined;
}

/**
 * Reads the saved choice, falling back to the single boolean older profiles
 * hold. `legacy` is the `ext.enabled` map: before the split, a scheme was one
 * switch in there painting both surfaces, and every install that exists today
 * looks like that. So an absent key does not mean "no theme" — it means the
 * answer is still in the old place, and it gets carried across to both slots.
 *
 * A key that *is* there wins outright, `null` slots included: splitting the
 * surfaces and putting the terminal back on the Yard's own palette writes a
 * choice that looks empty and is not.
 */
export function parseSchemeChoice(
  raw: string | undefined,
  legacy: Readonly<Record<string, boolean | undefined>>,
): SchemeChoice {
  if (raw) {
    try {
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const saved = data as Record<string, unknown>;
        return { terminal: known(saved.terminal), code: known(saved.code) };
      }
    } catch {
      // A truncated or hand-edited value reads as no choice at all, and the
      // migration below still gets its turn — never a throw before first paint.
    }
  }
  // `enabledScheme` is the old reading, kept whole: only `true` counts, because
  // the map it looks at holds the schemes the user turned back off as well.
  return setBoth(enabledScheme(legacy));
}

/** One radio on a store card, and what a click on it asks the store for. */
export interface SchemeRadio {
  /**
   * The radio group. One name per surface (and a third for the linked
   * control), because the browser is what enforces one-of-N inside a group:
   * share a name between the two surfaces and picking the terminal's scheme
   * would silently switch the editor's off.
   */
  name: string;
  checked: boolean;
  /** The choice a click asks for — clicking the one already on clears it. */
  next: SchemeChoice;
}

const GROUP: Record<SchemeSurface | "both", string> = {
  both: "scheme",
  terminal: "scheme-terminal",
  code: "scheme-code",
};

/**
 * The card's control, for one scheme and one surface — `"both"` being the
 * single radio the section shows while the link is on.
 *
 * Clearing is the half with no visible symptom: a radio already on fires no
 * change event, so going back to the Yard's own palette by clicking the one
 * that is lit only works because `next` says so out loud. And the linked
 * radio reports itself off on *every* card while the surfaces disagree —
 * one control cannot speak for two colours without lying about one of them.
 */
export function schemeRadio(
  choice: SchemeChoice,
  id: string,
  surface: SchemeSurface | "both",
): SchemeRadio {
  const checked =
    surface === "both" ? isLinked(choice) && choice.terminal === id : choice[surface] === id;
  const next = checked ? undefined : id;
  return {
    name: GROUP[surface],
    checked,
    next: surface === "both" ? setBoth(next) : setSurface(choice, surface, next),
  };
}

// ---------------------------------------------------------------------------
// the same two slots, from Ajustes
// ---------------------------------------------------------------------------

/**
 * The store is where palettes are browsed; Ajustes → Terminal and
 * Ajustes → Editor are where each surface is simply *told* what to wear. That
 * is the pair that makes the split discoverable — nobody opens a store to find
 * out what the editor is on right now.
 *
 * A `<select>` speaks strings and an empty slot is `undefined`, so the two
 * helpers below own that seam rather than each section re-deriving it.
 */
export function schemeOptions(yardLabel: string): { value: string; label: string }[] {
  return [
    { value: "", label: yardLabel },
    ...SCHEMES.map((s) => ({ value: s.id, label: s.name })),
  ];
}

/** A slot as the picker's value — the Yard's own palette is the empty one. */
export function schemeValue(id: string | undefined): string {
  return id ?? "";
}

/** The picker's value as a slot, dropping anything the catalog cannot paint. */
export function schemePick(value: string): string | undefined {
  return known(value);
}

/**
 * Puts the editor's scheme onto the document as `--syn-*` custom properties.
 *
 * The editor itself does not need this — it swaps a whole `HighlightStyle`
 * (`schemeSyntax.ts`). The two surfaces that do are the ones with no
 * CodeMirror in them: the diff viewer and the markdown preview paint
 * `@lezer/highlight`'s `tok-*` classes on plain React trees, and the sheets
 * colour those through exactly these names. Without this, a `.ts` open in a
 * diff tab kept the Yard's palette while the editor tab beside it wore
 * Dracula — the same file, disagreeing with itself.
 *
 * Removal is the half that breaks quietly, so it is unconditional: anything
 * that is not a scheme this app can paint takes every property back off, and
 * the fallbacks written into the sheets show through again.
 */
export function applySyntaxVars(root: ThemeRoot, schemeId: string | undefined): void {
  const scheme = schemeFor(schemeId);
  if (!scheme) {
    for (const name of SYNTAX_VARS) root.style.removeProperty(name);
    return;
  }
  for (const [name, value] of Object.entries(syntaxVars(scheme.syntax))) {
    root.style.setProperty(name, value);
  }
}
