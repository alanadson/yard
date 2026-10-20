/** Save the visible request before delivering it to the provider's existing CLI. */
import { promptAttachments } from "../components/Composer/attachments";
import { useChats } from "../stores/chatsStore";
import { beginTurn, setChatDelivery } from "./chat";
import { injectPrompt } from "./inject";
import { sendability } from "./sendable";
import { prepareTaskCheckpoint } from "./taskCheckpoint";

export async function sendChat(terminalId: string, text: string, turn: string, now: number, expectedThread?: number): Promise<void> {
  const readiness = sendability(terminalId, now);
  if (!readiness.ok) throw new Error(readiness.message);
  const document = await useChats.getState().update(terminalId, (current) => {
    if (expectedThread !== undefined && current.activeThread !== expectedThread) throw new Error("The draft belongs to another chat topic");
    return setChatDelivery(beginTurn(current, turn, text, now, promptAttachments(text).map(({ path, name }) => ({ path, name }))), turn, "sending");
  });
  const thread = document.activeThread + 1;
  const taskId = document.threads[document.activeThread].taskId;
  const command = `yard chat reply --thread ${thread} --turn ${JSON.stringify(turn)}`;
  const prompt = [
    `[Yard chat, topic ${thread}, turn ${turn}]`,
    `Complete the user's request below using your normal tools. When finished, deliver your final Markdown response with ${command} --file RESPONSE_FILE (or --stdin).`,
    `Use yard chat history --thread ${thread} when you need this topic's previous conversation. Only your final user-facing response belongs in the chat.`,
    ...(taskId ? [`This topic references a work task. Read its original request and acceptance criteria with yard task show ${JSON.stringify(taskId)}. A chat reply does not submit or approve a task delivery.`] : []),
    "", text,
  ].join("\n");
  try {
    await injectPrompt(terminalId, prompt, { checkpoint: await prepareTaskCheckpoint(terminalId) });
    await useChats.getState().update(terminalId, (current) => setChatDelivery(current, turn, "waiting"));
  } catch (error) {
    await useChats.getState().update(terminalId, (current) => setChatDelivery(current, turn, "uncertain", error instanceof Error ? error.message : String(error)));
    throw error;
  }
}
