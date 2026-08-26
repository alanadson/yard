/**
 * Can this terminal take a prompt right now?
 *
 * Five places in the app push text into a PTY, and until this module existed
 * they disagreed about what "ready" means. The two automated senders — the
 * routine scheduler and the role briefing — waited for the process to be up
 * *and* quiet, with a comment each explaining why: input that lands mid-paint
 * is swallowed, and input that lands on a menu with a cursor answers a
 * question nobody read. The three senders the user drives — the composer, the
 * bench and the diff review — checked only that the PTY was alive.
 *
 * That gap is not cosmetic. `injectPrompt` writes and then presses Enter, so
 * a prompt delivered to an agent sitting on `(y/N)` approves whatever was
 * being asked; and the review sender wipes the annotations as soon as the
 * write resolves, which turned "the agent was busy" into "the review is gone".
 *
 * So the rule lives here once, and the callers decide what to do about it:
 * refuse (bench), warn and keep the draft (composer), or wait for the window
 * to open (review).
 */
import { getActivity, isLive, useTerminals } from "../stores/terminalsStore";
import { useProjects } from "../stores/projectsStore";
import { t } from "./i18n";
import { baseName } from "./terminals";

/**
 * Silence that counts as "ready for input". The same figure the routine
 * scheduler used: long enough that a CLI finishing a paint is not mistaken
 * for one mid-answer, short enough not to feel like a stall.
 */
export const IDLE_MS = 5_000;

export type SendBlock = "missing" | "dead" | "blocked" | "busy";

export interface Sendability {
  ok: boolean;
  reason?: SendBlock;
  /** Ready to show to the user — names the terminal and what to do about it. */
  message?: string;
}

const READY: Sendability = { ok: true };

/**
 * `blocked` before `busy` on purpose: an agent frozen at a permission prompt
 * has been silent for a long time, so the idle test alone would call it ready
 * — and that is the single worst terminal to type into.
 */
export function sendability(terminalId: string, now = Date.now()): Sendability {
  const row = useProjects.getState().terminal(terminalId);
  if (!row) {
    return { ok: false, reason: "missing", message: t("Esse terminal não existe mais.") };
  }
  const name = baseName(row);
  const rt = useTerminals.getState().byId[terminalId];
  if (!isLive(rt)) {
    return {
      ok: false,
      reason: "dead",
      message: t("{name} não está rodando — inicie antes de enviar.", { name }),
    };
  }
  if (rt?.blocked) {
    return {
      ok: false,
      reason: "blocked",
      message: rt.blockedAsk
        ? t(
            "{name} está travado esperando o usuário ({ask}) — o texto viraria a resposta dessa pergunta. Responda na CLI antes.",
            { name, ask: rt.blockedAsk },
          )
        : t(
            "{name} está travado esperando o usuário — o texto viraria a resposta dessa pergunta. Responda na CLI antes.",
            { name },
          ),
    };
  }
  const { lastByteAt } = getActivity(terminalId);
  // No byte yet means the CLI is sitting at its prompt, not mid-work.
  if (lastByteAt && now - lastByteAt < IDLE_MS) {
    return {
      ok: false,
      reason: "busy",
      message: t("{name} está trabalhando agora — um prompt no meio da tarefa chega partido.", { name }),
    };
  }
  return READY;
}

export const canSend = (terminalId: string, now?: number): boolean =>
  sendability(terminalId, now).ok;

/**
 * Waits for the window to open, up to `timeoutMs`.
 *
 * Only worth it where giving up costs the user something they cannot retype —
 * the diff review, whose annotations are erased on a successful send. A
 * `blocked` terminal resolves immediately as a failure: it will not clear on
 * its own, and holding the user for ten seconds to tell them so is worse than
 * saying it at once.
 */
export async function waitUntilSendable(
  terminalId: string,
  timeoutMs = 12_000,
): Promise<Sendability> {
  const deadline = Date.now() + timeoutMs;
  let last = sendability(terminalId);
  while (!last.ok && last.reason === "busy" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = sendability(terminalId);
  }
  return last;
}
