/** Chat replies belong to the calling terminal and must name the pending turn. */
import { parseFlags, type Ctx } from "./bridgeCore";
import { createChat, messageWindow, replyToTurn } from "./chat";
import type { BridgeRequest, BridgeResponse } from "./ipc";
import { useChats } from "../stores/chatsStore";

/**
 * Messages `yard chat history` hands back by default: a topic keeps up to
 * 500, and the agent that asks pays to read every one it is given.
 */
export const CHAT_HISTORY_DEFAULT_LAST = 50;

export async function cmdChat(ctx: Ctx, args: string[], request: BridgeRequest): Promise<BridgeResponse> {
  if (args[0] === "history") {
    const document = useChats.getState().byTerminal[ctx.caller.id] ?? createChat();
    const parsed = parseFlags(args.slice(1), { "--thread": "number", "--last": "number" });
    const index = parsed.number.thread === undefined ? document.activeThread : parsed.number.thread - 1;
    const topic = document.threads[index];
    if (!topic) return { code: 1, output: "The thread must be between 1 and 7.\n" };
    const asked = parsed.number.last;
    const last = asked !== undefined && asked > 0 ? Math.round(asked) : CHAT_HISTORY_DEFAULT_LAST;
    // The newest `last`, and how many older ones were left out, so the agent
    // knows the record it got is not the whole topic.
    const { visible, hidden } = messageWindow(topic.messages, last);
    return { code: 0, output: JSON.stringify({ thread: index + 1, omitted: hidden, messages: visible }, null, 2) + "\n" };
  }
  if (args[0] !== "reply") return { code: 1, output: "Usage: yard chat reply --thread 1..7 --turn ID TEXT|--file FILE|--stdin\n" };
  const parsed = parseFlags(args.slice(1), { "--thread": "number", "--turn": "string", "--file": "stdin", "--stdin": "stdin" });
  const text = parsed.fromStdin ? request.stdin ?? "" : parsed.positional.join(" ");
  try {
    await useChats.getState().update(ctx.caller.id, (document) => replyToTurn(document, parsed.string.turn ?? "", (parsed.number.thread ?? 1) - 1, text, Date.now()));
    return { code: 0, output: "Reply saved in the terminal chat.\n" };
  } catch (error) {
    return { code: 1, output: `yard chat: ${String(error)}\n` };
  }
}
