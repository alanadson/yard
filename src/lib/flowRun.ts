/**
 * Modo Fluxo — the engine: walks a flow card's pipeline, one stage at a
 * time, **inside the wired CLI**. A flow has no agents of its own; the
 * terminal connected to the card is who executes every stage.
 *
 * Per stage it (1) waits for the CLI to be ready (`sendability`, the same
 * rule every other sender obeys), (2) parks the stage's full briefing on the
 * run (`brief`, what `yard flow stage` answers) and injects only a one-line
 * stamp through `injectPrompt` — never a raw `writePty`, never the letter
 * itself in the prompt — and (3) waits for the agent to finish exactly the
 * way `yard ask` does: the byte counter grew and then either the idle event
 * landed or the terminal went quiet. The clean output (or its
 * `### RESUMO DA ETAPA` block) becomes the next stage's carry.
 *
 * Two rules the loop never breaks:
 * - **A blocked agent pauses the flow, it does not fail it.** A question on
 *   screen is the user's to answer; the run marks the stage `blocked`, tells
 *   the user, and resumes on its own when the agent starts writing again.
 * - **The engine never advances over silence it did not see.** Every
 *   completion test is anchored on `ptyProbe().totalBytes`, which works with
 *   the group off-screen; the idle event (`finishedAt`, from the backend's
 *   4.5 s timer) is the accelerator, and only counts when it landed AFTER
 *   the stage began — the flag alone is a latch left armed by past turns.
 */
import { sendNotification } from "@tauri-apps/plugin-notification";

import {
  buildStagePrompt,
  buildStageStamp,
  extractCarry,
  FLOW_MSG_TAG,
  stageLabelOf,
  type FlowItem,
} from "./flow";
import { injectPrompt } from "./inject";
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { sendability } from "./sendable";
import { stripAnsi } from "./bridgeCore";
import { baseName } from "./terminals";
import { useFlows, terminalBusyInFlow, type FlowRun } from "../stores/flowStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";
import { t } from "./i18n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a stage may sit busy/booting before its turn even starts. */
const READY_TIMEOUT_MS = 10 * 60_000;
/** Poll while waiting for the ready window (the composer's cadence). */
const READY_POLL_MS = 500;
/** Completion poll — same 2 s the `ask` loop uses. */
const WORK_POLL_MS = 2_000;
/** Quiet polls that count as "finished" without the idle event (~10 s). */
const QUIET_POLLS = 5;
/**
 * A stage that produced no new byte for this long has died in silence.
 * Generous on purpose: an agent chewing a large repo can take a long turn,
 * and the deadline re-arms whenever output arrives or the agent is blocked.
 */
const STAGE_STALL_MS = 60 * 60_000;

export interface FlowStartResult {
  ok: boolean;
  message: string;
}

function toast(message: string, kind: "info" | "error" = "info") {
  useUI.getState().showToast(message, kind);
}

/** Native notice, only when the user asked to be notified at all. */
function notify(body: string) {
  if (!useUI.getState().prefs.notifyOnFinish) return;
  try {
    sendNotification({ title: t("Yard — Fluxo"), body });
  } catch {
    // Lacking notification permission is not a flow error.
  }
}

/**
 * Starts a run of `flow` inside `terminalId` (a CLI wired to the card).
 * Refuses — with a message ready for a toast or the CLI — when the pipeline
 * cannot walk: no stages, executor missing/stopped/already busy in a run,
 * or the flow itself already running.
 */
