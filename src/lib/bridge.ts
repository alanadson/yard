/**
 * The brain of the `yard` CLI: the agent<->app bridge.
 *
 * Rust (bridge.rs) only transports: each CLI invocation arrives here as an
 * event with `{id, request}` and the reply goes back via `bridge_respond`.
 * This module resolves names, validates the connections drawn on the canvas,
 * injects prompts into PTYs and waits for agents to finish — all on top of
 * the stores the UI already keeps.
 *
 * Access rule: an agent only talks to what is **connected** to it on the
 * canvas. Agents: direct connection. Notes: reachable traveling only
 * through notes (note chains work).
 *
 * The pure rules (name dedup, reach, ANSI cleanup) live in `bridgeCore.ts`
 * — those are the ones the composer reuses and the tests cover.
 */
import { nanoid } from "nanoid";
import { sendNotification } from "@tauri-apps/plugin-notification";

import {
  ipc,
  type BridgeRequest,
  type BridgeResponse,
  type PtySnapshot,
  type TerminalRow,
} from "./ipc";
import { uiLog } from "./log";
import { closeGroup, closeTerminal, disposePty } from "./lifecycle";
import {
  applyScore,
  readScore,
  saveScore,
  scoreAlreadyExists,
} from "./scores";
import { findGroupNamed, isIsolatedFloor } from "./floors";
import { sameRoot } from "./roots";
import { exitCodeOf, planText, runJson, runSummary } from "./provision/report";
import { provisionFronts } from "./provision/run";
import { agentAsFanout, fanOutTask } from "./floorFanout";
import { defaultRoleOf } from "./agentDefaults";
import { spawnEnvFor } from "./spawnEnv";
import { landFloor, previewFloor, settleAfterLand } from "./floorLand";
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { normalizeSurface } from "./surface";
import { useProjects } from "../stores/projectsStore";
import {
  reachedWait,
  useTerminals,
  type TerminalRuntime,
  type WaitUntil,
} from "../stores/terminalsStore";
import { bridgeCallerRect as callerRect, commitBridgeCanvas as commitCanvas } from "./bridgeCanvas";
import { boardElements, CANVAS_CAMERA_EVENT, runCanvasCommand } from "./bridgeCanvasCmd";
import { parseHookEvent } from "./hookEvents";
import {
  findWorker,
  formatWorkerInspect,
  formatWorkerList,
  formatWorkerReview,
  keptFloor,
  WORKER_USAGE,
  workerRows,
} from "./workerRuns";
import { t } from "./i18n";
import {
  clampRoutineInterval,
  EMPTY_CANVAS,
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  noteName,
  type CardRole,
  type RoutineDef,
  type TriggerDef,
} from "./canvas";
import { parseTriggerCreate, TRIGGER_CREATE_USAGE, triggerSummary } from "./triggers";
import {
  deleteGlobalRole,
  findSaved,
  groupRoles,
  mergeRoles,
  readGlobalRoles,
  resolveRole,
  roleLaunch,
  writeGlobalRole,
  type RoleLaunch,
  type RoleScope,
  type SavedRole,
} from "./roles";
import { applyRoleToProcess, deliverBriefing } from "./roleBrief";
import {
  addItems,
  connection,
  isConnected,
  patchItemOfType,
  removeItemAndEdges,
  setEntry,
} from "./canvasOps";
import { injectPrompt } from "./inject";
import { findFlow, flowsOf } from "./flow";
import { cancelFlow, startFlow } from "./flowRun";
import { useFlows, type FlowRun } from "../stores/flowStore";
import {
  connectedAgents,
  connectedNotes,
  connectedPortals,
  findAgent,
  findAny,
  findNote,
  makeCtx,
  parseFlags,
  reaches,
  stripAnsi,
  tail,
  type Ctx,
  type NoteItem,
} from "./bridgeCore";
import { formatSearch, parseSearch, TOTAL_LIMIT } from "./bridgeSearch";
import { formatQueue, queuedLine } from "./bridgeQueue";
import { handoffMessage } from "./handoff";
import { transcriptBlocks, type Block } from "./transcript";
import { bestSessionFor } from "./sessionFind";
import { hasSessions } from "../stores/agentsStore";
import { useChanges } from "../stores/changesStore";
import { waitUntilSendable } from "./sendable";
import { QUEUE_CAP } from "./queue";
import { useQueue } from "../stores/queueStore";
import { baseName } from "./terminals";
import { pushOut } from "./notifyOut";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// caller context
// ---------------------------------------------------------------------------

function buildCtx(terminalId: string): Ctx | string {
  const s = useProjects.getState();
  const caller = s.terminal(terminalId);
  if (!caller) {
    return (
      "yard: este terminal nao esta registrado no workspace do Yard " +
      "(YARD_PTY_ID desconhecido)\n"
    );
  }
  const canvas = s.layoutOf(caller.groupId).canvas ?? EMPTY_CANVAS;
  // The caller's own surface, and only it: the board and the panes stopped
  // sharing their CLIs, so a card that could address a tab would be offering
  // a conversation the user has no way to see, on either side.
  return makeCtx(
    caller,
    caller.groupId,
    canvas,
    s.terminalsOn(caller.groupId, normalizeSurface(caller.surface)),
  );
}

/**
 * What the prompt composer needs to know about a terminal: what it is
 * called and who is connected to it (the possible `@mentions`). Same gate
 * as the CLI — if the agent cannot talk, it cannot mention either.
 */
export function composerContext(
  terminalId: string,
): { me: string; agents: { id: string; name: string }[] } | null {
  const ctx = buildCtx(terminalId);
  if (typeof ctx === "string") return null;
  return {
    me: ctx.nameOf.get(ctx.caller.id) ?? "terminal",
    agents: connectedAgents(ctx).map((t) => ({
      id: t.id,
      name: ctx.nameOf.get(t.id)!,
    })),
  };
}

/**
 * Starts the process behind a card the CLI just created and marks the row
 * alive. The geometry is the same everywhere on purpose: the card is resized
 * by the user, and a PTY born at the pane's real size would still be wrong
 * the moment the canvas is zoomed.
 */
async function spawnCard(
  id: string,
  opts: { program: string; args: string[]; cwd: string; kind: string; title: string },
): Promise<PtySnapshot> {
  const snap = await ipc.spawnPty({
    id,
    program: opts.program,
    args: opts.args,
    cwd: opts.cwd,
    rows: SPAWN_ROWS,
    cols: SPAWN_COLS,
    kind: opts.kind as "shell" | "agent",
    title: opts.title,
    // The cache lifetime is an environment variable, and a PTY's environment
    // is fixed at spawn (`lib/spawnEnv.ts`).
    env: spawnEnvFor(id),
  });
  useProjects.getState().updateTerminal(id, { alive: true });
  return snap;
}

/**
 * The launch of a recruited card: untouched on Windows, wrapped in `wsl.exe`
 * when the agent was told to live in a distro. It happens once per branch,
 * where the working directory is finally known.
 */
function bornAs(
  agentId: string | null,
  program: string,
  args: string[],
  cwd: string,
): { program: string; args: string[] } {
  return useAgentDefaults.getState().launchOf(agentId, { program, args, cwd });
}

const SPAWN_ROWS = 38;
const SPAWN_COLS = 120;

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const ok = (output: string): BridgeResponse => ({ code: 0, output });
const err = (output: string): BridgeResponse => ({ code: 1, output });

export async function handleBridgeRequest(req: BridgeRequest): Promise<BridgeResponse> {
  const argv = Array.isArray(req.argv)
    ? req.argv.map(String)
    : req.argv != null
      ? [String(req.argv)]
      : [];
  const cmd = argv[0]?.toLowerCase() ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") return ok(HELP);

  const ctxOr = buildCtx(req.terminal ?? "");
  if (typeof ctxOr === "string") {
    if (cmd === "debug") {
      return ok(
        `terminal recebido: ${req.terminal ?? "(vazio)"}\n` +
          `registrado no workspace: nao\n` +
          `Dica: a CLI so funciona em terminais abertos pelo Yard.\n`,
      );
    }
    return err(ctxOr);
  }
  const ctx = ctxOr;
  uiLog.info(`bridge: ${ctx.nameOf.get(ctx.caller.id)} -> ${argv.join(" ")}`);

  switch (cmd) {
    case "list":
      return cmdList(ctx);
    case "search":
      return cmdSearch(ctx, argv.slice(1));
    case "queue":
      return cmdQueue(ctx, argv.slice(1));
    case "handoff":
      return cmdHandoff(ctx, argv.slice(1), req);
    case "ask":
      return cmdAsk(ctx, argv.slice(1), req);
    case "check":
      return cmdCheck(ctx, argv.slice(1));
    case "wait":
      return cmdWait(ctx, argv.slice(1), req.timeoutMs);
    case "note":
      return cmdNote(ctx, argv.slice(1), req);
    case "connect":
      return cmdConnect(ctx, argv.slice(1));
    case "recruit":
      return cmdRecruit(ctx, argv.slice(1));
    case "floor":
      return cmdFloor(ctx, argv.slice(1));
    case "dismiss":
      return cmdDismiss(ctx, argv.slice(1));
    case "role":
      return cmdRole(ctx, argv.slice(1));
    case "routine":
      return cmdRoutine(ctx, argv.slice(1), req);
    case "flow":
      return cmdFlow(ctx, argv.slice(1), req);
    case "score":
      return cmdScore(ctx, argv.slice(1));
    case "notify":
      return cmdNotify(ctx, argv.slice(1));
    case "debug":
      return cmdDebug(ctx);
    case "portal":
      return import("./bridgePortal").then(({ cmdPortal }) =>
        cmdPortal(ctx, argv.slice(1)),
      );
    case "trigger":
      return cmdTrigger(ctx, argv.slice(1), req);
    case "canvas":
      return cmdCanvas(ctx, argv.slice(1));
    case "worker":
      return cmdWorker(ctx, argv.slice(1), req);
    case "hook":
      return cmdHook(ctx, argv.slice(1), req);
    default:
      return err(`yard: comando desconhecido "${cmd}". Rode \`yard help\`.\n`);
  }
}

// --- hooks ------------------------------------------------------------------

/**
 * Workers as one object: a front opened for a task with one agent card
 * inside it (`lib/workerRuns.ts` reads them; `fanOutTask` makes them). No
 * cable is involved: a worker lives on another front, which no connection
 * crosses, so the reach here is the project, the same as `yard floor`.
 */
