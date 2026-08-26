/**
 * "Sair" lives in three places now — the window's X, the tray menu and the
 * palette — and only `App` knows the exit flow (save, ask about live agents,
 * destroy). This seam lets the other two ask for it without importing the
 * component, and says honestly when nobody is there to answer yet.
 */
import { describe, expect, it } from "vitest";

import { requestQuit, setQuitHandler } from "./quit";

describe("requestQuit", () => {
  it("reports false while no handler is installed — the app is still booting", () => {
    setQuitHandler(null);
    expect(requestQuit()).toBe(false);
  });

  it("calls the installed handler once and reports true", () => {
    let calls = 0;
    setQuitHandler(() => {
      calls += 1;
    });
    expect(requestQuit()).toBe(true);
    expect(calls).toBe(1);
    setQuitHandler(null);
  });
});
