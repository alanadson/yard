/**
 * Rendered Mermaid and KaTeX blocks, kept for the next mount.
 *
 * The markup depends only on the kind of block, its source and the theme it
 * was drawn for, so a block that mounts again (a scroll, a tab switch, the
 * preview toggled) reads its last render instead of running Mermaid's layout
 * or KaTeX's parser again. Bounded: the 50 blocks used most recently.
 */
import { LruCache } from "./lru";

export const RENDER_CACHE_SIZE = 50;

export type RenderedKind = "mermaid" | "katex";

export interface RenderCache {
  get(kind: RenderedKind, theme: string, source: string): string | undefined;
  set(kind: RenderedKind, theme: string, source: string, markup: string): void;
}

export function createRenderCache(limit = RENDER_CACHE_SIZE): RenderCache {
  const cache = new LruCache<string, string>(limit);
  const key = (kind: RenderedKind, theme: string, source: string) => JSON.stringify([kind, theme, source]);
  return {
    get: (kind, theme, source) => cache.get(key(kind, theme, source)),
    set: (kind, theme, source, markup) => {
      cache.set(key(kind, theme, source), markup);
    },
  };
}

/** The app's cache, shared by every preview. */
export const renderedBlocks = createRenderCache();
