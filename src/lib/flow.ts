/**
 * Modo Fluxo — the pure half: prompt assembly, wire matching, carry
 * extraction. `CanvasData -> answers`, no store, no IPC, no DOM, which is
 * what lets `flow.test.ts` cover the rules the run engine leans on.
 *
 * A flow is a **canvas item**: a pipeline of titled prompts with no CLI of
 * its own. Wiring an agent terminal to the flow card is what arms it — any
 * task that CLI receives is run through the stages, in that same CLI. The
 * run state lives in `stores/flowStore.ts`; the engine in `flowRun.ts`.
 */
import type { CanvasData, CanvasItem, FlowStage } from "./canvas";
import { isConnected } from "./canvasOps";
import { tail } from "./bridgeCore";

export type FlowItem = Extract<CanvasItem, { type: "flow" }>;

export function flowsOf(c: CanvasData | undefined): FlowItem[] {
  return (c?.items ?? []).filter((i): i is FlowItem => i.type === "flow");
}

/** By id first (exact), then by name (case-insensitive) — what the CLI takes. */
export function findFlow(
  c: CanvasData | undefined,
  nameOrId: string,
): FlowItem | undefined {
  const flows = flowsOf(c);
  const byId = flows.find((f) => f.id === nameOrId);
  if (byId) return byId;
  const q = nameOrId.trim().toLowerCase();
  return flows.find((f) => f.name.toLowerCase() === q);
}

/** The agent terminals wired to this flow card — its triggers/executors. */
export function flowAgents<T extends { id: string; kind: string }>(
  c: CanvasData,
  flowId: string,
  terminals: T[],
): T[] {
  return terminals.filter((t) => t.kind === "agent" && isConnected(c, flowId, t.id));
}

/**
 * The wire that joins two ids, in whatever direction it was drawn.
 * `reversed` is what lets the running-dash animation still flow *toward*
 * the executing CLI when the user drew the cable the other way around.
 */
export function wireOfPair(
  items: CanvasItem[],
  a: string,
  b: string,
): { id: string; reversed: boolean } | null {
  for (const it of items) {
    if (it.type !== "connection") continue;
    if (it.from === a && it.to === b) return { id: it.id, reversed: false };
    if (it.from === b && it.to === a) return { id: it.id, reversed: true };
  }
  return null;
}

/**
 * The closing line every stage is told to end with. The engine looks for the
 * last occurrence in the stage's output and hands everything from there to
 * the next stage — a summary written *for* the next turn beats 30 KB of
 * scrollback pasted at it.
 */
export const CARRY_MARK = "### RESUMO DA ETAPA";

/** Cap of what travels between stages when the agent skipped the summary. */
const CARRY_FALLBACK_CAP = 8_000;

/**
 * What the next stage receives from this one: the final summary when the
 * agent wrote one, the tail of the clean output when it did not. Never
 * empty-handed — a stage that printed anything at all hands that along.
 */
export function extractCarry(cleanOutput: string, cap = CARRY_FALLBACK_CAP): string {
  const at = cleanOutput.lastIndexOf(CARRY_MARK);
  if (at >= 0) return tail(cleanOutput.slice(at).trim(), cap);
  return tail(cleanOutput.trim(), cap);
}

/**
 * Every message the engine types into the CLI opens with this tag — it is
 * how the trigger briefing can say "these you execute, never forward"
 * without the wired agent bouncing its own stage prompt back at the flow.
 */
export const FLOW_MSG_TAG = "[Yard · Fluxo";

/** Display label of a stage: the user's title, else its position. */
export function stageLabelOf(s: FlowStage, index: number): string {
  return s.label?.trim() || `Etapa ${index + 1}`;
}

/**
 * Reduces a keyboard event (`term.onData`) over the text the user has typed
 * since the last submit. It is the heart of the Enter interception: Yard
 * rebuilds the prompt key by key so that, on Enter, the pipeline can take it
 * over — without having typed a SINGLE message into the terminal before that.
 *
 * Honest about the limits: editing with arrows, Home/End or Tab makes the
 * reconstruction unreliable, so those events **reset** the buffer — the next
 * Enter goes raw to the CLI instead of firing the flow with a wrongly guessed
 * task. Straight typing, backspace and paste (bracketed paste) are faithful.
 */
export function feedTyped(
  buf: string,
  data: string,
): { buf: string; submit: boolean } {
  // Plain Enter: submits if there is text; empty goes raw (menus, confirmations).
  if (data === "\r" || data === "\r\n") {
    return { buf, submit: buf.trim().length > 0 };
  }
  // Bracketed paste: the content is literal — line breaks included.
  if (data.includes("\x1b[200~")) {
    let inner = "";
    const re = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
    for (let m = re.exec(data); m; m = re.exec(data)) inner += m[1];
    return { buf: buf + inner, submit: false };
  }
  // Escape sequences (arrows, Home, F-keys…): the cursor left the end of the
  // line and the mirror is no longer faithful. A lone Esc also clears the box
  // in most agent CLIs.
  if (data.startsWith("\x1b")) return { buf: "", submit: false };
  if (data === "\x7f" || data === "\b") {
    return { buf: buf.slice(0, -1), submit: false };
  }
  // Ctrl+C / Ctrl+U discard the line; Tab triggers unpredictable completion.
  if (data === "\x03" || data === "\x15" || data === "\t") {
    return { buf: "", submit: false };
  }
  // A stray control byte we do not map: do not risk the mirror.
  if (data.length === 1 && data.charCodeAt(0) < 0x20 && data !== "\n") {
    return { buf, submit: false };
  }
  return { buf: buf + data, submit: false };
}

