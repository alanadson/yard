/**
 * The editor text's metrics, coming from Preferences.
 *
 * Font size, line height, tab width and the line-number column used to be
 * literals inside the theme (`cm.ts`) and in `basicSetup`'s fixed list. Here
 * they become an extension that lives in a compartment: changing any of them
 * is a `reconfigure` on the file already open, with no new state — the undo
 * history, the cursor and the scroll stay where they were.
 *
 * The translation itself (number → style rule, width → indent text) is a pure
 * function, and it is what `metrics.test.ts` pins down; the rest is the
 * CodeMirror wiring around it.
 */
import { indentUnit } from "@codemirror/language";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface CodeMetrics {
  /** Font size of the editor's text, in px. */
  fontSize: number;
  /** Line height, as a multiple of the font size. */
  lineHeight: number;
  /** How many columns a tabulation is worth. */
  tabSize: number;
  /** Indent with a real `\t` instead of `tabSize` spaces. */
  hardTabs: boolean;
  /** The line-number column. */
  lineNumbers: boolean;
}

/**
 * The style rules that carry the metrics into the surface.
 *
 * The numbering is hidden with CSS rather than by leaving the gutter out:
 * `basicSetup` is a fixed list and `lineNumbers()` cannot be removed from it,
 * while a rule of the editor's *own* theme can. With the column on, the key
 * is absent — a leftover `display: block` would flatten the `<div>` the
 * gutter uses to line each number up with its row.
 *
 * `!important` because CodeMirror's own base theme writes
 * `.cm-gutter { display: flex !important }` (its comment: to stop margins
 * from collapsing). A plain `display: none` loses to it, and the preference
 * ends up saving fine and doing nothing on screen.
 */
export function metricsSpec(m: CodeMetrics): Record<string, Record<string, string>> {
  return {
    ".cm-scroller": {
      fontSize: `${m.fontSize}px`,
      lineHeight: String(m.lineHeight),
    },
    ...(m.lineNumbers ? {} : { ".cm-lineNumbers": { display: "none !important" } }),
  };
}

/**
 * What one indent step inserts. With real tabs the chosen width is display
 * only: what lands in the file is a `\t`, and turning it into spaces would
 * change the text the user saves.
 */
export function indentUnitFor(tabSize: number, hardTabs: boolean): string {
  return hardTabs ? "\t" : " ".repeat(Math.max(1, Math.round(tabSize)));
}

/**
 * The compartment's content.
 *
 * `Prec.high` on the theme is load-bearing: `yardTheme` writes `font-size` on
 * the same `.cm-scroller`, both rules end up at the same specificity, and who
 * wins is decided by the order CodeMirror mounts the style modules in —
 * reverse precedence order, so the *higher* precedence one is written last.
 * Leaving it at default precedence made the preference silently depend on
 * where this sits in the extension array, and getting that wrong breaks
 * nothing visible except the field itself, which stops doing anything.
 */
export function codeMetrics(m: CodeMetrics): Extension {
  return [
    Prec.high(EditorView.theme(metricsSpec(m))),
    EditorState.tabSize.of(Math.max(1, Math.round(m.tabSize))),
    indentUnit.of(indentUnitFor(m.tabSize, m.hardTabs)),
  ];
}
