/**
 * One vocabulary for "this section is working".
 *
 * The repository already had two answers to the same question. `Floors` got it
 * right: the button that fired the action announces it (`is-busy` +
 * `aria-busy`) and the neighbours merely refuse the click. `Settings/Mcp` and
 * `ScoresModal` got it silent: every button took a bare `disabled={busy}`, so
 * writing an MCP server — which shells out to the CLI and takes seconds — read
 * as a freeze, and the user clicked again or closed the sheet.
 *
 * The decision is three-valued and identical everywhere, so it lives here
 * instead of being retyped per panel.
 */
import { describe, expect, it } from "vitest";

import { busyState, isBusy, refusesClick } from "./busy";

describe("busyState", () => {
  it("leaves every button free while nothing is running", () => {
    expect(busyState(null, "salvar")).toBe("livre");
    expect(busyState(null, "remover")).toBe("livre");
  });

  it("marks as running only the button that fired the action", () => {
    expect(busyState("salvar", "salvar")).toBe("rodando");
  });

  it("blocks the neighbours without letting them claim the work", () => {
    // The regression this locks down: a shared boolean made every button look
    // identical, so nothing on screen said *which* action was in flight.
    expect(busyState("salvar", "remover")).toBe("bloqueado");
    expect(busyState("salvar", "copiar")).toBe("bloqueado");
  });

  it("an empty id is idle, not a button whose id is also empty", () => {
    // `useState<string | null>` starting at `""` by accident must not make a
    // nameless button spin forever.
    expect(busyState("", "")).toBe("livre");
    expect(busyState("", "salvar")).toBe("livre");
  });

  it("says who spins and who only greys out", () => {
    expect(isBusy(busyState("salvar", "salvar"))).toBe(true);
    expect(isBusy(busyState("salvar", "remover"))).toBe(false);

    expect(refusesClick(busyState("salvar", "salvar"))).toBe(true);
    expect(refusesClick(busyState("salvar", "remover"))).toBe(true);
    expect(refusesClick(busyState(null, "salvar"))).toBe(false);
  });
});
