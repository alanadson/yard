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
import { closeTerminal, disposePty } from "./lifecycle";
import {
  applyScore,
  readScore,
  saveScore,
  scoreAlreadyExists,
} from "./scores";
import { findGroupNamed, isIsolatedFloor } from "./floors";
import { createFloor } from "./floorCreate";
import { agentAsFanout, fanOutTask } from "./floorFanout";
import { defaultRoleOf } from "./agentDefaults";
import { spawnEnvFor } from "./spawnEnv";
import { landFloor, previewFloor, settleAfterLand } from "./floorLand";
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { useProjects } from "../stores/projectsStore";
import {
  reachedWait,
  useTerminals,
  type TerminalRuntime,
  type WaitUntil,
} from "../stores/terminalsStore";
import { bridgeCallerRect as callerRect, commitBridgeCanvas as commitCanvas } from "./bridgeCanvas";
import {
  autoNodeRect,
  clampRoutineInterval,
  EMPTY_CANVAS,
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  noteName,
  type CardRole,
  type RoutineDef,
} from "./canvas";
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
  return makeCtx(caller, caller.groupId, canvas, s.terminalsOf(caller.groupId));
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
    default:
      return err(`yard: comando desconhecido "${cmd}". Rode \`yard help\`.\n`);
  }
}

// --- list -------------------------------------------------------------------

function cmdList(ctx: Ctx): BridgeResponse {
  const roles = ctx.canvas.roles ?? {};
  const rt = useTerminals.getState().byId;
  const me = ctx.nameOf.get(ctx.caller.id)!;
  const myRole = roles[ctx.caller.id];

  // The name only: `list` is a roster, and one agent's full instructions
  // would push everyone else's line off the reader's screen. `role show`
  // is where the text lives.
  let out = `You: "${me}"${myRole ? ` — papel: ${myRole.name}` : ""}\n`;

  const agents = connectedAgents(ctx);
  out += "Agentes conectados:\n";
  if (agents.length === 0) {
    out +=
      "  (nenhum — peça ao usuário para desenhar uma conexão no canvas,\n" +
      "   ou use `yard connect` / `yard recruit`)\n";
  }
  for (const t of agents) {
    const r = rt[t.id];
    // `running` is true of an agent mid-refactor and of one frozen at a
    // permission prompt. The second one is the whole reason to read this list.
    const state = r?.blocked ? "travado" : (r?.state ?? "idle");
    const role = roles[t.id];
    const asking = r?.blocked && r.blockedAsk ? ` — pergunta: ${r.blockedAsk}` : "";
    out +=
      `  - "${ctx.nameOf.get(t.id)}" [${state}]${role ? ` papel: ${role.name}` : ""}` +
      `${asking}\n`;
  }

  const notes = connectedNotes(ctx);
  out += "Notas conectadas:\n";
  if (notes.length === 0) out += "  (nenhuma — crie com `yard note create`)\n";
  for (const n of notes) {
    const lines = n.text ? n.text.split("\n").length : 0;
    out +=
      `  - "${ctx.noteNameOf.get(n.id)}" (${lines} linha${lines === 1 ? "" : "s"})` +
      `${n.locked ? " (locked)" : ""}\n`;
  }

  const portals = connectedPortals(ctx);
  out += "Portais conectados:\n";
  if (portals.length === 0) {
    out +=
      "  (nenhum — peça ao usuário para criar um portal no canvas (W)\n" +
      "   e ligá-lo em você, ou use `yard portal create`)\n";
  }
  for (const p of portals) {
    out += `  - "${ctx.portalNameOf.get(p.id)}"  ${p.url}\n`;
  }

  const enabledRoutines = (ctx.canvas.routines ?? []).filter((r) => r.enabled);
  if (enabledRoutines.length) {
    out += `Rotinas ativas no grupo: ${enabledRoutines.length} (\`yard routine list\`)\n`;
  }
  return ok(out);
}

// --- ask / check ------------------------------------------------------------

interface AskFlags {
  raw: boolean;
  noWait: boolean;
  /** The prompt comes from the request's `stdin` field (`--file`/`--stdin` on the shim). */
  fromStdin: boolean;
  timeoutMs: number;
}

const ASK_SPEC = {
  "--raw": "bool",
  "--no-wait": "bool",
  "--stdin": "stdin",
  "--file": "stdin",
  "--timeout": "number",
} as const;

