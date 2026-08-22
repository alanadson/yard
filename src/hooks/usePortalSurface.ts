import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { MenuAnchor } from "../components/ContextMenu";
import { ipc, type PortalOpen, type PortalRect } from "../lib/ipc";
import { watchPortalMenu } from "../lib/portalEvents";
import { watchPortal } from "../lib/portalLive";

export function elementBounds(element: HTMLElement | null): PortalRect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

export function holesOver(
  occluders: Record<string, PortalRect>,
  box: PortalRect,
  overlaps: (a: PortalRect, b: PortalRect) => boolean,
  padding = 4,
): PortalRect[] {
  const holes: PortalRect[] = [];
  for (const rect of Object.values(occluders)) {
    const hole = {
      x: rect.x - padding,
      y: rect.y - padding,
      w: rect.w + padding * 2,
      h: rect.h + padding * 2,
    };
    if (overlaps(box, hole)) holes.push(hole);
  }
  return holes;
}

interface PortalSurfaceOptions {
  id: string;
  url: string;
  engine?: string;
  storage?: string;
  ua?: string;
  projectId: string | null;
  live: boolean;
  getOpen: () => PortalOpen;
  reportBounds: () => void;
  onError: (error: unknown) => void;
}

/** Owns the native engine lifecycle shared by pane browsers and canvas cards. */
export function usePortalSurface({
  id,
  url,
  engine,
  storage,
  ua,
  projectId,
  live,
  getOpen,
  reportBounds,
  onError,
}: PortalSurfaceOptions): { ready: boolean; failed: boolean; retry: () => void } {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openNonce, setOpenNonce] = useState(0);
  const opening = useRef(false);
  const reopen = useRef(false);
  const getOpenRef = useRef(getOpen);
  const reportRef = useRef(reportBounds);
  const errorRef = useRef(onError);
  getOpenRef.current = getOpen;
  reportRef.current = reportBounds;
  errorRef.current = onError;

  useEffect(() => {
    if (opening.current) {
      reopen.current = true;
      return;
    }
    opening.current = true;
    setReady(false);
    setFailed(false);
    void ipc
      .portalOpen(getOpenRef.current())
      .then(() => {
        setReady(true);
        reportRef.current();
      })
      .catch((error) => {
        setFailed(true);
        errorRef.current(error);
      })
      .finally(() => {
        opening.current = false;
        if (reopen.current) {
          reopen.current = false;
          setOpenNonce((nonce) => nonce + 1);
        }
      });
  }, [id, engine, storage, ua, projectId, openNonce]);

  useEffect(
    () => () => {
      void ipc.portalSetBounds(id, { x: 0, y: 0, w: 1, h: 1, visible: false }).catch(() => {});
    },
    [id],
  );

  useEffect(() => {
    if (!live) return;
    return watchPortal(id, url);
  }, [id, live, url]);

  /**
   * Tries to open again after a failure.
   *
   * The "could not open the browser" state had no way out at all: the only
   * way back was to close the card (or the tab) and recreate it, which takes
   * the address and the session along. The same opening effect serves —
   * just ask for another round.
   */
  const retry = useCallback(() => {
    if (opening.current) return;
    setFailed(false);
    setOpenNonce((nonce) => nonce + 1);
  }, []);

  return { ready, failed, retry };
}

/** One menu subscription and coordinate conversion for either portal host. */
export function usePortalMenu(
  id: string,
  bodyRef: RefObject<HTMLElement>,
): {
  menu: MenuAnchor | null;
  openMenu: (x: number, y: number) => void;
  closeMenu: () => void;
} {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const openMenu = useCallback((x: number, y: number) => setMenu({ x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(
    () =>
      watchPortalMenu(id, (event) => {
        const box = bodyRef.current?.getBoundingClientRect();
        openMenu((box?.left ?? 0) + event.x, (box?.top ?? 0) + event.y);
      }),
    [bodyRef, id, openMenu],
  );

  return { menu, openMenu, closeMenu };
}
