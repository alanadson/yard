/**
 * A media card on the board (§52): the picture, the video, the PDF or the
 * audio the agents beside it are working from.
 *
 * **The bytes never cross the IPC.** The body is an `<img>`/`<video>`/
 * `<iframe>` pointed at `yardfile://` (`src-tauri/src/media.rs`), so the
 * webview fetches its own chunks — a 300 MB video seeks, and a card on screen
 * costs a request, not a base64 string through a JSON channel.
 *
 * The one call this component does make is `fsReadText`, on mount and whenever
 * the address changes. It looks odd for a video and it is deliberate: that
 * command short-circuits on a known binary (it never reads the bytes), it
 * answers with the MIME — which is what picks the element below — and, the
 * part that is not optional, **it registers the root**. The protocol only
 * serves roots the app opened this session, so without this a card restored
 * from `layoutJson` on a cold boot would draw a broken frame for a file that
 * is plainly there.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { FileQuestion, PenSquare } from "lucide-react";

import { InlineRename } from "../ContextMenu/InlineRename";

import { ResizeHandles } from "./ResizeHandles";
import { FileGlyph } from "../FileGlyph";
import { ipc } from "../../lib/ipc";
import { fileSize, mediaKind, mediaUrl, type MediaKind } from "../../lib/media";
import { mediaNodeName, type MediaItem } from "../../lib/mediaNode";
import type { ResizeDir } from "../../lib/canvas";
import { useT } from "../../hooks/useT";

interface Props {
  it: MediaItem;
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
  onOpen: (path: string) => void;
  onResizeStart: (e: React.PointerEvent, it: MediaItem, dir: ResizeDir) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
  /** The in-place rename is open on this card (the board owns which one). */
  renaming: boolean;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
  onRename: (id: string, name: string) => void;
}

interface FileFacts {
  kind: MediaKind | null;
  size: number;
  /** Cache-buster: an agent that rewrote the file must show the new one. */
  version: number;
  error: string | null;
}

function MediaCardImpl({
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
  const [facts, setFacts] = useState<FileFacts | null>(null);

  useEffect(() => {
    if (!root) {
      setFacts({
        kind: null,
        size: 0,
        version: 0,
        error: t("sem projeto: este cartão precisa de um caminho completo"),
      });
      return;
    }
    let alive = true;
    setFacts(null);
    ipc
      .fsReadText(root, it.path)
      .then((file) => {
        if (!alive) return;
        setFacts({
          kind: mediaKind(file.media),
          size: file.size,
          version: file.modifiedAt,
          error: null,
        });
      })
      .catch((e) => {
        if (!alive) return;
        setFacts({ kind: null, size: 0, version: 0, error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [root, it.path]);

  const name = mediaNodeName(it);
  const url = root && facts && !facts.error ? mediaUrl(root, it.path, facts.version) : null;
  /**
   * The bytes refused, even though the file is there.
   *
   * `fsReadText` answering does **not** mean the picture will draw: it is a
   * `.png` that is really text, a 400 MB TIFF, a format the webview does not
   * decode, or a file an agent replaced between the two requests. Without
   * this the card keeps the webview's own broken-image icon, which says
   * nothing and reads as our bug.
   */
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const grab = useCallback(
    (e: React.PointerEvent) => onItemDown(e, it.id),
    [it.id, onItemDown],
  );

  return (
    <div
      className={`cv-media ${selected ? "is-selected" : ""} ${connectClass}`}
      style={{ left: it.x + dx, top: it.y + dy, width: w, height: h, opacity: faded ? 0.22 : 1 }}
    >
      <div
        className="cv-media-head"
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
            className="cv-media-name"
            title={it.path}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRenameStart(it.id);
            }}
          >
            {name}
          </span>
        )}
        {facts && !facts.error && facts.size > 0 && (
          <span className="cv-media-size">{fileSize(facts.size)}</span>
        )}
        {/* Only for a file inside the project: the editor addresses files
            relative to the project root, and a card pointing at `D:\fotos`
            has nothing it could hand over. */}
        {!it.root && (
          <button
            className="cv-media-btn"
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

      <div
        className="cv-media-body"
        // The body drags the card too. There is no "click to edit" here to
        // compete with it — a picture has nothing to type into — so unlike a
        // note this needs no press/release bookkeeping.
        onPointerDown={grab}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      >
        {!facts ? (
          <span className="cv-media-msg">{t("carregando…")}</span>
        ) : facts.error ? (
          <span className="cv-media-msg is-error">
            <FileQuestion size={14} />
            {facts.error}
          </span>
        ) : broken ? (
          <span className="cv-media-msg is-error">
            <FileQuestion size={14} />
            {t("não consegui desenhar este arquivo")}
          </span>
        ) : facts.kind === "image" && url ? (
          <img
            className="cv-media-img"
            src={url}
            alt={name}
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : facts.kind === "video" && url ? (
          // `controls` needs the pointer, and the body swallows it for the
          // drag — so the player stops the propagation on its own.
          <video
            className="cv-media-el"
            src={url}
            controls
            onError={() => setBroken(true)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : facts.kind === "audio" && url ? (
          <audio
            className="cv-media-audio"
            src={url}
            controls
            onError={() => setBroken(true)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : facts.kind === "pdf" && url ? (
          <iframe
            className="cv-media-el"
            src={url}
            title={name}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          // Not media: a `.ts`, a `.json`, a spec. The card is still useful —
          // it pins the file to a place on the board — but it says plainly
          // that the picture is not coming and offers the door that works.
          <span className="cv-media-msg">
            <FileGlyph name={name} size={20} />
            {it.path}
          </span>
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

export const MediaCard = memo(MediaCardImpl);
