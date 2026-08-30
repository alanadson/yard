/**
 * Telling someone who is not at the machine.
 *
 * The profile this app is built for is long sessions, often at night, with
 * agents that stop and wait. A Windows balloon is perfect for that — as long
 * as you are in front of the screen. The moment you are not, the whole
 * "agente travou" mechanism stops working, and an agent frozen on a
 * permission prompt at 3am costs the night.
 *
 * So: an address the user pastes in (ntfy, Discord, Slack, a webhook of their
 * own), and one `POST` per notification. It is the only thing in Yard that
 * sends a terminal's words off the machine, and every rule here exists so
 * that cannot happen by surprise:
 *
 * - **there is no default.** No address, no requests, ever;
 * - **https only** — except on localhost, where there is no wire to listen
 *   on. The body can be a permission prompt naming a path or a command, and
 *   that is not going out in the clear;
 * - **a sentence, not a scrollback.** The body is capped: what arrives on a
 *   phone should be readable at a glance from the lock screen.
 */

/** As much text as is worth pushing to a phone. */
export const BODY_CAP = 400;

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/** The address to POST to, or `null` when there is not a usable one. */
export function webhookTarget(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && LOCAL.test(url.hostname)) return value;
  return null;
}

export interface WebhookBody {
  title: string;
  message: string;
  /** What produced it: a trigger's edge, or the app's own notification. */
  event: string;
}

export function webhookPayload(
  title: string,
  message: string,
  event: string,
): WebhookBody {
  const flat = message.replace(/\s+/g, " ").trim();
  return {
    title,
    message: flat.length > BODY_CAP ? `${flat.slice(0, BODY_CAP - 1)}…` : flat,
    event,
  };
}
