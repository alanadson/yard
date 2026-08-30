/**
 * Column guides: faint vertical lines at the columns you have decided a line
 * should not pass.
 *
 * Drawn as a layer of absolutely positioned rules inside the scroller, placed
 * with CodeMirror's own character width, so they follow the font and the size
 * from Preferências without knowing anything about either. They are content
 * the eye is meant to ignore until it needs them, which is why they are drawn
 * at the weight of the indentation guides and not at the weight of a border.
 */
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** More than this and they stop being guides and start being wallpaper. */
export const MAX_RULERS = 4;

/** Past this a column is not a place any line reaches. */
const MAX_COLUMN = 500;

/**
 * The columns hiding in a free-text preference. Free text is the right field
 * here, "80", "80, 120" and "100" are all answers a number input could not
 * hold, so this is where the mess is cleaned up: separators of any kind,
 * whole positive numbers only, each column once, in order, bounded.
 */
export function parseRulers(value: string | undefined | null): number[] {
  if (!value) return [];
  const columns = new Set<number>();
  // Split on separators, then demand the *whole* token be a column. Picking
  // digits out of the text instead would rescue a "3.5" as a 3 and a 5, and
  // a typo would silently become two guides.
  for (const piece of value.split(/[,;\s]+/)) {
    if (!/^[0-9]+$/.test(piece)) continue;
    const column = Number(piece);
    if (column <= 0 || column > MAX_COLUMN) continue;
    columns.add(column);
  }
  return [...columns].sort((a, b) => a - b).slice(0, MAX_RULERS);
}

const rulerTheme = EditorView.baseTheme({
  ".cm-rulers": {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    // Behind the text and the selection: a guide the caret hides behind is
    // a guide nobody reads.
    zIndex: "-1",
  },
  ".cm-ruler": {
    position: "absolute",
    top: "0",
    bottom: "0",
    width: "1px",
    background: "var(--cm-ruler, rgb(255 255 255 / 8%))",
  },
});

/** The guides for `columns`; an empty list is no extension at all. */
export function rulers(columns: readonly number[]): Extension {
  if (columns.length === 0) return [];
  return [
    rulerTheme,
    ViewPlugin.fromClass(
      class {
        readonly layer: HTMLDivElement;

        constructor(readonly view: EditorView) {
          this.layer = document.createElement("div");
          this.layer.className = "cm-rulers";
          this.layer.setAttribute("aria-hidden", "true");
          view.scrollDOM.appendChild(this.layer);
          this.draw();
        }

        update(update: ViewUpdate) {
          // The character width moves with the font, the size and the zoom;
          // geometry is the only thing worth redrawing for.
          if (update.geometryChanged || update.viewportChanged) this.draw();
        }

        draw() {
          const width = this.view.defaultCharacterWidth;
          const left = this.view.contentDOM.getBoundingClientRect().left;
          const origin = this.view.scrollDOM.getBoundingClientRect().left;
          const offset = left - origin + this.view.scrollDOM.scrollLeft;
          this.layer.replaceChildren(
            ...columns.map((column) => {
              const rule = document.createElement("div");
              rule.className = "cm-ruler";
              rule.style.left = `${offset + column * width}px`;
              return rule;
            }),
          );
        }

        destroy() {
          this.layer.remove();
        }
      },
    ),
  ];
}