async function cmdWorker(ctx: Ctx, args: string[], req: BridgeRequest): Promise<BridgeResponse> {
  const sub = (args[0] ?? "list").toLowerCase();
  const project = useProjects.getState().projectOfGroup(ctx.groupId);
  if (!project) return err("yard: o grupo deste terminal não pertence a um projeto.\n");

  // Read fresh every time: create, apply and discard all move the store.
  const rowsNow = () => {
    const s = useProjects.getState();
    const rt = useTerminals.getState().byId;
    return workerRows({
      groups: s.groupsOf(project.id),
      floorOf: (gid) => s.layoutOf(gid).floor,
      terminalsOf: (gid) => s.terminalsOf(gid),
      runtimeOf: (tid) => rt[tid],
    });
  };

  if (sub === "list") {
    const p = parseFlags(args.slice(1), { "--json": "bool" });
    const rows = rowsNow();
    if (p.bool.json) return ok(JSON.stringify(rows, null, 2) + "\n");
    return ok(formatWorkerList(rows, project.name));
  }

  if (sub === "create") {
    const p = parseFlags(args.slice(1), {
      "--task": "string",
      "--prompt": "string",
      "--agent": "string",
      "--copy-ground": "bool",
      "--stdin": "stdin",
    });
    const name = p.positional[0];
    const prompt = (p.fromStdin ? req.stdin : (p.string.task ?? p.string.prompt)) ?? "";
    if (!name || !prompt.trim()) return { code: 2, output: WORKER_USAGE };

    // Without `--agent` the worker is the same CLI as the caller, which is
    // what makes `yard worker create "X" --task "…"` a one-line delegation.
    const detected = await ipc.detectAgents(false);
    const want = (p.string.agent ?? ctx.caller.agentId ?? "").toLowerCase();
    const found = detected.find(
      (a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want,
    );
    const fan = found ? agentAsFanout(found) : null;
    if (!fan) {
      const available = detected.filter((a) => a.installed).map((a) => a.id);
      return err(
        want
          ? `yard: agente "${want}" não está instalado. Disponíveis: ${available.join(", ")}.\n`
          : `yard: diga o agente com --agent. Disponíveis: ${available.join(", ")}.\n`,
      );
    }
    try {
      const result = await fanOutTask({
        projectId: project.id,
        name,
        prompt,
        agents: [fan],
        copyGround: !!p.bool["copy-ground"],
        exactName: true,
      });
      const born = result.floors[0];
      if (!born) {
        return err(`yard: ${result.failures.join("; ") || "não consegui criar o worker"}\n`);
      }
      const floor = useProjects.getState().layoutOf(born.groupId).floor;
      const stopped = result.notStarted.some((f) => f.groupId === born.groupId);
      return ok(
        `worker "${born.name}" criado [${stopped ? "stopped" : "starting"}]\n` +
          `  agente: ${born.agentId}\n` +
          `  branch: ${floor?.branch ?? "?"}\n` +
          `  worktree: ${floor?.worktreePath ?? "?"}\n` +
          `  cartão: ${born.terminalId}\n` +
          `  grupo: ${born.groupId}\n` +
          (result.failures.length ? `  avisos: ${result.failures.join("; ")}\n` : "") +
          `Acompanhe com \`yard worker wait "${born.name}"\`; leia com \`yard worker review "${born.name}"\`.\n`,
      );
    } catch (e) {
      return err(`yard: não consegui criar o worker: ${e}\n`);
    }
  }

  // Everything below addresses one worker.
  const query = args[1];
  if (!query) return { code: 2, output: WORKER_USAGE };
  const row = findWorker(rowsNow(), query);
  if (!row) return err(`yard: não achei o worker "${query}". Veja \`yard worker list\`.\n`);
  const group = useProjects.getState().groups.find((g) => g.id === row.groupId);
  if (!group) return err(`yard: o grupo do worker "${row.name}" sumiu.\n`);

  switch (sub) {
    case "inspect":
      return ok(formatWorkerInspect(row));

    case "wait": {
      const p = parseFlags(args.slice(2), { "--until": "string", "--timeout": "number" });
      const until = (p.string.until ?? "stopped") as WaitUntil;
      if (until !== "stopped" && until !== "done" && until !== "blocked") {
        return err(`yard: --until aceita stopped, done ou blocked (recebi "${until}").\n`);
      }
      if (!row.terminalId) return err(`yard: o worker "${row.name}" não tem cartão para esperar.\n`);
      const timeoutMs =
        p.number.timeout && p.number.timeout > 0
          ? p.number.timeout * 1_000
          : Math.max(30_000, (req.timeoutMs ?? 600_000) - 15_000);
      const reached = await waitForReach([row.terminalId], until, false, null, timeoutMs);
      const after = findWorker(rowsNow(), row.groupId) ?? row;
      if (!reached.has(row.terminalId)) {
        return err(
          `yard: "${row.name}" não chegou em "${until}" em ${Math.round(timeoutMs / 1_000)}s ` +
            `(está [${after.state}]).\n`,
        );
      }
      return ok(`"${row.name}" [${after.state}]${after.ask ? ` (pergunta: ${after.ask})` : ""}\n`);
    }

    case "send": {
      const p = parseFlags(args.slice(2), { "--queue": "bool", "--stdin": "stdin" });
      const text = p.fromStdin ? (req.stdin ?? "") : (p.positional[0] ?? "");
      if (!text.trim()) return { code: 2, output: WORKER_USAGE };
      if (!row.terminalId) return err(`yard: o worker "${row.name}" não tem cartão para receber.\n`);
      if (p.bool.queue) {
        const queued = useQueue
          .getState()
          .enqueue(row.terminalId, text, "bridge", ctx.nameOf.get(ctx.caller.id));
        return queued.ok
          ? ok(queuedLine(row.name, queued.position ?? 1))
          : err(`yard: a fila de "${row.name}" está cheia.\n`);
      }
      const can = await waitUntilSendable(row.terminalId);
      if (!can.ok) {
        return err(`yard: "${row.name}" não pode receber agora (${can.reason}). Use --queue.\n`);
      }
      await injectPrompt(row.terminalId, text);
      return ok(`enviado para "${row.name}" (${text.length} caracteres).\n`);
    }

    case "review": {
      try {
        return ok(formatWorkerReview(await previewFloor(project, group)));
      } catch (e) {
        return err(`yard: não consegui comparar: ${e}\n`);
      }
    }

    case "apply": {
      const p = parseFlags(args.slice(2), { "--keep-front": "bool", "--close-siblings": "bool" });
      try {
        const result = await landFloor(project, group);
        if (!result.ok) {
          return err(
            `yard: ${result.message}` +
              (result.conflictPaths.length ? `\n  conflitos: ${result.conflictPaths.join(", ")}` : "") +
              "\n",
          );
        }
        const closeWinner = !p.bool["keep-front"];
        const closeSiblings = !!p.bool["close-siblings"];
        const warnings =
          closeWinner || closeSiblings
            ? await settleAfterLand({ project, winner: group, closeWinner, closeSiblings })
            : [];
        return ok(`${result.message}` + (warnings.length ? ` (${warnings.join("; ")})` : "") + "\n");
      } catch (e) {
        return err(`yard: não consegui aplicar: ${e}\n`);
      }
    }

    case "keep": {
      const floor = useProjects.getState().layoutOf(row.groupId).floor;
      if (floor) useProjects.getState().updateLayout(row.groupId, { floor: keptFloor(floor) });
      return ok(`"${row.name}" agora é uma frente comum (branch ${row.branch ?? "?"}).\n`);
    }

    case "discard": {
      if (row.groupId === ctx.groupId) {
        return err(`yard: você está dentro de "${row.name}"; descarte a partir de outra frente.\n`);
      }
      try {
        await closeGroup(row.groupId);
        return ok(`worker "${row.name}" descartado.\n`);
      } catch (e) {
        return err(`yard: não consegui descartar: ${e}\n`);
      }
    }

    case "stop": {
      if (!row.terminalId) return ok(`"${row.name}" já não tem processo.\n`);
      await disposePty(row.terminalId);
      useProjects.getState().updateTerminal(row.terminalId, { alive: false });
      return ok(`worker "${row.name}" parado; a frente fica.\n`);
    }

    default:
      return { code: 2, output: WORKER_USAGE };
  }
}

/**
 * A CLI's own hook reporting on its turn (`lib/hookEvents.ts`). Not for
 * agents to call by hand, and absent from the help: the caller is the CLI
 * process itself, through the settings file or notify program Yard handed
 * it at launch. Whatever it says lands on the runtime mirror of the caller.
 */
function cmdHook(ctx: Ctx, args: string[], req: BridgeRequest): BridgeResponse {
  const event = parseHookEvent(args, req.stdin);
  if (!event) return err("yard: hook desconhecido.\n");
  const mirror = useTerminals.getState();
  const id = ctx.caller.id;
  switch (event.kind) {
    case "turn-start":
      mirror.hookTurnStart(id);
      break;
    case "turn-end":
      mirror.markFinished(id);
      break;
    case "permission":
      mirror.markPermission(id, event.ask || t("Pedindo permissão"));
      break;
    case "working":
      mirror.hookWorking(id);
      break;
    case "session":
      break;
  }
  return ok("");
}

// --- canvas -----------------------------------------------------------------

/**
 * The board's layout from the agent's side (`lib/bridgeCanvasCmd.ts` decides;
 * this commits and moves the camera). A layout change goes through the same
 * external commit as a note write, so the user's undo never swallows it.
 */
function cmdCanvas(ctx: Ctx, args: string[]): BridgeResponse {
  const r = runCanvasCommand({
    argv: args,
    canvas: ctx.canvas,
    elements: boardElements(ctx),
    callerId: ctx.caller.id,
  });
  if (!r.ok) return err(r.output);
  if (r.canvas) {
    const next = r.canvas;
    commitCanvas(ctx.groupId, () => next);
  }
  if (r.camera) {
    window.dispatchEvent(
      new CustomEvent(CANVAS_CAMERA_EVENT, { detail: { groupId: ctx.groupId, ...r.camera } }),
    );
  }
  return ok(r.output);
}

// --- handoff ----------------------------------------------------------------

/**
 * Passing the baton to another agent (`lib/handoff.ts` writes the message).
 *
 * What makes this worth a command rather than a paragraph typed by hand is
 * the part a person always leaves out: the **state of the tree**. The prompt
 * carries the branch and the diffstat along with the last few turns, so the
 * agent taking over does not spend its first ten minutes discovering what the
 * previous one already changed.
 */
async function cmdHandoff(
  ctx: Ctx,
  argv: string[],
  req: BridgeRequest,
): Promise<BridgeResponse> {
  const p = parseFlags(argv, {
    "--queue": "bool",
    "--stdin": "stdin",
    "--file": "stdin",
  });
  const target = p.positional[0];
  const left = p.fromStdin ? (req.stdin ?? "") : (p.positional[1] ?? "");
  if (!target) {
    return err(
      'uso: yard handoff "Alvo" ["o que falta"] [--queue]\n' +
        "     passa o bastão: papel, estado da árvore e os últimos turnos viram o prompt do alvo\n",
    );
  }
  const to = findAgent(ctx, target);
  if (!to) return err(`yard: "${target}" não está conectado a você.\n`);

  const me = ctx.caller;
  const role = ctx.canvas.roles?.[me.id];
  const group = useProjects.getState().groups.find((g) => g.id === me.groupId);
  const git = group?.projectId
    ? useChanges.getState().gitByProject[group.projectId]
    : undefined;

  // The turns, when this CLI keeps a session file. Best effort on purpose: a
  // handoff with no transcript is still worth sending, and a `.jsonl` that
  // moved must not cost the whole command.
  let blocks: Block[] = [];
  try {
    if (me.agentId && hasSessions(me.agentId)) {
      const sessions = await ipc.listAgentSessions(me.agentId, me.cwd);
      const best = bestSessionFor(sessions, me.resume);
      if (best) blocks = transcriptBlocks(await ipc.sessionEvents(best.file));
    }
  } catch {
    blocks = [];
  }

  const message = handoffMessage({
    from: ctx.nameOf.get(me.id) ?? me.program,
    role: role?.name ?? "",
    branch: git?.branch ?? "",
    files: git?.files.length ?? 0,
    additions: git?.additions ?? 0,
    deletions: git?.deletions ?? 0,
    blocks,
    left,
  });
  const label = ctx.nameOf.get(to.id) ?? target;

  if (p.bool.queue) {
    const queued = useQueue
      .getState()
      .enqueue(to.id, message, "bridge", ctx.nameOf.get(me.id));
    return queued.ok
      ? ok(queuedLine(label, queued.position ?? 1))
      : err(`yard: a fila de "${label}" está cheia.\n`);
  }

  // The baton is one message and there is no second copy of it: a CLI that is
  // busy or at a prompt would swallow it into whatever question is on screen.
  const can = await waitUntilSendable(to.id);
  if (!can.ok) {
    return err(
      `yard: "${label}" não pode receber agora (${can.reason}). ` +
        "Use --queue para deixar o bastão esperando.\n",
    );
  }
  await injectPrompt(to.id, message);
  return ok(`bastão passado para "${label}" (${message.length} caracteres).\n`);
}

// --- queue ------------------------------------------------------------------

/**
 * What is waiting to be typed into somebody (`lib/queue.ts` holds it).
 *
 * Read-only plus a broom, and that is deliberate: an agent may look at the
 * queue and clear one, but it may not reorder another agent's work. Putting
 * something *in* the queue is `--queue` on the command that had something to
 * say.
 */
function cmdQueue(ctx: Ctx, args: string[]): BridgeResponse {
  const sub = (args[0] ?? "list").toLowerCase();
  const mine = [ctx.caller, ...connectedAgents(ctx)];
  const nameOf = (id: string) => ctx.nameOf.get(id) ?? id;

  if (sub === "list") {
    // Only what is queued for the caller and for what the caller can talk to:
    // the queue is workspace-wide, and the rest of it is none of its business.
    const items = useQueue
      .getState()
      .items.filter((item) => mine.some((t) => t.id === item.terminalId));
    return ok(formatQueue(items, nameOf));
  }

  if (sub === "clear") {
    const who = args[1];
    const target = who ? findAgent(ctx, who) : ctx.caller;
    if (!target) return err(`yard: "${who}" não está conectado a você.\n`);
    const had = useQueue.getState().count(target.id);
    useQueue.getState().clear(target.id);
    return ok(
      had === 0
        ? `A fila de "${nameOf(target.id)}" já estava vazia.\n`
        : `Fila de "${nameOf(target.id)}" limpa (${had} item${had === 1 ? "" : "s"}).\n`,
    );
  }

  return err('uso: yard queue [list]\n     yard queue clear ["Agente"]\n');
}

// --- search -----------------------------------------------------------------

/**
 * Reading the past: what some terminal printed, twenty minutes ago, in a pane
 * nobody has open. The shape of the answer and its ceiling live in
 * `bridgeSearch.ts`, which is where they can be tested.
 */
async function cmdSearch(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const { text, all, limit } = parseSearch(args);
  if (!text) {
    return err(
      'uso: yard search "texto" [--all] [--limit 4]\n' +
        "     procura no histórico dos terminais (o do grupo; --all, o workspace inteiro)\n",
    );
  }
  const s = useProjects.getState();
  const ids = (all ? s.terminals : ctx.terminals).map((t) => t.id);
  if (ids.length === 0) return ok("Nenhum terminal para procurar.\n");

  const answer = await ipc.searchScrollback(ids, text, limit, TOTAL_LIMIT);
  return ok(
    formatSearch(
      answer,
      (id) => {
        // A hit outside the caller's own group has no name in `nameOf`, and
        // "term_9fa2" tells the reader nothing about where to look.
        const known = ctx.nameOf.get(id);
        if (known) return known;
        const row = s.terminal(id);
        if (!row) return id;
        const group = s.groups.find((g) => g.id === row.groupId);
        return group ? `${baseName(row)}, ${group.name}` : baseName(row);
      },
      text,
    ),
  );
}

// --- list -------------------------------------------------------------------

/**
 * Who the caller can talk to. This is the first command every agent runs, so
 * it answers the three questions that follow it: what are the names, what
 * state is each one in, and what is there to read.
 */
function cmdList(ctx: Ctx): BridgeResponse {
  const roles = ctx.canvas.roles ?? {};
  const rt = useTerminals.getState().byId;
  const mine = ctx.nameOf.get(ctx.caller.id);
  const myRole = roles[ctx.caller.id];
  let out = `You: "${mine}"${myRole ? ` — papel: ${myRole.name}` : ""}\n`;

  const agents = connectedAgents(ctx);
  out += "Agentes conectados:\n";
  if (agents.length === 0) {
    out +=
      "  (nenhum — peça ao usuário para desenhar uma conexão no canvas,\n" +
      "   ou use `yard connect` / `yard recruit`)\n";
  }
  for (const t of agents) {
    const runtime = rt[t.id];
    const state = runtime?.blocked ? "travado" : (runtime?.state ?? "idle");
    const role = roles[t.id];
    // The question on the screen is the whole point of saying "travado": it
    // is what the reader can actually answer.
    const asking =
      runtime?.blocked && runtime.blockedAsk ? ` — pergunta: ${runtime.blockedAsk}` : "";
    out += `  - "${ctx.nameOf.get(t.id)}" [${state}]${role ? ` papel: ${role.name}` : ""}${asking}\n`;
  }

  const notes = connectedNotes(ctx);
  out += "Notas conectadas:\n";
  if (notes.length === 0) out += "  (nenhuma — crie com `yard note create`)\n";
  for (const n of notes) {
    const lines = n.text ? n.text.split("\n").length : 0;
    out += `  - "${ctx.noteNameOf.get(n.id)}" (${lines} linha${lines === 1 ? "" : "s"})${
      n.locked ? " (locked)" : ""
    }\n`;
  }

  const portals = connectedPortals(ctx);
  out += "Portais conectados:\n";
  if (portals.length === 0) {
    out +=
      "  (nenhum — peça ao usuário para criar um portal no canvas (W)\n" +
      "   e ligá-lo em você, ou use `yard portal create`)\n";
  }
  for (const p of portals) out += `  - "${ctx.portalNameOf.get(p.id)}"  ${p.url}\n`;

  const routines = (ctx.canvas.routines ?? []).filter((r) => r.enabled);
  if (routines.length) {
    out += `Rotinas ativas no grupo: ${routines.length} (\`yard routine list\`)\n`;
  }
  return ok(out);
}

// --- ask --------------------------------------------------------------------

const ASK_SPEC = {
  "--raw": "bool",
  "--no-wait": "bool",
  "--queue": "bool",
  "--stdin": "stdin",
  "--file": "stdin",
  "--timeout": "number",
} as const;

interface AskFlags {
  raw: boolean;
  noWait: boolean;
  queue: boolean;
  fromStdin: boolean;
  timeoutMs: number;
}

/**
 * The flags of `ask`, and the one number worth explaining: the wait defaults
 * to fifteen seconds *less* than the caller's own deadline. Waiting right up
 * to it means the shim times out first, and the agent gets a transport error
 * where it was owed an answer.
 */
function parseAsk(argv: string[], reqTimeout?: number): { rest: string[]; flags: AskFlags } {
  const args = parseFlags(argv, ASK_SPEC);
  const asked = args.number.timeout;
  return {
    rest: args.positional,
    flags: {
      raw: !!args.bool.raw,
      noWait: !!args.bool["no-wait"],
      queue: !!args.bool.queue,
      fromStdin: args.fromStdin,
      timeoutMs: asked && asked > 0 ? asked * 1_000 : Math.max(30_000, (reqTimeout ?? 600_000) - 15_000),
    },
  };
}

async function cmdAsk(
  ctx: Ctx,
  argv: string[],
  req: BridgeRequest,
): Promise<BridgeResponse> {
  const { rest, flags } = parseAsk(argv, req.timeoutMs);

  // `--batch` is the one place several agents are addressed at once. They run
  // in parallel because they are different processes; the answer keeps each
  // one under its own name, so a failure of the third does not read as a
  // failure of all four.
  if (rest[0] === "--batch") {
    let table: Record<string, unknown>;
    try {
      table = JSON.parse(rest[1] ?? "");
    } catch {
      return err('yard: --batch espera um JSON {"Agente": "prompt", ...}\n');
    }
    const results = await Promise.all(
      Object.entries(table).map(async ([name, prompt]) => {
        const r = await askOne(ctx, name, String(prompt), flags);
        return r.code === 0
          ? { name, output: r.output }
          : { name, error: r.output.trim() };
      }),
    );
    return ok(JSON.stringify(results, null, 2) + "\n");
  }

  const [name, inline] = rest;
  const prompt = flags.fromStdin ? (req.stdin ?? "") : inline;
  if (!name || prompt == null) {
    return err(
      'uso: yard ask "Agente" "prompt" [--raw] [--no-wait] [--timeout s]\n' +
        '     yard ask "Agente" --file prompt.md   (texto longo/multi-linha)\n' +
        '     yard ask "Agente" --stdin            (le da entrada padrão)\n',
    );
  }
  if (flags.fromStdin && !prompt.trim()) {
    return err("yard: --stdin/--file não trouxe texto nenhum.\n");
  }
  return askOne(ctx, name, prompt, flags);
}

/**
 * One question to one agent, and the wait for the answer.
 *
 * "Finished" cannot be asked of a CLI, so it is inferred: bytes appeared and
 * then stopped appearing. The `grew` latch is what keeps a slow agent from
 * being reported as silent: without it, three seconds of thinking before the
 * first byte would count as an answer of nothing.
 */
async function askOne(
  ctx: Ctx,
  name: string,
  prompt: string,
  flags: AskFlags,
): Promise<BridgeResponse> {
  const target = findAgent(ctx, name);
  if (!target) {
    const names = connectedAgents(ctx).map((t) => `"${ctx.nameOf.get(t.id)}"`);
    return err(
      `yard: "${name}" não está conectado a você.` +
        (names.length
          ? ` Conectados: ${names.join(", ")}.`
          : " Você não tem conexões — desenhe uma no canvas ou use `yard connect`.") +
        "\n",
    );
  }

  if (flags.queue) {
    const label = ctx.nameOf.get(target.id) ?? name;
    const queued = useQueue
      .getState()
      .enqueue(target.id, prompt, "bridge", ctx.nameOf.get(ctx.caller.id));
    return queued.ok
      ? ok(queuedLine(label, queued.position ?? 1))
      : err(
          queued.reason === "cheia"
            ? `yard: a fila de "${label}" está cheia (${QUEUE_CAP}). ` +
                "Espere ela andar ou peça ao usuário para limpá-la.\n"
            : "yard: nada para enfileirar (prompt vazio).\n",
        );
  }

  const before = await ipc.ptyProbe(target.id);
  if (!before.alive) {
    return err(`yard: "${name}" não está rodando. Peça ao usuário para retomá-lo.\n`);
  }
  const baseline = before.totalBytes;
  const t0 = Date.now();

  await injectPrompt(target.id, prompt, { raw: flags.raw });
  if (flags.noWait) return ok(`enviado para "${ctx.nameOf.get(target.id)}".\n`);

  let seen = baseline;
  let grew = false;
  let quiet = 0;
  while (Date.now() - t0 < flags.timeoutMs) {
    await sleep(2_000);
    const probe = await ipc.ptyProbe(target.id);
    if (!probe.alive) break;
    if (probe.totalBytes > seen) {
      seen = probe.totalBytes;
      grew = true;
      quiet = 0;
    } else if (grew) {
      quiet++;
    }
    const rt = useTerminals.getState().byId[target.id];
    // `finishedAt >= t0` is what tells a fresh idle from the one left over
    // from the previous turn. The flag is a latch, and reading it without
    // the timestamp would return instantly on stale state.
    if (grew && rt?.finished && rt.finishedAt >= t0) break;
    if (grew && quiet >= 3) break; // ~6 s without a new byte
  }

  const delta = await ipc.ptyReadSince(target.id, baseline, 64 * 1024);
  if (!delta.alive) {
    return err(
      `yard: "${ctx.nameOf.get(target.id)}" encerrou enquanto eu esperava a resposta — ` +
        "o processo não está mais rodando. Peça ao usuário para retomá-lo e tente de novo.\n",
    );
  }
  if (delta.totalBytes > baseline || delta.data.length > 0) grew = true;

  const text = stripAnsi(delta.data).trim();
  if (!grew && !text) {
    return err(
      `yard: sem resposta de "${ctx.nameOf.get(target.id)}" em ` +
        `${Math.round(flags.timeoutMs / 1_000)}s. Use \`yard check "${ctx.nameOf.get(target.id)}"\` ` +
        "para ver o estado.\n",
    );
  }
  return ok(tail(text, 30_000) + "\n");
}

// --- check ------------------------------------------------------------------

/** A photograph of one agent: the last sixty lines and what it is doing. */
async function cmdCheck(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const name = args[0];
  if (!name) return err('uso: yard check "Agente"\n');
  const target = findAgent(ctx, name);
  if (!target) return err(`yard: "${name}" não está conectado a você.\n`);

  const delta = await ipc.ptyReadSince(target.id, 0, 64 * 1024);
  const lines = stripAnsi(delta.data).trim().split("\n").slice(-60).join("\n");
  const rt = useTerminals.getState().byId[target.id];
  const state = !delta.alive
    ? "parado"
    : rt?.blocked
      ? `travado esperando o usuário — ${rt.blockedAsk ?? "pergunta na tela"}`
      : rt?.finished
        ? "terminou de trabalhar"
        : "rodando";
  return ok(`[${ctx.nameOf.get(target.id)} — ${state}]\n${tail(lines, 8_000)}\n`);
}

// --- wait -------------------------------------------------------------------

const WAIT_SPEC = {
  "--until": "string",
  "--timeout": "number",
  "--any": "bool",
  "--all": "bool",
  "--fresh": "bool",
} as const;

/** Safety net under the store subscription, not the way the wait works. */
const WAIT_TICK_MS = 1_000;

/**
 * Waiting on somebody else, which is what turns `check` from a photograph into
 * an orchestration. Without it the only move was to poll `check` in a loop and
 * guess at the sleep between calls.
 */
async function cmdWait(
  ctx: Ctx,
  args: string[],
  reqTimeout?: number,
): Promise<BridgeResponse> {
  const p = parseFlags(args, WAIT_SPEC);
  const until = (p.string.until ?? "stopped") as WaitUntil;
  if (until !== "stopped" && until !== "done" && until !== "blocked") {
    return err(`yard: --until aceita stopped, done ou blocked (recebi "${until}").\n`);
  }

  const everyone = p.bool.any || p.bool.all;
  const targets: TerminalRow[] = [];
  if (everyone) {
    targets.push(...connectedAgents(ctx));
    if (targets.length === 0) {
      return err(
        "yard: você não tem agentes conectados para esperar. " +
          "Desenhe uma conexão no canvas ou use `yard connect`.\n",
      );
    }
  } else {
    const name = p.positional[0];
    if (!name) {
      return err(
        'uso: yard wait "Agente" [--until stopped|done|blocked] [--timeout s] [--fresh]\n' +
          "     yard wait --any    (o primeiro dos conectados a parar)\n" +
          "     yard wait --all    (todos os conectados)\n",
      );
    }
    const target = findAgent(ctx, name);
    if (!target) return err(`yard: "${name}" não está conectado a você.\n`);
    targets.push(target);
  }

  // Same slack as `ask`: finish before the shim's own deadline.
  const timeoutMs =
    p.number.timeout && p.number.timeout > 0
      ? p.number.timeout * 1_000
      : Math.max(30_000, (reqTimeout ?? 600_000) - 15_000);

  // `--fresh` demands *new* output before counting a target as arrived. The
  // flag exists because `finished` is true of an agent that has been idle
  // since yesterday, and a wait that returns instantly on that is not a wait.
  const marks = new Map<string, number>();
  if (p.bool.fresh) {
    for (const t of targets) {
      try {
        marks.set(t.id, (await ipc.ptyProbe(t.id)).totalBytes);
      } catch {
        marks.set(t.id, 0);
      }
    }
  }

  const reached = await waitForReach(
    targets.map((t) => t.id),
    until,
    !!p.bool.all,
    p.bool.fresh ? marks : null,
    timeoutMs,
  );

  const rt = useTerminals.getState().byId;
  const arrived = targets
    .filter((t) => reached.has(t.id))
    .map((t) => `- "${ctx.nameOf.get(t.id)}": ${waitReason(rt[t.id])}`);

  if (arrived.length === 0) {
    const names = targets.map((t) => `"${ctx.nameOf.get(t.id)}"`).join(", ");
    return err(
      `yard: ${names} não chegou em "${until}" em ${Math.round(timeoutMs / 1_000)}s. ` +
        "Use `yard check` para ver o estado atual.\n",
    );
  }

  const pending = targets.filter((t) => !reached.has(t.id));
  let out = `${arrived.length} de ${targets.length} em "${until}":\n${arrived.join("\n")}\n`;
  if (pending.length > 0) {
    out += `Ainda trabalhando: ${pending
      .map((t) => `"${ctx.nameOf.get(t.id)}"`)
      .join(", ")}\n`;
  }
  // `--all` is a promise about the whole set, so a partial answer is a
  // failure. The body is printed either way: failing the exit code must not
  // cost the caller the information.
  return pending.length > 0 && p.bool.all ? err(out) : ok(out);
}

function waitReason(rt: TerminalRuntime | undefined): string {
  if (!rt) return "estado desconhecido";
  if (rt.state === "exited" || rt.state === "error") return "o processo parou";
  if (rt.blocked) return `travado — ${rt.blockedAsk ?? "pergunta na tela"}`;
  return "terminou de trabalhar";
}

/**
 * The wait itself. It rides the store's own subscription, so the answer
 * arrives when the state actually changes; the one-second tick underneath is
 * a safety net for a transition that somehow does not publish.
 */
async function waitForReach(
  ids: readonly string[],
  until: WaitUntil,
  all: boolean,
  marks: Map<string, number> | null,
  timeoutMs: number,
): Promise<Set<string>> {
  const reached = new Set<string>();
  const deadline = Date.now() + timeoutMs;

  const arrived = async (id: string): Promise<boolean> => {
    if (!reachedWait(useTerminals.getState().byId[id], until)) return false;
    if (!marks) return true;
    try {
      return (await ipc.ptyProbe(id)).totalBytes > (marks.get(id) ?? 0);
    } catch {
      return true;
    }
  };

  for (;;) {
    for (const id of ids) {
      if (!reached.has(id) && (await arrived(id))) reached.add(id);
    }
    if ((all ? reached.size === ids.length : reached.size > 0) || Date.now() >= deadline) break;
    await nextChange(deadline);
  }
  return reached;
}

/** Resolves on the next store change, or on the tick, whichever comes first. */
function nextChange(deadline: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = useTerminals.subscribe(finish);
    const timer = setTimeout(finish, Math.max(0, Math.min(WAIT_TICK_MS, deadline - Date.now())));
  });
}

