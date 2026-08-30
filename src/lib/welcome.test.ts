/**
 * The button on the first screen — the one the workspace shows when no group
 * is open.
 *
 * The screen has two faces and they must not offer the same call. With no
 * project there is nothing for a tab to run in: "Nova aba" there walks the
 * grid of CLIs only to bounce straight back into "Adicionar projeto", so the
 * screen asks for the folder up front. Once a project exists the folder
 * question is answered, and what is missing is the gesture the tab bar's `+`
 * already gives — a CLI, a browser, the notebook — which the screen had no
 * mouse path to at all.
 */
import { describe, expect, it } from "vitest";

import { welcomeCall } from "./welcome";

describe("welcomeCall", () => {
  it("asks for a folder while there is no project — not for a tab", () => {
    expect(welcomeCall(0)).toEqual({
      action: "new-project",
      label: "Adicionar projeto",
    });
  });

  it("offers the tab bar's + once a project exists", () => {
    expect(welcomeCall(1)).toEqual({ action: "new-tab", label: "Nova aba" });
    expect(welcomeCall(7).action).toBe("new-tab");
  });
});
