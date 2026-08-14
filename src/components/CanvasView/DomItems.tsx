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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Lock, Unlock } from "lucide-react";

import { NoteBody } from "./NoteBody";
import { ResizeHandles } from "./ResizeHandles";
import { noteInk, type CanvasItem, type ResizeDir } from "../../lib/canvas";

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
}

function TextItemImpl({
  it,
  dx,
  dy,
  selected,
  faded,
  editing,
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
  return (
    <div
      className={`cv-text ${selected ? "is-selected" : ""}`}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        color: it.color,
        fontSize: it.fontSize,
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
  onSelect: (id: string) => void;
  onToggleLock: (id: string) => void;
  focusAtEnd: (el: HTMLTextAreaElement | null) => void;
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
  onItemDown,
  onItemMove,
  onItemUp,
  onSelect,
  onBeginEdit,
  onPatchText,
  onEndEdit,
  onToggleLock,
  focusAtEnd,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: NoteItemProps) {
  // Where the press on the body started, to tell a click from a drag.
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const commitText = useCallback((t: string) => onPatchText(it.id, t), [it.id, onPatchText]);
  const { draft, onChange, flush } = useDraftText(it.text, editing, commitText);
  // Which ink the block needs. The class carries it to every rule that writes
  // inside the note; see `.cv-note.ink-dark`.
  const ink = it.fill ? noteInk(it.fill) : null;

  return (
    <div
      className={`cv-note ${selected ? "is-selected" : ""} ${connectClass} ${
        it.locked ? "is-locked" : ""
      } ${ink ? `has-fill ink-${ink}` : ""}`}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        width: w,
        height: h,
        opacity: faded ? 0.22 : 1,
        // The fill paints *flat*, never mixed into the dark surface: a hue
        // diluted into near-black comes out muddy (the yellow read olive), and
        // a note is a big enough surface to carry the color on its own.
        ...(it.fill ? { background: it.fill } : {}),
        // Inline would beat the connect highlight's own border, so the rim
        // only paints when no highlight is up — same guard as a colored card.
        ...(ink && !connectClass
          ? {
              borderColor:
                ink === "dark" ? "rgb(0 0 0 / 22%)" : "rgb(255 255 255 / 22%)",
            }
          : {}),
      }}
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
          placeholder="Anote aqui… markdown simples é renderizado ao sair."
          ref={focusAtEnd}
          onChange={(e) => onChange(e.target.value)}
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
            press.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            onSelect(it.id);
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
            if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= CLICK_SLOP) {
              onBeginEdit(it.id);
            }
          }}
          // A canceled gesture (the system stealing the pointer) must not
          // leave a half-open press behind, or the next pointerup on this note
          // would read a stale origin and open the editor out of nowhere.
          onPointerCancel={(e) => {
            press.current = null;
            onItemUp(e);
          }}
        >
          <NoteBody text={it.text} placeholder="Anote aqui…" />
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
