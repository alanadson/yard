/**
 * A portal on the canvas: chrome (url, reload, engine) around a hole
 * where the native webview / spawned browser sits.
 *
 * The native surface is a child of the main window, positioned over
 * `.cv-portal-body` in *screen* coordinates. This component reports
 * that rectangle every frame the parent asks (via `onBounds`) and
 * hides it when zoom is too far, the card is off-screen, or a canvas
 * overlay is eating pointer events.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Globe,
  Maximize2,
  MoreVertical,
  RefreshCw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { ResizeHandles } from "./ResizeHandles";
import { ipc, on } from "../../lib/ipc";
import {
  CANVAS_COLORS,
  PORTAL_MIN_H,
  PORTAL_MIN_W,
  resizeRect,
  type CanvasItem,
  type CanvasViewport,
  type PortalStorage,
  type RectPhase,
  type ResizeDir,
} from "../../lib/canvas";
import {
  hostnameOf,
  normalizePortalUrl,
  portalName,
  UA_PRESET_IDS,
} from "../../lib/portals";
import { useUI } from "../../stores/uiStore";

export type PortalData = Extract<CanvasItem, { type: "portal" }>;

interface DragSession {
  kind: ResizeDir;
  pointerId: number;
  cx: number;
  cy: number;
  start: { x: number; y: number; w: number; h: number };
}

export type { RectPhase };

interface Props {
  it: PortalData;
  dx: number;
  dy: number;
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  connectClass: string;
  getZoom: () => number;
  /**
   * The camera, passed in **only** so this card re-renders when it moves.
   *
   * The engine's surface is an OS window positioned in screen coordinates: it
   * has to be told the new rectangle on every pan and zoom. Without this prop
   * the memo below (correctly) bails out on a camera move — every other prop
   * is identical — and the native surface stays behind while the card slides.
   */
  vp: CanvasViewport;
  overlayActive: boolean;
  projectId: string | null;
  onSelect: (id: string) => void;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  onPatch: (id: string, patch: Partial<PortalData>) => void;
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
  onMenuOpen?: (open: boolean) => void;
  onRect: (
    id: string,
    rect: { x: number; y: number; w: number; h: number },
    phase: RectPhase,
  ) => void;
  onBounds: (id: string, box: { x: number; y: number; w: number; h: number; visible: boolean }) => void;
}

