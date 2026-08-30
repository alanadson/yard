/**
 * Why these rules matter: this is the one feature in Yard that sends the
 * contents of a terminal **off the machine**. It is opt-in by having a URL at
 * all, and everything else here exists so it cannot surprise anyone: only
 * https (or an explicit localhost), a body small enough to read on a phone,
 * and nothing sent when the address is not a real one.
 */
import { describe, expect, it } from "vitest";

import { BODY_CAP, webhookTarget, webhookPayload } from "./webhook";

describe("webhookTarget", () => {
  it("takes an https address", () => {
    expect(webhookTarget("https://ntfy.sh/meu-topico")).toBe("https://ntfy.sh/meu-topico");
  });

  it("trims what the user pasted", () => {
    expect(webhookTarget("  https://ntfy.sh/x  ")).toBe("https://ntfy.sh/x");
  });

  /**
   * Plain http leaks the agent's question over the wire, and this text can be
   * a permission prompt naming a path or a command. Localhost is the
   * exception, because there is no wire.
   */
  it("refuses plain http on the open internet", () => {
    expect(webhookTarget("http://exemplo.dev/hook")).toBeNull();
  });

  it("allows http on localhost, where nothing leaves the machine", () => {
    expect(webhookTarget("http://localhost:8080/hook")).toBe("http://localhost:8080/hook");
    expect(webhookTarget("http://127.0.0.1:8080/hook")).toBe("http://127.0.0.1:8080/hook");
  });

  it("refuses anything that is not http at all", () => {
    expect(webhookTarget("file:///c:/segredo.txt")).toBeNull();
    expect(webhookTarget("javascript:alert(1)")).toBeNull();
    expect(webhookTarget("")).toBeNull();
    expect(webhookTarget("   ")).toBeNull();
  });
});

describe("webhookPayload", () => {
  it("carries the title and the body, plus what fired it", () => {
    const body = webhookPayload("Yard", "o claude travou", "blocked");
    expect(body.title).toBe("Yard");
    expect(body.message).toBe("o claude travou");
    expect(body.event).toBe("blocked");
  });

  /** A phone notification is a sentence, not a scrollback. */
  it("cuts a body that would not fit on a phone", () => {
    const long = "x".repeat(BODY_CAP + 200);
    const body = webhookPayload("Yard", long, "finished");
    expect(body.message.length).toBe(BODY_CAP);
    expect(body.message.endsWith("…")).toBe(true);
  });

  it("leaves a short body exactly as it was written", () => {
    expect(webhookPayload("Yard", "curto", "finished").message).toBe("curto");
  });
});
