/**
 * Format-on-save — the Prettier half of the extension of the same name.
 *
 * Runs in the *buffer*, before the store persists: the formatted text goes
 * through a normal dispatch, so it lands in the undo history, the cursor is
 * mapped by Prettier itself, and the save that follows writes exactly what is
 * on screen. Everything is loaded on demand: Prettier and its parsers are a
 * heavy chunk that a profile with the extension off never pays for.
 *
 * A file Prettier cannot parse (syntax error, unsupported dialect) is left
 * untouched and the save proceeds — formatting is a courtesy, never a gate.
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { useExtensions } from "../../stores/extensionsStore";

type PluginLoader = () => Promise<unknown[]>; // i18n-ok — not a sentence

const babel: PluginLoader = () =>
  Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]);
const typescript: PluginLoader = () =>
  Promise.all([import("prettier/plugins/typescript"), import("prettier/plugins/estree")]);
const postcss: PluginLoader = () => Promise.all([import("prettier/plugins/postcss")]);

const PARSERS: Record<string, { parser: string; plugins: PluginLoader }> = {
  ts: { parser: "typescript", plugins: typescript },
  mts: { parser: "typescript", plugins: typescript },
  cts: { parser: "typescript", plugins: typescript },
  tsx: { parser: "typescript", plugins: typescript },
  js: { parser: "babel", plugins: babel },
  mjs: { parser: "babel", plugins: babel },
  cjs: { parser: "babel", plugins: babel },
  jsx: { parser: "babel", plugins: babel },
  json: { parser: "json", plugins: babel },
  jsonc: { parser: "json", plugins: babel },
  css: { parser: "css", plugins: postcss },
  scss: { parser: "scss", plugins: postcss },
  less: { parser: "less", plugins: postcss },
  html: { parser: "html", plugins: () => Promise.all([import("prettier/plugins/html")]) },
  md: { parser: "markdown", plugins: () => Promise.all([import("prettier/plugins/markdown")]) },
  markdown: { parser: "markdown", plugins: () => Promise.all([import("prettier/plugins/markdown")]) },
  yml: { parser: "yaml", plugins: () => Promise.all([import("prettier/plugins/yaml")]) },
  yaml: { parser: "yaml", plugins: () => Promise.all([import("prettier/plugins/yaml")]) },
};

/**
 * Formats the view's buffer if the extension is on and the file has a parser.
 * Resolves when the buffer is ready to be saved, formatted or not.
 */
export async function formatBeforeSave(view: EditorView, path: string): Promise<void> {
  if (useExtensions.getState().enabled["format-on-save"] !== true) return;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const spec = PARSERS[ext];
  if (!spec) return;
  try {
    const [prettier, plugins] = await Promise.all([
      import("prettier/standalone"),
      spec.plugins(),
    ]);
    const src = view.state.doc.toString();
    const out = await prettier.formatWithCursor(src, {
      parser: spec.parser,
      plugins: plugins as import("prettier").Plugin[],
      cursorOffset: view.state.selection.main.head,
    });
    if (out.formatted === src) return;
    view.dispatch({
      changes: { from: 0, to: src.length, insert: out.formatted },
      selection: EditorSelection.cursor(
        Math.min(Math.max(out.cursorOffset, 0), out.formatted.length),
      ),
      scrollIntoView: true,
    });
  } catch {
    /* unparseable file: save it as it is */
  }
}
