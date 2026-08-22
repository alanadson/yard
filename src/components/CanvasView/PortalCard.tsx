/**
 * A portal on the canvas: chrome (url, reload, engine) around a hole
 * where the native webview / spawned browser sits.
 *
 * The native surface is a child of the main window, positioned over
 * `.cv-portal-body` in *screen* coordinates. This component reports that
 * rectangle every frame the parent asks (via `onBounds`), and with it two
 * things no CSS can tell a native window: where the board ends (`clip` — it
 * would paint over the sidebar and the panels otherwise) and which app
 * surfaces have to show through it (`holes` — a menu, the toolbar, a toast).
 * It goes blank only when the spot is genuinely taken: the card off-screen,
 * or a full-screen surface up.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Maximize2,
  MoreVertical,
  MousePointerClick,
  RadioTower,
  RefreshCw,
  RotateCw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { ResizeHandles } from "./ResizeHandles";
import { isLocalUrl } from "../../lib/portalLive";
import { useGrabMode } from "../../hooks/useGrabMode";
import {
  elementBounds,
  holesOver,
  usePortalMenu,
  usePortalSurface,
} from "../../hooks/usePortalSurface";
import { ipc, type PortalPlace } from "../../lib/ipc";
import { portalPreferenceMenu } from "../../lib/portalMenu";
import {
  CANVAS_COLORS,
  PORTAL_MIN_H,
  PORTAL_MIN_W,
  resizeRect,
  type CanvasItem,
  type CanvasViewport,
  type RectPhase,
  type ResizeDir,
} from "../../lib/canvas";
import {
  hostnameOf,
  normalizePortalUrl,
  portalName,
} from "../../lib/portals";
import { rectsOverlap, useOccluders } from "../../stores/occludersStore";
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

/**
 * Why the hole is showing a placeholder instead of the page.
 *
 * `away` is the silent one — off-screen or being erased, nobody is looking.
 * The others are worth a line of text, so a deliberate gap does not read as
 * a broken portal.
 */