export function startFlow(
  groupId: string,
  flow: FlowItem,
  task: string,
  opts: {
    terminalId: string;
    callerId?: string;
    /**
     * The intercepted Enter: the task is already sitting in the CLI's box, so
     * stage 1 is APPENDED to the same message and submitted with it — without
     * repeating the text and without waiting for a window (the user just
     * pressed Enter).
     */
    typed?: boolean;
  },
): FlowStartResult {
  const st = useFlows.getState();
  const s = useProjects.getState();

  if (!task.trim()) return { ok: false, message: t("A tarefa chegou vazia.") };
  // Anti-loop: the trigger briefing and the stage messages reach the CLI as
  // typed text, and a hasty agent once tried to "forward" its own briefing.
  // Nothing Yard wrote is a user task.
  if (task.trimStart().startsWith("[Yard")) {
    return {
      ok: false,
      message: t(
        "isso é uma mensagem do próprio Yard (configuração ou etapa), não uma tarefa do usuário — nada foi disparado. Encaminhe apenas pedidos digitados pelo usuário.",
      ),
    };
  }
  if (flow.stages.length === 0) {
    return {
      ok: false,
      message: t('O fluxo "{name}" ainda não tem etapas — edite-o no canvas.', { name: flow.name }),
    };
  }
  // A stage with no prompt has nothing to instruct: the briefing would arrive
  // carrying only the task, and the CLI would spend a whole turn guessing what
  // this step is for. The editor drops them on save; this covers the cards
  // written before that (and anything the CLI wrote straight into the canvas).
  const util: FlowItem = {
    ...flow,
    stages: flow.stages.filter((stage) => stage.prompt.trim().length > 0),
  };
  if (util.stages.length === 0) {
    return {
      ok: false,
      message: t(
        'As etapas do fluxo "{name}" estão sem prompt — escreva o que cada uma deve fazer antes de rodá-lo.',
        { name: flow.name },
      ),
    };
  }
  const live = st.runs[flow.id];
  if (live && !live.finishedAt) {
    return { ok: false, message: t('O fluxo "{name}" já está em execução.', { name: flow.name }) };
  }

  const term = s.terminal(opts.terminalId);
  if (!term || term.kind !== "agent") {
    return { ok: false, message: t("O executor do fluxo precisa ser um terminal de agente.") };
  }
  if (!isLive(useTerminals.getState().byId[term.id])) {
    return { ok: false, message: t('Inicie "{name}" antes de rodar o fluxo.', { name: baseName(term) }) };
  }
  const other = terminalBusyInFlow(term.id);
  if (other) {
    return {
      ok: false,
      message: t('"{name}" já está executando o fluxo "{other}" — espere ou cancele-o.', {
        name: baseName(term),
        other: other.name,
      }),
    };
  }

  const run: FlowRun = {
    flowId: flow.id,
    groupId,
    name: flow.name,
    task,
    terminalId: term.id,
    ...(opts.callerId ? { callerId: opts.callerId } : {}),
    stages: util.stages.map((stage, i) => ({
      label: stageLabelOf(stage, i),
      status: "pending",
    })),
    current: 0,
    brief: "",
    startedAt: Date.now(),
    stageStartedAt: Date.now(),
    finishedAt: null,
    error: null,
    cancelRequested: false,
    cancelled: false,
  };
  st.begin(run);
  uiLog.info(
    `fluxo "${flow.name}": iniciado em "${baseName(term)}" com ${util.stages.length} etapa(s)`,
  );
  void walk(util, term.id, task, !!opts.typed);
  return {
    ok: true,
    message: t('Fluxo "{name}" iniciado em "{term}" — {n} etapa(s).', {
      name: flow.name,
      term: baseName(term),
      n: util.stages.length,
    }),
  };
}

/** Asks a live run to stop after the current wait tick. */
export function cancelFlow(flowId: string) {
  useFlows.getState().requestCancel(flowId);
}

/**
 * Runs still walking inside any of these canvas items.
 *
 * The engine works on the copy of the pipeline it took when the run began, so
 * deleting the card never interrupted anything: the stages went on being
 * stamped into the CLI, from a card that no longer existed. Whoever deletes a
 * flow card asks this first — to warn, and then to stop it.
 */
export function liveRunsOf(ids: Iterable<string>): FlowRun[] {
  const target = new Set(ids);
  return Object.values(useFlows.getState().runs).filter(
    (r) => !r.finishedAt && target.has(r.flowId),
  );
}

/** Stops the runs of flow cards that are going away. */
export function cancelRunsOf(ids: Iterable<string>): void {
  for (const run of liveRunsOf(ids)) cancelFlow(run.flowId);
}

function cancelRequested(flowId: string): boolean {
  return !!useFlows.getState().runs[flowId]?.cancelRequested;
}

