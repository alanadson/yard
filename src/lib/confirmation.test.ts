/**
 * Destructive choices share one queue so overlapping requests never replace
 * each other and every caller receives the answer to its own question.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ask,
  confirmationSnapshot,
  resetConfirmationsForTests,
  settleConfirmation,
  subscribeConfirmations,
} from "./confirmation";

afterEach(resetConfirmationsForTests);

describe("the app confirmation queue", () => {
  it("shows one destructive question at a time and resolves it with the chosen answer", async () => {
    const first = ask("Excluir a nota?", { title: "Excluir nota", kind: "warning" });
    const second = ask("Excluir o projeto?", { title: "Excluir projeto", kind: "warning" });

    expect(confirmationSnapshot()).toMatchObject({
      message: "Excluir a nota?",
      title: "Excluir nota",
      kind: "warning",
    });
    settleConfirmation(true);
    await expect(first).resolves.toBe(true);
    expect(confirmationSnapshot()?.message).toBe("Excluir o projeto?");

    settleConfirmation(false);
    await expect(second).resolves.toBe(false);
    expect(confirmationSnapshot()).toBeNull();
  });

  it("notifies the host when a request appears and when it closes", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConfirmations(listener);
    const answer = ask("Continuar?");
    expect(listener).toHaveBeenCalledTimes(1);
    settleConfirmation(false);
    await answer;
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
