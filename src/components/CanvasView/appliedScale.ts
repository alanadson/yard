/**
 * The render scale a terminal card actually draws with (`lib/renderScale.ts`
 * picks the one the zoom asks for).
 *
 * A new scale is a new font size, and xterm rebuilds its glyph atlas for it
 * even while paused. Off the board nobody sees the glyphs, so the card holds
 * the scale it has and takes the current one when it is visible again.
 */
export function appliedScale(previous: number, next: number, visible: boolean): number {
  return visible ? next : previous;
}