// --- notes ------------------------------------------------------------------

/**
 * The shared notebook of a group. An agent writes what the next one needs;
 * the user reads it on the canvas without opening a terminal.
 *
 * A note the user locked is the one thing here that refuses: it is the
 * user's own text, and an agent that "fixed" it would be editing the brief it
 * was given.
 */
function cmdNote(ctx: Ctx, args: string[], req: BridgeRequest): BridgeResponse {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);

  switch (sub) {
    case "create": {
      const p = parseFlags(rest, {
        "--name": "string",
        "--stdin": "stdin",
        "--file": "stdin",
      });
      const name = p.string.name;
      const text = p.fromStdin ? (req.stdin ?? "") : (p.positional[0] ?? "");
      const id = nanoid(8);
      const rect = callerRect(ctx);
      const note = {
        id,
        type: "note" as const,
        x: rect.x - 280,
        y: rect.y + connectedNotes(ctx).length * 40,
        w: 240,
        h: 180,
        text,
        color: "#f5f5f5",
        ...(name ? { name } : {}),
      };
      commitCanvas(ctx.groupId, (c) => addItems(c, note, connection(ctx.caller.id, id)));
      return ok(`Nota criada e conectada: "${name ?? noteName(note)}"\n`);
    }

    case "read": {
      const note: NoteItem | null = rest[0] ? findNote(ctx, rest[0]) : null;
      if (!note) return err(noteMiss(ctx, rest[0]));
      const name = ctx.noteNameOf.get(note.id);
      const lines = note.text.split("\n");
      if (!note.text) return ok(`(a nota "${name}" está vazia)\n`);

      const start = Math.max(1, Number(rest[1]) || 1);
      const count = Math.max(1, Number(rest[2]) || lines.length);
      // Said, not silently empty: an agent that asked for lines which do not
      // exist concluded the note was empty and carried on.
      if (start > lines.length) {
        return err(
          `yard: a nota "${name}" tem ${lines.length} linha(s); você pediu a partir da ${start}.\n`,
        );
      }
      const slice = lines.slice(start - 1, start - 1 + count);
      const width = String(start + slice.length - 1).length;
      const body = slice
        .map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
        .join("\n");
      return ok(`${body}\n`);
    }

    case "write":
    case "edit": {
      const note: NoteItem | null = rest[0] ? findNote(ctx, rest[0]) : null;
      if (!note) return err(noteMiss(ctx, rest[0]));
      const name = ctx.noteNameOf.get(note.id);
      if (note.locked) return err(lockedMsg(name));

      let nextText: string;
      if (sub === "write") {
        const p = parseFlags(rest.slice(1), { "--stdin": "stdin", "--file": "stdin" });
        const body = p.fromStdin ? req.stdin : p.positional[0];
        if (body == null) {
          return err(
            'uso: yard note write "Nome" "conteúdo"\n' +
              '     yard note write "Nome" --file texto.md   (multi-linha)\n',
          );
        }
        nextText = body;
      } else {
        const [, oldText, newText] = rest;
        if (oldText == null || newText == null) {
          return err('uso: yard note edit "Nome" "texto antigo" "texto novo"\n');
        }
        if (!note.text.includes(oldText)) {
          return err(`yard: o texto antigo não aparece na nota "${name}".\n`);
        }
        nextText = note.text.replace(oldText, newText);
      }

      commitCanvas(ctx.groupId, (c) => patchItemOfType(c, note.id, "note", { text: nextText }));
      // A note with no `--name` is named after its first line, so writing to
      // it can rename it. Saying so keeps the next `yard note read` from
      // missing a note nobody moved.
      const renamed = !note.name && noteName({ ...note, text: nextText }) !== name;
      return ok(
        `Nota "${name}" atualizada.` +
          (renamed ? ` Novo nome: "${noteName({ ...note, text: nextText })}".` : "") +
          "\n",
      );
    }

    case "delete": {
      const note: NoteItem | null = rest[0] ? findNote(ctx, rest[0]) : null;
      if (!note) return err(noteMiss(ctx, rest[0]));
      if (note.locked) return err(lockedMsg(ctx.noteNameOf.get(note.id)));
      commitCanvas(ctx.groupId, (c) => removeItemAndEdges(c, note.id));
      return ok(`Nota "${ctx.noteNameOf.get(note.id)}" removida.\n`);
    }

    default:
      return err("uso: yard note create|read|write|edit|delete … (veja `yard help`)\n");
  }
}

