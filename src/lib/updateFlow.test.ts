/**
 * Installing an update restarts the app, and a restart takes every live CLI
 * with it (Job Objects). Whether to ask first, and what a manual check says
 * back, are rules — the dialog and the toast are only their delivery.
 */
import { describe, expect, it } from "vitest";

import { checkToast, installQuestion } from "./updateFlow";

describe("installQuestion", () => {
  it("asks before restarting over live agents, naming how many", () => {
    expect(installQuestion(1)).toContain("1 CLI");
    expect(installQuestion(3)).toContain("3 CLIs");
  });

  it("does not ask when nothing is running", () => {
    expect(installQuestion(0)).toBeNull();
  });
});

describe("checkToast", () => {
  it("says the app is current when the check found nothing", () => {
    expect(checkToast("none", null)).toEqual({
      message: "O Yard já está na versão mais nova.",
      kind: "info",
    });
  });

  it("points at Settings when there is a version on offer", () => {
    const t = checkToast("available", "0.3.0");
    expect(t?.kind).toBe("info");
    expect(t?.message).toContain("0.3.0");
    expect(t?.message).toContain("Configurações");
  });

  it("an error is an error toast, and a check still running says nothing", () => {
    expect(checkToast("error", null, "offline")).toEqual({
      message: "Não consegui verificar atualizações: offline",
      kind: "error",
    });
    expect(checkToast("checking", null)).toBeNull();
  });
});