async function walk(flow: FlowItem, terminalId: string, task: string, typed: boolean) {
  const st = useFlows.getState();
  let carry = "";

  for (let i = 0; i < flow.stages.length; i++) {
    const stage = flow.stages[i];
    const label = stageLabelOf(stage, i);
    // Intercepted Enter: the request is sitting in the CLI's box and the user
    // just sent it — waiting for a window here would be holding their Enter.
    const joined = typed && i === 0;
    st.patchRun(flow.id, { current: i, stageStartedAt: Date.now() });
    st.setStage(flow.id, i, "waiting");

    if (!joined) {
      const ready = await waitReady(flow.id, i, terminalId);
      if (ready !== "ok") {
        if (ready === "cancelled") return endCancelled(flow, i);
        return endError(flow, i, ready);
      }
    }

    let baseline = 0;
    try {
      baseline = (await ipc.ptyProbe(terminalId)).totalBytes;
    } catch {
      return endError(flow, i, t("não consegui sondar o terminal executor."));
    }
    const t0 = Date.now();
    // The full letter stays on the run — `yard flow stage` hands it to the
    // agent. What crosses the CLI's prompt is only the one-line stamp.
    st.patchRun(flow.id, {
      brief: buildStagePrompt({
        flowName: flow.name,
        index: i,
        total: flow.stages.length,
        stageLabel: label,
        stagePrompt: stage.prompt,
        task,
        carry,
        prevLabel: i > 0 ? stageLabelOf(flow.stages[i - 1], i - 1) : undefined,
        nextLabel:
          i + 1 < flow.stages.length
            ? stageLabelOf(flow.stages[i + 1], i + 1)
            : undefined,
      }),
    });
    const stamp = buildStageStamp({
      flowName: flow.name,
      index: i,
      total: flow.stages.length,
      stageLabel: label,
      typed: joined,
    });
    try {
      // On the splice, the stamp goes glued to the already typed request (the
      // Enter the user pressed was swallowed) and the final submit sends it all
      // as ONE message.
      await injectPrompt(terminalId, joined ? `\n\n${stamp}` : stamp);
    } catch (e) {
      return endError(flow, i, t("não consegui entregar o carimbo da etapa: {e}", { e: String(e) }));
    }
    st.setStage(flow.id, i, "working");
    uiLog.info(`fluxo "${flow.name}": etapa ${i + 1}/${flow.stages.length} ("${label}") começou`);

    const outcome = await waitDone(flow.id, i, terminalId, baseline, t0, label);
    if (outcome === "cancelled") return endCancelled(flow, i);
    if (outcome !== "ok") return endError(flow, i, outcome);

    let clean = "";
    try {
      const after = await ipc.ptyReadSince(terminalId, baseline, 64 * 1024);
      clean = stripAnsi(after.data).trim();
    } catch {
      // The output is the carry, not the verdict: going on without it beats aborting.
    }
    carry = extractCarry(clean);
    st.setStage(flow.id, i, "done");
    uiLog.info(`fluxo "${flow.name}": etapa ${i + 1} ("${label}") concluída`);
  }

  st.patchRun(flow.id, { current: flow.stages.length, finishedAt: Date.now() });
  toast(t('Fluxo "{name}" concluído — {n} etapa(s).', { name: flow.name, n: flow.stages.length }));
  notify(t('Fluxo "{name}" concluído.', { name: flow.name }));
  uiLog.info(`fluxo "${flow.name}": concluído`);

  // The task was born in a CLI (`yard flow run`); when the caller is not the
  // executor itself — which already has everything on screen — the summary
  // goes back to it.
  const callerId = useFlows.getState().runs[flow.id]?.callerId;
  if (callerId && callerId !== terminalId) {
    void deliverResult(callerId, flow.name, carry);
  }
}

/**
 * Waits for the executor CLI to accept input. `busy` waits; `blocked` also
 * waits (marking the stage so the user sees who is holding the pipeline), and
 * both re-arm the deadline — only a terminal that died fails the turn.
 */
async function waitReady(
  flowId: string,
  index: number,
  terminalId: string,
): Promise<"ok" | "cancelled" | string> {
  let deadline = Date.now() + READY_TIMEOUT_MS;
  let toldBlocked = false;
  for (;;) {
    if (cancelRequested(flowId)) return "cancelled";
    const sb = sendability(terminalId);
    if (sb.ok) return "ok";
    if (sb.reason === "missing" || sb.reason === "dead") {
      return sb.message ?? t("o terminal executor não está mais rodando.");
    }
    if (sb.reason === "blocked") {
      useFlows.getState().setStage(flowId, index, "blocked");
      if (!toldBlocked) {
        toldBlocked = true;
        const run = useFlows.getState().runs[flowId];
        toast(
          t('Fluxo "{name}": a CLI está travada numa pergunta — responda para o fluxo seguir.', {
            name: run?.name ?? "",
          }),
        );
        notify(t('Fluxo "{name}" precisa de você.', { name: run?.name ?? "" }));
      }
      deadline = Date.now() + READY_TIMEOUT_MS;
    } else {
      useFlows.getState().setStage(flowId, index, "waiting");
    }
    if (Date.now() >= deadline) {
      return t("a CLI nunca ficou pronta para receber a etapa (ocupada por muito tempo).");
    }
    await sleep(READY_POLL_MS);
  }
}

/**
 * Waits for the stage turn to finish — the `askOne` recipe, without a short
 * timeout: growth then the idle event, or growth then ~10 s of silence. A
 * blocked pause is surfaced and forgiven; a stalled hour is not.
 */