export interface StagePromptInput {
  flowName: string;
  /** 0-based position of the stage; `total` is the pipeline length. */
  index: number;
  total: number;
  /** Label the user sees for this stage. */
  stageLabel: string;
  /** The stage's own instructions, written in the flow editor. */
  stagePrompt: string;
  /** The task that arrived at the wired CLI. */
  task: string;
  /** Summary handed over by the previous stage; empty on the first. */
  carry: string;
  prevLabel?: string;
  nextLabel?: string;
}

/**
 * The stage's full briefing — what `yard flow stage` answers. Everything the
 * agent needs is in it: which flow and stage this is, the task, what the
 * previous turn concluded — and the standing instruction to close with
 * `CARRY_MARK`, the only contract the engine relies on to hand context to
 * the next turn. It never travels through the CLI's input box (the stamp
 * does), so it can afford to be complete: the task is always restated, even
 * when the user's own words are one message above.
 */
export function buildStagePrompt(p: StagePromptInput): string {
  const inst = p.stagePrompt.trim();
  const parts: string[] = [];
  parts.push(
    `${FLOW_MSG_TAG} "${p.flowName}" — etapa ${p.index + 1}/${p.total}: ${p.stageLabel}]`,
  );
  if (inst) parts.push(inst);
  parts.push(`## Tarefa\n${p.task.trim()}`);
  if (p.carry.trim()) {
    parts.push(
      `## O que a etapa anterior${p.prevLabel ? ` (${p.prevLabel})` : ""} concluiu\n${p.carry.trim()}`,
    );
  }
  const handoff = p.nextLabel
    ? `Faça SÓ o que esta etapa pede. Ao terminar, escreva um bloco final começando ` +
      `com a linha "${CARRY_MARK}" resumindo o que fez e o que a próxima etapa ` +
      `(${p.nextLabel}) precisa saber.`
    : `Esta é a última etapa. Ao terminar, escreva um bloco final começando com a ` +
      `linha "${CARRY_MARK}" com o veredito e o estado final da tarefa para o usuário.`;
  parts.push(handoff);
  return parts.join("\n\n");
}

export interface StageStampInput {
  flowName: string;
  /** 0-based position of the stage; `total` is the pipeline length. */
  index: number;
  total: number;
  stageLabel: string;
  /**
   * The intercepted-Enter splice: the user's request is sitting right above,
   * in the same message, and the stamp says so instead of standing alone.
   */
  typed?: boolean;
}

/**
 * The only thing the engine ever types into the CLI: one line naming the
 * flow and the stage, plus the order to fetch the briefing. The letter
 * itself (instructions, task, carry, summary contract) stays out of the
 * prompt — the agent pulls it with `yard flow stage`, the way it would load
 * a skill, and the user's own words remain the only prose on screen.
 */
export function buildStageStamp(p: StageStampInput): string {
  const head = `${FLOW_MSG_TAG} "${p.flowName}" — etapa ${p.index + 1}/${p.total}: ${p.stageLabel}`;
  const mark = p.typed ? ` — assumiu o pedido acima` : "";
  return (
    `${head}${mark}] Rode \`yard flow stage\` e siga o briefing que ele ` +
    `devolver antes de qualquer outra coisa.`
  );
}

/**
 * Classic stage suggestions — the pipeline that gives the mode its name.
 * Offered in the editor's chips and applied only when the user asks; a stage
 * is born blank, because the title and the instructions are theirs to write.
 */
export const FLOW_PRESETS: { name: string; prompt: string }[] = [
  {
    name: "Planejador",
    prompt:
      "Nesta etapa você é o PLANEJADOR. Não escreva código. Analise a tarefa e o " +
      "código envolvido e produza um plano de implementação numerado: arquivos a " +
      "tocar, mudanças em cada um, riscos e o que NÃO fazer.",
  },
  {
    name: "Executor",
    prompt:
      "Nesta etapa você é o EXECUTOR. Implemente exatamente o plano da etapa " +
      "anterior. Se algo se provar inviável, adapte o mínimo necessário e registre " +
      "o desvio no resumo final. Não invente escopo novo.",
  },
  {
    name: "Testes (TDD)",
    prompt:
      "Nesta etapa você cuida de TESTES. Escreva/ajuste testes cobrindo o que foi " +
      "implementado (casos felizes, bordas e regressões), rode a suíte e corrija o " +
      "código apenas o suficiente para os testes passarem. Liste no resumo o que " +
      "ficou coberto e o que não ficou.",
  },
  {
    name: "QA",
    prompt:
      "Nesta etapa você é o QA. Revise criticamente o que as etapas anteriores " +
      "fizeram: rode a build, procure bugs, pontas soltas e desvios do plano. " +
      "Corrija problemas pequenos; os graves, descreva com precisão no resumo.",
  },
  {
    name: "Confirmador",
    prompt:
      "Nesta etapa você é o CONFIRMADOR, a última linha. Verifique o resultado de " +
      "ponta a ponta (build, testes, diff) e dê um veredito honesto: o que foi " +
      "entregue, o que ficou de fora e se está pronto. Não corrija nada — confirme " +
      "ou aponte.",
  },
];
