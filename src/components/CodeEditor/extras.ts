/**
 * Editor features that live behind the extension store — each one a plain
 * CodeMirror extension, off by default, swapped in and out of one compartment
 * by `CmSurface` while the file stays open.
 *
 * **Rainbow brackets** walks the syntax tree, not the raw text: a bracket is
 * only a bracket when the grammar tokenized it as one, so `"({"` inside a
 * string or a comment stays quiet. Depth is one shared counter (the classic
 * rainbow), clamped at zero so an unbalanced file degrades instead of
 * drifting negative. Recomputed for the whole document — capped, because the
 * scan runs on every edit and past a few hundred KB it stops being free.
 *
 * **TODO highlight** is textual on purpose (a pendency in a string or a
 * README counts too) and viewport-bound via `MatchDecorator`, which is what
 * keeps it free on any file size.
 */
import { language, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { colorPicker } from "@replit/codemirror-css-color-picker";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { showMinimap } from "@replit/codemirror-minimap";

// ---------------------------------------------------------------------------
// rainbow brackets
// ---------------------------------------------------------------------------

/** Content colors, same families the git states and diffs already use. */
const RB_MARKS = ["#e3b341", "#f778ba", "#79c0ff", "#7ee787", "#d2a8ff"].map(
  (_, i) => Decoration.mark({ class: `cm-rb-${i}` }),
);

const rbTheme = EditorView.baseTheme({
  ".cm-rb-0": { color: "#e3b341" },
  ".cm-rb-1": { color: "#f778ba" },
  ".cm-rb-2": { color: "#79c0ff" },
  ".cm-rb-3": { color: "#7ee787" },
  ".cm-rb-4": { color: "#d2a8ff" },
});

/** Above this the full-document scan costs a visible pause per keystroke. */
const RB_CAP = 200_000;

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/**
 * Every bracket the grammar tokenized as one, in document order, with its
 * nesting level. Exported for the tests: this is the piece that can be
 * asserted headless, without a DOM.
 */
export function bracketSpans(
  state: EditorState,
): { from: number; to: number; level: number }[] {
  const out: { from: number; to: number; level: number }[] = [];
  let depth = 0;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name.length !== 1) return;
      if (OPEN.has(node.name)) {
        out.push({ from: node.from, to: node.to, level: depth % RB_MARKS.length });
        depth += 1;
      } else if (CLOSE.has(node.name)) {
        depth = Math.max(0, depth - 1);
        out.push({ from: node.from, to: node.to, level: depth % RB_MARKS.length });
      }
    },
  });
  return out;
}

function rbDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  if (state.doc.length > RB_CAP) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  // Spans arrive in document order, which is exactly what the builder needs.
  for (const span of bracketSpans(state)) {
    builder.add(span.from, span.to, RB_MARKS[span.level]);
  }
  return builder.finish();
}

const rbPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = rbDecorations(view);
    }
    update(u: ViewUpdate) {
      // The tree grows in the background even without edits (lazy parsing);
      // comparing the instances is what catches those arrivals.
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState)
      ) {
        this.decorations = rbDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const rainbowBrackets: Extension = [rbPlugin, rbTheme];

// ---------------------------------------------------------------------------
// TODO highlight
// ---------------------------------------------------------------------------

const TODO_CLASS: Record<string, string> = {
  TODO: "cm-todo cm-todo--todo",
  FIXME: "cm-todo cm-todo--fix",
  BUG: "cm-todo cm-todo--fix",
  HACK: "cm-todo cm-todo--hack",
  XXX: "cm-todo cm-todo--hack",
  NOTE: "cm-todo cm-todo--note",
};

const todoDecorator = new MatchDecorator({
  regexp: /\b(TODO|FIXME|BUG|HACK|XXX|NOTE)\b/g,
  decoration: (m) => Decoration.mark({ class: TODO_CLASS[m[1]] }),
});

const todoTheme = EditorView.baseTheme({
  ".cm-todo": {
    borderRadius: "3px",
    padding: "0 3px",
    fontWeight: "600",
  },
  ".cm-todo--todo": { background: "rgb(227 179 65 / 22%)", color: "#e3b341" },
  ".cm-todo--fix": { background: "rgb(248 81 73 / 20%)", color: "#f85149" },
  ".cm-todo--hack": { background: "rgb(240 136 62 / 20%)", color: "#f0883e" },
  ".cm-todo--note": { background: "rgb(121 192 255 / 18%)", color: "#79c0ff" },
});

const todoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = todoDecorator.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = todoDecorator.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

export const todoHighlight: Extension = [todoPlugin, todoTheme];

// ---------------------------------------------------------------------------
// vendored extras — thin configuration over the Replit extensions
// ---------------------------------------------------------------------------

/**
 * Bird's-eye view on the right edge; blocks, not characters — it is a map.
 *
 * The blocks are painted with the token's own color, which the vendored
 * minimap resolves from the grammar plus the active highlight style. It only
 * re-reads both on four signals: the text changed, the folds changed, the
 * editor's theme classes changed — or **this config object changed identity**.
 *
 * A grammar arriving late is none of the first three: `CodeEditor` opens the
 * file with an empty language compartment and reconfigures it when the
 * `import()` of the grammar resolves, so the map was built while the document
 * was still plain text and every block stayed the same washed-out white. Same
 * story when a color-scheme extension swaps the highlight style under an open
 * file. Computing the config off both facets hands the map a new object at
 * exactly those two moments — and only those: a keystroke leaves the deps
 * untouched, and the minimap's own text path already covers it.
 */
const minimapExt: Extension = showMinimap.compute([language, EditorView.styleModule], () => ({
  create: () => ({ dom: document.createElement("div") }),
  displayText: "blocks",
  showOverlay: "always",
}));

/** Hairline guides in the app's own alpha, active block a step brighter. */
const indentExt: Extension = indentationMarkers({
  colors: {
    light: "rgb(255 255 255 / 8%)",
    dark: "rgb(255 255 255 / 8%)",
    activeLight: "rgb(255 255 255 / 18%)",
    activeDark: "rgb(255 255 255 / 18%)",
  },
});

export interface ExtraFlags {
  rainbow: boolean;
  todos: boolean;
  minimap: boolean;
  indent: boolean;
  cssColors: boolean;
}

/** What the store's switches translate to inside the editor's compartment. */
export function editorExtras(flags: ExtraFlags): Extension {
  return [
    flags.rainbow ? rainbowBrackets : [],
    flags.todos ? todoHighlight : [],
    flags.minimap ? minimapExt : [],
    flags.indent ? indentExt : [],
    flags.cssColors ? colorPicker : [],
  ];
}
