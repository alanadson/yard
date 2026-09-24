/**
 * `@codemirror/lsp-client`, and the CodeMirror it drags behind it, used to be
 * a third of the startup chunk: `App` runs `useLspLifecycle` on every boot,
 * the hook reaches this store, and the store imported the library by value.
 * So the store may only reach for the library when a server really starts.
 * Reading the catalog, pruning roots and stopping everything are what the
 * boot path calls, and none of them may load it; two files asking for the
 * same server at once still share one load, one process and one client; and a
 * library that cannot be loaded is a start failure like any other, never a
 * server left running with nobody talking to it. The wait for the library sits
 * between the spawn and the client's registration, and a server that dies in
 * that wait must still be reported, as it was when nothing was awaited there.
 *
 * "Loaded" is a property of the module registry, so every test gets a fresh
 * one and the library is counted when its module is evaluated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lspStart, lspSend, lspStop, lspDetect, library, exits } = vi.hoisted(() => ({
  lspStart: vi.fn(async (_id: string, _program: string, _args: string[], _cwd: string) => 4242),
  lspSend: vi.fn(async (_id: string, _message: string) => undefined),
  lspStop: vi.fn(async (_id: string) => undefined),
  lspDetect: vi.fn(async (_refresh: boolean) => [] as unknown[]),
  library: { loads: 0, broken: false, gate: null as Promise<void> | null },
  exits: [] as ((p: { id: string; code: number | null }) => void)[],
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    lspStart,
    lspSend,
    lspStop,
    lspDetect,
    writePref: vi.fn(async () => undefined),
    readPrefs: vi.fn(async () => ({})),
  },
  on: {
    lspMessage: () => Promise.resolve(() => {}),
    lspExit: (cb: (p: { id: string; code: number | null }) => void) => {
      exits.push(cb);
      return Promise.resolve(() => {});
    },
  },
}));

import type { LspServerInfo } from "../lib/ipc";

/**
 * The chunk boundary. A pass-through that only counts how often the module
 * is evaluated, or fails the way a chunk that cannot be read from disk does,
 * or, while `library.gate` is pending, waits like a chunk still on its way.
 * Registered per test (`doMock`, after `resetModules`): a hoisted `vi.mock`
 * keeps its first result for the whole file, and the count would lie.
 */
function watchLibrary() {
  vi.doMock("@codemirror/lsp-client", async (importOriginal) => {
    library.loads += 1;
    if (library.gate) await library.gate;
    if (library.broken) throw new Error("não consegui ler o chunk do lsp-client");
    return importOriginal();
  });
}

const TS: LspServerInfo = {
  languageIds: ["typescript", "javascript"],
  program: "typescript-language-server",
  args: ["--stdio"],
  version: "4.3.3",
  installHint: "npm i -g typescript-language-server typescript",
  found: true,
};
const RA: LspServerInfo = {
  languageIds: ["rust"],
  program: "rust-analyzer",
  args: [],
  version: null,
  installHint: "rustup component add rust-analyzer",
  found: false,
};

const ROOT = "C:\\Workspace\\Code\\yard";

async function freshStores() {
  const { useLsp, PRUNE_GRACE_MS } = await import("./lspStore");
  const { useUI } = await import("./uiStore");
  return { useLsp, useUI, PRUNE_GRACE_MS };
}

function sentMethods(): string[] {
  return lspSend.mock.calls.map((c) => JSON.parse(c[1]).method as string);
}

beforeEach(() => {
  vi.resetModules();
  watchLibrary();
  vi.useFakeTimers();
  library.loads = 0;
  library.broken = false;
  library.gate = null;
  exits.length = 0;
  lspStart.mockClear();
  lspSend.mockClear();
  lspStop.mockClear();
  lspDetect.mockReset();
  lspDetect.mockResolvedValue([TS, RA]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("when the language-server library loads", () => {
  it("nothing short of starting a server loads it", async () => {
    const { useLsp, PRUNE_GRACE_MS } = await freshStores();
    await useLsp.getState().load();
    expect(await useLsp.getState().clientFor(ROOT, "rust")).toBeNull();
    useLsp.getState().pruneRoots(new Set());
    useLsp.getState().pruneRoots(new Set([ROOT]));
    useLsp.getState().stopAll();
    await vi.advanceTimersByTimeAsync(PRUNE_GRACE_MS + 1);

    expect(library.loads).toBe(0);
    expect(lspStart).not.toHaveBeenCalled();
  });

  it("two files asking for the same server at once share one load, one process and one client", async () => {
    const { useLsp } = await freshStores();
    const [a, b] = await Promise.all([
      useLsp.getState().clientFor(ROOT, "typescript"),
      useLsp.getState().clientFor(ROOT, "javascript"),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(library.loads).toBe(1);
    expect(lspStart).toHaveBeenCalledTimes(1);
    expect(sentMethods().filter((m) => m === "initialize")).toHaveLength(1);
  });

  it("a library that cannot be loaded is a start failure: reported once, no server left running, no retry", async () => {
    library.broken = true;
    const { useLsp, useUI } = await freshStores();

    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
    await vi.advanceTimersByTimeAsync(0);

    // The reason is whatever the loader said (vitest wraps the factory's own
    // error, the webview says "Failed to fetch dynamically imported module").
    expect(Object.values(useLsp.getState().failed)).toEqual([expect.stringMatching(/\S/)]);
    expect(useUI.getState().toasts).toHaveLength(1);
    expect(Object.keys(useLsp.getState().clients)).toHaveLength(0);
    // Whatever was spawned before the library gave up is not left orphaned.
    for (const [id] of lspStart.mock.calls) expect(lspStop).toHaveBeenCalledWith(id);
    expect(lspStart.mock.calls.length).toBeLessThanOrEqual(1);
  });

  /**
   * The regression this locks down: the wait for the library came in between
   * the spawn and the client's registration, and an exit that arrived in it
   * found no client, so it was dropped. A dead server was then stored as a
   * live one, with no reason in Settings and no toast. Before the library was
   * lazy nothing was awaited there, and every exit was reported.
   */
  it("a server that dies while the library is still loading is reported like any other exit", async () => {
    let openGate = () => {};
    library.gate = new Promise<void>((resolve) => (openGate = resolve));
    const { useLsp, useUI } = await freshStores();

    const start = useLsp.getState().clientFor(ROOT, "typescript");
    // Spawned and listening for exits; the library is still on its way.
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    const [id] = lspStart.mock.calls[0];
    exits[0]({ id, code: 1 });
    openGate();
    await start;
    await vi.advanceTimersByTimeAsync(0);

    expect(Object.keys(useLsp.getState().clients)).toHaveLength(0);
    expect(Object.values(useLsp.getState().failed)).toEqual([
      "typescript-language-server encerrou (código 1)",
    ]);
    expect(useUI.getState().toasts.map((toast) => toast.message)).toEqual([
      expect.stringMatching(/typescript-language-server parou/),
    ]);
    // Reported once and left alone, like any server that dies.
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
    expect(lspStart).toHaveBeenCalledTimes(1);
  });
});
