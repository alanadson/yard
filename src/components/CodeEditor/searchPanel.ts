/**
 * The find/replace bar (Ctrl+F) — the app's own, in place of CodeMirror's.
 *
 * CodeMirror ships a working bar: two rows of bare inputs, four buttons and
 * three checkboxes, glued to the **bottom** of the editor. It works, and it
 * looks like a form from 1999 — and down there it is the last place the eye
 * goes when the question is "where is this word?".
 *
 * This one is a floating capsule at the **top** of the surface, in the app's
 * material: one rounded field with the magnifier inside it, the match counter
 * ("2 de 12") living in the same field, the three modifiers as a segmented
 * control (Aa · ab · .*), a pair of arrows, and the replace line folded
 * behind a disclosure — the shape of Xcode's find bar. The counter is the
 * piece the default bar never had: it turns "something is highlighted
 * somewhere" into an answer.
 *
 * The commands stay CodeMirror's, untouched — `findNext`, `findPrevious`,
 * `selectMatches`, `replaceNext`, `replaceAll`. Only the clothes are ours.
 * The counting lives in `searchCore.ts`, where a test can reach it.
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { matchLabel, matchStats } from "./searchCore";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide's geometry, drawn by hand: a CodeMirror panel is DOM, not React. */
const GLYPH = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function glyph(path: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = path;
  return svg;
}

function box(cls: string, kids: (Node | string)[] = []): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.append(...kids);
  return d;
}

