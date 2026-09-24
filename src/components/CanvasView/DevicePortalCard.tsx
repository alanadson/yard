/**
 * Android screen updates are paused whenever nobody can see them: another
 * surface covers the canvas, the card is off the board, or the window is
 * hidden (`deviceFeed.ts`).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  Home,
  RefreshCw,
  Smartphone,
  Square,
  X,
} from "lucide-react";
import { InlineRename } from "../ContextMenu/InlineRename";
import { ItemMaximizeButton } from "./ItemMaximizeButton";
import { ResizeHandles } from "./ResizeHandles";
import type { PortalCardProps } from "./PortalCard";
import {
  deviceGesture,
  devicePoint,
  type DeviceAction,
} from "../../lib/devicePortal";
import { resizeRect, type ResizeDir } from "../../lib/canvas";
import { ipc } from "../../lib/ipc";
import { useWindowShown } from "../../lib/windowShown";
import { screenFeed } from "./deviceFeed";
import { useT } from "../../hooks/useT";
import { useUI } from "../../stores/uiStore";

export const DevicePortalCard = memo(function DevicePortalCard({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  connectClass,
  covered,
  getZoom,
  onItemDown,
  onItemMove,
  onItemUp,
  onMaximize,
  onDelete,
  onRect,
  renaming,
  onRename,
  onRenameStart,
  onRenameEnd,
  visible = true,
}: PortalCardProps) {
  const t = useT();
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const image = useRef<HTMLImageElement>(null);
  const gesture = useRef<{ x: number; y: number; time: number } | null>(null);
  const resizing = useRef<{
    dir: ResizeDir;
    x: number;
    y: number;
    box: typeof it;
  } | null>(null);
  const serial = it.deviceSerial!;
  const windowShown = useWindowShown();
  const feed = screenFeed({ live, covered, faded, onScreen: visible, windowShown });

  // Keyed on `feed`: coming back from "off" takes a frame at once.
  useEffect(() => {
    if (feed === "off") return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const png = await ipc.deviceAction(serial, { kind: "screenshot" });
        if (!current) return;
        setFrame(`data:image/png;base64,${png}`);
        setError("");
      } catch (e) {
        if (current) setError(String(e));
      } finally {
        if (current && feed === "loop") timer = setTimeout(refresh, 800);
      }
    };
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [serial, feed, tick]);

  const act = useCallback(
    async (action: DeviceAction) => {
      if (pending.current) return false;
      pending.current = true;
      setBusy(true);
      try {
        await ipc.deviceAction(serial, action);
        setTick((value) => value + 1);
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [serial],
  );

  const point = (e: React.PointerEvent) => {
    const element = image.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return devicePoint(
      { x: e.clientX, y: e.clientY },
      { x: box.x, y: box.y, w: box.width, h: box.height },
      { w: element.naturalWidth, h: element.naturalHeight },
    );
  };

  return (
    <div
      className={`cv-tree cv-device ${selected ? "is-selected" : ""} ${connectClass}`}
      data-maximized={!!it.restore}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        width: w,
        height: h,
        opacity: faded ? 0.22 : 1,
      }}
    >
      <div
        className="cv-tree-head"
        style={{ background: it.color }}
        onPointerDown={(e) => onItemDown(e, it.id)}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      >
        <Smartphone size={13} />
        {renaming ? (
          <InlineRename
            value={it.name || serial}
            onCommit={(value) => {
              onRename(it.id, value);
              onRenameEnd();
            }}
            onCancel={onRenameEnd}
          />
        ) : (
          <span
            className="cv-tree-title"
            title={serial}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRenameStart(it.id);
            }}
          >
            {it.name || serial}
          </span>
        )}
        <ItemMaximizeButton item={it} onMaximize={onMaximize} />
        <button
          className="cv-tree-btn"
          aria-label={t("Excluir portal")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onDelete(it.id)}
        >
          <X size={12} />
        </button>
      </div>
      <div
        className="cv-device-tools"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {(
          [
            ["back", "Voltar", ArrowLeft],
            ["home", "Início", Home],
            ["recents", "Aplicativos recentes", Square],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            className="cv-tree-btn"
            disabled={busy}
            aria-label={t(label)}
            onClick={() => void act({ kind: "key", key })}
          >
            <Icon size={13} />
          </button>
        ))}
        <button
          className="cv-tree-btn"
          aria-label={t("Atualizar tela")}
          onClick={() => setTick((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
        <button
          className="cv-tree-btn"
          aria-label={t("Salvar captura")}
          onClick={async () => {
            try {
              const png = await ipc.deviceAction(serial, {
                kind: "screenshot",
              });
              const path = await ipc.clipboardSaveImage(png);
              await navigator.clipboard.writeText(path);
              useUI.getState().showToast(t("Caminho da captura copiado."));
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <Camera size={13} />
        </button>
        <label>
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          {t("Atualização automática")}
        </label>
      </div>
      {error && (
        <p className="cv-device-error" role="alert">
          {t("Não consegui acessar o dispositivo: {error}", { error })}
        </p>
      )}
      <div
        className="cv-device-screen"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {frame ? (
          <img
            ref={image}
            src={frame}
            alt={t("Tela do dispositivo Android")}
            draggable={false}
            onPointerDown={(e) => {
              if (e.button !== 0 || busy) return;
              const p = point(e);
              if (p) {
                gesture.current = { ...p, time: e.timeStamp };
                e.currentTarget.setPointerCapture(e.pointerId);
              }
            }}
            onPointerUp={(e) => {
              const from = gesture.current;
              gesture.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
              const to = point(e);
              if (from && to)
                void act(deviceGesture(from, to, e.timeStamp - from.time));
            }}
            onPointerCancel={() => {
              gesture.current = null;
            }}
          />
        ) : (
          <span>
            {error
              ? t("Conecte o aparelho e autorize a depuração USB.")
              : t("Carregando tela…")}
          </span>
        )}
      </div>
      <form
        className="cv-device-input"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          const draft = text;
          if (draft && (await act({ kind: "text", text: draft })))
            setText((value) => (value === draft ? "" : value));
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t("Texto para o dispositivo")}
          placeholder={t("Digitar no aparelho (ASCII)")}
        />
        <button className="btn" disabled={busy || !text}>
          {t("Enviar")}
        </button>
      </form>
      {!it.pinned && !it.dock && (
        <ResizeHandles
          outside
          onDown={(e, dir) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            resizing.current = { dir, x: e.clientX, y: e.clientY, box: it };
          }}
          onMove={(e) => {
            const r = resizing.current;
            if (r)
              onRect(
                it.id,
                resizeRect(
                  r.box,
                  r.dir,
                  (e.clientX - r.x) / getZoom(),
                  (e.clientY - r.y) / getZoom(),
                  240,
                  300,
                ),
                "live",
              );
          }}
          onUp={(e) => {
            const r = resizing.current;
            resizing.current = null;
            if (r)
              onRect(
                it.id,
                resizeRect(
                  r.box,
                  r.dir,
                  (e.clientX - r.x) / getZoom(),
                  (e.clientY - r.y) / getZoom(),
                  240,
                  300,
                ),
                e.type === "pointercancel" ? "cancel" : "commit",
              );
          }}
        />
      )}
    </div>
  );
});
