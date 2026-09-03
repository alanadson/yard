/**
 * A browser tab's body in the pane grid — what the pane draws when its
 * active tab is a `PaneBrowser`.
 *
 * Same native engine as a canvas portal card (`portal.rs`), different frame:
 * no camera, no zoom, no resize handles. The clip *is* the body's own
 * rectangle — the page may never paint outside the pane — and the surface
 * only has to be re-placed when something moves that rectangle: the pane
 * dividers, the sidebar, the window. Every one of those changes the body's
 * *size*, so a ResizeObserver on it replaces the per-frame reporting the
 * canvas needs.
 *
 * Only the active browser tab is mounted. That is safe because unmounting
 * merely hides the engine (1x1, invisible): the page, its scroll and its
 * session all live in the backend registry, and remounting re-places the
 * same surface without a reload.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  MousePointerClick,
  RadioTower,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";

import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { useGrabMode } from "../../hooks/useGrabMode";
import { usePortalsCovered } from "../../hooks/usePortalsCovered";
import { useT } from "../../hooks/useT";
import { t } from "../../lib/i18n";
import {
  elementBounds,
  holesOver,
  usePortalMenu,
  usePortalSurface,
} from "../../hooks/usePortalSurface";
import { ipc } from "../../lib/ipc";
import { isLocalUrl } from "../../lib/portalLive";
import { portalPreferenceMenu } from "../../lib/portalMenu";
import { hostnameOf, normalizePortalUrl } from "../../lib/portals";
import { useBrowsers, type PaneBrowser } from "../../stores/browsersStore";
import { rectsOverlap, useOccluders } from "../../stores/occludersStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

/** What the tab strip calls this tab. */
export function browserLabel(tab: PaneBrowser): string {
  return tab.name || tab.title || hostnameOf(tab.url) || "Navegador";
}

/**
 * Why the pane is showing a placeholder instead of the page — the same
 * vocabulary as the canvas card, minus `away` (a mounted pane body is always
 * on screen).
 */
type Veil = "opening" | "failed" | "covered" | "away";

