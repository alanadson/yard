/**
 * One language server per (project root, server program), started on the
 * first file that needs it and never twice; a server that fails to start or
 * dies is reported once and left alone until the user asks again — a client
 * that restarts a crashing `rust-analyzer` in a loop is worse than none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lspStart, lspSend, lspStop, lspDetect, listeners, writePref } = vi.hoisted(() => ({
  lspStart: vi.fn(async (_id: string, _program: string, _args: string[], _cwd: string) => 4242),
  lspSend: vi.fn(async (_id: string, _message: string) => undefined),
  lspStop: vi.fn(async (_id: string) => undefined),
  lspDetect: vi.fn(async (_refresh: boolean) => [] as unknown[]),
  listeners: {
    message: [] as ((p: { id: string; message: string }) => void)[],
    exit: [] as ((p: { id: string; code: number | null }) => void)[],
  },
  writePref: vi.fn(async () => undefined),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { lspStart, lspSend, lspStop, lspDetect, writePref, readPrefs: vi.fn(async () => ({})) },
  on: {
    lspMessage: (cb: (p: { id: string; message: string }) => void) => {
      listeners.message.push(cb);
      return Promise.resolve(() => {
        const i = listeners.message.indexOf(cb);
        if (i >= 0) listeners.message.splice(i, 1);
      });
    },
    lspExit: (cb: (p: { id: string; code: number | null }) => void) => {
      listeners.exit.push(cb);
      return Promise.resolve(() => {
        const i = listeners.exit.indexOf(cb);
        if (i >= 0) listeners.exit.splice(i, 1);
      });
    },
  },
}));

import type { LspServerInfo } from "../lib/ipc";
import { useLsp, PRUNE_GRACE_MS } from "./lspStore";
import { useUI } from "./uiStore";

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

function sentMethods(): string[] {
  return lspSend.mock.calls.map((c) => JSON.parse(c[1]).method as string);
}

beforeEach(() => {
  vi.useFakeTimers();
  lspStart.mockClear();
  lspSend.mockClear();
  lspStop.mockClear();
  lspDetect.mockReset();
  lspDetect.mockResolvedValue([TS, RA]);
  listeners.message.length = 0;
  listeners.exit.length = 0;
  useLsp.getState().reset();
  useUI.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLsp.clientFor", () => {
  it("starts nothing and answers null for a language without an installed server", async () => {
    expect(await useLsp.getState().clientFor(ROOT, "rust")).toBeNull();
    expect(await useLsp.getState().clientFor(ROOT, "haskell")).toBeNull();
    expect(lspStart).not.toHaveBeenCalled();
  });

  it("starts the server in the project root and opens the conversation with initialize", async () => {
    const client = await useLsp.getState().clientFor(ROOT, "typescript");
    expect(client).not.toBeNull();
    expect(lspStart).toHaveBeenCalledTimes(1);
    const [id, program, args, cwd] = lspStart.mock.calls[0];
    expect(id).toMatch(/^lsp-/);
    expect(program).toBe("typescript-language-server");
    expect(args).toEqual(["--stdio"]);
    expect(cwd).toBe(ROOT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentMethods()).toContain("initialize");
    const init = JSON.parse(lspSend.mock.calls[0][1]);
    expect(init.params.rootUri).toBe("file:///C:/Workspace/Code/yard");
  });

  it("reuses one client for every file and language the same server takes", async () => {
    const a = await useLsp.getState().clientFor(ROOT, "typescript");
    const b = await useLsp.getState().clientFor(ROOT, "javascript");
    const c = await useLsp.getState().clientFor("c:/workspace/code/yard/", "typescript");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(lspStart).toHaveBeenCalledTimes(1);
  });

  it("keeps separate clients for separate roots", async () => {
    const a = await useLsp.getState().clientFor(ROOT, "typescript");
    const b = await useLsp.getState().clientFor("D:\\other", "typescript");
    expect(a).not.toBe(b);
    expect(lspStart).toHaveBeenCalledTimes(2);
  });

  it("does not start the same server twice when two files ask at once", async () => {
    const [a, b] = await Promise.all([
      useLsp.getState().clientFor(ROOT, "typescript"),
      useLsp.getState().clientFor(ROOT, "javascript"),
    ]);
    expect(a).toBe(b);
    expect(lspStart).toHaveBeenCalledTimes(1);
  });

  /** A server that will not start is reported once; the next file does not try again. */
  it("remembers a start failure and does not retry until asked", async () => {
    lspStart.mockRejectedValueOnce(new Error("não consegui iniciar typescript-language-server: ENOENT"));
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
    expect(lspStart).toHaveBeenCalledTimes(1);
    expect(Object.values(useLsp.getState().failed)[0]).toMatch(/ENOENT/);
    expect(useUI.getState().toasts).toHaveLength(1);
    // The user pressed "Procurar de novo": the slate is clean.
    await useLsp.getState().load(true);
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).not.toBeNull();
    expect(lspStart).toHaveBeenCalledTimes(2);
  });

  it("a server that dies is dropped, reported once, and not restarted on its own", async () => {
    await useLsp.getState().clientFor(ROOT, "typescript");
    const id = lspStart.mock.calls[0][0];
    for (const cb of listeners.exit) cb({ id, code: 101 });
    expect(Object.keys(useLsp.getState().clients)).toHaveLength(0);
    expect(Object.values(useLsp.getState().failed)[0]).toMatch(/101/);
    expect(useUI.getState().toasts).toHaveLength(1);
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
    expect(lspStart).toHaveBeenCalledTimes(1);
  });
});

describe("useLsp.pruneRoots", () => {
  it("stops the servers of a root with no file open, after the grace period", async () => {
    await useLsp.getState().clientFor(ROOT, "typescript");
    const id = lspStart.mock.calls[0][0];
    useLsp.getState().pruneRoots(new Set());
    expect(lspStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PRUNE_GRACE_MS + 1);
    expect(lspStop).toHaveBeenCalledWith(id);
    expect(Object.keys(useLsp.getState().clients)).toHaveLength(0);
    // A stop we asked for is not a failure: the next file starts a fresh one.
    expect(useLsp.getState().failed).toEqual({});
  });

  it("a file reopened inside the grace period keeps the server", async () => {
    await useLsp.getState().clientFor(ROOT, "typescript");
    useLsp.getState().pruneRoots(new Set());
    useLsp.getState().pruneRoots(new Set([ROOT]));
    await vi.advanceTimersByTimeAsync(PRUNE_GRACE_MS + 1);
    expect(lspStop).not.toHaveBeenCalled();
    expect(Object.keys(useLsp.getState().clients)).toHaveLength(1);
  });
});

describe("useLsp.load", () => {
  it("reads the catalog once and again only when refreshing", async () => {
    await useLsp.getState().load();
    await useLsp.getState().load();
    expect(lspDetect).toHaveBeenCalledTimes(1);
    expect(useLsp.getState().detected).toEqual([TS, RA]);
    await useLsp.getState().load(true);
    expect(lspDetect).toHaveBeenCalledTimes(2);
    expect(lspDetect).toHaveBeenLastCalledWith(true);
  });

  it("keeps the error when the backend cannot answer, without crashing the editor", async () => {
    lspDetect.mockRejectedValueOnce(new Error("sem backend"));
    expect(await useLsp.getState().load()).toEqual([]);
    expect(useLsp.getState().error).toMatch(/sem backend/);
    expect(await useLsp.getState().clientFor(ROOT, "typescript")).toBeNull();
  });
});
