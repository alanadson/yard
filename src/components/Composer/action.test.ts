/**
 * Why this rule matters: the composer is where a person hands work to an
 * agent, and the answer "não pode agora" used to put the waiting on them —
 * hold the prompt, watch the card, click again. Two of the four refusals are
 * temporary by definition, and those are the ones the queue should absorb.
 * The other two are not, and parking a prompt for a terminal that will never
 * run is a counter going up on a card forever.
 */
import { describe, expect, it } from "vitest";

import { composerAction } from "./action";

describe("composerAction", () => {
  it("sends when the CLI is ready", () => {
    expect(composerAction({ ok: true })).toBe("send");
  });

  it("queues for an agent that is mid-answer", () => {
    expect(composerAction({ ok: false, reason: "busy" })).toBe("queue");
  });

  /** Blocked clears the moment the user answers the CLI's question. */
  it("queues for an agent frozen on a permission prompt", () => {
    expect(composerAction({ ok: false, reason: "blocked" })).toBe("queue");
  });

  it("refuses for a terminal that is not running — nothing is coming", () => {
    expect(composerAction({ ok: false, reason: "dead" })).toBe("refuse");
  });

  it("refuses for a terminal that no longer exists", () => {
    expect(composerAction({ ok: false, reason: "missing" })).toBe("refuse");
  });
});
