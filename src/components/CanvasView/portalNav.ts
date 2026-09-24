import type { CanvasData } from "../../lib/canvas";

/**
 * A portal navigated: its item takes the new url. The same canvas object
 * comes back when nothing on this board matched (the event is app-wide, and
 * every fresh object is a layout write plus a workspace save) or when the
 * portal is already on that url.
 */
export function navigatePortal(c: CanvasData, id: string, url: string): CanvasData {
  const hit = c.items.find((i) => i.type === "portal" && i.id === id);
  if (!hit || hit.type !== "portal" || hit.url === url) return c;
  return {
    ...c,
    items: c.items.map((i) => (i === hit ? { ...i, url } : i)),
  };
}