async function waitDone(
  flowId: string,
  index: number,
  terminalId: string,
  baseline: number,
  t0: number,
  label: string,
): Promise<"ok" | "cancelled" | string> {
  let lastSeq = baseline;
  let lastGrowthAt = Date.now();
  let grew = false;
  let quiet = 0;
  let toldBlocked = false;

  for (;;) {
    if (cancelRequested(flowId)) return "cancelled";
    await sleep(WORK_POLL_MS);

    let probe;
    try {
      probe = await ipc.ptyProbe(terminalId);
    } catch (e) {
      return t('perdi o terminal executor no meio da etapa "{label}": {e}', { label, e: String(e) });
    }
    if (!probe.alive) {
      return t('o terminal executor encerrou no meio da etapa "{label}".', { label });
    }
    if (probe.totalBytes > lastSeq) {
      lastSeq = probe.totalBytes;
      lastGrowthAt = Date.now();
      grew = true;
      quiet = 0;
    } else if (grew) {
      quiet++;
    }

    const rt = useTerminals.getState().byId[terminalId];
    if (rt?.blocked) {
      useFlows.getState().setStage(flowId, index, "blocked");
      lastGrowthAt = Date.now(); // a question on screen is not a stalled flow
      if (!toldBlocked) {
        toldBlocked = true;
        const run = useFlows.getState().runs[flowId];
        toast(
          t('Fluxo "{name}": a etapa "{label}" espera uma resposta sua na CLI.', {
            name: run?.name ?? "",
            label,
          }),
        );
        notify(t('Fluxo "{name}" precisa de você.', { name: run?.name ?? "" }));
      }
      continue;
    }
    if (toldBlocked) {
      // Writing again: the question was answered.
      toldBlocked = false;
      useFlows.getState().setStage(flowId, index, "working");
    }

    // `finished` is a latch: only focus on the pane releases it, so it may
    // have been armed since the PREVIOUS turn. Activity after `t0` does not
    // break the tie — the echo of the stamp itself is activity — and that is
    // how a real stage once "finished" in 2 s. What breaks the tie is
    // `finishedAt`: the idle event must have landed AFTER this stage began.
    // Without a mounted XTermView the event still moves (it is the backend's);
    // and the silence path right below remains the safety net.
    if (grew && rt?.finished && rt.finishedAt >= t0) return "ok";
    if (grew && quiet >= QUIET_POLLS) return "ok";
    if (Date.now() - lastGrowthAt > STAGE_STALL_MS) {
      return t('a etapa "{label}" ficou mais de {min} min sem produzir saída — interrompida.', {
        label,
        min: Math.round(STAGE_STALL_MS / 60_000),
      });
    }
  }
}

/** How long the caller's CLI gets to go quiet before the result is dropped. */
const RESULT_TIMEOUT_MS = 3 * 60_000;

/**
 * Types the final summary back into the CLI that asked for the run. Best
 * effort on purpose: the result also lives on the executor's screen and in
 * the HUD, so a caller that died or is stuck at a question just misses the
 * copy — nothing retries into a terminal that cannot take it.
 */
async function deliverResult(terminalId: string, flowName: string, carry: string) {
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  for (;;) {
    const sb = sendability(terminalId);
    if (sb.ok) break;
    if (sb.reason !== "busy" || Date.now() >= deadline) {
      uiLog.info(`fluxo "${flowName}": resultado não entregue ao chamador (${sb.reason})`);
      return;
    }
    await sleep(READY_POLL_MS);
  }
  const msg =
    `${FLOW_MSG_TAG} "${flowName}" — concluído]\n\n` + // i18n-ok — typed into the agent
    `Resultado final da tarefa que você encaminhou:\n\n${carry.trim()}\n\n` + // i18n-ok
    "Apresente o resultado ao usuário desta CLI de forma clara e curta."; // i18n-ok
  try {
    await injectPrompt(terminalId, msg);
    uiLog.info(`fluxo "${flowName}": resultado entregue ao chamador`);
  } catch (e) {
    uiLog.error(`fluxo "${flowName}": falha entregando o resultado ao chamador: ${e}`);
  }
}

function endError(flow: FlowItem, index: number, message: string) {
  const st = useFlows.getState();
  st.setStage(flow.id, index, "error");
  st.patchRun(flow.id, { error: message, finishedAt: Date.now() });
  toast(
    t('Fluxo "{name}" parou na etapa {n}: {message}', { name: flow.name, n: index + 1, message }),
    "error",
  );
  notify(t('Fluxo "{name}" falhou na etapa {n}.', { name: flow.name, n: index + 1 }));
  uiLog.error(`fluxo "${flow.name}": etapa ${index + 1} falhou — ${message}`);
}

function endCancelled(flow: FlowItem, index: number) {
  const st = useFlows.getState();
  st.patchRun(flow.id, { cancelled: true, finishedAt: Date.now() });
  toast(t('Fluxo "{name}" cancelado na etapa {n}.', { name: flow.name, n: index + 1 }));
  uiLog.info(`fluxo "${flow.name}": cancelado na etapa ${index + 1}`);
}
