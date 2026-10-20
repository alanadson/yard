/**
 * Where each board's camera is kept between sessions.
 *
 * The camera used to ride inside the board's `layoutJson`: every pan or zoom
 * re-serialized the whole layout (every stroke point included) and saved
 * the whole workspace. It is not content, so it now has a small kv row per
 * board (`canvas.viewport.<groupId>`), written when the gesture settles.
 *
 * The layout still carries a camera (every content commit writes the current
 * one), and it is the fallback: a board with no row (cloned, imported, older
 * data) opens where its layout says. Nothing here ever writes content, so a
 * lost or rejected row costs a camera position, never a note.
 */
import { DEFAULT_VIEWPORT, ZOOM_MAX, ZOOM_MIN, type CanvasViewport } from "./canvas";
import { persistPref } from "./prefs";

export const VIEWPORT_PREF_PREFIX = "canvas.viewport.";

/** A kv row back into a camera, or `null` for anything not trustworthy. */
export function parseViewport(raw: string | undefined): CanvasViewport | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) return null;
  return { x, y, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) };
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale || 0;
};

export interface ViewportMemory {
  /** Loads the rows read at boot. */
  seed(prefs: Record<string, string>): void;
  /** The board's camera: remembered, else its layout's, else the default. */
  viewportOf(groupId: string, fallback: CanvasViewport | undefined): CanvasViewport;
  /** Keeps the camera and writes its row. */
  remember(groupId: string, viewport: CanvasViewport): void;
}

export function createViewportMemory(write: (key: string, value: string) => void): ViewportMemory {
  const known = new Map<string, CanvasViewport>();
  return {
    seed(prefs) {
      for (const [key, raw] of Object.entries(prefs)) {
        if (!key.startsWith(VIEWPORT_PREF_PREFIX)) continue;
        const viewport = parseViewport(raw);
        if (viewport) known.set(key.slice(VIEWPORT_PREF_PREFIX.length), viewport);
      }
    },
    viewportOf(groupId, fallback) {
      const viewport = known.get(groupId) ?? fallback ?? DEFAULT_VIEWPORT;
      return { ...viewport };
    },
    remember(groupId, viewport) {
      // Hundredths of a world pixel: the camera lands where it was, and the
      // row stays a few dozen bytes.
      const kept = { x: round(viewport.x, 2), y: round(viewport.y, 2), zoom: round(viewport.zoom, 4) };
      const before = known.get(groupId);
      if (before && before.x === kept.x && before.y === kept.y && before.zoom === kept.zoom) return;
      known.set(groupId, kept);
      write(`${VIEWPORT_PREF_PREFIX}${groupId}`, JSON.stringify(kept));
    },
  };
}

/** The app's cameras, written through the prefs transport. */
export const viewports = createViewportMemory((key, value) =>
  persistPref(key, value, (error) => console.warn("[yard] could not save the canvas camera", error)),
);
