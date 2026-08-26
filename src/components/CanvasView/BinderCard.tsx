/**
 * A fichário on the board (§13): several notes, one rectangle, a strip of
 * tabs.
 *
 * It draws a note it does **not** own. The note is still an item of the canvas
 * (`lib/binder.ts` explains why), so everything that addresses a note keeps
 * working on a filed one — `yard note write`, the wires, the lock, the search.
 * What this component does is render the active one and offer the tabs.
 *
 * Editing goes through the very same channel a loose note uses: the parent's
 * `onBeginEdit`/`onPatchText`/`onEndEdit`, keyed by the *note's* id. There is
 * no second editor here and there must never be one — two code paths writing
 * the same note is how a debounce race eats a paragraph.
 */
import { memo, useCallback } from "react";
import { FilePlus2, X } from "lucide-react";

import { NoteBody } from "./NoteBody";
import { ResizeHandles } from "./ResizeHandles";
import { BINDER_CHROME, binderTabs, type BinderItem } from "../../lib/binder";
import { noteName, type CanvasItem, type ResizeDir } from "../../lib/canvas";
import { useT } from "../../hooks/useT";

interface Props {
  it: BinderItem;
  /** Every item on the board — the tabs are looked up in it. */
  items: readonly CanvasItem[];
  dx: number;
  dy: number;
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  connectClass: string;
  selectTool: boolean;
  /** Id of the note being edited, when it is one of ours. */
  editingId: string | null;
  /** Project root, for the images inside the note (§12.3). */
  root: string;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  onShowTab: (binderId: string, noteId: string) => void;
  onRemoveTab: (noteId: string) => void;
  onNewNote: (binderId: string) => void;
  onBeginEdit: (id: string) => void;
  onPatchText: (id: string, text: string) => void;
  onEndEdit: (it: CanvasItem) => void;
  onToggleTask: (id: string, line: number) => void;
  onOpenLink: (href: string) => void;
  onResizeStart: (e: React.PointerEvent, it: BinderItem, dir: ResizeDir) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}

function BinderCardImpl({
  it,
  items,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  connectClass,
  selectTool,
  editingId,
  root,
  onItemDown,
  onItemMove,
  onItemUp,
  onShowTab,
  onRemoveTab,
  onNewNote,
  onBeginEdit,
  onPatchText,
  onEndEdit,
  onToggleTask,
  onOpenLink,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: Props) {
  const t = useT();
  const tabs = binderTabs(it, items);
  const at = Math.min(it.active ?? 0, Math.max(0, tabs.length - 1));
  const showing = tabs[at] ?? null;
  const editing = !!showing && editingId === showing.id;

  const grab = useCallback(
    (e: React.PointerEvent) => onItemDown(e, it.id),
    [it.id, onItemDown],
  );

  return (
    <div
      className={`cv-binder ${selected ? "is-selected" : ""} ${connectClass}`}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        width: w,
        height: h,
        opacity: faded ? 0.22 : 1,
        ["--cv-binder-chrome" as string]: `${BINDER_CHROME}px`,
      }}
    >
      <div
        className="cv-binder-head"
        style={{ background: it.color }}
        onPointerDown={grab}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      >
        <span className="cv-binder-title">
          {it.name || (showing ? noteName(showing) : t("Fichário"))}
        </span>
        <span className="cv-binder-count">
          {tabs.length ? `${at + 1}/${tabs.length}` : t("vazio")}
        </span>
        <button
          className="cv-binder-btn"
          data-tip={t("Nova nota neste fichário")}
          aria-label={t("Nova nota neste fichário")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onNewNote(it.id);
          }}
        >
          <FilePlus2 size={12} />
        </button>
      </div>

      <div
        className="cv-binder-page"
        onPointerDown={(e) => {
          // With no tab open there is nothing to edit, so the page is just
          // more surface to drag the card by.
          if (!showing || !selectTool) {
            grab(e);
            return;
          }
          if (e.button !== 0) return;
          e.preventDefault();
          onItemDown(e, it.id);
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
        onDoubleClick={(e) => {
          if (!showing) return;
          e.stopPropagation();
          onBeginEdit(showing.id);
        }}
      >
        {!showing ? (
          <span className="cv-binder-empty">
            {t("Fichário vazio — arquive notas aqui pelo menu da nota.")}
          </span>
        ) : editing ? (
          <textarea
            className="cv-binder-text"
            autoFocus
            defaultValue={showing.text}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onPatchText(showing.id, e.target.value)}
            onBlur={(e) => onEndEdit({ ...showing, text: e.target.value })}
          />
        ) : (
          <NoteBody
            text={showing.text}
            placeholder={t("Nota vazia — dois cliques para escrever.")}
            root={root}
            onTask={(line) => onToggleTask(showing.id, line)}
            onLink={onOpenLink}
          />
        )}
      </div>

      {/* The strip. At the bottom because that is where a real fichário's
          tabs are, and because the header already carries the name. */}
      <div
        className="cv-binder-tabs"
        role="tablist"
        aria-label={t("Notas do fichário")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {tabs.map((note, i) => (
          <button
            key={note.id}
            role="tab"
            aria-selected={i === at}
            className={`cv-binder-tab ${i === at ? "is-active" : ""}`}
            title={noteName(note)}
            onClick={(e) => {
              e.stopPropagation();
              onShowTab(it.id, note.id);
            }}
          >
            <span className="cv-binder-tab-name">{noteName(note)}</span>
            <span
              className="cv-binder-tab-off"
              role="button"
              tabIndex={-1}
              data-tip={t("Tirar do fichário (a nota volta para o canvas)")}
              aria-label={t("Tirar {name} do fichário", { name: noteName(note) })}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveTab(note.id);
              }}
            >
              <X size={10} />
            </span>
          </button>
        ))}
      </div>

      <ResizeHandles
        onDown={(e, dir) => onResizeStart(e, it, dir)}
        onMove={onResizeMove}
        onUp={onResizeEnd}
      />
    </div>
  );
}

export const BinderCard = memo(BinderCardImpl);
