/**
 * Which renderer an xterm gets, and when. WebGL arrives through a dynamic
 * import that resolves after the mount effect returned, and a card can be
 * unmounted in that window (a layout switch, a closed tab): loading the
 * addon into a disposed terminal left a WebGL context nobody could release,
 * and Chromium hands a page sixteen of them before it starts killing the
 * oldest, live terminals included.
 */
import { describe, expect, it } from "vitest";
import { attachRenderer, type RendererAddon, type RendererHost, type WebglLike } from "./termRenderer";

/** The addons here carry a name, so the host can say which one it got. */
const nameOf = (addon: RendererAddon) => (addon as { name?: string }).name ?? "?";

/** An xterm as the renderer sees it: what got loaded into it, in order. */
function host(): RendererHost & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    loaded,
    loadAddon: (addon) => loaded.push(nameOf(addon)),
  };
}

interface Fake extends WebglLike {
  name: string;
  disposed: boolean;
  lose: () => void;
}

/** A WebGL addon whose context can be lost at will. */
function webgl(): Fake {
  let onLoss: (() => void) | null = null;
  const addon: Fake = {
    name: "webgl",
    disposed: false,
    dispose: () => {
      addon.disposed = true;
    },
    onContextLoss: (cb) => {
      onLoss = cb;
    },
    lose: () => onLoss?.(),
  };
  return addon;
}

const canvas = (): Fake => ({
  name: "canvas",
  disposed: false,
  dispose() {
    this.disposed = true;
  },
  onContextLoss: () => {},
  lose: () => {},
});

describe("attachRenderer", () => {
  it("canvas is loaded on the spot when it is the preference", async () => {
    const term = host();
    await attachRenderer({ term, prefer: "canvas", webgl: async () => webgl(), canvas, alive: () => true });
    expect(term.loaded).toEqual(["canvas"]);
  });

  it("webgl is loaded once it arrives, and a lost context hands over to canvas", async () => {
    const term = host();
    const gl = webgl();
    await attachRenderer({ term, prefer: "webgl", webgl: async () => gl, canvas, alive: () => true });
    expect(term.loaded).toEqual(["webgl"]);

    gl.lose();
    expect(gl.disposed).toBe(true);
    expect(term.loaded).toEqual(["webgl", "canvas"]);
  });

  it("a webgl addon that arrives after the terminal was disposed is not loaded, and neither is canvas", async () => {
    const term = host();
    let alive = true;
    const pending = attachRenderer({
      term,
      prefer: "webgl",
      webgl: async () => webgl(),
      canvas,
      alive: () => alive,
    });
    alive = false;
    await pending;
    expect(term.loaded).toEqual([]);
  });

  it("a lost context on a terminal already disposed loads nothing", async () => {
    const term = host();
    let alive = true;
    const gl = webgl();
    await attachRenderer({ term, prefer: "webgl", webgl: async () => gl, canvas, alive: () => alive });
    alive = false;
    gl.lose();
    expect(gl.disposed).toBe(true);
    expect(term.loaded).toEqual(["webgl"]);
  });

  it("webgl that fails to load or to start falls back to canvas, once", async () => {
    const failedImport = host();
    await attachRenderer({
      term: failedImport,
      prefer: "webgl",
      webgl: async () => {
        throw new Error("no module");
      },
      canvas,
      alive: () => true,
      warn: () => {},
    });
    expect(failedImport.loaded).toEqual(["canvas"]);

    const refusedByTheGpu = host();
    refusedByTheGpu.loadAddon = (addon) => {
      if (nameOf(addon) === "webgl") throw new Error("no GL");
      refusedByTheGpu.loaded.push(nameOf(addon));
    };
    const warned: unknown[] = [];
    await attachRenderer({
      term: refusedByTheGpu,
      prefer: "webgl",
      webgl: async () => webgl(),
      canvas,
      alive: () => true,
      warn: (e) => warned.push(e),
    });
    expect(refusedByTheGpu.loaded).toEqual(["canvas"]);
    expect(warned).toHaveLength(1);
  });
});
