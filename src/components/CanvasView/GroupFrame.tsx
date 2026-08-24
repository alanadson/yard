/**
 * The frame of a group (§5.4): a named rectangle drawn *behind* everything it
 * holds.
 *
 * Two rules shape the whole component, and both come straight from the spec's
 * "não deve impedir comunicação ou seleção dos elementos internos":
 *
 * - **The body takes no pointer.** `.cv-group` is `pointer-events: none`; only
 *   the title band and the border ring turn them back on. Anything else and
 *   the frame would swallow every click meant for the cards inside it — the
 *   single failure that makes frames unusable in every tool that gets it
 *   wrong.
 * - **It owns nothing.** Membership is geometric (`lib/canvasGroups.ts`), so
 *   this component never receives a member list and never needs one; it draws
 *   a box and a name.
 *
 * Memoized like every other canvas item: a frame must not re-render while a
 * card inside it is being dragged, and it re-renders per frame only when the
 * frame itself is the thing moving.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { ResizeHandles } from "./ResizeHandles";
import { GROUP_HEAD, GROUP_NAME_MAX } from "../../lib/canvasGroups";
import type { CanvasItem, ResizeDir } from "../../lib/canvas";

type GroupData = Extract<CanvasItem, { type: "group" }>;

interface Props {
  it: GroupData;
  dx: number;
  dy: number;
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  /** Only the select tool grabs a frame; with a pen in hand you draw over it. */
  selectTool: boolean;
  editing: boolean;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  onBeginEdit: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onEndEdit: (id: string) => void;
  onResizeStart: (e: React.PointerEvent, it: GroupData, dir: ResizeDir) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}

function GroupFrameImpl({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  selectTool,
  editing,
  onItemDown,
  onItemMove,
  onItemUp,
  onBeginEdit,
  onRename,
  onEndEdit,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: Props) {
  const [draft, setDraft] = useState(it.name);
  const input = useRef<HTMLInputElement | null>(null);

  // Out of edit mode the item is the truth again. Re-seeding only on that
  // edge keeps an agent's rename from yanking the field mid-typing.
  useEffect(() => {
    if (!editing) setDraft(it.name);
  }, [editing, it.name]);

  const setInput = useCallback((el: HTMLInputElement | null) => {
    input.current = el;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = useCallback(() => {
    onRename(it.id, draft);
    onEndEdit(it.id);
  }, [draft, it.id, onEndEdit, onRename]);

  return (
    <div
      className={`cv-group ${selected ? "is-selected" : ""}`}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        width: w,
        height: h,
        opacity: faded ? 0.22 : 1,
        // The ink of the band and of the ring. One token, so a frame recolored
        // from the menu changes both at once.
        ["--cv-group-ink" as string]: it.color,
        ["--cv-group-head" as string]: `${GROUP_HEAD}px`,
      }}
    >
      <div
        className="cv-group-head"
        onPointerDown={(e) => {
          if (!selectTool || e.button !== 0) return;
          onItemDown(e, it.id);
        }}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onBeginEdit(it.id);
        }}
      >
        {editing ? (
          <input
            ref={setInput}
            className="cv-group-name-input"
            value={draft}
            maxLength={GROUP_NAME_MAX}
            aria-label="Nome do grupo"
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
                return;
              }
              if (e.key !== "Escape") return;
              // Escape abandons the edit; the name on the item is untouched,
              // so the plain `onEndEdit` is the whole of it.
              e.preventDefault();
              e.stopPropagation();
              setDraft(it.name);
              onEndEdit(it.id);
            }}
          />
        ) : (
          <span className="cv-group-name">{it.name}</span>
        )}
      </div>

      {/* The ring, and it is **decoration only** — `pointer-events: none`.
          There is no way in CSS to make just a border hittable: an `inset: 0`
          box that takes the pointer takes the whole interior with it, which is
          precisely the failure this component exists to avoid. The frame is
          grabbed by its band and resized by its grips. */}
      <div className="cv-group-ring" aria-hidden="true" />

      {selected && (
        <ResizeHandles
          onDown={(e, dir) => onResizeStart(e, it, dir)}
          onMove={onResizeMove}
          onUp={onResizeEnd}
        />
      )}
    </div>
  );
}

export const GroupFrame = memo(GroupFrameImpl);