function takeFlags(args: string[], reqTimeout?: number): { rest: string[]; flags: AskFlags } {
  const p = parseFlags(args, ASK_SPEC);
  const timeout = p.number.timeout;
  return {
    rest: p.positional,
    flags: {
      raw: !!p.bool.raw,
      noWait: !!p.bool["no-wait"],
      fromStdin: p.fromStdin,
      // Leave the bridge's own deadline some slack: replying after the CLI
      // gave up is the same as not replying.
      timeoutMs:
        timeout && timeout > 0
          ? timeout * 1000
          : Math.max(30_000, (reqTimeout ?? 600_000) - 15_000),
    },
  };
}

async function cmdAsk(
  ctx: Ctx,
  args: string[],
  req: BridgeRequest,
): Promise<BridgeResponse> {
  const { rest, flags } = takeFlags(args, req.timeoutMs);

  if (rest[0] === "--batch") {
    let map: Record<string, string>;
    try {
      map = JSON.parse(rest[1] ?? "");
    } catch {
      return err('yard: --batch espera um JSON {"Agente": "prompt", ...}\n');
    }
    const results = await Promise.all(
      Object.entries(map).map(async ([name, prompt]) => {
        const r = await askOne(ctx, name, String(prompt), flags);
        return r.code === 0 ? { name, output: r.output } : { name, error: r.output.trim() };
      }),
    );
    return ok(JSON.stringify(results, null, 2) + "\n");
  }

  const [name, positional] = rest;
  const prompt = flags.fromStdin ? (req.stdin ?? "") : positional;
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

  const before = await ipc.ptyProbe(target.id);
  if (!before.alive) {
    return err(
      `yard: "${name}" não está rodando. ` +
        "Peça ao usuário para retomá-lo.\n",
    );
  }
  const baseline = before.totalBytes;
  const t0 = Date.now();

  await injectPrompt(target.id, prompt, { raw: flags.raw });

  if (flags.noWait) return ok(`enviado para "${ctx.nameOf.get(target.id)}".\n`);

  // Wait for "finished": there was new output and then silence (or the
  // agent detector's idle signal, or the process exited).
  let lastSeq = baseline;
  let grew = false;
  let quiet = 0;
  while (Date.now() - t0 < flags.timeoutMs) {
    await sleep(2000);
    const probe = await ipc.ptyProbe(target.id);
    if (!probe.alive) break;
    if (probe.totalBytes > lastSeq) {
      lastSeq = probe.totalBytes;
      grew = true;
      quiet = 0;
    } else if (grew) {
      quiet++;
    }
    const rt = useTerminals.getState().byId[target.id];
    // `finished` is a latch (only focus releases it) and the echo of the
    // injected prompt is activity after `t0` — what tells a stale idle from a
    // fresh one is the event's own `finishedAt`.
    if (grew && rt?.finished && rt.finishedAt >= t0) break;
    if (grew && quiet >= 3) break; // ~6 s without a new byte
  }

  const after = await ipc.ptyReadSince(target.id, baseline, 64 * 1024);

  // The process died while we waited. `read_since` cannot honour the cursor
  // for a PTY that left the registry — it falls back to the tail of the
  // scrollback on disk and reports `totalBytes: 0`. Treating that as the
  // delta handed the caller 30 KB of some *earlier* task as if it were the
  // answer, with exit code 0, and an orchestrating agent moved on believing
  // it had been replied to.
  if (!after.alive) {
    return err(
      `yard: "${ctx.nameOf.get(target.id)}" encerrou enquanto eu esperava a resposta — ` +
        "o processo não está mais rodando. Peça ao usuário para retomá-lo e tente de novo.\n",
    );
  }

  if (after.totalBytes > baseline || after.data.length > 0) grew = true;
  const clean = stripAnsi(after.data).trim();
  if (!grew && !clean) {
    return err(
      `yard: sem resposta de "${ctx.nameOf.get(target.id)}" em ${Math.round(
        flags.timeoutMs / 1000,
      )}s. Use \`yard check "${ctx.nameOf.get(target.id)}"\` para ver o estado.\n`,
    );
  }
  return ok(tail(clean, 30_000) + "\n");
}

async function cmdCheck(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const name = args[0];
  if (!name) return err('uso: yard check "Agente"\n');
  const target = findAgent(ctx, name);
  if (!target) return err(`yard: "${name}" não está conectado a você.\n`);
  const att = await ipc.ptyReadSince(target.id, 0, 64 * 1024);
  const clean = stripAnsi(att.data).trim();
  const lines = clean.split("\n");
  const view = lines.slice(-60).join("\n");
  const rt = useTerminals.getState().byId[target.id];
  const state = !att.alive
    ? "parado"
    : rt?.blocked
      ? `travado esperando o usuário — ${rt.blockedAsk ?? "pergunta na tela"}`
      : rt?.finished
        ? "terminou de trabalhar"
        : "rodando";
  return ok(`[${ctx.nameOf.get(target.id)} — ${state}]\n${tail(view, 8_000)}\n`);
}

