/**
 * CodeMirror 6 configuration — the editor's engine.
 *
 * What lives here is **the theme**, written in the app's tokens (`--mono`,
 * `--text`, `--accent`…), so the editor looks like part of the window and not
 * a widget glued on. The per-file grammars live in `languages.ts` — one
 * registry serving the editor, the markdown fences and the status bar — and
 * are re-exported below so the components keep one import.
 *
 * The highlighting follows the app's visual contract inside out: color in the
 * *content* is allowed (the diff already does that), color in the *frame*
 * remains blue only.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { EditorState, type Extension } from "@codemirror/state";

import { highlightTag } from "./languages";

export {
  fenceLabel,
  fenceLanguages,
  highlightTag,
  isMarkdown,
  LANGUAGES,
  languageLabel,
  loadLanguage,
  markdownHighlight,
} from "./languages";

export const yardTheme = EditorView.theme(
  {
    "&": {
      color: "var(--text)",
      backgroundColor: "transparent",
      height: "100%",
    },
    // Size and line height are the *floor*: the file editor overrides both
    // from Preferências (`metrics.ts`, higher precedence in the extension
    // list). What is left reading these two is the note editor, which shares
    // this theme but is prose, not code.
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      fontSize: "12.5px",
      lineHeight: "1.55",
      overflow: "auto",
    },
    ".cm-content": { padding: "8px 0 40vh" },
    ".cm-line": { padding: "0 12px 0 6px" },
    // Frameless gutter: the numbering is background information, not a column.
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "rgb(255 255 255 / 26%)",
      border: "none",
      paddingRight: "2px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--text-dim)",
    },
    ".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 3.5%)" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent-bright)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "rgb(10 132 255 / 30%)" },
    ".cm-selectionMatch": { backgroundColor: "rgb(255 255 255 / 9%)" },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgb(10 132 255 / 22%)",
      outline: "1px solid var(--accent-border)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "rgb(255 255 255 / 8%)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      color: "var(--text-dim)",
      padding: "0 6px",
    },
    // Panels at the bottom — the go-to-line dialog (Ctrl+G) — wear the same
    // material as the app's menus.
    ".cm-panels-bottom": {
      backgroundColor: "var(--material-menu)",
      backdropFilter: "var(--blur-menu)",
      color: "var(--text)",
      borderTop: "1px solid var(--border)",
    },
    // The find bar rides at the top and brings its own capsule
    // (`.ysearch`, in `editor.css`): here the strip is only a rail for it.
    ".cm-panels-top": {
      backgroundColor: "transparent",
      color: "var(--text)",
      border: "none",
    },
    ".cm-panel input, .cm-panel button, .cm-panel label": {
      fontFamily: "inherit",
      fontSize: "var(--fs-sm)",
    },
    ".cm-dialog input": {
      background: "rgb(0 0 0 / 30%)",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-sm)",
      padding: "3px 7px",
    },
    ".cm-searchMatch": { backgroundColor: "rgb(240 195 60 / 26%)" },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgb(240 195 60 / 45%)",
    },
    // Git gutter: a thin strip beside the numbers — green born, blue changed,
    // a red wedge where lines died. Content color, allowed by the contract.
    ".cm-git-gutter": { width: "4px" },
    ".cm-git-gutter .cm-gutterElement": { position: "relative" },
    ".cm-gutterElement.cm-git-add": {
      background: "rgb(63 185 80 / 75%)",
      borderRadius: "2px",
    },
    ".cm-gutterElement.cm-git-mod": {
      background: "rgb(10 132 255 / 80%)",
      borderRadius: "2px",
    },
    ".cm-gutterElement.cm-git-del::before, .cm-gutterElement.cm-git-del-below::after":
      {
        content: '""',
        position: "absolute",
        left: "0",
        width: "0",
        height: "0",
        borderLeft: "5px solid rgb(248 81 73 / 90%)",
        borderTop: "4px solid transparent",
        borderBottom: "4px solid transparent",
      },
    ".cm-gutterElement.cm-git-del::before": { top: "-4px" },
    ".cm-gutterElement.cm-git-del-below::after": { bottom: "-4px" },
    // Trailing whitespace (code only): visible enough to notice, not a wound.
    ".cm-trailingSpace": { backgroundColor: "rgb(248 81 73 / 14%)" },
    ".cm-tooltip": {
      background: "var(--material-menu)",
      backdropFilter: "var(--blur-menu)",
      border: "1px solid var(--border-strong)",
      borderRadius: "var(--r-md)",
      boxShadow: "var(--shadow-2)",
      color: "var(--text)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      background: "var(--accent)",
      color: "var(--on-accent)",
    },
  },
  { dark: true },
);

/** Highlighting: cool like the rest of the window, low saturation, muted comments. */
export const yardHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7b8494", fontStyle: "italic" },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c792ea" },
  { tag: [t.operatorKeyword, t.definitionKeyword, t.modifier], color: "#c792ea" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#8fd694" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#e3b341" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#6fb3ff" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e2e2e6" },
  { tag: [t.typeName, t.className, t.namespace], color: "#5ecfbb" },
  { tag: [t.propertyName, t.attributeName], color: "#a9c7ff" },
  { tag: [t.tagName, t.angleBracket], color: "#ff8a80" },
  { tag: [t.variableName, t.self], color: "var(--text)" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "#e0a458" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#9e9ea6" },
  { tag: [t.meta, t.processingInstruction], color: "#9e9ea6" },
  { tag: t.link, color: "var(--accent-text)", textDecoration: "underline" },
  { tag: t.url, color: "var(--accent-text)" },
  { tag: [t.heading, t.strong], color: "var(--text-bright)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  {
    tag: highlightTag,
    background: "rgb(240 195 60 / 22%)",
    color: "var(--text-bright)",
  },
  { tag: [t.invalid], color: "var(--red)" },
]);

/**
 * CodeMirror speaks the app's language. The panels (Ctrl+F, Ctrl+G) ship
 * their labels in English; every string they use goes through this table.
 */
const ptBR = EditorState.phrases.of({
  // @codemirror/search — the find/replace panel
  Find: "Buscar",
  Replace: "Substituir",
  next: "próxima",
  previous: "anterior",
  all: "todas",
  "match case": "maiúsculas",
  "by word": "palavra inteira",
  regexp: "regex",
  replace: "substituir",
  "replace all": "substituir todas",
  close: "fechar",
  "current match": "ocorrência atual",
  "replaced $ matches": "$ ocorrências substituídas",
  "replaced match on line $": "substituído na linha $",
  "on line": "na linha",
  // @codemirror/search — the go-to-line panel (Ctrl+G)
  "Go to line": "Ir para a linha",
  go: "ir",
  // @codemirror/autocomplete
  Completions: "Sugestões",
  // @codemirror/lint
  Diagnostics: "Problemas",
  "No diagnostics": "Sem problemas",
});

/**
 * The editor's base bundle around a given highlight style. The default is
 * `yardHighlight`; a color-scheme extension swaps only this piece — theme
 * chrome and the pt-BR phrases stay whatever the scheme.
 */
export function syntaxBundle(highlight: HighlightStyle): Extension {
  return [yardTheme, syntaxHighlighting(highlight), ptBR];
}

export const yardSyntax: Extension = syntaxBundle(yardHighlight);
