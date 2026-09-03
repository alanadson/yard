/**
 * The tray icon and the summon hotkey are the two things that reach the user
 * while the window is hidden or behind a game. The tooltip is the only place
 * the count of blocked agents lives then, and a hotkey string typed by hand
 * has to become exactly what the global-shortcut plugin accepts — a typo
 * there is a shortcut that silently never fires.
 */
import { describe, expect, it } from "vitest";

import type { TerminalRuntime } from "../stores/terminalsStore";
import { normalizeHotkey, trayStatus } from "./tray";

function rt(partial: Partial<TerminalRuntime>): TerminalRuntime {
  return {
    state: "idle",
    pid: null,
    exit: null,
    error: null,
    unread: false,
    finished: false,
    finishedAt: 0,
    blocked: false,
    blockedAsk: null,
    permission: false,
    rssMb: 0,
    cpu: 0,
    ...partial,
  };
}

describe("trayStatus", () => {
  it("counts live terminals as running and the blocked ones apart, never both", () => {
    const status = trayStatus({
      a: rt({ state: "running" }),
      b: rt({ state: "starting" }),
      c: rt({ state: "running", blocked: true, blockedAsk: "(y/N)" }),
      d: rt({ state: "exited" }),
      e: rt({ state: "idle" }),
    });
    expect(status).toEqual({ blocked: 1, running: 2 });
  });

  it("a dead terminal that still carries the blocked flag is not counted", () => {
    expect(trayStatus({ a: rt({ state: "exited", blocked: true }) })).toEqual({
      blocked: 0,
      running: 0,
    });
  });
});

describe("normalizeHotkey", () => {
  it("turns the user's spelling into the plugin's accelerator form", () => {
    expect(normalizeHotkey("Ctrl+Alt+Y")).toBe("CommandOrControl+Alt+Y");
    expect(normalizeHotkey("ctrl + shift + f12")).toBe("CommandOrControl+Shift+F12");
    expect(normalizeHotkey("Control+Space")).toBe("CommandOrControl+Space");
    expect(normalizeHotkey("Win+Alt+K")).toBe("Super+Alt+K");
  });

  it("refuses a bare key — a global shortcut without a modifier steals the key from every app", () => {
    expect(normalizeHotkey("Y")).toBeNull();
    expect(normalizeHotkey("F12")).toBeNull();
  });

  it("refuses an unknown modifier, a missing key and an empty string", () => {
    expect(normalizeHotkey("Hyper+Y")).toBeNull();
    expect(normalizeHotkey("Ctrl+Shift")).toBeNull();
    expect(normalizeHotkey("Ctrl+")).toBeNull();
    expect(normalizeHotkey("")).toBeNull();
    expect(normalizeHotkey("   ")).toBeNull();
  });

  it("orders modifiers canonically and drops a repeated one", () => {
    expect(normalizeHotkey("Shift+Ctrl+Y")).toBe("CommandOrControl+Shift+Y");
    expect(normalizeHotkey("Ctrl+Ctrl+Y")).toBe("CommandOrControl+Y");
  });
});
