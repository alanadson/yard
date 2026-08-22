/**
 * The color-scheme extensions' half inside the editor: turns a scheme's
 * `SyntaxPalette` (pure data in `lib/colorSchemes.ts`) into the same
 * HighlightStyle shape `yardHighlight` has, so switching schemes changes
 * colors and nothing else — same tags, same italics for comments, same
 * restraint (`invalid` stays the app's red, the mark highlight stays amber).
 */
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

import { syntaxBundle, yardSyntax } from "./cm";
import { highlightTag } from "./languages";
import { schemeFor, type SyntaxPalette } from "../../lib/colorSchemes";

function styleOf(p: SyntaxPalette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment], color: p.comment, fontStyle: "italic" },
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: p.keyword },
    { tag: [t.operatorKeyword, t.definitionKeyword, t.modifier], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
    { tag: [t.number, t.bool, t.null, t.atom], color: p.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.function },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: p.variable },
    { tag: [t.typeName, t.className, t.namespace], color: p.type },
    { tag: [t.propertyName, t.attributeName], color: p.property },
    { tag: [t.tagName, t.angleBracket], color: p.tag },
    { tag: [t.variableName, t.self], color: p.variable },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: p.number },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: p.operator },
    { tag: [t.meta, t.processingInstruction], color: p.comment },
    { tag: t.link, color: p.function, textDecoration: "underline" },
    { tag: t.url, color: p.function },
    { tag: [t.heading, t.strong], color: p.variable, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: highlightTag, background: "rgb(240 195 60 / 22%)", color: p.variable },
    { tag: [t.invalid], color: "var(--red)" },
  ]);
}

/** Built once per scheme — HighlightStyle registers CSS on definition. */
const cache = new Map<string, Extension>();

/** The editor's syntax bundle for the active scheme (or the Yard default). */
export function syntaxFor(schemeId: string | undefined | null): Extension {
  if (!schemeId) return yardSyntax;
  const scheme = schemeFor(schemeId);
  if (!scheme) return yardSyntax;
  let bundle = cache.get(schemeId);
  if (!bundle) {
    bundle = syntaxBundle(styleOf(scheme.syntax));
    cache.set(schemeId, bundle);
  }
  return bundle;
}