function PortalCardImpl({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  connectClass,
  getZoom,
  vp,
  overlayActive,
  projectId,
  onSelect,
  onItemDown,
  onItemMove,
  onItemUp,
  onPatch,
  onDelete,
  onFocus,
  onMenuOpen,
  onRect,
  onBounds,
}: Props) {
  const showToast = useUI((s) => s.showToast);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sess = useRef<DragSession | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [urlDraft, setUrlDraft] = useState(it.url);
  const [nativeOn, setNativeOn] = useState(false);
  const [resizing, setResizing] = useState(false);
  const opening = useRef(false);

  useEffect(() => {
    setUrlDraft(it.url);
  }, [it.url]);

  const openMenu = (x: number, y: number) => {
    setMenu({ x, y });
    onMenuOpen?.(true);
  };

  useEffect(() => {
    let gone = false;
    let un: (() => void) | undefined;
    void on
      .portalMenu((p) => {
        if (gone || p.id !== it.id) return;
        const box = bodyRef.current?.getBoundingClientRect();
        openMenu((box?.left ?? 0) + p.x, (box?.top ?? 0) + p.y);
      })
      .then((u) => {
        if (gone) u();
        else un = u;
      });
    return () => {
      gone = true;
      un?.();
    };
  }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const bodyBox = () => {
    const el = bodyRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  const shouldShow = (box: { w: number; h: number; x: number; y: number }) =>
    !overlayActive &&
    !faded &&
    !resizing &&
    box.w > 8 &&
    box.h > 8 &&
    box.y + box.h > 0 &&
    box.x + box.w > 0 &&
    box.y < window.innerHeight &&
    box.x < window.innerWidth;

  // Open the engine on the card's real rectangle — never off-screen.
  // Recreates only when engine / storage / UA change.
  useEffect(() => {
    if (opening.current) return;
    opening.current = true;
    const box = bodyBox() ?? { x: 80, y: 80, w: Math.max(80, w - 2), h: Math.max(80, h - 58) };
    void ipc
      .portalOpen({
        id: it.id,
        url: it.url,
        engine: "webview2",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        ua: it.ua ?? null,
        storage: it.storage ?? "instance",
        muted: it.muted ?? false,
        projectId,
      })
      .then(() => {
        const now = bodyBox();
        if (now) {
          const vis = shouldShow(now);
          setNativeOn(vis);
          onBounds(it.id, { ...now, visible: vis });
        }
      })
      .catch((e) => {
        showToast(String(e), "error");
      })
      .finally(() => {
        opening.current = false;
      });
  }, [it.id, it.engine, it.storage, it.ua, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      void ipc.portalSetBounds(it.id, 0, 0, 1, 1, false).catch(() => {});
    };
  }, [it.id]);

  const reportBounds = useCallback(() => {
    const box = bodyBox();
    if (!box) return;
    const visible = shouldShow(box);
    setNativeOn(visible);
    onBounds(it.id, { ...box, visible });
  }, [faded, it.id, onBounds, overlayActive, resizing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Explicit dependencies instead of "every render": the effect reads the
  // DOM (`getBoundingClientRect` forces layout) and the list below is the
  // complete set of things that can move the card on screen.
  useLayoutEffect(() => {
    reportBounds();
  }, [reportBounds, vp, dx, dy, w, h, it.x, it.y]);

  const go = (href: string) => {
    const next = normalizePortalUrl(href);
    if (!next) return;
    setUrlDraft(next);
    onPatch(it.id, { url: next });
    void ipc.portalNavigate(it.id, next).catch((e) => showToast(String(e), "error"));
  };

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onSelect(it.id);
    onItemDown(e, it.id);
  };

  const startResize = (e: React.PointerEvent, kind: ResizeDir) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(it.id);
    setResizing(true);
    sess.current = {
      kind,
      pointerId: e.pointerId,
      cx: e.clientX,
      cy: e.clientY,
      start: { x: it.x + dx, y: it.y + dy, w, h },
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const rectFor = (s: DragSession, e: React.PointerEvent) => {
    const z = getZoom();
    return resizeRect(
      s.start,
      s.kind,
      (e.clientX - s.cx) / z,
      (e.clientY - s.cy) / z,
      PORTAL_MIN_W,
      PORTAL_MIN_H,
    );
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const s = sess.current;
    if (!s || e.pointerId !== s.pointerId) return;
    onRect(it.id, rectFor(s, e), "live");
  };

  const onResizeUp = (e: React.PointerEvent) => {
    const s = sess.current;
    if (!s || e.pointerId !== s.pointerId) return;
    sess.current = null;
    setResizing(false);
    onRect(it.id, rectFor(s, e), "commit");
  };

  const menuItems = (): MenuEntry[] => {
    const uas: MenuEntry[] = UA_PRESET_IDS.map((id) => ({
      id: `ua-${id}`,
      label: id === "desktop" ? "UA: desktop (padrão)" : `UA: ${id}`,
      onSelect: () => {
        const next = id === "desktop" ? undefined : id;
        onPatch(it.id, { ua: next });
        void ipc.portalSetUa(it.id, next ?? null).catch((e) => showToast(String(e), "error"));
      },
    }));
    const scopes: PortalStorage[] = ["instance", "workspace", "global"];
    const scopeLabels: Record<PortalStorage, string> = {
      instance: "Cookies: desta carta",
      workspace: "Cookies: deste projeto",
      global: "Cookies: global",
    };
    return [
      {
        kind: "swatches",
        colors: CANVAS_COLORS,
        active: it.color,
        onPick: (c) => onPatch(it.id, { color: c }),
      },
      { kind: "sep" },
      ...uas,
      { kind: "sep" },
      ...scopes.map((s) => ({
        id: `st-${s}`,
        label: scopeLabels[s],
        onSelect: () => onPatch(it.id, { storage: s }),
      })),
      { kind: "sep" },
      {
        id: "mute",
        label: it.muted ? "Ativar som" : "Silenciar",
        icon: it.muted ? <Volume2 size={13} /> : <VolumeX size={13} />,
        onSelect: () => {
          const muted = !it.muted;
          onPatch(it.id, { muted });
          void ipc.portalSetMuted(it.id, muted).catch(() => {});
        },
      },
      {
        id: "del",
        label: "Fechar portal",
        icon: <X size={13} />,
        danger: true,
        onSelect: () => onDelete(it.id),
      },
    ];
  };

  return (
    <div
      className={`cv-card cv-portal ${selected ? "is-focused" : ""} ${connectClass}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
      style={{
        left: it.x + dx,
        top: it.y + dy,
        width: w,
        height: h,
        opacity: faded ? 0.22 : 1,
      }}
    >
      <div
        className="cv-card-head"
        style={it.color ? { background: it.color } : undefined}
        onPointerDown={onHeadDown}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onFocus(it.id);
        }}

      >
        <Globe size={12} />
        <span className="cv-card-title">{portalName(it)}</span>
        <div className="cv-card-actions">
          <button
            className="icon-btn"
            data-tip="Preencher a tela (100%)"
            aria-label="Maximizar no canvas"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onFocus(it.id);
            }}
          >
            <Maximize2 size={12} />
          </button>
          <button
            className="icon-btn"
            data-tip-at="right" data-tip={it.muted ? "Ativar som" : "Silenciar"}
            aria-label={it.muted ? "Ativar som" : "Silenciar"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const muted = !it.muted;
              onPatch(it.id, { muted });
              void ipc.portalSetMuted(it.id, muted).catch(() => {});
            }}
          >
            {it.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button
            className="icon-btn"
            data-tip-at="right" data-tip="Mais"
            aria-label="Menu do portal"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu(r.left, r.bottom + 4);
            }}
          >
            <MoreVertical size={12} />
          </button>
          <button
            className="icon-btn"
            data-tip-at="right" data-tip="Fechar"
            aria-label="Fechar portal"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(it.id);
            }}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="cv-portal-bar">
        <button
          className="icon-btn"
          data-tip="Voltar"
          aria-label="Voltar"
          onClick={() => void ipc.portalBack(it.id).catch(() => {})}
        >
          <ArrowLeft size={12} />
        </button>
        <button
          className="icon-btn"
          data-tip="Recarregar"
          aria-label="Recarregar"
          onClick={() => void ipc.portalReload(it.id).catch(() => {})}
        >
          <RefreshCw size={12} />
        </button>
        <form
          className="cv-portal-url"
          onSubmit={(e) => {
            e.preventDefault();
            go(urlDraft);
          }}
        >
          <input
            value={urlDraft}
            spellCheck={false}
            onChange={(e) => setUrlDraft(e.target.value)}
            onFocus={() => onSelect(it.id)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </form>
      </div>

      <div ref={bodyRef} className="cv-portal-body cv-card-body">
        {!nativeOn && (
          <div className="cv-portal-ph">
            <Globe size={22} />
            <strong>{hostnameOf(it.url)}</strong>
            {/* The native surface is an OS window on top of the DOM: it has to
                step aside for menus and for the resize preview. Saying which
                one it is keeps the gap from reading as a bug. */}
            <small>
              {resizing
                ? "Solte para o site voltar no novo tamanho"
                : overlayActive
                  ? "O site volta quando o menu ou a ferramenta sair"
                  : "Abrindo o navegador…"}
            </small>
          </div>
        )}
      </div>

      <ResizeHandles
        outside
        onDown={startResize}
        onMove={onResizeMove}
        onUp={onResizeUp}
      />

      {menu && (
        <ContextMenu
          anchor={menu}
          items={menuItems()}
          onClose={() => {
            setMenu(null);
            onMenuOpen?.(false);
          }}
        />
      )}
    </div>
  );
}

export const PortalCard = memo(PortalCardImpl);
