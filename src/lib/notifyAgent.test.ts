/**
 * Agent silence becomes a Windows balloon — but for two quite different
 * reasons: it **finished** (`blocked.ts` found no question in the tail) or it
 * **is waiting for you** (a `(y/N)`, a menu, a `Password:`).
 *
 * There was a single switch for both. Turning off the "finished" balloon —
 * exactly what anyone working with six CLIs does on day one — also killed the
 * warning that matters: the agent stuck in a group nobody is looking at. This
 * module is the rule that separates the two.
 */
import { describe, expect, it } from "vitest";

import { shouldNotify } from "./notifyAgent";

describe("which switch governs the balloon", () => {
  it("turning off 'finished' does not silence the blocked agent", () => {
    const prefs = { notifyOnFinish: false, notifyBlocked: true };
    expect(shouldNotify(true, prefs)).toBe(true);
    expect(shouldNotify(false, prefs)).toBe(false);
  });

  it("turning off 'blocked' does not silence what finished", () => {
    const prefs = { notifyOnFinish: true, notifyBlocked: false };
    expect(shouldNotify(true, prefs)).toBe(false);
    expect(shouldNotify(false, prefs)).toBe(true);
  });

  it("with both off, nothing notifies", () => {
    const prefs = { notifyOnFinish: false, notifyBlocked: false };
    expect(shouldNotify(true, prefs)).toBe(false);
    expect(shouldNotify(false, prefs)).toBe(false);
  });
});
