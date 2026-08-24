/**
 * Canvas notes and texts — the items that live in the DOM (inside
 * `.cv-world`), not in the SVG layers.
 *
 * Each is a memoized component on its own: during a pan, a
 * zoom or dragging a card, no note should re-render (`NoteBody`'s
 * markdown is re-parsed on every render — paying that per frame
 * was the biggest cost of a canvas with notes). Every callback received here
 * must be stable in the parent, otherwise `memo` dies silently.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Lock, Unlock } from "lucide-react";

import { NoteBody } from "./NoteBody";
import { ResizeHandles } from "./ResizeHandles";
import type { NoteEditorApi } from "./NoteToolbar";
import {
  clamp,
  CORNER_DIRS,
  noteInk,
  TEXT_FONT_MAX,
  TEXT_FONT_MIN,
  type CanvasItem,
  type ResizeDir,
} from "../../lib/canvas";
import { changedSpan } from "../../lib/diff";
import { applyMd, blockOf, enterKey, type MdCommand, type MdSel } from "../../lib/mdedit";

type TextData = Extract<CanvasItem, { type: "text" }>;
type NoteData = Extract<CanvasItem, { type: "note" }>;

/**
 * How long the typed text may live only in this component before reaching the
 * store. Every commit re-serializes the whole canvas to JSON (nodes, notes and
 * every pen stroke) and schedules a workspace save, so committing per
 * keystroke made typing cost proportional to the size of the drawing.
 */
export const COMMIT_DEBOUNCE_MS = 250;

/**
 * Local draft of an editable text, committed on a debounce.
 *
 * While the field has focus the draft wins over the item — an agent writing
 * into the same note through the `yard` CLI will not yank the caret
 * mid-sentence; its text shows up as soon as editing ends. Leaving edit,
 * blurring or unmounting always flushes: no keystroke is dropped.
 */
function useDraftText(text: string, editing: boolean, commit: (t: string) => void) {
  const [draft, setDraft] = useState(text);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const send = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const value = pending.current;
    pending.current = null;
    if (value != null) commitRef.current(value);
    return value;
  }, []);

  const onChange = useCallback(
    (value: string) => {
      setDraft(value);
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(send, COMMIT_DEBOUNCE_MS);
    },
    [send],
  );

  // Out of edit mode the item is the source of truth again — but anything
  // still in flight has to land *first*. Re-seeding from a `text` that the
  // pending commit has not reached yet would show the user their own typing
  // rolled back, and a fast click away and back would then overwrite it.
  useEffect(() => {
    if (editing) return;
    if (pending.current != null) send();
    else setDraft(text);
  }, [editing, text, send]);

  // Unmounting mid-edit (group switch, layout switch) must not lose the tail.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current != null) commitRef.current(pending.current);
    },
    [],
  );

  return { draft, onChange, flush: send };
}

/**
 * Markdown shortcuts inside a note, keyed by `code` so they survive a layout
 * where the digits are not where a US keyboard puts them. `S:` is Shift.
 *
 * Both the window (`useKeybindings`) and the canvas step aside while a text
 * field has focus, so these are free to take `Ctrl+B`, `Ctrl+1` and friends
 * back for as long as the note is open.
 */
const NOTE_KEYS: Record<string, MdCommand> = {
  Digit0: "paragraph",
  Digit1: "h1",
  Digit2: "h2",
  Digit3: "h3",
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
  "S:Digit7": "ordered",
  "S:Digit8": "bullet",
  "S:Digit9": "task",
  "S:Period": "quote",
  "S:Minus": "rule",
};

/**
 * Writes `next` into the field as the smallest edit that gets there.
 *
 * Through `execCommand("insertText")` and not `el.value = …` on purpose:
 * assigning the value wipes the field's own undo stack, and `Ctrl+Z` inside a
 * note has to keep working after a button press exactly like it does after
 * typing. The `input` event it fires is the same one typing fires, so the
 * draft and its debounce never learn the difference. If the command is
 * refused, the caller's `onChange` still lands the text — only the undo
 * history is lost.
 */
function writeInto(
  el: HTMLTextAreaElement,
  next: string,
  fallback: (value: string) => void,
): void {
  const cur = el.value;
  if (cur === next) return;
  const { from, to, insert } = changedSpan(cur, next);
  el.setSelectionRange(from, to);
  let ok = false;
  try {
    ok = insert
      ? document.execCommand("insertText", false, insert)
      : document.execCommand("delete");
  } catch {
    ok = false;
  }
  if (!ok || el.value !== next) fallback(next);
}