function lockedMsg(name?: string): string {
  return (
    `yard: a nota "${name}" está travada pelo usuário — só ele edita. ` +
    "Peça a mudança em vez de contorná-la (ou escreva numa nota sua).\n"
  );
}

function noteMiss(ctx: Ctx, name?: string): string {
  const names = connectedNotes(ctx).map((n) => `"${ctx.noteNameOf.get(n.id)}"`);
  return (
    `yard: nota "${name ?? ""}" não encontrada entre as conectadas.` +
    (names.length ? ` Disponíveis: ${names.join(", ")}.` : " Nenhuma nota conectada.") +
    "\n"
  );
}

// --- connect / recruit / dismiss --------------------------------------------

/**
 * Drawing a wire from the CLI.
 *
 * The access rule holds here too, or it is not a rule: one of the two ends
 * has to be the caller or something already reachable from it. Otherwise an
 * agent could wire together two strangers and then talk to both.
 */
function cmdConnect(ctx: Ctx, args: string[]): BridgeResponse {
  const [a, b] = args;
  if (!a || !b) return err('uso: yard connect "A" "B"\n');

  const resolve = (name: string): { kind: string; id: string } | null => {
    const found = findAny(ctx, name);
    if (found) return found;
    const flow = findFlow(ctx.canvas, name);
    return flow ? { kind: "flow", id: flow.id } : null;
  };
  const left = resolve(a);
  if (!left) return err(`yard: não achei "${a}" neste grupo.\n`);
  const right = resolve(b);
  if (!right) return err(`yard: não achei "${b}" neste grupo.\n`);
  if (left.id === right.id) return err("yard: os dois lados são a mesma coisa.\n");

  if (!reaches(ctx, left.id) && !reaches(ctx, right.id)) {
    return err(
      `yard: nem "${a}" nem "${b}" estão ao seu alcance — uma das pontas precisa ser você ` +
        "ou algo já conectado a você. Peça ao usuário para desenhar essa conexão no canvas.\n",
    );
  }
  if (isConnected(ctx.canvas, left.id, right.id)) return ok("já estavam conectados.\n");

  commitCanvas(ctx.groupId, (c) => addItems(c, connection(left.id, right.id)));
  return ok(`Conectado: "${a}" ↔ "${b}".\n`);
}

