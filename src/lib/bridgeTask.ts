/** Task CLI reads stay within the caller's explicit assignments. */
import { parseFlags, type Ctx } from "./bridgeCore";
import type { BridgeResponse, BridgeRequest } from "./ipc";
import { ipc } from "./ipc";
import type { Submission } from "./work";

export async function cmdTask(ctx: Ctx, args: string[], request: BridgeRequest): Promise<BridgeResponse> {
  if (!["show", "history", "submit"].includes(args[0]) || !args[1]) return { code: 1, output: "Usage: yard task show ID | yard task history ID | yard task submit ID --attempt ATTEMPT_ID --stdin | --file FILE\n" };
  try {
    const task = await ipc.taskGet(args[1]);
    if (!task.links.terminalIds.includes(ctx.caller.id)) return { code: 1, output: "This task is not assigned to this terminal.\n" };
    if (args[0] === "history") return { code: 0, output: JSON.stringify(await ipc.taskDeliveries(task.id), null, 2) + "\n" };
    if (args[0] === "submit") {
      if (task.links.executorTerminalId && task.links.executorTerminalId !== ctx.caller.id) return { code: 1, output: "Only the current executor can submit a delivery for this task.\n" };
      const flags = parseFlags(args.slice(2), { "--stdin": "stdin", "--file": "stdin", "--attempt": "string" });
      if (!flags.fromStdin || !request.stdin?.trim()) return { code: 1, output: "A delivery JSON document is required through --stdin or --file.\n" };
      const document = JSON.parse(request.stdin) as Submission;
      const submission = flags.string.attempt ? { ...document, attemptId: flags.string.attempt } : document;
      const submitted = await ipc.taskSubmit(task.id, task.revision, submission);
      return { code: 0, output: JSON.stringify(submitted, null, 2) + "\n" };
    }
    return { code: 0, output: JSON.stringify(task, null, 2) + "\n" };
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    return { code: 1, output: `yard task: ${message}\n` };
  }
}
