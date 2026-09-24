/**
 * Which renderer an xterm gets: canvas on the spot, or WebGL once its module
 * arrives, with canvas as the fallback for a GPU that refuses it and for a
 * context lost later.
 *
 * Free of xterm and of React on purpose: the addons and the "still mounted"
 * answer come in as parameters, so the race that mattered is a plain test.
 * The WebGL module resolves after the mount effect returned, and a terminal
 * can be disposed in that window (a layout switch, a closed tab); loading
 * the addon into it left a WebGL context nobody could release, and Chromium
 * hands a page sixteen of them before it starts killing the oldest, live
 * terminals included.
 */

export interface RendererAddon {
  dispose(): void;
}

export interface WebglLike extends RendererAddon {
  onContextLoss(listener: () => void): unknown;
}

/** An xterm as the renderer sees it. */
export interface RendererHost {
  loadAddon(addon: RendererAddon): void;
}

export interface RendererChoice {
  term: RendererHost;
  prefer: "webgl" | "canvas";
  /** The WebGL addon, built: an import that may fail, a constructor that may throw. */
  webgl: () => Promise<WebglLike>;
  canvas: () => RendererAddon;
  /** Whether the terminal is still mounted: nothing is loaded into one that is not. */
  alive: () => boolean;
  /** Told why WebGL was given up on. */
  warn?: (error: unknown) => void;
}

/** Resolves once the renderer is in place, or once it was decided not to be. */
export async function attachRenderer(choice: RendererChoice): Promise<void> {
  const { term, canvas, alive } = choice;
  if (choice.prefer !== "webgl") {
    term.loadAddon(canvas());
    return;
  }
  let addon: WebglLike;
  try {
    addon = await choice.webgl();
  } catch (error) {
    choice.warn?.(error);
    if (alive()) term.loadAddon(canvas());
    return;
  }
  if (!alive()) {
    addon.dispose();
    return;
  }
  // A lost GL context (driver reset, GPU sleep) leaves xterm with no
  // renderer at all: the canvas one takes over, as it would have if WebGL
  // had failed to load in the first place.
  addon.onContextLoss(() => {
    addon.dispose();
    if (alive()) term.loadAddon(canvas());
  });
  try {
    term.loadAddon(addon);
  } catch (error) {
    choice.warn?.(error);
    term.loadAddon(canvas());
  }
}
