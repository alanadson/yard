/** Process loss retires the waiting state without authorizing another provider request. */
import { useChats } from "../stores/chatsStore";
import { setChatDelivery } from "./chat";
import { ipc } from "./ipc";

export async function requestChatInterrupt(terminalId: string): Promise<void> {
  const pending = useChats.getState().byTerminal[terminalId]?.pending;
  if (!pending) return;
  try { await ipc.writePty(terminalId, "\x1b"); }
  finally { await useChats.getState().update(terminalId, (document) => setChatDelivery(document, pending.id, "uncertain")); }
}

export async function markChatInterrupted(terminalId: string): Promise<void> {
  const pending = useChats.getState().byTerminal[terminalId]?.pending;
  if (!pending || pending.delivery === "uncertain") return;
  await useChats.getState().update(terminalId, (document) => setChatDelivery(document, pending.id, "uncertain"));
}

export async function reconcileChatProcesses(live: ReadonlySet<string>): Promise<void> {
  for (const id of Object.keys(useChats.getState().byTerminal)) {
    if (!live.has(id)) await markChatInterrupted(id);
  }
}