// --- wait -------------------------------------------------------------------

const WAIT_SPEC = {
  "--until": "string",
  "--timeout": "number",
  "--any": "bool",
  "--all": "bool",
  "--fresh": "bool",
} as const;

/** How long the loop may sleep with nothing happening. A safety net, not the clock. */
const WAIT_TICK_MS = 1_000;

/**
 * Blocks until connected agents stop — the command that turns polling into
 * waiting.
 *
 * `check` is a photograph, so an orchestrator that wanted to know when three
 * recruits were done had exactly one move: take photograph after photograph.
 * Each one costs a round trip and sixty lines of somebody else's terminal in
 * its context window, and it still learns the news one cycle late.
 *
 * This waits on the runtime mirror instead. The store already receives the
 * idle event that decides `finished`/`blocked`, so the answer arrives when the
 * state actually changes; the one-second tick underneath is a safety net for a
 * transition that somehow arrives without a store write, not the mechanism.
 *
 * `--fresh` exists for the `ask --no-wait` then `wait` pattern: `finished` may
 * still be set from the *previous* turn, and returning instantly on stale
 * state would be the same bug as not waiting at all. With it, a terminal only
 * counts once its byte counter has moved past where it was when `wait` began.
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

  // Same slack as `ask`: replying after the CLI gave up is not replying.
  const timeoutMs =
    p.number.timeout && p.number.timeout > 0
      ? p.number.timeout * 1000
      : Math.max(30_000, (reqTimeout ?? 600_000) - 15_000);

  const baseline = new Map<string, number>();
  if (p.bool.fresh) {
    for (const t of targets) {
      try {
        baseline.set(t.id, (await ipc.ptyProbe(t.id)).totalBytes);
      } catch {
        baseline.set(t.id, 0);
      }
    }
  }

  const reached = await waitForAgents(
    targets.map((t) => t.id),
    until,
    !!p.bool.all,
    p.bool.fresh ? baseline : null,
    timeoutMs,
  );

  const rt = useTerminals.getState().byId;
  const lines = targets
    .filter((t) => reached.has(t.id))
    .map((t) => `- "${ctx.nameOf.get(t.id)}": ${describeStop(rt[t.id])}`);

  if (lines.length === 0) {
    const who = targets.map((t) => `"${ctx.nameOf.get(t.id)}"`).join(", ");
    return err(
      `yard: ${who} não chegou em "${until}" em ${Math.round(timeoutMs / 1000)}s. ` +
        "Use `yard check` para ver o estado atual.\n",
    );
  }

  const pending = targets.filter((t) => !reached.has(t.id));
  let out = `${lines.length} de ${targets.length} em "${until}":\n${lines.join("\n")}\n`;
  if (pending.length > 0) {
    out += `Ainda trabalhando: ${pending
      .map((t) => `"${ctx.nameOf.get(t.id)}"`)
      .join(", ")}\n`;
  }
  // `--all` is a promise about the whole set. The shim prints the body either
  // way, so failing the exit code costs the caller no information and stops an
  // orchestrator from moving on with half the team still working.
  return pending.length > 0 && p.bool.all ? err(out) : ok(out);
}

function describeStop(rt: TerminalRuntime | undefined): string {
  if (!rt) return "estado desconhecido";
  if (rt.state === "exited" || rt.state === "error") return "o processo parou";
  if (rt.blocked) return `travado — ${rt.blockedAsk ?? "pergunta na tela"}`;
  return "terminou de trabalhar";
}

/**
 * Resolves when `all` (or the first, when not) of the ids reach `until`.
 *
 * The store subscription is what makes this cheap: no IPC per turn of the
 * loop, and the wake-up rides the same event that painted the badge.
 */
async function waitForAgents(
  ids: string[],
  until: WaitUntil,
  all: boolean,
  baseline: Map<string, number> | null,
  timeoutMs: number,
): Promise<Set<string>> {
  const reached = new Set<string>();
  const deadline = Date.now() + timeoutMs;

  const settled = async (id: string): Promise<boolean> => {
    if (!reachedWait(useTerminals.getState().byId[id], until)) return false;
    if (!baseline) return true;
    try {
      return (await ipc.ptyProbe(id)).totalBytes > (baseline.get(id) ?? 0);
    } catch {
      // The PTY is gone: that is a stop, and pretending otherwise would hold
      // the caller until the timeout for a process that will never answer.
      return true;
    }
  };

  for (;;) {
    for (const id of ids) {
      if (!reached.has(id) && (await settled(id))) reached.add(id);
    }
    if (all ? reached.size === ids.length : reached.size > 0) break;
    if (Date.now() >= deadline) break;
    await nextRuntimeChange(deadline);
  }
  return reached;
}

