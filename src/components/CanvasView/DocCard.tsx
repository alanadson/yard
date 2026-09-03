/**
 * A document card: a source file open on the board, beside the agent that
 * is editing it.
 *
 * The card owns no text. It asks the editor store to load the file
 * (`loadDoc`, which never opens a tab) and renders the same `DocBody` a pane
 * tab renders, so the card and a tab of the same file are two views of one
 * buffer: a keystroke in either lands in both, and the save is one save.
 *
 * Only the header drags. The body is the editor, and the editor needs every
 * pointer event it gets.
 */
import { memo, useEffect, useState } from "react";
import { FileQuestion, PenSquare } from "lucide-react";

import { InlineRename } from "../ContextMenu/InlineRename";
import { DocBody } from "../CodeEditor";
import { ResizeHandles } from "./ResizeHandles";
import { FileGlyph } from "../FileGlyph";
import { docId as docKey, useEditor } from "../../stores/editorStore";
import { docNodeName, type DocItem } from "../../lib/docNode";
import type { ResizeDir } from "../../lib/canvas";
import { useT } from "../../hooks/useT";

interface Props {
  it: DocItem;
  dx: number;
  dy: number;
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  connectClass: string;
  /** Project root, for a card that carries none of its own. */
  projectRoot: string;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  /** Opens the same file as a tab beside the CLIs. */
  onOpen: (path: string) => void;
  onResizeStart: (e: React.PointerEvent, it: DocItem, dir: ResizeDir) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
  renaming: boolean;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
  onRename: (id: string, name: string) => void;
}

function DocCardImpl({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  connectClass,
  projectRoot,
  onItemDown,
  onItemMove,
  onItemUp,
  onOpen,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  renaming,
  onRenameStart,
  onRenameEnd,
  onRename,
}: Props) {
  const t = useT();
  const root = it.root || projectRoot;
  const id = root ? docKey(root, it.path) : null;
  const loaded = useEditor((s) => !!id && s.docs.some((d) => d.id === id));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!root || loaded) return;
    let alive = true;
    setError(null);
    useEditor
      .getState()
      .loadDoc(root, it.path)
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [root, it.path, loaded]);

  const name = docNodeName(it);
  const grab = (e: React.PointerEvent) => onItemDown(e, it.id);

  return (
    <div
      className={`cv-doc ${selected ? "is-selected" : ""} ${connectClass}`}
      style={{ left: it.x + dx, top: it.y + dy, width: w, height: h, opacity: faded ? 0.22 : 1 }}
    >
      <div
        className="cv-doc-head"
        style={{ background: it.color }}
        onPointerDown={grab}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      >
        <FileGlyph name={name} size={13} />
        {renaming ? (
          <InlineRename
            value={name}
            onCommit={(next) => {
              onRename(it.id, next);
              onRenameEnd();
            }}
            onCancel={onRenameEnd}
          />
        ) : (
          <span
            className="cv-doc-name"
            title={it.path}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRenameStart(it.id);
            }}
          >
            {name}
          </span>
        )}
        {!it.root && (
          <button
            className="cv-doc-btn"
            data-tip={t("Abrir no editor")}
            aria-label={t("Abrir {name} no editor", { name })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(it.path);
            }}
          >
            <PenSquare size={12} />
          </button>
        )}
      </div>

      <div className="cv-doc-body" onPointerDown={(e) => e.stopPropagation()}>
        {!root ? (
          <span className="cv-media-msg is-error">
            <FileQuestion size={14} />
            {t("Este quadro não tem projeto: o cartão precisa de um caminho completo.")}
          </span>
        ) : error ? (
          <span className="cv-media-msg is-error">
            <FileQuestion size={14} />
            {error}
          </span>
        ) : loaded && id ? (
          <DocBody docId={id} />
        ) : (
          <span className="cv-media-msg">{t("carregando…")}</span>
        )}
      </div>

      {!it.pinned && (
        <ResizeHandles
          onDown={(e, dir) => onResizeStart(e, it, dir)}
          onMove={onResizeMove}
          onUp={onResizeEnd}
        />
      )}
    </div>
  );
}

export const DocCard = memo(DocCardImpl);