type Veil = "opening" | "failed" | "covered" | "away";

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
  /**
   * A surface is up that covers the whole workspace — a modal, Ao Vivo, the
   * diff, the editor, the composer.
   *
   * Only these blank the portal outright. Everything else that floats over
   * the canvas publishes its rectangle (`occludersStore`) and is cut out of
   * the page instead, so the site keeps every pixel a menu does not need.
   */
  covered: boolean;
  /**
   * Bumped whenever the *app* layout moves the canvas without touching the
   * card: opening the sidebar or a panel, resizing the window.
   *
   * The native surface is placed in screen coordinates, so it has to be told.
   * None of the other props change in that case — the card keeps the same
   * world rectangle and the same camera — and the portal used to stay behind,
   * painting the page over whatever the canvas now has in that spot.
   */
  layoutTick: number;
  /**
   * The canvas's rectangle on screen, read at report time.
   *
   * The page is a native window stacked over the app: `overflow: hidden` on
   * the board does nothing to it, so the rectangle it may paint in has to be
   * sent down with the bounds. Without it the site spills over the sidebar,
   * the panels and the title bar the moment the card reaches an edge.
   */
  getClip: () => { x: number; y: number; w: number; h: number } | null;
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
  onBounds: (id: string, place: PortalPlace) => void;
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
  covered,
  layoutTick,
  getClip,
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
  const occluders = useOccluders((s) => s.rects);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sess = useRef<DragSession | null>(null);
  const { menu, openMenu, closeMenu } = usePortalMenu(it.id, bodyRef);
  const [urlDraft, setUrlDraft] = useState(it.url);
  /** Why the site is not on screen — `null` while it is. */
  const [veil, setVeil] = useState<Veil | null>("away");
  // Modo Design lives in `useGrabMode` — the pane browser runs the same
  // picker over the same engine, and the two must not drift.
  const { grabbing, toggleGrab } = useGrabMode(it.id, showToast);

  useEffect(() => {
    setUrlDraft(it.url);
  }, [it.url]);

  /**
   * The "a menu is open" flag belongs to the menu's lifetime, not to the two
   * call sites that used to raise and lower it by hand.
   *
   * That pairing broke whenever the card left with its menu still up (the
   * item deleted from the CLI, the group switched): the flag stayed raised,
   * and with it the transparent sheet that hides every portal and eats clicks
   * on the canvas — a canvas that then looked simply broken.
   */
  const menuOpen = menu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    onMenuOpen?.(true);
    return () => onMenuOpen?.(false);
  }, [menuOpen, onMenuOpen]);

  const bodyBox = () => elementBounds(bodyRef.current);

  /**
   * `null` means "put the page on screen".
   *
   * Everything here is about the *rectangle*, never about the mood of the
   * app: a tool picked in the toolbar, a menu open over another card or a
   * card being resized all leave the site exactly where it is.
   *
   * Off the edge of the *canvas* is off screen: the engine clips the page to
   * that rectangle, and a card scrolled past it has nothing left to show.
   *
   * A menu landing on the card is not in here any more: it is sent down as a
   * hole in the page (`holesOver`), so the site stays where it is and only
   * gives up the few pixels the menu actually needs.
   */
  const hideReason = (box: { w: number; h: number; x: number; y: number }): Veil | null => {
    if (covered) return "covered";
    if (faded) return "away";
    if (box.w <= 8 || box.h <= 8) return "away";
    const clip = getClip();
    const left = Math.max(box.x, clip?.x ?? 0);
    const top = Math.max(box.y, clip?.y ?? 0);
    const right = Math.min(box.x + box.w, clip ? clip.x + clip.w : window.innerWidth);
    const bottom = Math.min(box.y + box.h, clip ? clip.y + clip.h : window.innerHeight);
    if (right - left < 1 || bottom - top < 1) return "away";
    return null;
  };

  /**
   * The app surfaces that land on this card, with a little slack for the
   * shadow around them — anything else on the board is not this card's
   * business and would only cost a region the engine has to rebuild.
   */
  const portalHoles = (box: { x: number; y: number; w: number; h: number }) =>
    holesOver(occluders, box, rectsOverlap);

  /** Camera zoom readable by lifecycle callbacks that settle after this render. */
  const zoomRef = useRef(vp.zoom);
  zoomRef.current = vp.zoom;

  const reportBounds = useCallback(() => {
    const box = bodyBox();
    if (!box) return;
    const why = hideReason(box);
    setVeil(why);
    onBounds(it.id, {
      ...box,
      visible: why === null,
      clip: getClip(),
      holes: portalHoles(box),
      zoom: zoomRef.current,
    });
  }, [covered, faded, getClip, it.id, occluders, onBounds]); // eslint-disable-line react-hooks/exhaustive-deps

  const local = isLocalUrl(it.url);
  const liveOn = local && (it.live ?? true);
  const { ready, failed, retry } = usePortalSurface({
    id: it.id,
    url: it.url,
    engine: it.engine ?? "webview2",
    storage: it.storage,
    ua: it.ua,
    projectId,
    live: liveOn,
    getOpen: () => {
      const box = bodyBox() ?? {
        x: 80,
        y: 80,
        w: Math.max(80, w - 2),
        h: Math.max(80, h - 58),
      };
      return {
        id: it.id,
        url: it.url,
        engine: it.engine ?? "webview2",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        ua: it.ua ?? null,
        storage: it.storage ?? "instance",
        muted: it.muted ?? false,
        projectId,
        clip: getClip(),
        zoom: zoomRef.current,
      };
    },
    reportBounds,
    onError: (error) => showToast(String(error), "error"),
  });

  // Explicit dependencies instead of "every render": the effect reads the
  // DOM (`getBoundingClientRect` forces layout) and the list below is the
  // complete set of things that can move the card on screen — `layoutTick`
  // being everything that moves it without moving *it* (window, panels).
  useLayoutEffect(() => {
    reportBounds();
  }, [reportBounds, vp, dx, dy, w, h, it.x, it.y, layoutTick]);

  const go = (href: string) => {
    const next = normalizePortalUrl(href);
    if (!next) return;
    setUrlDraft(next);
    onPatch(it.id, { url: next });
    void ipc.portalNavigate(it.id, next).catch((e) => showToast(String(e), "error"));
  };

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // No `onSelect` here: `onItemDown` owns the selection rules (replace,
    // keep the group, Shift-toggle) and a single-item select first undoes them.
    onItemDown(e, it.id);
  };

  const startResize = (e: React.PointerEvent, kind: ResizeDir) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(it.id);
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
    onRect(it.id, rectFor(s, e), "commit");
  };

  const menuItems = (): MenuEntry[] => {
    return [
      {
        kind: "swatches",
        colors: CANVAS_COLORS,
        active: it.color,
        onPick: (c) => onPatch(it.id, { color: c }),
      },
      { kind: "sep" },
      ...portalPreferenceMenu({
        id: it.id,
        ua: it.ua,
        storage: it.storage,
        instanceLabel: "desta carta",
        subject: "Portal",
        patch: (change) => onPatch(it.id, change),
        showToast,
      }),
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

  // Until the engine answers, the hole is empty whatever the geometry says.
  const shownVeil: Veil | null = failed ? "failed" : ready ? veil : "opening";

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
        {/* Back without forward is amputated navigation — and the command
            already existed in the backend, with no screen calling it. */}
        <button
          className="icon-btn"
          data-tip="Avançar"
          aria-label="Avançar"
          onClick={() => void ipc.portalForward(it.id).catch(() => {})}
        >
          <ArrowRight size={12} />
        </button>
        <button
          className="icon-btn"
          data-tip="Recarregar"
          aria-label="Recarregar"
          onClick={() => void ipc.portalReload(it.id).catch(() => {})}
        >
          <RefreshCw size={12} />
        </button>
        {local && (
          <button
            className={`icon-btn ${liveOn ? "is-active" : ""}`}
            data-tip-wrap=""
            data-tip={
              liveOn
                ? "Ao vivo: recarrega sozinho quando o site muda — clique para desligar"
                : "Ao vivo desligado — clique para recarregar sozinho quando o site mudar"
            }
            aria-label="Recarregar sozinho quando o site mudar"
            aria-pressed={liveOn}
            onClick={() => onPatch(it.id, { live: !liveOn })}
          >
            <RadioTower size={12} />
          </button>
        )}
        <button
          className={`icon-btn ${grabbing ? "is-active" : ""}`}
          data-tip-wrap=""
          data-tip={
            grabbing
              ? "Clique no elemento dentro da página (Esc cancela)"
              : "Modo design — apontar um elemento e mandar para o agente"
          }
          aria-label="Modo design"
          aria-pressed={grabbing}
          onClick={toggleGrab}
        >
          <MousePointerClick size={12} />
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
            aria-label="Endereço do portal"
            onChange={(e) => setUrlDraft(e.target.value)}
            onFocus={() => onSelect(it.id)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </form>
      </div>

      <div ref={bodyRef} className="cv-portal-body cv-card-body">
        {shownVeil && (
          <div className="cv-portal-ph">
            <Globe size={22} />
            <strong>{hostnameOf(it.url)}</strong>
            {/* The native surface is an OS window on top of the DOM, so a
                full-screen surface has to blank it. Saying so keeps the gap
                from reading as a bug. */}
            {shownVeil !== "away" && (
              <small>
                {shownVeil === "opening"
                  ? "Abrindo o navegador…"
                  : shownVeil === "failed"
                    ? "Não deu para abrir o navegador"
                    : "O site volta quando esta tela sair"}
              </small>
            )}
            {/* Failing with no way out forced closing the card and recreating
                it, which takes the address and the session along. */}
            {shownVeil === "failed" && (
              <button
                className="btn btn--sm"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={retry}
              >
                <RotateCw size={12} aria-hidden="true" /> Tentar de novo
              </button>
            )}
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
        <ContextMenu anchor={menu} items={menuItems()} onClose={closeMenu} />
      )}
    </div>
  );
}

export const PortalCard = memo(PortalCardImpl);
