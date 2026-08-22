/**
 * The face of a file that is not text: image, video, audio, PDF — and the
 * honest card for everything else.
 *
 * Before, any file without text opened with one sentence and nothing more
 * ("binary file — no text to edit"). But half of what you click in a project
 * tree is exactly that: the screenshot the agent saved, the icon someone
 * swapped, the video of the bug. Saying there is no text is true and useless.
 *
 * Three rules here:
 *
 * - **The bytes do not go through JavaScript.** The `<img>`/`<video>`/`<iframe>`
 *   points at the `yardfile` protocol (`lib/media.ts`), and the webview fetches
 *   the chunks it needs. That is what makes a 300 MB video open instantly and
 *   the progress bar work.
 * - **Failing is an answer.** A `.mkv` with a codec WebView2 will not play must
 *   not become an unexplained black rectangle: the element reports it, and the
 *   screen swaps in the card with "open in default app".
 * - **What cannot be drawn can still be described.** A `.zip`, a `.docx`, an
 *   `.exe`: name, type, size and the two ways out (open externally, show in
 *   Explorer).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  File as FileIcon,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Maximize2,
  Music,
  ScanLine,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { ipc } from "../../lib/ipc";
import { fileSize, mediaKind, mediaUrl, type MediaKind } from "../../lib/media";
import { fileName, toOsPath } from "../../lib/paths";
import { useUI } from "../../stores/uiStore";
import type { OpenDoc } from "../../stores/editorStore";

/** Zoom step per click. */
const ZOOM_STEP = 1.4;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 16;

/** The type in one word: the extension, which is what people call the format. */
function shortType(mime: string | null, path: string): string {
  const itemName = fileName(path);
  const dot = itemName.lastIndexOf(".");
  if (dot > 0) return itemName.slice(dot + 1).toUpperCase();
  return mime?.split("/")[1]?.toUpperCase() ?? "arquivo";
}

function Icon({ kind }: { kind: MediaKind | null }) {
  if (kind === "image") return <ImageIcon size={26} />;
  if (kind === "video") return <Film size={26} />;
  if (kind === "audio") return <Music size={26} />;
  return <FileIcon size={26} />;
}

export function MediaView({ doc }: { doc: OpenDoc }) {
  const showToast = useUI((s) => s.showToast);
  const kind = mediaKind(doc.media);
  const [failed, setFailed] = useState(false);
  const [realSize, setRealSize] = useState<{ w: number; h: number } | null>(null);
  /** `null` = fit to the window; a number = the exact scale. */
  const [zoom, setZoom] = useState<number | null>(null);

  // The mtime goes into the URL: when an agent rewrites the screenshot, the
  // address changes and the webview refetches instead of showing the old frame.
  const url = useMemo(
    () => mediaUrl(doc.root, doc.path, doc.modifiedAt),
    [doc.root, doc.path, doc.modifiedAt],
  );
  const osPath = toOsPath(doc.root, doc.path);
  const name = fileName(doc.path);

  // New file (or the same one, rewritten): start over from a clean state.
  useEffect(() => {
    setFailed(false);
    setRealSize(null);
    setZoom(null);
  }, [url]);

  const openExternally = useCallback(() => {
    void ipc.openExternal(osPath).catch((e) => showToast(String(e), "error"));
  }, [osPath, showToast]);

  const reveal = useCallback(() => {
    void ipc.revealPath(osPath).catch((e) => showToast(String(e), "error"));
  }, [osPath, showToast]);

  if (!kind || failed) {
    return (
      <div className="media-view">
        <div className="media-stage media-stage--center">
          <div className="media-card">
            <span className="media-card-icon">
              <Icon kind={kind} />
            </span>
            <strong>{name}</strong>
            <span className="media-card-meta">
              {shortType(doc.media, doc.path)} · {fileSize(doc.size)}
            </span>
            {failed && (
              <p className="media-card-why">
                O visualizador embutido não deu conta: o formato (ou o codec lá dentro)
                está fora do que o navegador do app toca. No programa do sistema ele
                abre.
              </p>
            )}
            <div className="media-card-actions">
              <button className="btn btn--primary btn--sm" onClick={openExternally}>
                <ExternalLink size={12} aria-hidden="true" />
                Abrir no aplicativo padrão
              </button>
              <button className="btn btn--ghost btn--sm" onClick={reveal}>
                <FolderOpen size={12} aria-hidden="true" />
                Mostrar no Explorer
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const scale = zoom ?? 1;

  return (
    <div className={`media-view media-view--${kind}`}>
      <div className="media-bar">
        <span className="media-facts">
          {shortType(doc.media, doc.path)}
          {realSize && ` · ${realSize.w} × ${realSize.h}`}
          {` · ${fileSize(doc.size)}`}
        </span>

        {kind === "image" && (
          <div className="media-tools">
            <button
              className="icon-btn"
              data-tip="Diminuir"
              aria-label="Diminuir"
              onClick={() => setZoom(Math.max(ZOOM_MIN, scale / ZOOM_STEP))}
            >
              <ZoomOut size={14} />
            </button>
            <span className="media-zoom" aria-live="polite">
              {zoom === null ? "ajustada" : `${Math.round(scale * 100)}%`}
            </span>
            <button
              className="icon-btn"
              data-tip="Aumentar"
              aria-label="Aumentar"
              onClick={() => setZoom(Math.min(ZOOM_MAX, scale * ZOOM_STEP))}
            >
              <ZoomIn size={14} />
            </button>
            <button
              className={`icon-btn ${zoom === null ? "is-active" : ""}`}
              data-tip="Caber na janela"
              aria-label="Caber na janela"
              aria-pressed={zoom === null}
              onClick={() => setZoom(null)}
            >
              <Maximize2 size={14} />
            </button>
            <button
              className={`icon-btn ${zoom === 1 ? "is-active" : ""}`}
              data-tip="Tamanho real (1:1)"
              aria-label="Tamanho real"
              aria-pressed={zoom === 1}
              onClick={() => setZoom(1)}
            >
              <ScanLine size={14} />
            </button>
          </div>
        )}
      </div>

      <div
        className={`media-stage ${
          kind === "image" && zoom !== null ? "is-zoomed" : "media-stage--center"
        }`}
      >
        {kind === "image" && (
          /* Clicking toggles between fit and 1:1 — the gesture from Preview and
             Explorer, and the only way to look closely at a pixel without aim. */
          <img
            className={`media-img ${zoom === null ? "is-fit" : ""}`}
            src={url}
            alt={name}
            style={
              zoom !== null && realSize
                ? { width: realSize.w * zoom, height: realSize.h * zoom }
                : undefined
            }
            onLoad={(e) =>
              setRealSize({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
            onClick={() => setZoom(zoom === null ? 1 : null)}
          />
        )}
        {kind === "video" && (
          <video
            className="media-video"
            src={url}
            controls
            /* No `autoplay`: opening a file is not asking to play it. Only the
               metadata, which is what draws the bar and the first frame. */
            preload="metadata"
            onLoadedMetadata={(e) =>
              setRealSize({
                w: e.currentTarget.videoWidth,
                h: e.currentTarget.videoHeight,
              })
            }
            onError={() => setFailed(true)}
          />
        )}
        {kind === "audio" && (
          <div className="media-audio">
            <span className="media-card-icon">
              <Music size={26} />
            </span>
            <strong>{name}</strong>
            <audio src={url} controls preload="metadata" onError={() => setFailed(true)} />
          </div>
        )}
        {kind === "pdf" && <iframe className="media-pdf" src={url} aria-label={name} />}
      </div>
    </div>
  );
}
