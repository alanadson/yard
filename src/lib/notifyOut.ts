/**
 * The second address of a notification: somewhere that is not this machine.
 *
 * Five places in the app send a native balloon — an agent finished or froze
 * on a question, a trigger fired, a flow ended, `yard notify`, the budget.
 * All five are useless the moment the user walks away from the screen, which
 * for this app's actual profile (long sessions, at night, agents that stop
 * and wait) is precisely when the message matters most.
 *
 * So each of those five now also calls here, and here posts the same sentence
 * to whatever address the user pasted into Configurações. The rules of what
 * may be posted where are in `lib/webhook.ts`, next to their tests; the fence
 * is repeated in `src-tauri/src/webhook.rs`, because that command is
 * reachable from the frontend.
 *
 * Failure is silent by design (a line in the log, nothing on screen): a
 * balloon about a notification having failed to be delivered elsewhere is a
 * notification about nothing.
 */
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { webhookPayload, webhookTarget } from "./webhook";
import { useUI } from "../stores/uiStore";

export function pushOut(title: string, body: string, event: string): void {
  const configured = useUI.getState().prefs.notifyWebhook;
  if (!configured?.trim()) return;
  const url = webhookTarget(configured);
  if (!url) {
    uiLog.warn("webhook: endereço inválido, nada enviado");
    return;
  }
  const payload = webhookPayload(title, body, event);
  void ipc
    .webhookPost(url, JSON.stringify(payload))
    .catch((e) => uiLog.warn(`webhook: ${e}`));
}