/** What a recruit is made of, once the working directory is known. */
interface RecruitPlan {
  name: string;
  program: string;
  cliArgs: string[];
  kind: TerminalRow["kind"];
  rowAgentId: string | null;
  dir?: string;
  cardRole?: CardRole;
  launch: RoleLaunch;
}

async function cmdRecruit(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const p = parseFlags(args, {
    "--agent": "string",
    "--preset": "string",
    "--role": "string",
    "--dir": "string",
    "--replace": "string",
    "--floor": "string",
    "--timeout": "number",
  });
  const agent = p.string.agent ?? p.string.preset;
  const role = p.string.role;
  const dir = p.string.dir;
  const replace = p.string.replace;
  const floor = p.string.floor;
  const name = p.positional[0];

  if (!name) {
    return err(
      'uso: yard recruit "Nome" [--agent claude|codex|…] [--role "…"] [--dir PATH]\n' +
        '     yard recruit "Nome" --floor "Frente"       (nasce numa aba da frente)\n' +
        '     yard recruit "Nome" --replace "Antigo" [--agent …]   (troca o processo do cartão)\n',
    );
  }
  if (replace && floor) {
    return err(
      "yard: --replace e --floor não combinam — o cartão substituído já mora num grupo.\n",
    );
  }

  // Without `--agent`, the recruit is a copy of the caller: same binary, same
  // kind. That is what makes `yard recruit "Segundo"` a one-word command.
  let program = ctx.caller.program;
  const cliArgs: string[] = [];
  let kind = ctx.caller.kind;
  let rowAgentId = ctx.caller.agentId ?? null;

  if (agent) {
    const detected = await ipc.detectAgents(false);
    const found = detected.find(
      (a) =>
        a.id.toLowerCase() === agent.toLowerCase() ||
        a.name.toLowerCase() === agent.toLowerCase(),
    );
    if (!found || !found.installed || !found.bin) {
      const available = detected.filter((a) => a.installed).map((a) => a.id);
      return err(
        `yard: agente "${agent}" não está instalado. Disponíveis: ${available.join(", ")}.\n`,
      );
    }
    program = found.bin;
    kind = "agent";
    rowAgentId = found.id;
  }

  // A role asked for on the command line wins; otherwise the recruit is born
  // into whatever role that CLI is configured with in Configurações › Agentes.
  const cardRole = role
    ? await resolveRole(ctx.canvas, role)
    : (defaultRoleOf(useAgentDefaults.getState().defaults, rowAgentId)?.role ?? undefined);
  const launch = roleLaunch(rowAgentId, cardRole);
  cliArgs.push(...launch.args);

  const plan: RecruitPlan = {
    name,
    program,
    cliArgs,
    kind,
    rowAgentId,
    ...(dir ? { dir } : {}),
    ...(cardRole ? { cardRole } : {}),
    launch,
  };
  if (replace) return replaceCard(ctx, replace, plan);
  if (floor) return recruitOnFloor(ctx, floor, plan);

  const cwd = dir ?? ctx.caller.cwd;
  const s = useProjects.getState();
  const born = bornAs(rowAgentId, program, cliArgs, cwd);
  const id = s.addTerminal({
    groupId: ctx.groupId,
    title: name,
    kind,
    agentId: rowAgentId,
    program: born.program,
    args: born.args,
    cwd,
  });

  const rect = callerRect(ctx);
  const nth = connectedAgents(ctx).length;
  commitCanvas(ctx.groupId, (c) => ({
    ...addItems(c, connection(ctx.caller.id, id)),
    nodes: {
      ...c.nodes,
      [id]: { x: rect.x + rect.w + 110, y: rect.y + nth * 90, w: NODE_DEFAULT_W, h: NODE_DEFAULT_H },
    },
    roles: cardRole ? { ...(c.roles ?? {}), [id]: cardRole } : c.roles,
  }));

  try {
    await spawnCard(id, { program, args: cliArgs, cwd, kind, title: name });
  } catch (e) {
    return err(`yard: terminal "${name}" criado no canvas, mas o processo não subiu: ${e}\n`);
  }
  if (launch.briefing) void deliverBriefing(id, launch.briefing);
  return ok(
    `Recrutado "${name}"${cardRole ? ` (papel: ${cardRole.name})` : ""} — conectado a você. ` +
      "Dê alguns segundos para o agente subir antes do primeiro `yard ask`.\n",
  );
}

/**
 * `kill` only signals: the id stays in the Rust registry until the reader
 * thread sees EOF and cleans up. Spawning before that dies with "id already
 * in use", so the replacement waits for the id to actually go.
 */
async function waitPtyGone(id: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await ipc.ptyExists(id).catch(() => false))) return true;
    await sleep(80);
  }
  return false;
}

/**
 * Swapping the process behind a card, keeping the card: position, wires and
 * role stay, so the canvas does not change at all.
 */
async function replaceCard(
  ctx: Ctx,
  who: string,
  plan: RecruitPlan,
): Promise<BridgeResponse> {
  const target =
    findAgent(ctx, who) ??
    ctx.terminals.find(
      (t) => ctx.nameOf.get(t.id)?.toLowerCase() === who.trim().toLowerCase(),
    ) ??
    null;
  if (!target) {
    return err(
      `yard: não achei "${who}" neste grupo para substituir. ` +
        "Rode `yard list` para ver os nomes.\n",
    );
  }

  const cwd = plan.dir ?? target.cwd;
  const s = useProjects.getState();
  await disposePty(target.id);
  if (!(await waitPtyGone(target.id))) {
    // Honest about what already happened: the old process and its scrollback
    // are gone either way, and pretending otherwise sends the caller looking
    // for a history that no longer exists.
    return err(
      `yard: matei o processo de "${who}" mas o id não saiu do registro a tempo, então não ` +
        `consegui subir "${plan.name}" no lugar. O cartão continua no canvas (posição, ` +
        `conexões e papel), parado e ainda apontando para "${who}" — o processo dele e o ` +
        "histórico já foram embora. Espere alguns segundos e rode o mesmo " +
        "`recruit --replace` de novo.\n",
    );
  }

  const born = bornAs(plan.rowAgentId, plan.program, plan.cliArgs, cwd);
  s.updateTerminal(target.id, {
    title: plan.name,
    kind: plan.kind,
    agentId: plan.rowAgentId,
    program: born.program,
    args: born.args,
    cwd,
    resume: null,
    alive: false,
  });

  try {
    const snap = await spawnCard(target.id, {
      program: born.program,
      args: born.args,
      cwd,
      kind: plan.kind,
      title: plan.name,
    });
    useTerminals.getState().markRunning(target.id, snap.pid);
  } catch (e) {
    return err(
      `yard: o cartão de "${who}" já aponta para "${plan.name}", mas o processo não subiu: ${e}. ` +
        "Peça ao usuário para apertar ▶ no cartão.\n",
    );
  }

  if (plan.cardRole) {
    const role = plan.cardRole;
    commitCanvas(ctx.groupId, (c) => ({ ...c, roles: { ...(c.roles ?? {}), [target.id]: role } }));
  }
  if (plan.launch.briefing) void deliverBriefing(target.id, plan.launch.briefing);
  return ok(
    `Cartão de "${who}" agora roda "${plan.name}" — posição, conexões e papel preservados.\n`,
  );
}

/**
 * Sending an agent away. `closeTerminal` already takes the card, the role,
 * the routines and the wires with it.
 */
async function cmdDismiss(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const name = args[0];
  if (!name) return err('uso: yard dismiss "Nome"\n');
  const target = findAgent(ctx, name);
  if (!target) {
    return err(
      `yard: "${name}" não está conectado a você (só é possível dispensar conexões diretas).\n`,
    );
  }
  const label = ctx.nameOf.get(target.id);
  await closeTerminal(target.id);
  return ok(`"${label}" dispensado.\n`);
}

// --- floor ------------------------------------------------------------------

/** Group in the caller's project whose name matches, however it is written. */
function findGroupByName(projectId: string, name: string) {
  return findGroupNamed(useProjects.getState().groupsOf(projectId), name);
}

/**
 * A recruit born on another front's canvas. Connections never cross fronts
 * (they are different working copies), so no wire is drawn, and the answer
 * says so rather than leaving the caller to discover it with `yard ask`.
 */
async function recruitOnFloor(
  ctx: Ctx,
  floorName: string,
  plan: RecruitPlan,
): Promise<BridgeResponse> {
  const s = useProjects.getState();
  const project = s.projectOfGroup(ctx.groupId);
  if (!project) return err("yard: o grupo deste terminal não pertence a um projeto.\n");

  const group = findGroupByName(project.id, floorName);
  if (!group) {
    return err(`yard: não achei a frente "${floorName}" neste projeto. Rode \`yard floor list\`.\n`);
  }

  // The front's own root, not the caller's: that is the whole point of
  // opening a CLI there.
  const cwd = plan.dir ?? s.rootOfGroup(group.id) ?? ctx.caller.cwd;
  // A front is a project's group, and a project's group has no canvas (the
  // canvas is the boards, `lib/surface.ts`): the recruit is a tab of that
  // front, and no rectangle is written for it anywhere. The role still goes
  // into the group's canvas JSON, which is where every tab's role lives.
  const born = bornAs(plan.rowAgentId, plan.program, plan.cliArgs, cwd);
  const id = s.addTerminal({
    groupId: group.id,
    title: plan.name,
    kind: plan.kind,
    agentId: plan.rowAgentId,
    program: born.program,
    args: born.args,
    cwd,
  });

  const role = plan.cardRole;
  if (role) {
    commitCanvas(group.id, (c) => ({ ...c, roles: { ...(c.roles ?? {}), [id]: role } }));
  }

  try {
    await spawnCard(id, {
      program: plan.program,
      args: plan.cliArgs,
      cwd,
      kind: plan.kind,
      title: plan.name,
    });
  } catch (e) {
    return err(
      `yard: "${plan.name}" foi criado na frente "${group.name}", mas o processo não subiu: ${e}\n`,
    );
  }
  if (plan.launch.briefing) void deliverBriefing(id, plan.launch.briefing);
  return ok(
    `Recrutado "${plan.name}" numa aba da frente "${group.name}" (cwd: ${cwd}). ` +
      "Conexões não cruzam frentes.\n",
  );
}

