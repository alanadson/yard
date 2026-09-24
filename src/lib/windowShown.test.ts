/**
 * Whether the main window is on screen at all. Everything that polls on a
 * timer (a phone's screenshots, a portal's reload probe) reads this to stop
 * spending IPC and CPU on a minimized or hidden window, so two things must
 * hold: the default is "shown" (a backend that never reports keeps today's
 * behaviour), and a subscriber hears only real changes (a repeated report
 * must not look like a resume and fire a burst of immediate refreshes).
 */
import { describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => ({
  listeners: [] as ((p: { shown: boolean }) => void)[],
  registrations: 0,
}));
vi.mock("./ipc", () => ({
  on: {
    windowShown: (cb: (p: { shown: boolean }) => void) => {
      bus.registrations += 1;
      bus.listeners.push(cb);
      return Promise.resolve(() => {});
    },
  },
}));

import { createShownStore, isWindowShown, subscribeWindowShown } from "./windowShown";

describe("createShownStore", () => {
  it("starts shown: a window nobody has reported on is on screen", () => {
    expect(createShownStore().get()).toBe(true);
  });

  it("tells subscribers when the window is hidden and when it comes back", () => {
    const store = createShownStore();
    const heard: boolean[] = [];
    store.subscribe((shown) => heard.push(shown));

    store.set(false);
    store.set(true);

    expect(heard).toEqual([false, true]);
    expect(store.get()).toBe(true);
  });

  it("a repeated report of the same state notifies nobody", () => {
    const store = createShownStore();
    const heard: boolean[] = [];
    store.subscribe((shown) => heard.push(shown));

    store.set(true);
    store.set(false);
    store.set(false);

    expect(heard).toEqual([false]);
  });

  it("a listener that unsubscribed hears nothing more", () => {
    const store = createShownStore();
    const heard: boolean[] = [];
    const off = store.subscribe((shown) => heard.push(shown));

    off();
    store.set(false);

    expect(heard).toEqual([]);
  });
});

describe("the app-wide window state", () => {
  it("follows the backend's window://shown event, listening to it only once", () => {
    const heard: boolean[] = [];
    const offA = subscribeWindowShown((shown) => heard.push(shown));
    const offB = subscribeWindowShown(() => {});

    expect(bus.registrations).toBe(1);
    for (const cb of bus.listeners) cb({ shown: false });

    expect(isWindowShown()).toBe(false);
    expect(heard).toEqual([false]);

    for (const cb of bus.listeners) cb({ shown: true });
    expect(isWindowShown()).toBe(true);
    expect(heard).toEqual([false, true]);
    offA();
    offB();
  });
});