/** Wakes on the next runtime write, or on the tick, or at the deadline. */
function nextRuntimeChange(deadline: number): Promise<void> {
  return new Promise((resolve) => {
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = useTerminals.subscribe(finish);
    const timer = setTimeout(
      finish,
      Math.max(0, Math.min(WAIT_TICK_MS, deadline - Date.now())),
    );
  });
}

// --- note -------------------------------------------------------------------

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
      const pinned = p.string.name;
      const text = p.fromStdin ? (req.stdin ?? "") : (p.positional[0] ?? "");
      const id = nanoid(8);
      const base = callerRect(ctx);
      const item: NoteItem = {
        id,
        type: "note",
        x: base.x - 280,
        y: base.y + connectedNotes(ctx).length * 40,
        w: 240,
        h: 180,
        text,
        color: "#f5f5f5",
        ...(pinned ? { name: pinned } : {}),
      };
      commitCanvas(ctx.groupId, (c) =>
        addItems(c, item, connection(ctx.caller.id, id)),
      );
      return ok(`Nota criada e conectada: "${pinned ?? noteName(item)}"\n`);
    }
    case "read": {
      const note = rest[0] ? findNote(ctx, rest[0]) : null;
      if (!note) return err(noteMiss(ctx, rest[0]));
      const itemName = ctx.noteNameOf.get(note.id)!;
      const lines = note.text.split("\n");
      // An empty note is a fact, not an error — say it instead of answering
      // with a blank line the caller has to interpret.
      if (!note.text) return ok(`(a nota "${itemName}" está vazia)\n`);
      const start = Math.max(1, Number(rest[1]) || 1);
      const count = Math.max(1, Number(rest[2]) || lines.length);
      // Asking past the end used to return `ok("\n")`, and an agent reading
      // that concluded the note was empty rather than that it had asked for
      // lines which do not exist.
      if (start > lines.length) {
        return err(
          `yard: a nota "${itemName}" tem ${lines.length} linha(s); você pediu a partir da ${start}.\n`,
        );
      }
      const slice = lines.slice(start - 1, start - 1 + count);
      const width = String(start + slice.length - 1).length;
      const body = slice
        .map((l, i) => `${String(start + i).padStart(width)}  ${l}`)
        .join("\n");
      return ok(`${body}\n`);
    }
    case "write":
    case "edit": {
      const note = rest[0] ? findNote(ctx, rest[0]) : null;
      if (!note) return err(noteMiss(ctx, rest[0]));
      const oldName = ctx.noteNameOf.get(note.id)!;
      if (note.locked) return err(lockedMsg(oldName));
      let nextText: string;
      if (sub === "write") {
        // Same spec as everywhere else: this used to be an `includes()` check,
        // which accepted the flag in positions the other commands rejected.
        const p = parseFlags(rest.slice(1), {
          "--stdin": "stdin",
          "--file": "stdin",
        });
        const content = p.fromStdin ? req.stdin : p.positional[0];
        if (content == null) {
          return err(
            'uso: yard note write "Nome" "conteúdo"\n' +
              '     yard note write "Nome" --file texto.md   (multi-linha)\n',
          );
        }
        nextText = content;
      } else {
        const [, oldText, newText] = rest;
        if (oldText == null || newText == null) {
          return err('uso: yard note edit "Nome" "texto antigo" "texto novo"\n');
        }
        if (!note.text.includes(oldText)) {
          return err(`yard: o texto antigo não aparece na nota "${oldName}".\n`);
        }
        nextText = note.text.replace(oldText, newText);
      }
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, note.id, "note", { text: nextText }),
      );
      const renamed = !note.name && noteName({ ...note, text: nextText }) !== oldName;
      return ok(
        `Nota "${oldName}" atualizada.` +
          (renamed ? ` Novo nome: "${noteName({ ...note, text: nextText })}".` : "") +
          "\n",
      );
    }
    case "delete": {
      const note = rest[0] ? findNote(ctx, rest[0]) : null;
      if (!note) return err(noteMiss(ctx, rest[0]));
      if (note.locked) return err(lockedMsg(ctx.noteNameOf.get(note.id)!));
      commitCanvas(ctx.groupId, (c) => removeItemAndEdges(c, note.id));
      return ok(`Nota "${ctx.noteNameOf.get(note.id)}" removida.\n`);
    }
    default:
      return err(
        "uso: yard note create|read|write|edit|delete … (veja `yard help`)\n",
      );
  }
}