async function cmdFloor(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase() ?? "list";
  const s = useProjects.getState();
  const project = s.projectOfGroup(ctx.groupId);
  if (!project) return err("yard: o grupo deste terminal não pertence a um projeto.\n");

  if (sub === "list") {
    const groups = s.groupsOf(project.id);
    let out = `Frentes de "${project.name}":\n`;
    groups.forEach((g, i) => {
      const floor = s.layoutOf(g.id).floor;
      const aliveCount = s.terminalsOf(g.id).filter((t) => t.alive).length;
      const tag =
        floor?.kind === "isolated"
          ? ` [branch ${floor.branch ?? "?"}${floor.adopted ? ", worktree adotado" : ""}]`
          : floor?.kind === "plain"
            ? " [sem git]"
            : i === 0
              ? " [chão]"
              : "";
      const here = g.id === ctx.groupId ? "  ← você" : "";
      out += `  - "${g.name}"${tag} — ${aliveCount} vivo(s)${here}\n`;
    });
    return ok(out);
  }

  if (sub === "create") {
    const p = parseFlags(args.slice(1), {
      "--branch": "string",
      "--existing-branch": "bool",
      "--adopt": "string",
      "--no-git": "bool",
      "--copy-ground": "bool",
      "--base": "string",
      "--worktree-name": "string",
      "--dry-run": "bool",
      "--json": "bool",
    });
    const branch = p.string.branch;
    const existing = !!p.bool["existing-branch"];
    const adoptPath = p.string.adopt;
    const noGit = !!p.bool["no-git"];
    const copyGround = !!p.bool["copy-ground"];
    const name = p.positional[0];
    const asJson = !!p.bool.json;

    if (!name) {
      return {
        code: 2,
        output:
          'uso: yard floor create "Nome" [--branch x] [--existing-branch] [--adopt PATH] ' +
          "[--no-git] [--copy-ground] [--base REF] [--worktree-name PASTA] [--dry-run] [--json]\n",
      };
    }
    if (existing && !branch) {
      return { code: 2, output: "yard: --existing-branch exige --branch com o nome da branch.\n" };
    }

    // `--adopt` takes a worktree git already knows about: nothing is created
    // on the disk, so the path has to be one of this repository's own.
    let adopt: { path: string; branch: string | null } | undefined;
    if (adoptPath) {
      const entries = await ipc.worktreeList(project.path).catch(() => []);
      const found = entries.find((w) => !w.bare && sameRoot(w.path, adoptPath));
      if (!found) {
        return err(
          `yard: "${adoptPath}" não é um worktree deste repositório. Veja o que "git worktree list" lista.\n`,
        );
      }
      adopt = { path: found.path, branch: found.branch };
    }

    // The same road the dialog takes: preflight, plan, journal. `--dry-run`
    // stops after the plan, and the plan writes nothing, which is what lets a
    // person read what will happen before it happens.
    try {
      const run = await provisionFronts({
        projectId: project.id,
        activate: false,
        copyGround,
        dryRun: !!p.bool["dry-run"],
        fronts: [
          {
            id: "front",
            kind: adopt
              ? "existing_worktree"
              : existing
                ? "new_worktree_existing_branch"
                : "new_worktree_new_branch",
            name,
            ...(branch ? { branch } : {}),
            ...(adopt ? { worktreePath: adopt.path } : {}),
            ...(noGit ? { noGit: true } : {}),
            ...(p.string.base ? { baseRef: p.string.base } : {}),
            ...(p.string["worktree-name"] ? { worktreeName: p.string["worktree-name"] } : {}),
          },
        ],
      });

      const code = exitCodeOf(run);
      if (asJson) return { code, output: JSON.stringify(runJson(run), null, 2) + "\n" };
      // A refusal prints the plan as well: the reason belongs under the row
      // that caused it, which is worth more than one line of stderr.
      if (p.bool["dry-run"] || !run.plan.valid) {
        return { code, output: planText(run.plan, { project: project.name }) };
      }
      const tail =
        run.plan.items[0]?.action === "adopt_worktree"
          ? "Encerrar a frente NÃO apaga esse worktree.\n"
          : run.plan.items[0]?.action === "create_folder"
            ? "Sem git: os terminais dela usam o mesmo diretório do chão.\n"
            : copyGround
              ? "Layout do chão clonado (terminais parados).\n"
              : "";
      return { code, output: runSummary(run) + tail };
    } catch (e) {
      return err(`yard: não consegui abrir a frente: ${e}\n`);
    }
  }

  if (sub === "land") {
    const p = parseFlags(args.slice(1), {
      "--close": "bool",
      "--keep-losers": "bool",
    });
    const name = p.positional[0];
    if (!name) {
      return err(
        'uso: yard floor land "Nome" [--close] [--keep-losers]\n',
      );
    }
    const target = findGroupByName(project.id, name);
    if (!target) return err(`yard: não achei a frente "${name}".\n`);
    try {
      const result = await landFloor(project, target);
      if (!result.ok) {
        return err(
          `yard: ${result.message}` +
            (result.conflictPaths.length
              ? `\n  conflitos: ${result.conflictPaths.join(", ")}`
              : "") +
            "\n",
        );
      }
      if (p.bool.close) {
        const warnings = await settleAfterLand({
          project,
          winner: target,
          closeWinner: true,
          closeSiblings: !p.bool["keep-losers"],
        });
        return ok(
          `${result.message}` +
            (warnings.length ? ` (${warnings.join("; ")})` : "") +
            "\n",
        );
      }
      return ok(`${result.message}\n`);
    } catch (e) {
      return err(`yard: não consegui aterrissar: ${e}\n`);
    }
  }

  if (sub === "compare") {
    const floors = s
      .groupsOf(project.id)
      .filter((g) => isIsolatedFloor(s.layoutOf(g.id).floor));
    if (floors.length === 0) {
      return ok(`Nenhuma frente isolada em "${project.name}".\n`);
    }
    let out = `Frentes de "${project.name}" vs o chão:\n`;
    for (const g of floors) {
      try {
        const p = await previewFloor(project, g);
        const tag = p.alreadyMerged
          ? "já no chão"
          : !p.clean
            ? `${p.conflictPaths.length} conflito(s)`
            : `+${p.additions} −${p.deletions}, ${p.files.length} arquivo(s)`;
        out += `  - "${g.name}" [${p.floorBranch}] — ${tag}\n`;
      } catch (e) {
        out += `  - "${g.name}" — erro: ${e}\n`;
      }
    }
    return ok(out);
  }

  if (sub === "fanout") {
    const p = parseFlags(args.slice(1), {
      "--prompt": "string",
      "--agents": "string",
      "--copy-ground": "bool",
    });
    const name = p.positional[0];
    const prompt = p.string.prompt;
    if (!name || !prompt) {
      return err(
        'uso: yard floor fanout "Nome" --prompt "pedido" [--agents claude,codex] [--copy-ground]\n',
      );
    }
    try {
      const detected = await ipc.detectAgents(false);
      const wanted = (p.string.agents ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      const pool = detected.filter((a) => a.installed && a.bin);
      const chosen = wanted.length
        ? pool.filter(
            (a) =>
              wanted.includes(a.id.toLowerCase()) ||
              wanted.includes(a.name.toLowerCase()),
          )
        : pool;
      if (chosen.length === 0) {
        return err(
          wanted.length
            ? `yard: nenhum dos agentes (${wanted.join(", ")}) está instalado.\n`
            : "yard: nenhuma CLI de agente instalada nesta máquina.\n",
        );
      }
      const result = await fanOutTask({
        projectId: project.id,
        name,
        prompt,
        agents: chosen.map(agentAsFanout).filter((a): a is NonNullable<typeof a> => !!a),
        copyGround: !!p.bool["copy-ground"],
      });
      return ok(
        `Tarefa "${name}": ${result.floors.map((f) => `"${f.name}"`).join(", ")}.\n`,
      );
    } catch (e) {
      return err(`yard: não consegui disparar a tarefa: ${e}\n`);
    }
  }

  return err(
    "uso: yard floor list\n" +
      '     yard floor create "Nome" [--branch x] [--existing-branch] [--adopt PATH]\n' +
      "                       [--no-git] [--copy-ground] [--base REF] [--worktree-name PASTA]\n" +
      "                       [--dry-run] [--json]\n" +
      '     yard floor land "Nome" [--close] [--keep-losers]\n' +
      "     yard floor compare\n" +
      '     yard floor fanout "Nome" --prompt "pedido" [--agents claude,codex]\n',
  );
}

// --- role and role presets ------------------------------------------------

/** The library as this caller sees it: its group's roles, then the global ones. */
async function libraryOf(ctx: Ctx): Promise<SavedRole[]> {
  return mergeRoles(groupRoles(ctx.canvas), await readGlobalRoles());
}

/** One line of `role show` / `list`: name, and the text folded to one line. */
function roleLine(role: CardRole): string {
  if (!role.text) return role.name;
  return `${role.name} — ${role.text.replace(/\s+/g, " ").slice(0, 120)}`;
}

async function cmdRole(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase();
  const roles = ctx.canvas.roles ?? {};

  if (sub === "show" || sub == null) {
    const name = args[1];
    if (!name) {
      const label = ctx.nameOf.get(ctx.caller.id)!;
      const mine = roles[ctx.caller.id];
      return ok(mine ? `${label}: ${roleLine(mine)}\n` : `${label}: (sem papel)\n`);
    }
    const target = findAgent(ctx, name);
    if (target) {
      const label = ctx.nameOf.get(target.id)!;
      const role = roles[target.id];
      return ok(role ? `${label}: ${roleLine(role)}\n` : `${label}: (sem papel)\n`);
    }
    // Not a connected agent: maybe it is the name of a saved role.
    const saved = findSaved(await libraryOf(ctx), name);
    if (saved) return ok(`papel "${saved.name}" [${saved.scope}]:\n${saved.text}\n`);
    return err(`yard: "${name}" não está conectado a você e não é um papel salvo.\n`);
  }

  if (sub === "set") {
    const [, name, text] = args;
    if (!name || text == null) {
      return err('uso: yard role set "Agente" "texto ou nome de papel salvo"\n');
    }
    const isSelf = ctx.nameOf.get(ctx.caller.id)!.toLowerCase() === name.trim().toLowerCase();
    const id = isSelf ? ctx.caller.id : (findAgent(ctx, name)?.id ?? null);
    if (!id) return err(`yard: "${name}" não está conectado a você.\n`);
    const role = await resolveRole(ctx.canvas, text);
    if (!role) return err("yard: papel vazio.\n");
    commitCanvas(ctx.groupId, (c) => ({
      ...c,
      roles: { ...(c.roles ?? {}), [id]: role },
    }));
    // Exactly what the dialog does: swap the flag for the next start, and type
    // the instructions into the session that is running now.
    const target = useProjects.getState().terminal(id);
    if (target) applyRoleToProcess(target, roles[id], role);
    return ok(
      `Papel de "${ctx.nameOf.get(id)}" definido: ${role.name}.` +
        (role.text ? " As instruções foram enviadas ao terminal.\n" : "\n"),
    );
  }

  if (sub === "list") {
    const lib = await libraryOf(ctx);
    let out = "Papéis salvos:\n";
    if (!lib.length) out += '  (nenhum — crie com `yard role create "Nome" "texto"`)\n';
    for (const r of lib) {
      out += `  - "${r.name}" [${r.scope}] ${r.text.split("\n")[0].slice(0, 60)}\n`;
    }
    return ok(out);
  }

  if (sub === "create" || sub === "write" || sub === "edit") {
    const p = parseFlags(args.slice(1), { "--scope": "string" });
    const requested = p.string.scope?.toLowerCase();
    const scope: RoleScope = requested === "current" ? "current" : "global";
    const [name, text] = p.positional;
    if (!name || text == null) {
      return err(
        `uso: yard role ${sub} "Nome do papel" "texto" [--scope global|current]\n`,
      );
    }
    if (sub === "edit" && !findSaved(await libraryOf(ctx), name)) {
      return err(`yard: papel "${name}" não existe — use \`role create\`.\n`);
    }
    if (scope === "current") {
      commitCanvas(ctx.groupId, (c) => ({
        ...c,
        rolePresets: { ...(c.rolePresets ?? {}), [name]: { text } },
      }));
    } else {
      await writeGlobalRole(name, { text });
    }
    return ok(`Papel "${name}" salvo (escopo ${scope}).\n`);
  }

  if (sub === "delete") {
    const name = args[1];
    if (!name) return err('uso: yard role delete "Nome do papel"\n');
    let found = false;
    if (ctx.canvas.rolePresets?.[name] != null) {
      found = true;
      commitCanvas(ctx.groupId, (c) => ({
        ...c,
        rolePresets: setEntry(c.rolePresets, name, undefined),
      }));
    }
    if (await deleteGlobalRole(name)) found = true;
    return found
      ? ok(`Papel "${name}" removido.\n`)
      : err(`yard: papel "${name}" não existe.\n`);
  }

  return err(
    'uso: yard role show ["Agente"] | role set "Agente" "texto|papel salvo"\n' +
      '     yard role create|edit|write "Papel" "texto" [--scope global|current]\n' +
      "     yard role list | role delete \"Papel\"\n",
  );
}

// --- routine ----------------------------------------------------------------

function cmdRoutine(ctx: Ctx, args: string[], req: BridgeRequest): BridgeResponse {
  const sub = args[0]?.toLowerCase() ?? "list";
  const routines = ctx.canvas.routines ?? [];
  const targetName = (id: string) => ctx.nameOf.get(id) ?? "(removido)";

  if (sub === "list") {
    if (!routines.length) {
      return ok(
        'Nenhuma rotina neste grupo. Crie com:\n  yard routine create "Agente" "prompt" --every 30\n',
      );
    }
    let out = "Rotinas do grupo:\n";
    for (const r of routines) {
      const when = r.once ? `uma vez em ${r.everyMin} min` : `a cada ${r.everyMin} min`;
      const last = r.lastRunAt
        ? ` último: ${new Date(r.lastRunAt).toLocaleTimeString()}`
        : "";
      out +=
        `  [${r.id}] "${targetName(r.terminalId)}" ${when}` +
        `${r.enabled ? "" : " (pausada)"}${last}\n      ${r.text.split("\n")[0].slice(0, 70)}\n`;
    }
    return ok(out);
  }

  if (sub === "create") {
    const p = parseFlags(args.slice(1), {
      "--every": "number",
      "--once": "bool",
      "--stdin": "stdin",
      "--file": "stdin",
    });
    // Clamped, not trusted: `--every 999999` produced a routine that lists as
    // active and never fires.
    const everyMin = clampRoutineInterval(
      p.number.every && p.number.every > 0 ? p.number.every : 30,
    );
    const once = !!p.bool.once;
    const [nameOfTarget, textPos] = p.positional;
    const text = p.fromStdin ? (req.stdin ?? "") : textPos;
    if (!nameOfTarget || !text) {
      return err(
        'uso: yard routine create "Agente" "prompt" [--every 30] [--once]\n' +
          "     (o alvo pode ser você mesmo; --file/--stdin para prompt longo)\n",
      );
    }
    const isSelf =
      ctx.nameOf.get(ctx.caller.id)!.toLowerCase() === nameOfTarget.trim().toLowerCase();
    const target = isSelf ? ctx.caller : findAgent(ctx, nameOfTarget);
    if (!target) return err(`yard: "${nameOfTarget}" não está conectado a você.\n`);
    const newOne: RoutineDef = {
      id: nanoid(6),
      terminalId: target.id,
      text,
      everyMin,
      enabled: true,
      once,
      createdAt: Date.now(),
    };
    commitCanvas(ctx.groupId, (c) => ({ ...c, routines: [...(c.routines ?? []), newOne] }));
    return ok(
      `Rotina [${newOne.id}] criada para "${ctx.nameOf.get(target.id)}" ` +
        `${once ? `daqui a ${everyMin} min (uma vez)` : `a cada ${everyMin} min`}. ` +
        "Só dispara com o terminal rodando e ocioso.\n",
    );
  }

  if (sub === "delete" || sub === "pause" || sub === "resume") {
    const id = args[1];
    const target = routines.find((r) => r.id === id);
    if (!target) return err(`yard: rotina "${id ?? ""}" não existe (\`routine list\`).\n`);
    if (sub === "delete") {
      commitCanvas(ctx.groupId, (c) => ({
        ...c,
        routines: (c.routines ?? []).filter((r) => r.id !== id),
      }));
      return ok(`Rotina [${id}] removida.\n`);
    }
    const enabled = sub === "resume";
    commitCanvas(ctx.groupId, (c) => ({
      ...c,
      routines: (c.routines ?? []).map((r) => (r.id === id ? { ...r, enabled } : r)),
    }));
    return ok(`Rotina [${id}] ${enabled ? "retomada" : "pausada"}.\n`);
  }

  return err("uso: yard routine list|create|delete|pause|resume …\n");
}

// --- flow (modo Fluxo) ------------------------------------------------------

/** One line per stage: state + name, the format that fits in a terminal. */
function describeFlowRun(ctx: Ctx, run: FlowRun): string {
  const glyph: Record<string, string> = {
    pending: "·",
    waiting: "…",
    working: "▶",
    blocked: "?",
    done: "✓",
    error: "✗",
  };
  const stages = run.stages
    .map((s, i) => `    ${glyph[s.status] ?? "·"} ${i + 1}. "${s.label}" (${s.status})`)
    .join("\n");
  const state = run.error
    ? `falhou: ${run.error}`
    : run.cancelled
      ? "cancelado"
      : run.finishedAt
        ? "concluído"
        : `em execução (etapa ${Math.min(run.current + 1, run.stages.length)}/${run.stages.length})`;
  const location = ctx.nameOf.get(run.terminalId) ?? "(removido)";
  return `  "${run.name}" em "${location}" — ${state}\n${stages}`;
}

// --- trigger ----------------------------------------------------------------

/**
 * `yard trigger` — the event-driven twin of `routine`. The same gate as
 * `ask`: the source and the target must be you or someone wired to you, and a
 * flow must be reachable by cable — an agent cannot arm an automation on a
 * terminal it could not talk to directly.
 */
function cmdTrigger(ctx: Ctx, args: string[], req: BridgeRequest): BridgeResponse {
  const sub = args[0]?.toLowerCase() ?? "list";
  const triggers = ctx.canvas.triggers ?? [];
  const nameOf = (id: string) => ctx.nameOf.get(id) ?? "(removida)";
  const flowNameOf = (id: string) => findFlow(ctx.canvas, id)?.name;

  if (sub === "list") {
    if (!triggers.length) {
      return ok(
        "Nenhum gatilho neste grupo. Crie com:\n" +
          '  yard trigger create --when finished --on "Agente" --ask "Alvo" "prompt"\n',
      );
    }
    let out = "Gatilhos do grupo:\n";
    for (const t of triggers) {
      const last = t.lastRunAt ? ` último: ${new Date(t.lastRunAt).toLocaleTimeString()}` : "";
      const extra = [
        t.enabled ? "" : "(pausado)",
        t.once ? "(uma vez)" : "",
        t.cooldownSec ? `(mín. ${t.cooldownSec} s)` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const text = t.action.kind === "notify" || t.action.kind === "ask" || t.action.kind === "flow"
        ? t.action.text.split("\n")[0].slice(0, 70)
        : "";
      out += `  [${t.id}] ${triggerSummary(t, nameOf, flowNameOf)} ${extra}${last}\n      ${text}\n`;
    }
    return ok(out);
  }

  if (sub === "create") {
    const parsed = parseTriggerCreate(args.slice(1), req.stdin ?? undefined);
    if (!parsed.ok) return err(parsed.usage);
    const { spec } = parsed;
    const me = ctx.nameOf.get(ctx.caller.id)!;
    const resolve = (name: string): TerminalRow | null =>
      name.trim().toLowerCase() === me.toLowerCase() ? ctx.caller : findAgent(ctx, name);

    let sourceId = "*";
    if (spec.source !== "*") {
      const source = resolve(spec.source);
      if (!source) return err(`yard: "${spec.source}" não está conectado a você.\n`);
      sourceId = source.id;
    }

    let action: TriggerDef["action"];
    if (spec.action.kind === "ask") {
      const target = resolve(spec.action.target);
      if (!target) return err(`yard: "${spec.action.target}" não está conectado a você.\n`);
      action = { kind: "ask", targetId: target.id, text: spec.action.text };
    } else if (spec.action.kind === "flow") {
      const flow = findFlow(ctx.canvas, spec.action.flow);
      if (!flow) return err(`yard: fluxo "${spec.action.flow}" não existe neste grupo.\n`);
      if (!flowReach(ctx, flow.id)) {
        return err(
          `yard: você não está conectado ao cartão do fluxo "${flow.name}" — ` +
            "peça o cabo ao usuário (ou `yard connect`).\n",
        );
      }
      action = { kind: "flow", flowId: flow.id, text: spec.action.text };
    } else {
      action = { kind: "notify", text: spec.action.text };
    }

    const fresh: TriggerDef = {
      id: nanoid(6),
      sourceId,
      event: spec.event,
      action,
      enabled: true,
      once: spec.once,
      ...(spec.cooldownSec ? { cooldownSec: spec.cooldownSec } : {}),
      createdAt: Date.now(),
    };
    commitCanvas(ctx.groupId, (c) => ({ ...c, triggers: [...(c.triggers ?? []), fresh] }));
    return ok(
      `Gatilho [${fresh.id}] criado: ${triggerSummary(fresh, nameOf, flowNameOf)}. ` +
        "Um prompt só é entregue com o alvo rodando e ocioso.\n",
    );
  }

  if (sub === "delete" || sub === "pause" || sub === "resume") {
    const id = args[1];
    const target = triggers.find((t) => t.id === id);
    if (!target) return err(`yard: gatilho "${id ?? ""}" não existe (\`trigger list\`).\n`);
    if (sub === "delete") {
      commitCanvas(ctx.groupId, (c) => ({
        ...c,
        triggers: (c.triggers ?? []).filter((t) => t.id !== id),
      }));
      return ok(`Gatilho [${id}] removido.\n`);
    }
    const enabled = sub === "resume";
    commitCanvas(ctx.groupId, (c) => ({
      ...c,
      triggers: (c.triggers ?? []).map((t) => (t.id === id ? { ...t, enabled } : t)),
    }));
    return ok(`Gatilho [${id}] ${enabled ? "retomado" : "pausado"}.\n`);
  }

  return err("uso: yard trigger list|create|delete|pause|resume …\n" + TRIGGER_CREATE_USAGE);
}

/** The flow gate: only a CLI wired by cable to the card reaches it. */
function flowReach(ctx: Ctx, flowId: string): boolean {
  return isConnected(ctx.canvas, ctx.caller.id, flowId);
}

async function cmdFlow(
  ctx: Ctx,
  args: string[],
  req: BridgeRequest,
): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase() ?? "list";
  const flows = flowsOf(ctx.canvas);

  if (sub === "list") {
    if (!flows.length) {
      return ok(
        "Nenhum fluxo neste grupo. O usuário cria um com a ferramenta F no canvas.\n",
      );
    }
    const runs = useFlows.getState().runs;
    let out = "Fluxos do grupo:\n";
    for (const f of flows) {
      const run = runs[f.id];
      const stages = f.stages
        .map((s, i) => `${i + 1}. "${s.label?.trim() || `Etapa ${i + 1}`}"`)
        .join(" -> ");
      const reachLabel = flowReach(ctx, f.id) ? "" : " (sem cabo até você)";
      const theState = run
        ? run.finishedAt
          ? run.error
            ? " [última execução falhou]"
            : " [última execução concluída]"
          : ` [EM EXECUÇÃO — etapa ${Math.min(run.current + 1, f.stages.length)}/${f.stages.length}]`
        : "";
      out += `  - "${f.name}"${reachLabel}${theState}\n      ${stages || "(sem etapas)"}\n`;
    }
    out +=
      'Use `yard flow run "Nome" --stdin` para rodar a esteira AQUI, na sua CLI.\n';
    return ok(out);
  }

  // The current stage's briefing — the letter the stamp sends you to fetch.
  // Only the executor gets it: it is ITS prompt; another CLI has no use for it.
  if (sub === "stage") {
    const mine = Object.values(useFlows.getState().runs).filter(
      (r) => r.terminalId === ctx.caller.id,
    );
    const run = mine.find((r) => !r.finishedAt);
    if (!run) {
      const past = mine.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
      return err(
        past
          ? `yard: a execução do fluxo "${past.name}" nesta CLI já terminou ` +
              `(${past.error ? `com erro: ${past.error}` : past.cancelled ? "cancelada" : "concluída"}) — ` +
              "não há etapa aberta. `yard flow status` mostra o histórico.\n"
          : "yard: nenhum fluxo em execução nesta CLI — o briefing só existe " +
              "durante uma execução. `yard flow status` mostra as do grupo.\n",
      );
    }
    if (!run.brief) {
      return err(
        `yard: o fluxo "${run.name}" ainda não abriu a etapa — aguarde o carimbo chegar.\n`,
      );
    }
    return ok(run.brief.endsWith("\n") ? run.brief : run.brief + "\n");
  }

  if (sub === "status") {
    const runs = Object.values(useFlows.getState().runs).filter(
      (r) => r.groupId === ctx.groupId,
    );
    const name = args[1];
    const chosen = name
      ? runs.filter((r) => r.name.toLowerCase() === name.trim().toLowerCase())
      : runs;
    if (!chosen.length) {
      return ok(
        name
          ? `Nenhuma execução do fluxo "${name}" nesta sessão.\n`
          : "Nenhum fluxo executado nesta sessão.\n",
      );
    }
    return ok(chosen.map((r) => describeFlowRun(ctx, r)).join("\n") + "\n");
  }

  if (sub === "run") {
    const p = parseFlags(args.slice(1), { "--stdin": "stdin", "--file": "stdin" });
    const [name, taskPos] = p.positional;
    const task = p.fromStdin ? (req.stdin ?? "") : taskPos;
    if (!name || !task?.trim()) {
      return err(
        'uso: yard flow run "Nome do Fluxo" --stdin   (a tarefa pela entrada padrão)\n' +
          '     yard flow run "Nome" "tarefa curta"\n',
      );
    }
    const flow = findFlow(ctx.canvas, name);
    if (!flow) {
      const names = flows.map((f) => `"${f.name}"`).join(", ");
      return err(
        `yard: fluxo "${name}" não existe neste grupo.` +
          (names ? ` Existem: ${names}.` : "") +
          "\n",
      );
    }
    if (!flowReach(ctx, flow.id)) {
      return err(
        `yard: você não está conectado ao cartão do fluxo "${flow.name}" — ` +
          "peça o cabo ao usuário (ou `yard connect`).\n",
      );
    }
    // The pipeline runs on the CLI that asked: the flow is a sequence of
    // prompts, and the one walking through it is you.
    const r = startFlow(ctx.groupId, flow, task, {
      terminalId: ctx.caller.id,
      callerId: ctx.caller.id,
    });
    if (!r.ok) return err(`yard: ${r.message}\n`);
    return ok(
      `${r.message} Cada etapa chegará aqui como um carimbo "[Yard · Fluxo …]" — ` +
        "a cada um, rode `yard flow stage` para receber o briefing e execute-o. " +
        "Não rode `yard flow status` em loop.\n",
    );
  }

  if (sub === "cancel") {
    const name = args[1];
    if (!name) return err('uso: yard flow cancel "Nome do Fluxo"\n');
    const flow = findFlow(ctx.canvas, name);
    if (!flow) return err(`yard: fluxo "${name}" não existe neste grupo.\n`);
    const run = useFlows.getState().runs[flow.id];
    if (!run || run.finishedAt) {
      return err(`yard: o fluxo "${flow.name}" não está em execução.\n`);
    }
    if (!flowReach(ctx, flow.id) && run.terminalId !== ctx.caller.id) {
      return err(`yard: você não alcança o fluxo "${flow.name}" para cancelá-lo.\n`);
    }
    cancelFlow(flow.id);
    return ok(`Cancelamento pedido — o fluxo "${flow.name}" para na próxima checagem.\n`);
  }

  return err(
    'uso: yard flow list | run "Nome" --stdin | stage | status ["Nome"] | cancel "Nome"\n',
  );
}

// --- score (arrangements) -----------------------------------------------------

async function cmdScore(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase() ?? "list";
  if (sub === "list") {
    const everything = await ipc.scoreList();
    if (!everything.length) return ok('Nenhuma partitura salva (`yard score save "Nome"`).\n');
    let out = "Partituras:\n";
    for (const s of everything) {
      out += `  - "${s.name}" (${new Date(s.updatedAt).toLocaleString()})\n`;
    }
    return ok(out);
  }
  if (sub === "save") {
    const p = parseFlags(args.slice(1), { "--force": "bool" });
    const name = p.positional[0];
    if (!name) return err('uso: yard score save "Nome" [--force]\n');
    try {
      const path = await saveScore(ctx.groupId, name, !!p.bool.force);
      return ok(`Partitura "${name}" salva em ${path}\n`);
    } catch (e) {
      // Replacing somebody's saved arrangement is not something an agent gets
      // to do by picking a name that happens to be taken.
      if (scoreAlreadyExists(e)) {
        return err(
          `yard: já existe uma partitura chamada "${name}". Escolha outro nome ` +
            "(ou repita com `--force` se o usuário pediu para substituir).\n",
        );
      }
      return err(`yard: não consegui salvar a partitura: ${e}\n`);
    }
  }
  if (sub === "apply") {
    const name = args[1];
    if (!name) return err('uso: yard score apply "Nome"\n');
    try {
      const score = await readScore(name);
      // The caller's own folder: a board has no project to take one from.
      const r = applyScore(score, ctx.groupId, { cwd: ctx.caller.cwd });
      return ok(
        `Partitura "${name}" aplicada neste quadro: ${r.terminals} terminal(is) ` +
          `e ${r.items} item(ns) de canvas. Os terminais nascem parados — ` +
          "o usuário inicia quando quiser.\n",
      );
    } catch (e) {
      return err(`yard: não consegui aplicar a partitura: ${e}\n`);
    }
  }
  return err('uso: yard score save "Nome" | score list | score apply "Nome"\n');
}

// --- notify / debug ---------------------------------------------------------

function cmdNotify(ctx: Ctx, args: string[]): BridgeResponse {
  const msg = args[0];
  if (!msg) return err('uso: yard notify "mensagem"\n');
  try {
    const title = `Yard, ${ctx.nameOf.get(ctx.caller.id)}`;
    sendNotification({ title, body: msg });
    // An agent calling `yard notify` is asking for the user's attention, and
    // the user may not be at the machine (`lib/notifyOut.ts`).
    pushOut(title, msg, "notify");
  } catch (e) {
    return err(`yard: notificação indisponível: ${e}\n`);
  }
  return ok("notificação enviada.\n");
}

function cmdDebug(ctx: Ctx): BridgeResponse {
  const agents = connectedAgents(ctx);
  const notes = connectedNotes(ctx);
  const group = useProjects.getState().groups.find((g) => g.id === ctx.groupId);
  return ok(
    `terminal: ${ctx.caller.id} ("${ctx.nameOf.get(ctx.caller.id)}")\n` +
      `grupo: ${group?.name ?? ctx.groupId}\n` +
      `conexões no canvas: ${ctx.canvas.items.filter((i) => i.type === "connection").length}\n` +
      `agentes conectados: ${agents.length} | notas conectadas: ${notes.length} | portais: ${connectedPortals(ctx).length}\n` +
      `notas travadas: ${notes.filter((n) => n.locked).length}\n` +
      `rotinas no grupo: ${(ctx.canvas.routines ?? []).length}\n` +
      `ponte: ok (esta resposta veio por ela)\n`,
  );
}

const HELP = `yard — ponte entre agentes, notas e o canvas do Yard

  yard list                                    quem está conectado a você
  yard ask "Agente" "prompt"                   envia e espera a resposta
  yard ask "Agente" --file plano.md            prompt longo/multi-linha
  yard ask "Agente" --stdin                    prompt pela entrada padrão
  yard ask "Agente" --raw "2\\n"                teclas cruas (\\n \\t \\e \\xNN)
  yard ask "Agente" --no-wait "prompt"         envia sem esperar
  yard ask "Agente" --queue "prompt"           enfileira para quando ele estiver livre
  yard queue [list] | queue clear ["Agente"]   o que está esperando
  yard handoff "Alvo" ["o que falta"]          passa o bastão (papel, árvore, últimos turnos)
  yard ask --batch '{"A":"p1","B":"p2"}'       vários em paralelo
  yard ask … --timeout 600                     segundos de espera
  yard check "Agente"                          lê a tela atual do agente
  yard search "texto" [--all] [--limit 4]      procura no histórico dos terminais
  yard wait "Agente"                           bloqueia até ele parar
  yard wait --any | --all                      espera o primeiro | todos
  yard wait … --until stopped|done|blocked     o que conta como parar
  yard wait … --fresh                          exige saída nova antes de contar
  yard wait … --timeout 600                    segundos de espera
  yard note create ["conteúdo"] [--name "N"]   nota conectada a você
  yard note read "Nota" [início qtd]           lê com números de linha
  yard note write "Nota" "conteúdo"            substitui tudo (--file/--stdin)
  yard note edit "Nota" "antigo" "novo"        troca um trecho
  yard note delete "Nota"                      remove (destrutivo)
  yard connect "A" "B"                         liga agente/nota/portal
  yard portal create URL ["Nome"] [--ua chrome|ios|…] [--size WxH]
                                               (sempre WebView2; --ua só troca o user-agent)
  yard portal edit "Nome" [--url URL] [--live on|off]  endereco / recarga automatica
  yard portal close "Nome"                     remove (destrutivo; so se o usuario pediu)
  yard portal navigate|snapshot|click|fill|type|key|hover|scroll|resize|ua
  yard portal screenshot|evaluate|html|text|info|logs "Nome"
  yard recruit "Nome" [--agent id] [--role t] [--dir p]   novo agente conectado
  yard recruit "Nome" --floor "Frente"         novo agente numa aba da frente
  yard recruit "Nome" --replace "Antigo"       troca o processo do cartão
  yard dismiss "Nome"                          encerra e remove um conectado
  yard floor list                              chão e frentes do projeto
  yard floor create "Nome" [--branch x] [--existing-branch] [--adopt PATH]
                    [--no-git] [--copy-ground] [--base REF] [--worktree-name PASTA]
                                               frente nova (git worktree isolado)
  yard floor create … --dry-run                mostra o plano e nao escreve nada
  yard floor create … --json                   o mesmo plano/resultado em JSON
  yard floor land "Nome" [--close] [--keep-losers]
  yard worker create "Nome" --task "pedido" [--agent x] [--copy-ground]   uma frente, um agente, a tarefa
  yard worker list [--json] | inspect "Nome" | wait "Nome" [--until …]
  yard worker send "Nome" "texto" [--queue] | review "Nome"
  yard worker apply "Nome" [--keep-front] [--close-siblings] | keep | discard | stop
                                               merge no chão; --close encerra a frente
  yard floor compare                           diffstat de cada frente vs o chão
  yard floor fanout "Nome" --prompt "…" [--agents a,b]
                                               um pedido, N frentes, um agente cada
  yard role show ["Agente"] | role set "Agente" "texto|papel salvo"
  yard role create|edit "Papel" "texto" [--scope global|current]
  yard role list | role delete "Papel"         biblioteca de papéis
  yard routine list                            prompts agendados do grupo
  yard routine create "Agente" "prompt" --every 30 [--once]
  yard routine pause|resume|delete <id>
  yard trigger list                            gatilhos (quando X acontecer → faça Y) do grupo
  yard trigger create --when finished|blocked|exited --on "Agente"|any
                      --ask "Alvo" "prompt" | --notify "texto" | --flow "Fluxo" "tarefa"
                      [--once] [--cooldown 60]   ({name} e {ask} viram quem disparou e a pergunta)
  yard trigger pause|resume|delete <id>
  yard flow list                               fluxos (correntes de agentes) do grupo
  yard flow run "Fluxo" "tarefa"               dispara a corrente etapa por etapa
  yard flow stage                              briefing da etapa em execução NESTA CLI
  yard flow status ["Fluxo"] | flow cancel "Fluxo"
  yard score save "Nome" [--force] | score list | score apply "Nome"
  yard canvas list [--json]                    tudo que está no canvas, com posição e tamanho
  yard canvas move "Nome" X Y | --by DX DY     move um cartão ou item conectado a você
  yard canvas resize "Nome" W H                redimensiona
  yard canvas arrange [--layout grid|row|column] ["Nome"...]
                                               organiza você e os conectados (ou os nomeados)
  yard canvas align left|hcenter|right|top|vcenter|bottom "A" "B" [...]
  yard canvas frame "Grupo" ["Membro"...]      moldura nomeada em volta deles
  yard canvas pin|unpin "Nome"                 fixa/solta no lugar
  yard canvas focus "Nome" | zoom fit|N%       move a câmera do usuário
  yard notify "mensagem"                       notificação nativa ao usuário
  yard debug                                   diagnóstico da ponte

Comunicação exige conexão desenhada no canvas (ou criada por connect/recruit).
Notas travadas pelo usuário recusam escrita — peça a mudança a ele.
Use \`--\` para mandar texto que começa com \`-\`: yard ask "A" -- --raw
`;
