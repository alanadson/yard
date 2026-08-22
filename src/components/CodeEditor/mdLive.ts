/**
 * Live preview — markdown that **looks** like the document while it stays the
 * document.
 *
 * This is the middle mode, and the reason it exists: a WYSIWYG editor keeps a
 * model of its own and writes the file back from it, so every round trip is a
 * chance to rewrite text nobody asked to change. Here the buffer is the file,
 * character for character; what changes is only how it is *drawn*. A heading
 * is bigger, `**` disappears while you are not on that line, a `- [ ]` gets a
 * checkbox you can click. Put the caret on the line and the markers come
 * back, because that is the moment you need to see them.
 *
 * The rule for revealing is per line, not per node: hiding the two asterisks
 * you are typing between makes the text jump under the cursor.
 *
 * Everything is built from the syntax tree the markdown grammar already
 * produces for highlighting, over the visible range only — a 5 000-line
 * changelog decorates the screenful you are looking at and nothing else.
 */
import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

/** Marker hidden while the line is not being edited. */
const hidden = Decoration.replace({});

const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

const HEADING = [1, 2, 3, 4, 5, 6].map((n) => line(`cm-md-h cm-md-h${n}`));

const INLINE: Record<string, Decoration> = {
  StrongEmphasis: mark("cm-md-strong"),
  Emphasis: mark("cm-md-em"),
  Strikethrough: mark("cm-md-strike"),
  InlineCode: mark("cm-md-code"),
  Highlight: mark("cm-md-highlight"),
  Link: mark("cm-md-link"),
  Image: mark("cm-md-image"),
  Subscript: mark("cm-md-sub"),
  Superscript: mark("cm-md-sup"),
};

/** Node names that are pure syntax: the ink markdown asks for, not content. */
const MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "HighlightMark",
  "SubscriptMark",
  "SuperscriptMark",
]);

/**
 * A `- [ ]` that ticks.
 *
 * The widget writes the same character the file already has room for, so the
 * click is an ordinary edit: undoable, savable, and visible to any agent
 * reading the file a second later.
 */
class TaskBox extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly at: number,
  ) {
    super();
  }

  override eq(other: TaskBox): boolean {
    return other.done === this.done && other.at === this.at;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-md-task";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.done));
    box.setAttribute("aria-label", this.done ? "Reabrir a tarefa" : "Concluir a tarefa");
    box.textContent = "";
    box.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.at, to: this.at + 1, insert: this.done ? " " : "x" },
        userEvent: "input.task",
      });
    };
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** A real rule instead of three dashes. */
class RuleLine extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-rule";
    return el;
  }
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const found: Range<Decoration>[] = [];

  // Lines the selection touches keep their markers: those are the ones being
  // written, and text that shifts under the caret is worse than a visible `*`.
  const editing = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) editing.add(n);
  }
  const revealed = (from: number) => editing.has(state.doc.lineAt(from).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
          const level = Number(name[name.length - 1]);
          if (level >= 1 && level <= 6) {
            const first = state.doc.lineAt(node.from);
            found.push(HEADING[level - 1].range(first.from));
          }
          return;
        }

        if (name === "Blockquote") {
          for (let pos = node.from; pos <= node.to; ) {
            const l = state.doc.lineAt(pos);
            found.push(line("cm-md-quote").range(l.from));
            pos = l.to + 1;
          }
          return;
        }

        if (name === "FencedCode" || name === "CodeBlock") {
          for (let pos = node.from; pos <= node.to; ) {
            const l = state.doc.lineAt(pos);
            found.push(line("cm-md-fence").range(l.from));
            pos = l.to + 1;
          }
          return;
        }

        if (name === "HorizontalRule") {
          if (!revealed(node.from)) {
            found.push(Decoration.replace({ widget: new RuleLine() }).range(node.from, node.to));
          } else {
            found.push(line("cm-md-hr").range(state.doc.lineAt(node.from).from));
          }
          return;
        }

        if (name === "TaskMarker") {
          // `[x]` — the character between the brackets is what gets flipped.
          const done = state.doc.sliceString(node.from + 1, node.to - 1).toLowerCase() === "x";
          if (!revealed(node.from)) {
            found.push(
              Decoration.replace({ widget: new TaskBox(done, node.from + 1) }).range(
                node.from,
                node.to,
              ),
            );
          }
          return;
        }

        if (name === "ListMark") {
          found.push(mark("cm-md-bullet").range(node.from, node.to));
          return;
        }

        if (name === "QuoteMark") {
          found.push(mark("cm-md-quotemark").range(node.from, node.to));
          return;
        }

        if (name === "URL") {
          // The address half of `[text](address)` is markup — the text is
          // the content, and leaving the URL visible was the one thing that
          // still read as source. A bare address (`https://…` typed on its
          // own, which the grammar also calls a URL) has no `(` in front of
          // it and stays: there, the address *is* the text.
          const inside = state.doc.sliceString(node.from - 1, node.from) === "(";
          if (inside && !revealed(node.from)) found.push(hidden.range(node.from, node.to));
          else found.push(mark("cm-md-url").range(node.from, node.to));
          return;
        }

        const inline = INLINE[name];
        if (inline) {
          if (node.to > node.from) found.push(inline.range(node.from, node.to));
          return;
        }

        if (MARKS.has(name) && !revealed(node.from) && node.to > node.from) {
          found.push(hidden.range(node.from, node.to));
        }
      },
    });
  }

  // `set(…, true)` sorts: the tree hands nodes over in document order, but a
  // line decoration is only known when its heading is entered — after marks
  // that started earlier on the same line.
  return Decoration.set(found, true);
}

/**
 * The plugin, rebuilt when the document, the viewport or the selection moves
 * — the selection matters because it is what reveals a line's markers.
 */
export const mdLive: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(u: ViewUpdate) {
      // The tree comparison is not paranoia: the markdown grammar is a lazy
      // import, so the file is already on screen when it arrives, and a
      // reconfiguration changes neither the document, the viewport nor the
      // selection. Without this the whole live preview only appeared after
      // the first keystroke. It also covers the incremental parse of a long
      // file, which lands the rest of the tree in later updates.
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // A replaced range must not swallow the caret: without this, an arrow key
    // could park the cursor inside a `**` nobody can see.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);