function lockedMsg(name: string): string {
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

function cmdConnect(ctx: Ctx, args: string[]): BridgeResponse {
  const [a, b] = args;
  if (!a || !b) return err('uso: yard connect "A" "B"\n');
  // A flow card is a cable end too: that is how a CLI hooks itself onto a
  // pipeline without the user's mouse.
  const resolve = (name: string) => {
    const found = findAny(ctx, name);
    if (found) return found;
    const flow = findFlow(ctx.canvas, name);
    return flow ? { kind: "flow" as const, id: flow.id } : null;
  };
  const ea = resolve(a);
  const eb = resolve(b);
  if (!ea) return err(`yard: não achei "${a}" neste grupo.\n`);
  if (!eb) return err(`yard: não achei "${b}" neste grupo.\n`);
  if (ea.id === eb.id) return err("yard: os dois lados são a mesma coisa.\n");
  // The gate has to hold here too, or it is not a gate: an agent that could
  // wire any two things in the group could wire itself to everything and
  // reach the whole group — exactly what the skill manual says it cannot do.
  if (!reaches(ctx, ea.id) && !reaches(ctx, eb.id)) {
    return err(
      `yard: nem "${a}" nem "${b}" estão ao seu alcance — uma das pontas ` +
        "precisa ser você ou algo já conectado a você. Peça ao usuário para " +
        "desenhar essa conexão no canvas.\n",
    );
  }
  if (isConnected(ctx.canvas, ea.id, eb.id)) return ok("já estavam conectados.\n");
  commitCanvas(ctx.groupId, (c) => addItems(c, connection(ea.id, eb.id)));
  return ok(`Conectado: "${a}" ↔ "${b}".\n`);
}

async function cmdRecruit(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const p = parseFlags(args, {
    "--agent": "string",
    "--preset": "string",
    "--role": "string",
    "--dir": "string",
    "--replace": "string",
    "--floor": "string",
    // Accepted and ignored: the shim adds it to every call.
    "--timeout": "number",
  });
  const agentId = p.string.agent ?? p.string.preset;
  const role = p.string.role;
  const dir = p.string.dir;
  const replace = p.string.replace;
  const floorName = p.string.floor;
  const name = p.positional[0];
  if (!name) {
    return err(
      'uso: yard recruit "Nome" [--agent claude|codex|…] [--role "…"] [--dir PATH]\n' +
        '     yard recruit "Nome" --floor "Andar"        (nasce no canvas do andar)\n' +
        '     yard recruit "Nome" --replace "Antigo" [--agent …]   (troca o processo do cartão)\n',
    );
  }
  if (replace && floorName) {
    return err("yard: --replace e --floor não combinam — o cartão substituído já mora num grupo.\n");
  }

  let program = ctx.caller.program;
  const cliArgs: string[] = [];
  let kind = ctx.caller.kind;
  let rowAgentId = ctx.caller.agentId ?? null;
  if (agentId) {
    const agents = await ipc.detectAgents(false);
    const found = agents.find(
      (x) =>
        x.id.toLowerCase() === agentId!.toLowerCase() ||
        x.name.toLowerCase() === agentId!.toLowerCase(),
    );
    if (!found || !found.installed || !found.bin) {
      const have = agents.filter((x) => x.installed).map((x) => x.id);
      return err(
        `yard: agente "${agentId}" não está instalado. Disponíveis: ${have.join(", ")}.\n`,
      );
    }
    program = found.bin;
    kind = "agent";
    rowAgentId = found.id;
  }
  // Without `--role`, the recruit is born into whatever role that CLI is
  // configured with in Configurações › Agentes — the same one a click in
  // "Nova aba" would have given it. An explicit `--role` still wins.
  const cardRole = role
    ? await resolveRole(ctx.canvas, role)
    : (defaultRoleOf(useAgentDefaults.getState().defaults, rowAgentId)?.role ??
      undefined);
  // The role reaches the recruit the same way it reaches a CLI the user opens
  // by hand: through the flag when the CLI has one, typed in when it does not.
  const launch = roleLaunch(rowAgentId, cardRole);
  cliArgs.push(...launch.args);
  // What this CLI is configured with — the fixed line, the cache, the distro —
  // is added by `bornAs`, once the working directory is known.

  if (replace) return replaceCard(ctx, replace, { name, program, cliArgs, kind, rowAgentId, dir, cardRole, launch });

  if (floorName) {
    return recruitInFloor(ctx, floorName, { name, program, cliArgs, kind, rowAgentId, dir, cardRole, launch });
  }

  const cwd = dir ?? ctx.caller.cwd;
  const s = useProjects.getState();
  const born = bornAs(rowAgentId, program, cliArgs, cwd);
  const newId = s.addTerminal({
    groupId: ctx.groupId,
    title: name,
    kind: kind as "shell" | "agent",
    agentId: rowAgentId,
    program: born.program,
    args: born.args,
    cwd,
  });

  const base = callerRect(ctx);
  const idx = connectedAgents(ctx).length;
  commitCanvas(ctx.groupId, (c) => ({
    ...addItems(c, connection(ctx.caller.id, newId)),
    nodes: {
      ...c.nodes,
      [newId]: {
        x: base.x + base.w + 110,
        y: base.y + idx * 90,
        w: NODE_DEFAULT_W,
        h: NODE_DEFAULT_H,
      },
    },
    roles: cardRole ? { ...(c.roles ?? {}), [newId]: cardRole } : c.roles,
  }));

  try {
    await spawnCard(newId, { program, args: cliArgs, cwd, kind, title: name });
  } catch (e) {
    return err(
      `yard: terminal "${name}" criado no canvas, mas o processo não subiu: ${e}\n`,
    );
  }
  if (launch.briefing) void deliverBriefing(newId, launch.briefing);
  return ok(
    `Recrutado "${name}"${cardRole ? ` (papel: ${cardRole.name})` : ""} — conectado a você. ` +
      "Dê alguns segundos para o agente subir antes do primeiro `yard ask`.\n",
  );
}

/**
 * `recruit --replace "Antigo"`: swaps the process behind a card that
 * already exists, keeping id, position, connections and role.
 *
 * Reusing the **same terminal id** is the trick: the already-mounted
 * `XTermView` keeps listening on `pty://output/<id>`, so the new terminal
 * appears in the old one's place without the card flashing or the canvas
 * arrows coming undone.
 */
/** Waits for the id to leave the Rust registry so it can be reused. */
async function waitPtyGone(id: string, timeoutMs = 5000): Promise<boolean> {
  const theEnd = Date.now() + timeoutMs;
  while (Date.now() < theEnd) {
    if (!(await ipc.ptyExists(id).catch(() => false))) return true;
    await sleep(80);
  }
  return false;
}

async function replaceCard(
  ctx: Ctx,
  targetLabel: string,
  newValue: {
    name: string;
    program: string;
    cliArgs: string[];
    kind: string;
    rowAgentId: string | null;
    dir?: string;
    cardRole?: CardRole;
    launch: RoleLaunch;
  },
): Promise<BridgeResponse> {
  const target =
    findAgent(ctx, targetLabel) ??
    ctx.terminals.find(
      (t) => ctx.nameOf.get(t.id)!.toLowerCase() === targetLabel.trim().toLowerCase(),
    ) ??
    null;
  if (!target) {
    return err(
      `yard: não achei "${targetLabel}" neste grupo para substituir. ` +
        "Rode `yard list` para ver os nomes.\n",
    );
  }
  const cwd = newValue.dir ?? target.cwd;
  const s = useProjects.getState();

  await disposePty(target.id);
  // `kill` only signals: the id stays in the Rust registry until the reader
  // thread sees EOF and cleans up. Spawning before that dies with "pty ja
  // esta rodando" — the same reason `pty::restart` waits on the other side.
  if (!(await waitPtyGone(target.id))) {
    // Be honest about what already happened. This used to say "o cartão está
    // intacto. Tente de novo." — after `disposePty` had already killed the
    // process and forgotten its scrollback. The agent that read it retried
    // believing nothing had changed, while the user had just lost a live
    // teammate and its history.
    return err(
      `yard: matei o processo de "${targetLabel}" mas o id não saiu do registro a tempo, ` +
        `então não consegui subir "${newValue.name}" no lugar. ` +
        "O cartão continua no canvas (posição, conexões e papel), parado e ainda " +
        `apontando para "${targetLabel}" — o processo dele e o histórico já foram embora. ` +
        "Espere alguns segundos e rode o mesmo `recruit --replace` de novo.\n",
    );
  }
  const born = bornAs(newValue.rowAgentId, newValue.program, newValue.cliArgs, cwd);
  s.updateTerminal(target.id, {
    title: newValue.name,
    kind: newValue.kind as "shell" | "agent",
    agentId: newValue.rowAgentId,
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
      kind: newValue.kind,
      title: newValue.name,
    });
    // The view was already mounted when the PTY died; without this the card
    // would stay marked "encerrado" until the first activity.
    useTerminals.getState().markRunning(target.id, snap.pid);
  } catch (e) {
    return err(
      `yard: o cartão de "${targetLabel}" já aponta para "${newValue.name}", mas o processo não subiu: ${e}. ` +
        "Peça ao usuário para apertar ▶ no cartão.\n",
    );
  }

  // Without `--role` the canvas does not change at all: node and connections
  // are the same, and the new title already came through `updateTerminal`.
  if (newValue.cardRole) {
    const role = newValue.cardRole;
    commitCanvas(ctx.groupId, (c) => ({
      ...c,
      roles: { ...(c.roles ?? {}), [target.id]: role },
    }));
  }
  if (newValue.launch.briefing) void deliverBriefing(target.id, newValue.launch.briefing);
  return ok(
    `Cartão de "${targetLabel}" agora roda "${newValue.name}" — posição, conexões e papel preservados.\n`,
  );
}