function button(
  cls: string,
  content: Node | string,
  tip: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.append(content);
  b.title = tip;
  b.setAttribute("aria-label", tip);
  // Without this, mousedown pulls the caret out of the field before the
  // click lands — and the field is where the user is typing.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Whether the replace line was open last time. Someone replacing across ten
 * files should not have to unfold the disclosure in every one of them — this
 * is the same memory Xcode's find bar keeps.
 */
let replaceWasOpen = false;

/**
 * The bar on screen for a given editor. `getPanel` cannot find it — the
 * facet holds CodeMirror's own `createSearchPanel`, which only *calls* ours —
 * and Ctrl+H needs to reach the live panel to unfold it.
 */
const onScreen = new WeakMap<EditorView, YardSearchPanel>();

class YardSearchPanel implements Panel {
  readonly dom: HTMLElement;
  /** Above the text, not under it — the whole point of this file. */
  readonly top = true;

  private query: SearchQuery;
  private readonly field: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly caseBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly reBtn: HTMLButtonElement;
  private readonly onMatches: HTMLButtonElement[] = [];
  private readonly replaceRow: HTMLElement | null = null;
  private readonly twist: HTMLButtonElement | null = null;

  constructor(private readonly view: EditorView) {
    const say = (key: string) => view.state.phrase(key);
    this.query = getSearchQuery(view.state);

    this.field = document.createElement("input");
    this.field.className = "ysearch-input";
    this.field.value = this.query.search;
    this.field.placeholder = say("Find");
    this.field.setAttribute("aria-label", say("Find"));
    // CodeMirror focuses whatever carries this attribute when the panel opens.
    this.field.setAttribute("main-field", "true");
    this.field.setAttribute("name", "search");
    this.field.setAttribute("form", "");
    this.field.addEventListener("input", this.commit);

    this.counter = document.createElement("span");
    this.counter.className = "ysearch-count";
    // The count is news for a screen reader too: it is the only answer to
    // "did it find anything?" that does not depend on seeing the highlights.
    this.counter.setAttribute("aria-live", "polite");

    this.wrap = box("ysearch-field", [glyph(GLYPH.search, 13), this.field, this.counter]);

    this.caseBtn = this.toggle("Aa", "Diferenciar maiúsculas de minúsculas", () =>
      this.turn({ caseSensitive: !this.query.caseSensitive }),
    );
    this.wordBtn = this.toggle("ab", "Somente palavras inteiras", () =>
      this.turn({ wholeWord: !this.query.wholeWord }),
    );
    this.wordBtn.firstElementChild?.classList.add("ysearch-word");
    this.reBtn = this.toggle(".*", "Expressão regular", () =>
      this.turn({ regexp: !this.query.regexp }),
    );

    const prev = button("ysearch-step", glyph(GLYPH.up), `${say("previous")} (Shift+Enter)`, () =>
      findPrevious(view),
    );
    const next = button("ysearch-step", glyph(GLYPH.down), `${say("next")} (Enter)`, () =>
      findNext(view),
    );
    const all = button("ysearch-text", "Todas", "Selecionar todas as ocorrências", () =>
      selectMatches(view),
    );
    this.onMatches.push(prev, next, all);

    const head = box("ysearch-row", [
      this.wrap,
      box("ysearch-seg", [this.caseBtn, this.wordBtn, this.reBtn]),
      box("ysearch-nav", [prev, next]),
      all,
      box("ysearch-gap"),
      button("ysearch-x", glyph(GLYPH.close, 13), `${say("close")} (Esc)`, () =>
        closeSearchPanel(view),
      ),
    ]);

    // A read-only file has nothing to replace: no disclosure, no second row.
    this.replaceField = document.createElement("input");
    if (!view.state.readOnly) {
      this.replaceField.className = "ysearch-input";
      this.replaceField.value = this.query.replace;
      this.replaceField.placeholder = say("Replace");
      this.replaceField.setAttribute("aria-label", say("Replace"));
      this.replaceField.setAttribute("name", "replace");
      this.replaceField.setAttribute("form", "");
      this.replaceField.addEventListener("input", this.commit);

      // `Replace`, not `replace`: the label sits next to "Tudo" and starts a
      // sentence the same way.
      const one = button("ysearch-text", say("Replace"), `${say("replace")} (Enter)`, () =>
        replaceNext(view),
      );
      const every = button("ysearch-text", "Tudo", `${say("replace all")} (Ctrl+Enter)`, () =>
        replaceAll(view),
      );
      this.onMatches.push(one, every);

      this.replaceRow = box("ysearch-row ysearch-row--replace", [
        box("ysearch-field", [this.replaceField]),
        one,
        every,
      ]);

      this.twist = button("ysearch-twist", glyph(GLYPH.right, 13), "Substituir (Ctrl+H)", () =>
        this.setReplace(this.replaceRow?.hidden ?? true),
      );
      head.prepend(this.twist);
    }

    this.dom = box("ysearch", this.replaceRow ? [head, this.replaceRow] : [head]);
    onScreen.set(view, this);
    this.dom.addEventListener("keydown", this.keydown);
    this.setReplace(replaceWasOpen);
    this.paint();
  }

  /** The current query with one knob turned, handed straight to the editor. */
  private turn(patch: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regexp?: boolean;
  }) {
    this.query = new SearchQuery({
      search: this.field.value,
      replace: this.replaceField.value,
      caseSensitive: this.query.caseSensitive,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
      ...patch,
    });
    this.push();
    this.field.focus();
  }

  private toggle(label: string, tip: string, onClick: () => void): HTMLButtonElement {
    const span = document.createElement("span");
    span.textContent = label;
    return button("ysearch-tog", span, tip, onClick);
  }

  /** A field changed: rebuild the query, keeping the modifiers as they are. */
  private commit = () => {
    this.query = new SearchQuery({
      search: this.field.value,
      replace: this.replaceField.value,
      caseSensitive: this.query.caseSensitive,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
    });
    this.push();
  };

  private push() {
    this.view.dispatch({ effects: setSearchQuery.of(this.query) });
    this.paint();
  }

  private keydown = (e: KeyboardEvent) => {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
    } else if (e.key === "Enter" && e.target === this.field) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      (e.ctrlKey || e.metaKey ? replaceAll : replaceNext)(this.view);
    }
  };

  /** Show or hide the replace line, remembering the choice for next time. */
  setReplace(open: boolean) {
    replaceWasOpen = open;
    if (!this.replaceRow || !this.twist) return;
    this.replaceRow.hidden = !open;
    this.twist.setAttribute("aria-expanded", String(open));
    this.twist.classList.toggle("is-open", open);
  }

  focusReplace() {
    this.replaceField.select();
  }

  /** Everything the bar says about where the search stands. */
  private paint() {
    const { doc, selection } = this.view.state;
    const stats = matchStats(doc, this.query, selection.main);
    this.counter.textContent = matchLabel(stats);
    this.wrap.classList.toggle("is-bad", stats.status === "invalid");
    this.wrap.classList.toggle("is-dry", stats.status === "ok" && stats.total === 0);
    // Nothing to walk to and nothing to replace: the buttons say so instead
    // of answering a click with silence.
    const dead = stats.status !== "ok" || stats.total === 0;
    for (const b of this.onMatches) b.disabled = dead;
    for (const [b, on] of [
      [this.caseBtn, this.query.caseSensitive],
      [this.wordBtn, this.query.wholeWord],
      [this.reBtn, this.query.regexp],
    ] as const) {
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("is-on", on);
    }
  }

  update(u: ViewUpdate) {
    for (const tr of u.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.field.value = this.query.search;
          this.replaceField.value = this.query.replace;
        }
      }
    }
    // The counter follows the caret: walking the matches with Enter has to
    // move "2 de 12" along, and typing over one of them has to drop it.
    this.paint();
  }

  mount() {
    this.field.select();
  }

  get pos() {
    return 80;
  }

  destroy() {
    if (onScreen.get(this.view) === this) onScreen.delete(this.view);
  }
}

const createPanel = (view: EditorView) => new YardSearchPanel(view);

/** The find bar, in the app's clothes and above the text. */
export const yardSearch: Extension = search({ top: true, createPanel });

/**
 * Ctrl+H: the same bar, already unfolded on the replace line with the caret
 * in it — the gesture every editor the user comes from spells this way.
 */
export function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view);
  const panel = onScreen.get(view);
  if (panel) {
    panel.setReplace(true);
    panel.focusReplace();
  }
  return true;
}