function BrowserBodyImpl({ tab }: { tab: PaneBrowser }) {
  const t = useT();
  const showToast = useUI((s) => s.showToast);
  const patch = useBrowsers((s) => s.patch);
  const occluders = useOccluders((s) => s.rects);
  // The surfaces that cover the workspace whole, one registry (`lib/layers`),
  // shared with the canvas card: only these blank the page, everything else
  // that floats becomes a hole cut out of it.
  const covered = usePortalsCovered();

  const projectId = useProjects((s) => s.projectOfGroup(tab.groupId)?.id ?? null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [urlDraft, setUrlDraft] = useState(tab.url);
  /** Why the site is not on screen — `null` while it is. */
  const [veil, setVeil] = useState<Veil | null>("away");
  const { grabbing, toggleGrab } = useGrabMode(tab.id, showToast);
  const { menu, closeMenu } = usePortalMenu(tab.id, bodyRef);

  useEffect(() => {
    setUrlDraft(tab.url);
  }, [tab.url]);

  const bodyBox = () => elementBounds(bodyRef.current);

  const hideReason = (box: { w: number; h: number }): Veil | null => {
    if (covered) return "covered";
    if (box.w <= 8 || box.h <= 8) return "away";
    return null;
  };

  /** App surfaces that land on this pane — cut out of the page as holes. */
  const portalHoles = (box: { x: number; y: number; w: number; h: number }) =>
    holesOver(occluders, box, rectsOverlap);

  // Readable from callbacks that land after the render that started them —
  // opening the engine takes hundreds of milliseconds.
  const hideRef = useRef(hideReason);
  hideRef.current = hideReason;
  const holesRef = useRef(portalHoles);
  holesRef.current = portalHoles;
  const lastPlace = useRef("");

  const reportBounds = useCallback(() => {
    const box = bodyBox();
    if (!box) return;
    const why = hideRef.current(box);
    setVeil(why);
    const place = {
        ...box,
        visible: why === null,
        clip: box,
        holes: holesRef.current(box),
        zoom: 1,
      };
    const fingerprint = JSON.stringify(place);
    if (lastPlace.current === fingerprint) return;
    lastPlace.current = fingerprint;
    void ipc.portalSetBounds(tab.id, place).catch(() => {});
  }, [tab.id]);

  /**
   * Everything that moves the body on screen changes its size — dividers,
   * sidebar, panels, window — so one observer covers what the canvas needs a
   * whole `layoutTick` machine for.
   */
  const reportRef = useRef(reportBounds);
  reportRef.current = reportBounds;
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        reportRef.current();
      });
    };
    window.addEventListener("resize", bump);
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", bump);
      ro.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    reportBounds();
  }, [reportBounds, covered, occluders]);

  const local = isLocalUrl(tab.url);
  const liveOn = local && (tab.live ?? true);
  const { ready, failed, retry } = usePortalSurface({
    id: tab.id,
    url: tab.url,
    engine: "webview2",
    storage: tab.storage,
    ua: tab.ua,
    projectId,
    live: liveOn,
    getOpen: () => {
      const box = bodyBox() ?? { x: 80, y: 80, w: 320, h: 240 };
      return {
        id: tab.id,
        url: tab.url,
        engine: "webview2",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        ua: tab.ua ?? null,
        storage: tab.storage ?? "instance",
        muted: tab.muted ?? false,
        projectId,
        clip: box,
        zoom: 1,
      };
    },
    reportBounds,
    onError: (error) => showToast(String(error), "error"),
  });

  const go = (href: string) => {
    const next = normalizePortalUrl(href);
    if (!next) return;
    setUrlDraft(next);
    patch(tab.id, { url: next });
    void ipc.portalNavigate(tab.id, next).catch((e) => showToast(String(e), "error"));
  };

  const shownVeil: Veil | null = failed ? "failed" : ready ? veil : "opening";

  return (
    <div className="pane-browser">
      <div className="cv-portal-bar pane-browser-bar">
        <button
          className="icon-btn"
          data-tip={t("Voltar")}
          aria-label={t("Voltar")}
          onClick={() => void ipc.portalBack(tab.id).catch(() => {})}
        >
          <ArrowLeft size={18} />
        </button>
        {/* Back without forward is amputated navigation — and the command
            already existed in the backend, with no screen calling it. */}
        <button
          className="icon-btn"
          data-tip={t("Avançar")}
          aria-label={t("Avançar")}
          onClick={() => void ipc.portalForward(tab.id).catch(() => {})}
        >
          <ArrowRight size={18} />
        </button>
        <button
          className="icon-btn"
          data-tip={t("Recarregar")}
          aria-label={t("Recarregar")}
          onClick={() => void ipc.portalReload(tab.id).catch(() => {})}
        >
          <RefreshCw size={18} />
        </button>
        {local && (
          <button
            className={`icon-btn ${liveOn ? "is-active" : ""}`}
            data-tip-wrap=""
            data-tip={
              liveOn
                ? t("Ao vivo: recarrega sozinho quando o site muda — clique para desligar")
                : t("Ao vivo desligado — clique para recarregar sozinho quando o site mudar")
            }
            aria-label={t("Recarregar sozinho quando o site mudar")}
            aria-pressed={liveOn}
            onClick={() => patch(tab.id, { live: !liveOn })}
          >
            <RadioTower size={18} />
          </button>
        )}
        <button
          className={`icon-btn ${grabbing ? "is-active" : ""}`}
          data-tip-wrap=""
          data-tip={
            grabbing
              ? t("Clique no elemento dentro da página (Esc cancela)")
              : t("Modo design — apontar um elemento e mandar para o agente")
          }
          aria-label={t("Modo design")}
          aria-pressed={grabbing}
          onClick={toggleGrab}
        >
          <MousePointerClick size={18} />
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
            aria-label={t("Endereço")}
            placeholder={t("Endereço — http://localhost:5173, exemplo.com…")}
            // A tab born blank exists to receive an address.
            autoFocus={tab.url === "about:blank"}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
        </form>
      </div>

      <div ref={bodyRef} className="cv-portal-body pane-browser-body">
        {shownVeil && (
          <div className="cv-portal-ph">
            <Globe size={22} />
            <strong>{hostnameOf(tab.url) || t("Navegador")}</strong>
            {shownVeil !== "away" && (
              <small>
                {shownVeil === "opening"
                  ? t("Abrindo o navegador…")
                  : shownVeil === "failed"
                    ? t("Não deu para abrir o navegador")
                    : t("O site volta quando esta tela sair")}
              </small>
            )}
            {shownVeil === "failed" && (
              <button className="btn btn--sm" onClick={retry}>
                <RotateCw size={12} aria-hidden="true" /> {t("Tentar de novo")}
              </button>
            )}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          anchor={menu}
          items={[
            ...browserMenuItems(tab, showToast),
            { kind: "sep" },
            {
              id: "close",
              label: t("Fechar navegador"),
              icon: <X size={13} />,
              danger: true,
              onSelect: () => useBrowsers.getState().close(tab.id),
            },
          ]}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

export const BrowserBody = memo(BrowserBodyImpl);

/**
 * The browser entries of a pane tab's context menu — the same knobs the
 * canvas card offers, wired to the store instead of the canvas item.
 */
export function browserMenuItems(
  tab: PaneBrowser,
  showToast: (message: string, kind?: "info" | "error") => void,
): MenuEntry[] {
  const { patch } = useBrowsers.getState();
  return portalPreferenceMenu({
    id: tab.id,
    ua: tab.ua,
    storage: tab.storage,
    instanceLabel: t("desta aba"),
    subject: t("Navegador"),
    patch: (change) => patch(tab.id, change),
    showToast,
  });
}