async function cmdDismiss(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const name = args[0];
  if (!name) return err('uso: yard dismiss "Nome"\n');
  const target = findAgent(ctx, name);
  if (!target) {
    return err(`yard: "${name}" não está conectado a você (só é possível dispensar conexões diretas).\n`);
  }
  // `closeTerminal` already takes the card, the role, the routines and the
  // wires with it — that cleanup used to live here, which is why closing the
  // same terminal from the UI left debris behind.
  const itemName = ctx.nameOf.get(target.id);
  await closeTerminal(target.id);
  return ok(`"${itemName}" dispensado.\n`);
}

// --- floor ------------------------------------------------------------------

/** Group in the caller's project whose name matches (case-insensitive). */
function findGroupByName(projectId: string, name: string) {
  return findGroupNamed(useProjects.getState().groupsOf(projectId), name);
}

/**
 * `recruit --floor`: the new card is born on the floor's canvas, with the
 * worktree's cwd, without pulling the caller off the ground. No cable: a
 * connection only lives inside its own group's canvas (cross-floor comes later).
 */
async function recruitInFloor(
  ctx: Ctx,
  floorName: string,
  next: {
    name: string;
    program: string;
    cliArgs: string[];
    kind: string;
    rowAgentId: string | null;
    dir?: string;
    cardRole?: CardRole;
    launch: RoleLaunch;
  },
): Promise<BridgeResponse> {
  const s = useProjects.getState();
  const project = s.projectOfGroup(ctx.groupId);
  if (!project) return err("yard: o grupo deste terminal não pertence a um projeto.\n");
  const target = findGroupByName(project.id, floorName);
  if (!target) {
    return err(
      `yard: não achei o andar "${floorName}" neste projeto. Rode \`yard floor list\`.\n`,
    );
  }
  const cwd = next.dir ?? s.rootOfGroup(target.id) ?? ctx.caller.cwd;

  const idx = s.terminalsOf(target.id).length;
  const born = bornAs(next.rowAgentId, next.program, next.cliArgs, cwd);
  const newId = s.addTerminal({
    groupId: target.id,
    title: next.name,
    kind: next.kind as "shell" | "agent",
    agentId: next.rowAgentId,
    program: born.program,
    args: born.args,
    cwd,
  });
  commitCanvas(target.id, (c) => ({
    ...c,
    nodes: { ...c.nodes, [newId]: autoNodeRect(idx) },
    roles: next.cardRole ? { ...(c.roles ?? {}), [newId]: next.cardRole } : c.roles,
  }));

  try {
    await spawnCard(newId, {
      program: next.program,
      args: next.cliArgs,
      cwd,
      kind: next.kind,
      title: next.name,
    });
  } catch (e) {
    return err(
      `yard: "${next.name}" foi criado no andar "${target.name}", mas o processo não subiu: ${e}\n`,
    );
  }
  if (next.launch.briefing) void deliverBriefing(newId, next.launch.briefing);
  return ok(
    `Recrutado "${next.name}" no andar "${target.name}" (cwd: ${cwd}). ` +
      "Conexões não cruzam andares — fale com ele pelo canvas daquele andar.\n",
  );
}

