/**
 * Modo Fluxo — the Enter interception: the mechanism that makes "any prompt
 * typed into the connected CLI" go through the pipeline **without** Yard ever
 * typing instructions into the terminal on connect.
 *
 * The path: `XTermView` runs every keyboard event through here before
 * writing it to the PTY. For an agent terminal wired to a flow card (with the
 * trigger on), the typed text is mirrored key by key (`feedTyped`); on Enter,
 * Yard swallows the `\r`, the text stays put in the CLI's box, and the engine
 * appends the one-line STAMP of stage 1 to the SAME message and submits — the
 * user's request remains the only prose on screen, and the agent fetches the
 * stage briefing with `yard flow stage`. The following stages go through
 * normal injection of the stamp.
 *
 * What is never intercepted: a terminal with no flow wired, trigger off, a
 * run already in progress (the user's answers to the agent have to get
 * through), an agent stuck on a question ("y" + Enter is an answer, not a
 * task), a busy CLI, an empty Enter, and any line whose reconstruction became
 * uncertain (arrows/Tab reset the mirror — the prompt goes raw, never guessed).
 */
import { feedTyped, flowsOf, type FlowItem } from "./flow";
import { startFlow } from "./flowRun";
import { isConnected } from "./canvasOps";
import { uiLog } from "./log";
import { useFlows } from "../stores/flowStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";
import { t } from "./i18n";

/** Text typed since the last submit, per terminal. Never persisted. */
const buffers = new Map<string, string>();

/** The flow armed on this terminal: wired, with a trigger and with stages. */
export function boundFlowOf(
  terminalId: string,
): { groupId: string; flow: FlowItem } | null {
  const s = useProjects.getState();
  const row = s.terminal(terminalId);
  if (!row || row.kind !== "agent") return null;
  const canvas = s.layoutOf(row.groupId).canvas;
  if (!canvas) return null;
  const flow = flowsOf(canvas).find(
    (f) =>
      f.trigger !== false &&
      f.stages.length > 0 &&
      isConnected(canvas, f.id, terminalId),
  );
  return flow ? { groupId: row.groupId, flow } : null;
}

/**
 * Called by `XTermView` for every keyboard event. Returns `true` when the
 * event was consumed (the Enter that became a flow trigger) — only in that
 * case does the byte NOT go on to the PTY.
 */
export function interceptFlowInput(terminalId: string, data: string): boolean {
  const bound = boundFlowOf(terminalId);
  if (!bound) {
    buffers.delete(terminalId);
    return false;
  }

  // In the middle of a run, or with the agent stopped on a question, the
  // keyboard is a conversation between user and CLI — the flow stays out.
  const rt = useTerminals.getState().byId[terminalId];
  const running = Object.values(useFlows.getState().runs).some(
    (r) => !r.finishedAt && r.terminalId === terminalId,
  );
  if (rt?.blocked || running) {
    buffers.delete(terminalId);
    return false;
  }

  const { buf, submit } = feedTyped(buffers.get(terminalId) ?? "", data);
  if (!submit) {
    buffers.set(terminalId, buf);
    return false;
  }

  // Enter with text: the pipeline takes over. No `sendability` here — its
  // "busy" criterion is "a byte came out in the last 5 s", and the ECHO of
  // the typing itself is output: at the instant of Enter the CLI would always
  // look busy and the flow would never fire. The protections that matter have
  // already happened (stuck/active run, above) or live in `startFlow` (dead
  // CLI, flow without stages, double race).
  buffers.set(terminalId, "");
  const r = startFlow(bound.groupId, bound.flow, buf.trim(), {
    terminalId,
    typed: true,
  });
  if (!r.ok) {
    uiLog.info(`fluxo "${bound.flow.name}": Enter seguiu cru — ${r.message}`);
    return false;
  }
  useUI
    .getState()
    .showToast(
      t('Fluxo "{name}" assumiu o pedido — {n} etapa(s) nesta CLI.', {
        name: bound.flow.name,
        n: bound.flow.stages.length,
      }),
    );
  return true;
}

/** The process is gone; the mirror of what was typed goes with it. */
export function forgetTyped(terminalId: string) {
  buffers.delete(terminalId);
}
