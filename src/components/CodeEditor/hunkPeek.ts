/**
 * What a line was, shown where the line is.
 *
 * The git calha has always been able to say *that* a line changed. Clicking
 * one of its marks now opens the old text right under the change, with the
 * two things anyone wants at that moment: put it back, or copy it.
 *
 * A block widget rather than a tooltip, because the answer is lines of code
 * and it has to line up with the lines above it. It closes on Esc, on a
 * second click, and on any edit to the document: the ranges it holds are
 * recomputed on a debounce, so a peek that outlived the text it describes
 * would offer to revert the wrong thing.
 */
import { Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";

import { t } from "../../lib/i18n";
import type { Hunk } from "../../lib/hunks";

export interface PeekTarget {
  hunk: Hunk;
  /** The lines HEAD has for it (`peekLines`); empty when the hunk is new text. */
  lines: string[];
}

/** Opens the panel, or closes it with `null`. */
export const showHunkPeek = StateEffect.define<PeekTarget | null>();

export interface HunkActions {
  /** Put this hunk back the way HEAD has it. */
  revert: (hunk: Hunk) => void;
  /** The text the panel is showing, to the clipboard. */
  copy: (lines: string[]) => void;
}

/** How the widget reaches the app: the editor provides these once. */
export const hunkActions = Facet.define<HunkActions, HunkActions | null>({
  combine: (values) => values[0] ?? null,
});

class PeekWidget extends WidgetType {
  constructor(
    readonly target: PeekTarget,
    readonly actions: HunkActions | null,
  ) {
    super();
  }

  override eq(other: PeekWidget) {
    return (
      other.target.hunk.newFrom === this.target.hunk.newFrom &&
      other.target.hunk.oldFrom === this.target.hunk.oldFrom &&
      other.target.lines.join("\n") === this.target.lines.join("\n")
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-hunk-peek";

    const body = document.createElement("pre");
    body.className = "cm-hunk-peek-text";
    body.textContent = this.target.lines.length
      ? this.target.lines.join("\n")
      : t("Linha nova: não havia nada aqui no HEAD.");
    box.appendChild(body);

    const bar = document.createElement("div");
    bar.className = "cm-hunk-peek-bar";

    const revert = document.createElement("button");
    revert.textContent = t("Reverter este trecho");
    revert.onclick = () => this.actions?.revert(this.target.hunk);
    bar.appendChild(revert);

    if (this.target.lines.length) {
      const copy = document.createElement("button");
      copy.textContent = t("Copiar o do HEAD");
      copy.onclick = () => this.actions?.copy(this.target.lines);
      bar.appendChild(copy);
    }

    const close = document.createElement("button");
    close.textContent = t("Fechar");
    close.onclick = () => view.dispatch({ effects: showHunkPeek.of(null) });
    bar.appendChild(close);

    box.appendChild(bar);
    return box;
  }

  override ignoreEvent() {
    // The buttons are the point; without this the view swallows their clicks.
    return false;
  }
}

const peekField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Any edit outdates the ranges this panel was built from.
    if (tr.docChanged) return Decoration.none;
    for (const e of tr.effects) {
      if (!e.is(showHunkPeek)) continue;
      if (!e.value) return Decoration.none;
      const actions = tr.state.facet(hunkActions);
      const doc = tr.state.doc;
      // Under the hunk's last line; for a pure deletion, under the line that
      // took its place, which is where the wedge is drawn.
      const anchor = Math.min(
        Math.max(e.value.hunk.newTo || e.value.hunk.newFrom, 1),
        doc.lines,
      );
      const at = doc.line(anchor).to;
      return Decoration.set([
        Decoration.widget({
          widget: new PeekWidget(e.value, actions),
          block: true,
          side: 1,
        }).range(at),
      ]);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const peekTheme = EditorView.baseTheme({
  ".cm-hunk-peek": {
    margin: "4px 0 4px 6px",
    padding: "6px 8px",
    borderRadius: "var(--r-md, 8px)",
    border: "1px solid var(--border)",
    background: "var(--cm-peek, rgb(255 255 255 / 4%))",
  },
  ".cm-hunk-peek-text": {
    margin: "0",
    whiteSpace: "pre-wrap",
    color: "var(--text-dim)",
    font: "inherit",
  },
  ".cm-hunk-peek-bar": {
    display: "flex",
    gap: "6px",
    marginTop: "6px",
  },
  ".cm-hunk-peek-bar button": {
    padding: "1px 8px",
    borderRadius: "var(--r-sm, 6px)",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text)",
    font: "inherit",
    cursor: "default",
  },
  ".cm-hunk-peek-bar button:hover": { background: "var(--bg-hover)" },
});

export const hunkPeek: Extension = [
  peekField,
  peekTheme,
  keymap.of([
    {
      key: "Escape",
      run: (view) => {
        if (view.state.field(peekField).size === 0) return false;
        view.dispatch({ effects: showHunkPeek.of(null) });
        return true;
      },
    },
  ]),
];

/** Is the panel open right now? */
export function peekIsOpen(view: EditorView): boolean {
  return view.state.field(peekField, false)?.size !== 0;
}