async function cmdFloor(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase() ?? "list";
  const s = useProjects.getState();
  const project = s.projectOfGroup(ctx.groupId);
  if (!project) return err("yard: o grupo deste terminal não pertence a um projeto.\n");

  if (sub === "list") {
    const groups = s.groupsOf(project.id);
    let out = `Andares de "${project.name}":\n`;
    groups.forEach((g, i) => {
      const floor = s.layoutOf(g.id).floor;
      const aliveCount = s.terminalsOf(g.id).filter((t) => t.alive).length;
      const tag =
        floor?.kind === "isolated"
          ? ` [branch ${floor.branch ?? "?"}]`
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
      "--no-git": "bool",
      "--copy-ground": "bool",
    });
    const branch = p.string.branch;
    const existing = !!p.bool["existing-branch"];
    const noGit = !!p.bool["no-git"];
    const copyGround = !!p.bool["copy-ground"];
    const name = p.positional[0];
    if (!name) {
      return err(
        'uso: yard floor create "Nome" [--branch x] [--existing-branch] [--no-git] [--copy-ground]\n',
      );
    }
    if (existing && !branch) {
      return err("yard: --existing-branch exige --branch com o nome da branch.\n");
    }
    try {
      const { provision } = await createFloor({
        projectId: project.id,
        name,
        branch: branch ?? undefined,
        existingBranch: existing,
        noGit,
        copyGround,
        activate: false,
      });
      return ok(
        provision.kind === "isolated"
          ? `Andar "${name}" criado: branch ${provision.branch}, worktree em ${provision.path}.` +
              `${copyGround ? " Layout do chão clonado (terminais parados)." : ""}\n`
          : `Andar "${name}" criado SEM git (projeto sem repositório ou --no-git): ` +
              `os terminais dele usam o mesmo diretório do chão.\n`,
      );
    } catch (e) {
      return err(`yard: não consegui criar o andar: ${e}\n`);
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
    if (!target) return err(`yard: não achei o andar "${name}".\n`);
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
      return ok(`Nenhum andar isolado em "${project.name}".\n`);
    }
    let out = `Andares de "${project.name}" vs o chão:\n`;
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
    'uso: yard floor list\n     yard floor create "Nome" [--branch x] [--existing-branch] [--no-git] [--copy-ground]\n     yard floor land "Nome" [--close] [--keep-losers]\n     yard floor compare\n     yard floor fanout "Nome" --prompt "pedido" [--agents claude,codex]\n',
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
      const r = applyScore(score, ctx.groupId);
      return ok(
        `Partitura "${name}" aplicada neste grupo: ${r.terminals} terminal(is) ` +
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
    sendNotification({
      title: `Yard — ${ctx.nameOf.get(ctx.caller.id)}`,
      body: msg,
    });
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
  yard ask --batch '{"A":"p1","B":"p2"}'       vários em paralelo
  yard ask … --timeout 600                     segundos de espera
  yard check "Agente"                          lê a tela atual do agente
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
  yard recruit "Nome" --floor "Andar"          novo agente no canvas do andar
  yard recruit "Nome" --replace "Antigo"       troca o processo do cartão
  yard dismiss "Nome"                          encerra e remove um conectado
  yard floor list                              chão e andares do projeto
  yard floor create "Nome" [--branch x] [--existing-branch] [--no-git] [--copy-ground]
                                               andar novo (git worktree isolado)
  yard floor land "Nome" [--close] [--keep-losers]
                                               merge no chão; --close encerra o andar
  yard floor compare                           diffstat de cada andar vs o chão
  yard floor fanout "Nome" --prompt "…" [--agents a,b]
                                               um pedido, N andares, um agente cada
  yard role show ["Agente"] | role set "Agente" "texto|papel salvo"
  yard role create|edit "Papel" "texto" [--scope global|current]
  yard role list | role delete "Papel"         biblioteca de papéis
  yard routine list                            prompts agendados do grupo
  yard routine create "Agente" "prompt" --every 30 [--once]
  yard routine pause|resume|delete <id>
  yard flow list                               fluxos (correntes de agentes) do grupo
  yard flow run "Fluxo" "tarefa"               dispara a corrente etapa por etapa
  yard flow stage                              briefing da etapa em execução NESTA CLI
  yard flow status ["Fluxo"] | flow cancel "Fluxo"
  yard score save "Nome" [--force] | score list | score apply "Nome"
  yard notify "mensagem"                       notificação nativa ao usuário
  yard debug                                   diagnóstico da ponte

Comunicação exige conexão desenhada no canvas (ou criada por connect/recruit).
Notas travadas pelo usuário recusam escrita — peça a mudança a ele.
Use \`--\` para mandar texto que começa com \`-\`: yard ask "A" -- --raw
`;
