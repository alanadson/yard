/**
 * What the composer's main button does right now.
 *
 * Until the queue existed there was one answer: type the prompt in, and
 * refuse if the CLI could not take it (`lib/sendable.ts`). Refusing is
 * correct — a prompt landing mid-answer arrives broken, and one landing on a
 * permission prompt *answers* it — but it puts the waiting on the person: you
 * hold the prompt, watch the card, and click again when it goes quiet.
 *
 * With a queue there is a better third answer for exactly two of the four
 * refusals:
 *
 * - **busy** — it will be free in a moment, by definition. Park it.
 * - **blocked** — it is frozen on a question only the user can answer; the
 *   moment they do, the prompt goes in. Park it.
 * - **dead** and **missing** — nothing is coming. A prompt parked for a
 *   terminal that does not run would sit there being counted forever, so this
 *   still refuses, out loud.
 */
import type { Sendability } from "../../lib/sendable";

export type ComposerAction = "send" | "queue" | "refuse";

export function composerAction(ready: Sendability): ComposerAction {
  if (ready.ok) return "send";
  return ready.reason === "busy" || ready.reason === "blocked"
    ? "queue"
    : "refuse";
}
