/**
 * Delivering a prompt to a terminal as if the user had pasted and hit Enter.
 *
 * It lived in `bridge.ts` while the CLI was the only caller. It is not: the
 * composer, the bench, the diff reviewer, the routine scheduler and the role
 * briefing all push text into a PTY, and the last of those is imported *by*
 * the bridge — leaving it there made the two modules import each other.
 */
import { decodeEscapes } from "./bridgeCore";
import { ipc } from "./ipc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The bracketed-paste markers are what keep a multi-line prompt from becoming
 * N submits: the agent gets the whole block and only then the separate `\r`
 * (the pause gives the CLI time to process the paste).
 */
export async function injectPrompt(
  terminalId: string,
  text: string,
  opts?: { raw?: boolean; submit?: boolean },
): Promise<void> {
  if (opts?.raw) {
    await ipc.writePty(terminalId, decodeEscapes(text));
    return;
  }
  if (text.includes("\n")) {
    await ipc.writePty(terminalId, `\x1b[200~${text}\x1b[201~`);
  } else {
    await ipc.writePty(terminalId, text);
  }
  // `submit: false` stops exactly here: the text sits on the CLI's prompt line
  // and the Enter is the user's to press. That is the whole difference between
  // sending a prompt and handing one over (`PromptModal`).
  if (opts?.submit === false) return;
  await sleep(150);
  await ipc.writePty(terminalId, "\r");
}

/**
 * Injects and waits for proof the terminal actually took it.
 *
 * `writePty` resolving only means the bytes reached the ConPTY — it says
 * nothing about the CLI on the other side. That distinction is invisible for
 * a prompt the user can retype, and expensive for the diff review, which
 * erases the annotations once the send "worked". Every CLI echoes a paste, so
 * a byte counter that moves is the cheapest honest confirmation available.
 *
 * Returns `false` on timeout **after** the text was written: the caller must
 * treat that as "may or may not have arrived", never as "nothing happened".
 */
export async function injectAndConfirm(
  terminalId: string,
  text: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  const baseline = await ipc.ptyProbe(terminalId).then(
    (p) => p.totalBytes,
    () => 0,
  );
  await injectPrompt(terminalId, text);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const probe = await ipc.ptyProbe(terminalId).catch(() => null);
    if (!probe?.alive) return false;
    if (probe.totalBytes > baseline) return true;
  }
  return false;
}
