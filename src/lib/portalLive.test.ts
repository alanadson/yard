/**
 * The "Ao vivo" reload probe asks a local address for its fingerprint every
 * few seconds, once per live portal. That work is only worth doing for a page
 * someone can see: a card panned off the board, or a whole window minimized
 * to the tray, used to keep probing forever. These tests pin the pause (no
 * probe while unseen) and the catch-up (one probe the moment it is seen
 * again, so a build that landed meanwhile reloads right away, not a
 * heartbeat later). The clock is faked; the IPC boundary is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => ({
  probe: vi.fn(async (_url: string) => "print"),
  shown: [] as ((p: { shown: boolean }) => void)[],
}));
vi.mock("./ipc", () => ({
  ipc: {
    portalProbe: (url: string) => bus.probe(url),
    portalReload: async () => {},
  },
  on: {
    filesActivity: () => Promise.resolve(() => {}),
    windowShown: (cb: (p: { shown: boolean }) => void) => {
      bus.shown.push(cb);
      return Promise.resolve(() => {});
    },
  },
}));

type Live = typeof import("./portalLive");
let live: Live;

const IDLE_MS = 4000;
const A = "http://localhost:3000/a";
const B = "http://localhost:3000/b";

function reportWindow(shown: boolean): void {
  for (const cb of bus.shown) cb({ shown });
}

function probed(): string[] {
  return bus.probe.mock.calls.map(([url]) => url);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  bus.probe.mockClear();
  bus.shown.length = 0;
  live = await import("./portalLive");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a portal off the screen", () => {
  it("is not probed when its heartbeat comes due", async () => {
    const stop = live.watchPortal("a", A);
    live.parkPortal("a");

    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);

    expect(probed()).toEqual([]);
    stop();
  });

  it("is checked at once when it comes back on screen, not a heartbeat later", async () => {
    const stop = live.watchPortal("a", A);
    const release = live.parkPortal("a");
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);

    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(probed()).toEqual([A]);
    stop();
  });

  it("goes back to its heartbeat after the catch-up check", async () => {
    const stop = live.watchPortal("a", A);
    const release = live.parkPortal("a");
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(probed()).toEqual([A, A]);
    stop();
  });
});

describe("a window that is not shown", () => {
  it("stops the probes of every live portal", async () => {
    const stopA = live.watchPortal("a", A);
    const stopB = live.watchPortal("b", B);

    reportWindow(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);

    expect(probed()).toEqual([]);
    stopA();
    stopB();
  });

  it("coming back checks every on-screen portal at once and leaves an off-screen one parked", async () => {
    const stopA = live.watchPortal("a", A);
    const stopB = live.watchPortal("b", B);
    live.parkPortal("b");
    reportWindow(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);

    reportWindow(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(probed()).toEqual([A]);
    stopA();
    stopB();
  });
});