interface CommonHandlers {
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  onBeginEdit: (id: string) => void;
  onPatchText: (id: string, text: string) => void;
  onEndEdit: (it: CanvasItem) => void;
}

interface TextItemProps extends CommonHandlers {
  it: TextData;
  dx: number;
  dy: number;
  selected: boolean;
  faded: boolean;
  editing: boolean;
  /** Zoom read at gesture time (see `TerminalCard`: as a prop it re-renders). */
  getZoom: () => number;
  /** End of a corner drag: the new font and where the text ended up. */
  onScale: (id: string, next: { fontSize: number; x: number; y: number }) => void;
}

/** Live state of a corner drag, before it becomes a commit. */
interface ScaleSession {
  pointerId: number;
  dir: ResizeDir;
  cx: number;
  cy: number;
  /** Laid-out size at the start, in world units (`offsetWidth` ignores scale). */
  w: number;
  h: number;
  font: number;
}

function TextItemImpl({
  it,
  dx,
  dy,
  selected,
  faded,
  editing,
  getZoom,
  onScale,
  onItemDown,
  onItemMove,
  onItemUp,
  onBeginEdit,
  onPatchText,
  onEndEdit,
}: TextItemProps) {
  const commitText = useCallback((t: string) => onPatchText(it.id, t), [it.id, onPatchText]);
  const { draft, onChange, flush } = useDraftText(it.text, editing, commitText);
  const shown = editing ? draft : it.text;
  const widest = shown.split("\n").reduce((m, l) => Math.max(m, l.length), 1);

  const box = useRef<HTMLDivElement>(null);
  const scale = useRef<ScaleSession | null>(null);
  /**
   * Preview of the corner drag. It stays local to the item — a text is not a
   * connection endpoint, and its selection outline is the element's own CSS
   * outline, so nothing outside needs to know the size until it commits.
   */
  const [live, setLive] = useState<{ font: number; dx: number; dy: number } | null>(null);

  /**
   * Where the drag has taken the text, without touching any state.
   *
   * A text box scales *with* the font — every glyph is the same shape, larger —
   * so the factor is read off whichever axis the pointer pulled hardest and the
   * corner opposite the grip is the one that stays nailed down.
   */
  const scaleNow = (e: React.PointerEvent) => {
    const s = scale.current;
    if (!s || e.pointerId !== s.pointerId) return null;
    const z = getZoom();
    const gx = ((e.clientX - s.cx) / z) * (s.dir.includes("w") ? -1 : 1);
    const gy = ((e.clientY - s.cy) / z) * (s.dir.includes("n") ? -1 : 1);
    const k = Math.max((s.w + gx) / s.w, (s.h + gy) / s.h);
    const font = clamp(Math.round(s.font * k), TEXT_FONT_MIN, TEXT_FONT_MAX);
    // From the *rounded* font, so the preview and the commit land on the same
    // pixel — the anchored corner must not slide by a fraction on release.
    const f = font / s.font;
    return {
      font,
      dx: s.dir.includes("w") ? s.w * (1 - f) : 0,
      dy: s.dir.includes("n") ? s.h * (1 - f) : 0,
    };
  };

  const startScale = (e: React.PointerEvent, dir: ResizeDir) => {
    const el = box.current;
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    e.stopPropagation();
    scale.current = {
      pointerId: e.pointerId,
      dir,
      cx: e.clientX,
      cy: e.clientY,
      // Guarded: an empty text lays out at zero width and the ratio below
      // would divide by it.
      w: Math.max(1, el.offsetWidth),
      h: Math.max(1, el.offsetHeight),
      font: it.fontSize,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  // The grips live *inside* the text, whose own handlers drag the item: every
  // event of this gesture has to stop before reaching them, not only the press.
  const moveScale = (e: React.PointerEvent) => {
    const next = scaleNow(e);
    if (!next) return;
    e.stopPropagation();
    setLive(next);
  };

  const endScale = (e: React.PointerEvent) => {
    const s = scale.current;
    const next = scaleNow(e);
    if (s) e.stopPropagation();
    scale.current = null;
    setLive(null);
    // A grip clicked without travelling is not a resize: it must not cost an
    // undo entry, exactly like a click on a card header.
    if (!s || !next || next.font === s.font) return;
    onScale(it.id, { fontSize: next.font, x: it.x + next.dx, y: it.y + next.dy });
  };

  return (
    <div
      ref={box}
      className={`cv-text ${selected ? "is-selected" : ""}`}
      style={{
        left: it.x + dx + (live?.dx ?? 0),
        top: it.y + dy + (live?.dy ?? 0),
        color: it.color,
        fontSize: live?.font ?? it.fontSize,
        opacity: faded ? 0.22 : 1,
      }}
      onPointerDown={(e) => {
        if (!editing) onItemDown(e, it.id);
      }}
      onPointerMove={onItemMove}
      onPointerUp={onItemUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onBeginEdit(it.id);
      }}
    >
      {editing ? (
        <textarea
          autoFocus
          className="cv-text-edit"
          value={draft}
          rows={Math.max(1, draft.split("\n").length)}
          style={{ width: `${Math.max(8, widest + 2)}ch` }}
          onChange={(e) => onChange(e.target.value)}
          // Flush first, then hand `onEndEdit` the text it needs to decide
          // whether an empty text item should disappear — the prop is still
          // one commit behind at this point.
          onBlur={() => {
            const latest = flush();
            onEndEdit(latest != null ? { ...it, text: latest } : it);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        it.text || "…"
      )}
      {/* Only while selected, and never mid-edit: the grips hang half outside
          the box, and on a short line the four corners would cover the very
          text you are trying to click. */}
      {selected && !editing && (
        <ResizeHandles
          dirs={CORNER_DIRS}
          onDown={startScale}
          onMove={moveScale}
          onUp={endScale}
        />
      )}
    </div>
  );
}

export const TextItem = memo(TextItemImpl);

interface NoteItemProps extends CommonHandlers {
  it: NoteData;
  dx: number;
  dy: number;
  /** Displayed size: the item's, or the in-progress resize. */
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  editing: boolean;
  connectClass: string;
  /** Only the selection tool enters edit from the note body. */
  selectTool: boolean;
  /** Project root a relative image in the note resolves against (§12.3). */
  root: string;
  onToggleLock: (id: string) => void;
  focusAtEnd: (el: HTMLTextAreaElement | null) => void;
  /** Hands the floating formatting bar a way in, for as long as we're edited. */
  registerEditor: (id: string, api: NoteEditorApi | null) => void;
  /** A checkbox ticked in the reading view, by source line. */
  onToggleTask: (id: string, line: number) => void;
  onOpenLink: (href: string) => void;
  onResizeStart: (e: React.PointerEvent, it: NoteData, dir: ResizeDir) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}

/**
 * How far the pointer may travel between press and release and still count as
 * "I clicked the note" rather than "I dragged it" — in screen pixels, so the
 * tolerance feels the same at any zoom.
 */
const CLICK_SLOP = 4;

function NoteItemImpl({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  editing,
  connectClass,
  selectTool,
  root,
  onItemDown,
  onItemMove,
  onItemUp,
  onBeginEdit,
  onPatchText,
  onEndEdit,
  onToggleLock,
  focusAtEnd,
  registerEditor,
  onToggleTask,
  onOpenLink,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: NoteItemProps) {
  /**
   * Where the press on the body started, to tell a click from a drag — and
   * whether the note **was already selected** when it began.
   *
   * The state is read here, on pointerdown, not on release: `onItemDown`
   * selects the note right away, so by pointerup the answer would always be
   * "yes". That distinction is what makes the first click select and the
   * second open the editor — without it, selecting a note to delete it opened
   * the editor and Delete became a text key.
   */
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    wasSelected: boolean;
    additive: boolean;
  } | null>(null);
  const commitText = useCallback((t: string) => onPatchText(it.id, t), [it.id, onPatchText]);
  const { draft, onChange, flush } = useDraftText(it.text, editing, commitText);
  // Which ink the block needs. The class carries it to every rule that writes
  // inside the note; see `.cv-note.ink-dark`.
  const ink = it.fill ? noteInk(it.fill) : null;

  const area = useRef<HTMLTextAreaElement | null>(null);
  /** Where the caret has to end up once React has repainted the field. */
  const wanted = useRef<[number, number] | null>(null);
  /** The bar, watching the caret. A plain Set: nothing else may listen. */
  const watchers = useRef(new Set<() => void>());

  const setArea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      area.current = el;
      focusAtEnd(el);
    },
    [focusAtEnd],
  );

  const announce = useCallback(() => {
    for (const cb of watchers.current) cb();
  }, []);

  /** Runs one editing command and puts the caret back where it belongs. */
  const apply = (next: MdSel) => {
    const el = area.current;
    if (!el) return;
    // Immediately *and* after the render: `execCommand` leaves the field
    // already holding the new text, so the caret can go home now; the fallback
    // path only gets its text on the next commit. The request is only left
    // standing when the text really changed — a command that turned out to be
    // a no-op would otherwise leave it there to fire on the next keystroke.
    if (el.value !== next.value) wanted.current = [next.start, next.end];
    writeInto(el, next.value, onChange);
    el.setSelectionRange(next.start, next.end);
    el.focus();
    announce();
  };

  const run = (cmd: MdCommand) => {
    const el = area.current;
    if (!el) return;
    apply(applyMd(cmd, { value: el.value, start: el.selectionStart, end: el.selectionEnd }));
  };

  // Keyed on the draft, not bare: a note re-renders on every frame of a drag,
  // and this must not become work the canvas pays for 60 times a second.
  useLayoutEffect(() => {
    const at = wanted.current;
    const el = area.current;
    if (!at || !el) return;
    wanted.current = null;
    el.setSelectionRange(at[0], at[1]);
  }, [draft]);

  // One object for the whole edit, with its methods refreshed per render:
  // handing the bar a new object every render would resubscribe it on every
  // keystroke, and `run` has to close over the current `onChange`.
  const api = useRef<NoteEditorApi>({
    run: () => {},
    block: () => {
      const el = area.current;
      return el ? blockOf(el.value, el.selectionStart) : "paragraph";
    },
    subscribe: (cb) => {
      watchers.current.add(cb);
      return () => {
        watchers.current.delete(cb);
      };
    },
  });
  api.current.run = run;

  useEffect(() => {
    if (!editing) return;
    const handle = api.current;
    registerEditor(it.id, handle);
    return () => registerEditor(it.id, null);
  }, [editing, it.id, registerEditor]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const ctrl = e.ctrlKey || e.metaKey;
    const now = (): MdSel => ({
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
    });

    // Enter inside a list carries the marker down — and clears it when the
    // item was never filled in. Anything else falls through to the field.
    if (e.key === "Enter" && !ctrl && !e.shiftKey && !e.altKey) {
      const next = enterKey(now());
      if (!next) return;
      e.preventDefault();
      apply(next);
      return;
    }
    // Tab indents instead of leaving the note: inside a sticky note there is
    // nothing to Tab *to*, and nested lists are the reason anyone presses it.
    if (e.key === "Tab" && !ctrl && !e.altKey) {
      e.preventDefault();
      run(e.shiftKey ? "outdent" : "indent");
      return;
    }
    if (e.altKey && !ctrl && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      run(e.key === "ArrowUp" ? "moveUp" : "moveDown");
      return;
    }
    if (!ctrl || e.altKey) return;
    const cmd = NOTE_KEYS[`${e.shiftKey ? "S:" : ""}${e.code}`];
    if (!cmd) return;
    e.preventDefault();
    run(cmd);
  };

  const toggleTask = useCallback(
    (line: number) => onToggleTask(it.id, line),
    [it.id, onToggleTask],
  );

  return (
    <div
      className={`cv-note ${selected ? "is-selected" : ""} ${connectClass} ${
        it.locked ? "is-locked" : ""
      } ${ink ? `has-fill ink-${ink}` : ""}`}
      style={
        {
          left: it.x + dx,
          top: it.y + dy,
          width: w,
          height: h,
          opacity: faded ? 0.22 : 1,
          // Everything written inside the note sizes off this token (headings
          // and code included, in `em`), so one number scales the whole block.
          ...(it.fontSize ? { "--note-fs": `${it.fontSize}px` } : {}),
          // The fill paints *flat*, never mixed into the dark surface: a hue
          // diluted into near-black comes out muddy (the yellow read olive),
          // and a note is a big enough surface to carry the color on its own.
          // A custom property and not `background`, so the sheet can lay the
          // sheen over it (`.cv-note.has-fill`) — an inline background would
          // win against any rule that tried.
          ...(it.fill ? { "--note-fill": it.fill } : {}),
          // Inline would beat the connect highlight's own border, so the rim
          // only paints when no highlight is up — same guard as a colored card.
          ...(ink && !connectClass
            ? {
                borderColor:
                  ink === "dark" ? "rgb(0 0 0 / 22%)" : "rgb(255 255 255 / 22%)",
              }
            : {}),
        } as React.CSSProperties
      }
    >
      <div
        className="cv-note-head"
        style={{ background: it.color }}
        onPointerDown={(e) => onItemDown(e, it.id)}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      />
      <button
        className="cv-note-lock"
        aria-pressed={!!it.locked}
        data-tip-wrap="" data-tip={
          it.locked
            ? "Travada: a CLI yard não escreve nem apaga esta nota. Clique para destravar."
            : "Travar contra escrita de agentes (você continua editando)"
        }
        aria-label={it.locked ? "Destravar nota" : "Travar nota"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLock(it.id);
        }}
      >
        {it.locked ? <Lock size={11} /> : <Unlock size={11} />}
      </button>
      {editing ? (
        <textarea
          className="cv-note-text"
          value={draft}
          placeholder="Anote aqui… a barra acima formata; markdown é renderizado ao sair."
          ref={setArea}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          // The bar lights up the block the caret is inside, and only the bar
          // re-renders for it: a caret position kept in canvas state would
          // repaint the whole board on every arrow key.
          onKeyUp={announce}
          onClick={announce}
          onSelect={announce}
          onBlur={() => {
            const latest = flush();
            onEndEdit(latest != null ? { ...it, text: latest } : it);
          }}
        />
      ) : (
        <div
          className="cv-note-read"
          // The whole body drags the note, and a *click* (press and release
          // without travelling) is what enters edit. The 9px header strip used
          // to be the only place that moved a note — a target no one could
          // find. Deferring the edit to pointerup is what lets both gestures
          // share the same surface.
          //
          // `preventDefault` kills the compatibility `mousedown`: its default
          // focus walks up looking for something focusable, finds only divs
          // and *clears* focus — which would blur the textarea we are about to
          // mount on pointerup, sending the note back to reading before the
          // first keystroke.
          onPointerDown={(e) => {
            if (!selectTool || e.button !== 0) return;
            e.preventDefault();
            press.current = {
              id: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              wasSelected: selected,
              additive: e.shiftKey,
            };
            // No `onSelect` here: `onItemDown` owns the selection rules
            // (replace, keep the group, Shift-toggle), and forcing a
            // single-item selection first would undo all three.
            onItemDown(e, it.id);
            // `onItemDown` captures on `e.target`, which here is whatever
            // markdown node happens to be under the cursor — a `<code>` that a
            // re-parse could replace mid-drag. Re-capturing on the body (last
            // call wins) pins it to a node that outlives the gesture.
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onItemMove}
          onPointerUp={(e) => {
            const p = press.current;
            press.current = null;
            onItemUp(e);
            if (!p || p.id !== e.pointerId) return;
            if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return;
            // Shift is a selection gesture (add to / remove from the group),
            // never an edit one; and a click on a note that wasn't selected
            // yet only selects it. Clicking again — or double-clicking — writes.
            if (p.additive || !p.wasSelected) return;
            onBeginEdit(it.id);
          }}
          // A canceled gesture (the system stealing the pointer) must not
          // leave a half-open press behind, or the next pointerup on this note
          // would read a stale origin and open the editor out of nowhere.
          onPointerCancel={(e) => {
            press.current = null;
            onItemUp(e);
          }}
          // The usual shortcut for whoever doesn't want the two clicks.
          onDoubleClick={(e) => {
            e.stopPropagation();
            onBeginEdit(it.id);
          }}
        >
          <NoteBody
            text={it.text}
            placeholder="Anote aqui…"
            root={root}
            onTask={toggleTask}
            onLink={onOpenLink}
          />
        </div>
      )}
      <ResizeHandles
        onDown={(e, dir) => onResizeStart(e, it, dir)}
        onMove={onResizeMove}
        onUp={onResizeEnd}
      />
    </div>
  );
}

export const NoteItem = memo(NoteItemImpl);
