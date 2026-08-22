/**
 * What reaches the PTY, byte for byte.
 *
 * Two things are worth pinning down here. The bracketed paste, because without
 * it a ten-line prompt becomes ten submits in the agent's CLI. And the
 * `submit: false` case, because that is the whole promise the prompt window
 * makes: the text lands on the command line and the Enter stays with the user.
 * A stray `\r` there would send an unfinished prompt to an agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { injectPrompt } from "./inject";

const writePty = vi.fn(async () => {});

vi.mock("./ipc", () => ({
  ipc: {
    writePty: (...args: unknown[]) => writePty(...(args as [])),
  },
}));

/** Everything written to the terminal, in order. */
const written = () => writePty.mock.calls.map((c) => (c as unknown as string[])[1]);

beforeEach(() => {
  writePty.mockClear();
});

describe("injectPrompt", () => {
  it("sends the text and then the Enter, separately", async () => {
    await injectPrompt("t1", "oi");
    expect(written()).toEqual(["oi", "\r"]);
  });

  it("wraps multi-line text in bracketed paste", async () => {
    await injectPrompt("t1", "linha 1\nlinha 2");
    expect(written()).toEqual(["\x1b[200~linha 1\nlinha 2\x1b[201~", "\r"]);
  });

  it("with submit: false does not press Enter", async () => {
    await injectPrompt("t1", "prompt longo\nem duas linhas", { submit: false });
    expect(written()).toEqual(["\x1b[200~prompt longo\nem duas linhas\x1b[201~"]);
    expect(written().join("")).not.toContain("\r");
  });

  it("in raw mode writes only once, with no bonus Enter", async () => {
    await injectPrompt("t1", "\\x03", { raw: true });
    expect(written()).toEqual(["\x03"]);
  });
});
