/**
 * The formatting commands, hooked up to CodeMirror.
 *
 * `lib/mdedit.ts` is the whole grammar of "what `**` means" and it is pure:
 * text plus a selection in, text plus a selection out. That is what lets the
 * canvas note (a `<textarea>`) and this editor (CodeMirror) share one set of
 * rules instead of two implementations that disagree at the third edge case.
 *
 * The only job here is the translation — and one thing that matters more than
 * it looks: the edit is dispatched as the **smallest change** that gets from
 * the old text to the new one. Replacing the whole document would work, and
 * would also throw away the undo granularity, every other cursor, and the
 * scroll position on a long file. Pressing "bold" has to undo like typing.
 */
import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { changedSpan } from "../../lib/diff";
import { applyMd, blockOf, type BlockKind, type MdCommand } from "../../lib/mdedit";

/** Runs one command against the view and puts the caret where it belongs. */
export function runMd(view: EditorView | null, cmd: MdCommand): boolean {
  if (!view || view.state.readOnly) return false;
  const value = view.state.doc.toString();
  const sel = view.state.selection.main;
  const next = applyMd(cmd, { value, start: sel.from, end: sel.to });
  const change = changedSpan(value, next.value);

  view.dispatch({
    ...(change.from === change.to && !change.insert ? {} : { changes: change }),
    selection: EditorSelection.range(next.start, next.end),
    scrollIntoView: true,
    // Named so the history groups a button press like a typed edit.
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** The block marker the caret is inside — the button the bar shows pressed. */
export function blockAt(view: EditorView | null): BlockKind {
  if (!view) return "paragraph";
  return blockOf(view.state.doc.toString(), view.state.selection.main.head);
}

/**
 * Keyboard shortcuts, by **physical key** (`event.code`) and not by the
 * character it produces — the same table the canvas note uses (`NOTE_KEYS` in
 * `DomItems.tsx`), extended with what only a file has.
 *
 * Two reasons for the code and not the letter. It survives a keyboard where
 * the digits and punctuation are not where a US layout puts them (this app is
 * written on an ABNT2), and it keeps the note and the editor honest with each
 * other: the same gesture has to mean the same thing whether the markdown is
 * on a sticky note or in a `.md`. `S:` is Shift.
 */
const BY_CODE: Record<string, MdCommand> = {
  Digit0: "paragraph",
  Digit1: "h1",
  Digit2: "h2",
  Digit3: "h3",
  Digit4: "h4",
  Digit5: "h5",
  Digit6: "h6",
  KeyB: "bold",
  KeyI: "italic",
  KeyE: "code",
  KeyK: "link",
  Backslash: "clear",
  Enter: "toggleTask",
  NumpadEnter: "toggleTask",
  "S:KeyX": "strike",
  "S:KeyH": "highlight",
  "S:KeyC": "codeblock",
  "S:KeyD": "duplicate",
  "S:KeyI": "image",
  "S:KeyT": "table",
  "S:KeyF": "footnote",
  "S:Digit7": "ordered",
  "S:Digit8": "bullet",
  "S:Digit9": "task",
  "S:Period": "quote",
  "S:Minus": "rule",
};

/**
 * `Prec.high` so these win over CodeMirror's own keymap: Ctrl+E and
 * Ctrl+Shift+D are already spoken for there, and inside a document markdown
 * is what the key means.
 */
export const mdKeymap = Prec.high(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
      const cmd = BY_CODE[`${event.shiftKey ? "S:" : ""}${event.code}`];
      if (!cmd) return false;
      event.preventDefault();
      return runMd(view, cmd);
    },
  }),
);
