/**
 * The transport is the only bridge between `@codemirror/lsp-client` (bare
 * JSON in, bare JSON out) and the Rust process manager (`lsp_send`,
 * `lsp://message`). Two servers share one event topic, so the id filter is
 * what keeps rust-analyzer's answers out of the TypeScript client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { lspSend, listeners } = vi.hoisted(() => ({
  lspSend: vi.fn(async () => undefined),
  listeners: [] as ((p: { id: string; message: string }) => void)[],
}));

vi.mock("../ipc", () => ({
  ipc: { lspSend },
  on: {
    lspMessage: (cb: (p: { id: string; message: string }) => void) => {
      listeners.push(cb);
      return Promise.resolve(() => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      });
    },
  },
}));

import { IpcTransport } from "./transport";

function deliver(id: string, message: string) {
  for (const cb of [...listeners]) cb({ id, message });
}

beforeEach(() => {
  lspSend.mockClear();
  listeners.length = 0;
});

describe("IpcTransport", () => {
  it("hands each outgoing message to the server with its id", () => {
    const t = new IpcTransport("lsp-1");
    t.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(lspSend).toHaveBeenCalledWith("lsp-1", '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  });

  it("delivers a message of its own id to every subscriber, and nobody else's", async () => {
    const t = new IpcTransport("lsp-1");
    await Promise.resolve();
    const a = vi.fn();
    const b = vi.fn();
    t.subscribe(a);
    t.subscribe(b);
    deliver("lsp-1", '{"a":1}');
    deliver("lsp-2", '{"other":1}');
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith('{"a":1}');
    expect(b).toHaveBeenCalledWith('{"a":1}');
  });

  it("stops delivering to a handler that unsubscribed", async () => {
    const t = new IpcTransport("lsp-1");
    await Promise.resolve();
    const a = vi.fn();
    t.subscribe(a);
    t.unsubscribe(a);
    deliver("lsp-1", '{"a":1}');
    expect(a).not.toHaveBeenCalled();
  });

  /** A disposed transport is a broken connection: the client must be told, not fed silence. */
  it("after dispose it listens no more and refuses to send", async () => {
    const t = new IpcTransport("lsp-1");
    await Promise.resolve();
    expect(listeners).toHaveLength(1);
    const a = vi.fn();
    t.subscribe(a);
    t.dispose();
    await Promise.resolve();
    expect(listeners).toHaveLength(0);
    expect(() => t.send("{}")).toThrow(/lsp-1/);
    expect(a).not.toHaveBeenCalled();
  });
});
