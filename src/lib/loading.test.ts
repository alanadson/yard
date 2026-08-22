/**
 * The bug this module locks out: **a failed read turning into empty state.**
 *
 * The `.catch(() => setLista([]))` pattern showed up on four screens. A score
 * that could not be read became "Nenhuma partitura salva ainda"; the fan-out
 * agent list came up empty without saying why; the font picker showed only
 * the bundled ones, as if the machine had none installed. The user decides
 * wrong on a sentence the app knows to be a lie — recreates a score that
 * already exists, gives up on the fan-out, switches fonts for nothing.
 *
 * `SessionsModal` had already fixed this by hand, with a comment in the code.
 * Here the fix becomes a type: there is no state in which the read failed
 * *and* the collection looks empty — the two are mutually exclusive, and the
 * compiler demands the `falhou` case when rendering.
 */
import { describe, expect, it } from "vitest";

import { load, isEmpty, reasonOf, type LoadState } from "./loading";

describe("carregar", () => {
  it("a read that succeeded arrives as `pronto`, with the data", async () => {
    expect(await load(Promise.resolve([1, 2]))).toEqual({
      state: "pronto",
      data: [1, 2],
    });
  });

  it("a read that failed arrives as `falhou` — never as `pronto` with an empty list", async () => {
    const r = await load<number[]>(Promise.reject(new Error("disco sumiu")));
    expect(r).toEqual({ state: "falhou", reason: "disco sumiu" });
    // The regression in one line: if this ever goes back to `pronto: []`, the
    // screen goes back to saying "nothing here" for an error.
    expect(r.state).not.toBe("pronto");
  });

  it("a genuinely empty list is still `pronto`", async () => {
    expect(await load(Promise.resolve([]))).toEqual({ state: "pronto", data: [] });
  });
});

describe("motivoDe", () => {
  it("uses the Error's message, without the `Error:` in front", () => {
    expect(reasonOf(new Error("permissão negada"))).toBe("permissão negada");
  });

  it("a rejected string is the reason itself", () => {
    expect(reasonOf("comando não existe")).toBe("comando não existe");
  });

  it("an error with no message still says something", () => {
    expect(reasonOf(new Error(""))).toBe("falha desconhecida");
    expect(reasonOf(null)).toBe("falha desconhecida");
    expect(reasonOf({})).toBe("falha desconhecida");
  });

  it("a strange object becomes text instead of `[object Object]`", () => {
    expect(reasonOf({ message: "sem espaço em disco" })).toBe("sem espaço em disco");
  });
});

describe("estaVazio", () => {
  const emptyOne: LoadState<number[]> = { state: "pronto", data: [] };
  const full: LoadState<number[]> = { state: "pronto", data: [1] };
  const failed: LoadState<number[]> = { state: "falhou", reason: "x" };

  it("is only empty when the read succeeded and nothing came back", () => {
    expect(isEmpty(emptyOne)).toBe(true);
    expect(isEmpty(full)).toBe(false);
  });

  it("loading is not empty — the screen does not know yet", () => {
    expect(isEmpty({ state: "carregando" })).toBe(false);
  });

  it("a failure is never empty: that is the mistake this module exists to prevent", () => {
    expect(isEmpty(failed)).toBe(false);
  });
});
