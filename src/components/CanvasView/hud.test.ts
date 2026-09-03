/**
 * The card's status line is read at a glance from across the board, so the
 * one state that costs the user dead time (a CLI waiting on a permission)
 * must not read like the plain "stuck on a question" block: it is a
 * different thing to walk over and answer, and it comes from the CLI's own
 * hook, not from a guess about the tail of the output.
 */
import { describe, expect, it } from "vitest";

import { hudKind, hudLabel } from "./hud";

describe("hudKind / hudLabel", () => {
  it("a permission prompt reported by the CLI has its own kind and label", () => {
    const rt = { state: "running", blocked: true, finished: true, permission: true };
    expect(hudKind(rt)).toBe("permission");
    expect(hudLabel(rt)).toBe("Pedindo permissão: aprove na CLI");
  });

  it("a plain block (the tail detector's guess) keeps reading as blocked", () => {
    const rt = { state: "running", blocked: true, finished: true, permission: false };
    expect(hudKind(rt)).toBe("blocked");
    expect(hudLabel(rt)).toMatch(/^Travado/);
  });

  it("the flag alone means nothing: it only reads with the block it came with", () => {
    const rt = { state: "running", blocked: false, finished: false, permission: true };
    expect(hudKind(rt)).toBe("work");
    expect(hudLabel(rt)).toBe("Trabalhando");
  });
});
