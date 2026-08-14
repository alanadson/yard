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
  on,
  type BridgeRequest,
  type BridgeResponse,
  type PtySnapshot,
} from "./ipc";
import { uiLog } from "./log";
import { closeTerminal, disposePty } from "./lifecycle";
import { applyScore, readScore, saveScore, serializeGroup } from "./scores";
import type { FloorMeta } from "./floors";
import { useProjects } from "../stores/projectsStore";
import { getActivity, useTerminals } from "../stores/terminalsStore";
import {
  autoNodeRect,
  CANVAS_EXTERNAL_WRITE,
  EMPTY_CANVAS,
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  noteName,
  PORTAL_DEFAULT_H,
  PORTAL_DEFAULT_W,
  type CanvasData,
  type CanvasNode,
  type RoutineDef,
} from "./canvas";
import {
  addItems,
  connection,
  isConnected,
  patchItemOfType,
  removeItemAndEdges,
  removeNodeAndEdges,
  setEntry,
} from "./canvasOps";
import {
  connectedAgents,
  connectedNotes,
  connectedPortals,
  decodeEscapes,
  findAgent,
  findAny,
  findNote,
  findPortal,
  makeCtx,
  parseFlags,
  stripAnsi,
  tail,
  type Ctx,
  type NoteItem,
} from "./bridgeCore";
import { normalizePortalUrl, portalName, resolveUa, UA_PRESET_IDS } from "./portals";
import {
  checkJs,
  clickJs,
  fillJs,
  focusJs,
  hoverJs,
  HTML_JS,
  INFO_JS,
  keyJs,
  LOGS_JS,
  LOGS_START_JS,
  scrollIntoViewJs,
  scrollJs,
  selectJs,
  SNAPSHOT_JS,
  textJs,
  typeJs,
} from "./portalDriver";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the bridge listener. Returns the teardown (for App unmount). */
export function startBridge(): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void on
    .bridgeRequest(async ({ id, request }) => {
      let res: BridgeResponse;
      try {
        res = await handle(request);
      } catch (e) {
        res = { code: 1, output: `yard: erro interno: ${e}\n` };
      }
      void ipc.bridgeRespond(id, res).catch(() => {});
    })
    .then((u) => {
      if (stopped) u();
      else unlisten = u;
    });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

// ---------------------------------------------------------------------------
// canvas writes that did not come from the user
// ---------------------------------------------------------------------------

/**
 * Applies a canvas change made by an agent (or a routine) and notifies the
 * UI. The notice exists because of undo: without it, the user's `Ctrl+Z`
 * would undo the note the agent just wrote.
 */
export function commitCanvasExternal(
  groupId: string,
  fn: (c: CanvasData) => CanvasData,
) {
  useProjects.getState().updateCanvas(groupId, fn);
  window.dispatchEvent(new CustomEvent(CANVAS_EXTERNAL_WRITE, { detail: { groupId } }));
}

/**
 * Delivers a prompt to a terminal as if the user had pasted and hit
 * Enter.
 *
 * The bracketed-paste markers are what keep a multi-line prompt from
 * becoming N submits: the agent gets the whole block and only then the
 * separate `\r` (the pause gives the CLI time to process the paste).
 */
export async function injectPrompt(
  terminalId: string,
  text: string,
  opts?: { raw?: boolean },
): Promise<void> {
  if (opts?.raw) {
    await ipc.writePty(terminalId, decodeEscapes(text));
    return;
  }
  if (text.includes("\n")) {
    await ipc.writePty(terminalId, `\x1b[200~${text}\x1b[201~`);
  } else {
    await ipc.writePty(terminalId, text);
  }
  await sleep(150);
  await ipc.writePty(terminalId, "\r");
}

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

function commitCanvas(groupId: string, fn: (c: CanvasData) => CanvasData) {
  commitCanvasExternal(groupId, fn);
}

/**
 * Where the caller's card sits, so whatever the CLI creates lands next to it
 * instead of at the origin. A terminal that was never dragged has no entry in
 * `nodes` and falls back to its computed slot.
 */
function callerRect(ctx: Ctx): CanvasNode {
  return (
    ctx.canvas.nodes[ctx.caller.id] ??
    autoNodeRect(ctx.terminals.findIndex((t) => t.id === ctx.caller.id))
  );
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
  });
  useProjects.getState().updateTerminal(id, { alive: true });
  return snap;
}

const SPAWN_ROWS = 38;
const SPAWN_COLS = 120;

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const ok = (output: string): BridgeResponse => ({ code: 0, output });
const err = (output: string): BridgeResponse => ({ code: 1, output });

async function handle(req: BridgeRequest): Promise<BridgeResponse> {
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
    case "score":
      return cmdScore(ctx, argv.slice(1));
    case "notify":
      return cmdNotify(ctx, argv.slice(1));
    case "debug":
      return cmdDebug(ctx);
    case "portal":
      return cmdPortal(ctx, argv.slice(1));
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

  let out = `You: "${me}"${myRole ? ` — papel: ${myRole}` : ""}\n`;

  const agents = connectedAgents(ctx);
  out += "Agentes conectados:\n";
  if (agents.length === 0) {
    out +=
      "  (nenhum — peça ao usuário para desenhar uma conexão no canvas,\n" +
      "   ou use `yard connect` / `yard recruit`)\n";
  }
  for (const t of agents) {
    const state = rt[t.id]?.state ?? "idle";
    const role = roles[t.id];
    out += `  - "${ctx.nameOf.get(t.id)}" [${state}]${role ? ` papel: ${role}` : ""}\n`;
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

  const minhas = (ctx.canvas.routines ?? []).filter((r) => r.enabled);
  if (minhas.length) {
    out += `Rotinas ativas no grupo: ${minhas.length} (\`yard routine list\`)\n`;
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

  const before = await ipc.attachPty(target.id);
  if (!before.alive) {
    return err(
      `yard: "${name}" não está rodando (processo ${before.exit?.reason ?? "parado"}). ` +
        "Peça ao usuário para retomá-lo.\n",
    );
  }
  const baseline = before.data.length;
  const t0 = Date.now();

  await injectPrompt(target.id, prompt, { raw: flags.raw });

  if (flags.noWait) return ok(`enviado para "${ctx.nameOf.get(target.id)}".\n`);

  // Wait for "finished": there was new output and then silence (or the
  // agent detector's idle signal, or the process exited).
  let lastLen = baseline;
  let grew = false;
  let quiet = 0;
  while (Date.now() - t0 < flags.timeoutMs) {
    await sleep(2000);
    const att = await ipc.attachPty(target.id);
    if (!att.alive) break;
    if (att.data.length > lastLen) {
      lastLen = att.data.length;
      grew = true;
      quiet = 0;
    } else if (grew) {
      quiet++;
    }
    const rt = useTerminals.getState().byId[target.id];
    if (grew && rt?.finished && getActivity(target.id).lastByteAt >= t0) break;
    if (grew && quiet >= 3) break; // ~6 s without a new byte
  }

  const after = await ipc.attachPty(target.id);
  const delta =
    after.data.length >= baseline ? after.data.slice(baseline) : after.data;
  const clean = stripAnsi(delta).trim();
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
  const att = await ipc.attachPty(target.id);
  const clean = stripAnsi(att.data).trim();
  const lines = clean.split("\n");
  const view = lines.slice(-60).join("\n");
  const state = att.alive ? "rodando" : `parado (${att.exit?.reason ?? "?"})`;
  return ok(`[${ctx.nameOf.get(target.id)} — ${state}]\n${tail(view, 8_000)}\n`);
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
      const lines = note.text.split("\n");
      const start = Math.max(1, Number(rest[1]) || 1);
      const count = Math.max(1, Number(rest[2]) || lines.length);
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
        const conteudo = p.fromStdin ? req.stdin : p.positional[0];
        if (conteudo == null) {
          return err(
            'uso: yard note write "Nome" "conteúdo"\n' +
              '     yard note write "Nome" --file texto.md   (multi-linha)\n',
          );
        }
        nextText = conteudo;
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
  const ea = findAny(ctx, a);
  const eb = findAny(ctx, b);
  if (!ea) return err(`yard: não achei "${a}" neste grupo.\n`);
  if (!eb) return err(`yard: não achei "${b}" neste grupo.\n`);
  if (ea.id === eb.id) return err("yard: os dois lados são a mesma coisa.\n");
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
  const roleText = role ? await resolveRoleText(ctx, role) : undefined;

  if (replace) return replaceCard(ctx, replace, { name, program, cliArgs, kind, rowAgentId, dir, roleText });

  if (floorName) {
    return recruitInFloor(ctx, floorName, { name, program, cliArgs, kind, rowAgentId, dir, roleText });
  }

  const cwd = dir ?? ctx.caller.cwd;
  const s = useProjects.getState();
  const newId = s.addTerminal({
    groupId: ctx.groupId,
    title: name,
    kind: kind as "shell" | "agent",
    agentId: rowAgentId,
    program,
    args: cliArgs,
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
    roles: roleText ? { ...(c.roles ?? {}), [newId]: roleText } : c.roles,
  }));

  try {
    await spawnCard(newId, { program, args: cliArgs, cwd, kind, title: name });
  } catch (e) {
    return err(
      `yard: terminal "${name}" criado no canvas, mas o processo não subiu: ${e}\n`,
    );
  }
  return ok(
    `Recrutado "${name}"${roleText ? ` (papel: ${roleText})` : ""} — conectado a você. ` +
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
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    if (!(await ipc.ptyExists(id).catch(() => false))) return true;
    await sleep(80);
  }
  return false;
}

async function replaceCard(
  ctx: Ctx,
  alvoNome: string,
  novo: {
    name: string;
    program: string;
    cliArgs: string[];
    kind: string;
    rowAgentId: string | null;
    dir?: string;
    roleText?: string;
  },
): Promise<BridgeResponse> {
  const alvo =
    findAgent(ctx, alvoNome) ??
    ctx.terminals.find(
      (t) => ctx.nameOf.get(t.id)!.toLowerCase() === alvoNome.trim().toLowerCase(),
    ) ??
    null;
  if (!alvo) {
    return err(
      `yard: não achei "${alvoNome}" neste grupo para substituir. ` +
        "Rode `yard list` para ver os nomes.\n",
    );
  }
  const cwd = novo.dir ?? alvo.cwd;
  const s = useProjects.getState();

  await disposePty(alvo.id);
  // `kill` only signals: the id stays in the Rust registry until the reader
  // thread sees EOF and cleans up. Spawning before that dies with "pty ja
  // esta rodando" — the same reason `pty::restart` waits on the other side.
  if (!(await waitPtyGone(alvo.id))) {
    return err(
      `yard: o processo de "${alvoNome}" não encerrou a tempo; o cartão está intacto. Tente de novo.\n`,
    );
  }
  s.updateTerminal(alvo.id, {
    title: novo.name,
    kind: novo.kind as "shell" | "agent",
    agentId: novo.rowAgentId,
    program: novo.program,
    args: novo.cliArgs,
    cwd,
    resume: null,
    alive: false,
  });

  try {
    const snap = await spawnCard(alvo.id, {
      program: novo.program,
      args: novo.cliArgs,
      cwd,
      kind: novo.kind,
      title: novo.name,
    });
    // The view was already mounted when the PTY died; without this the card
    // would stay marked "encerrado" until the first activity.
    useTerminals.getState().markRunning(alvo.id, snap.pid);
  } catch (e) {
    return err(
      `yard: o cartão de "${alvoNome}" já aponta para "${novo.name}", mas o processo não subiu: ${e}. ` +
        "Peça ao usuário para apertar ▶ no cartão.\n",
    );
  }

  // Without `--role` the canvas does not change at all: node and connections
  // are the same, and the new title already came through `updateTerminal`.
  if (novo.roleText) {
    commitCanvas(ctx.groupId, (c) => ({
      ...c,
      roles: { ...(c.roles ?? {}), [alvo.id]: novo.roleText! },
    }));
  }
  return ok(
    `Cartão de "${alvoNome}" agora roda "${novo.name}" — posição, conexões e papel preservados.\n`,
  );
}

async function cmdDismiss(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const name = args[0];
  if (!name) return err('uso: yard dismiss "Nome"\n');
  const target = findAgent(ctx, name);
  if (!target) {
    return err(`yard: "${name}" não está conectado a você (só é possível dispensar conexões diretas).\n`);
  }
  await closeTerminal(target.id);
  commitCanvas(ctx.groupId, (c) => removeNodeAndEdges(c, target.id));
  return ok(`"${ctx.nameOf.get(target.id)}" dispensado.\n`);
}

// --- floor ------------------------------------------------------------------

/** Group in the caller's project whose name matches (case-insensitive). */
function findGroupByName(projectId: string, name: string) {
  const s = useProjects.getState();
  const q = name.trim().toLowerCase();
  return s.groupsOf(projectId).find((g) => g.name.toLowerCase() === q) ?? null;
}

/**
 * `recruit --floor`: the new card is born on the floor's canvas, with the
 * worktree's cwd, without pulling the caller off the ground. No cable: a
 * connection only lives inside its own group's canvas (cross-floor comes later).
 */
async function recruitInFloor(
  ctx: Ctx,
  floorName: string,
  novo: {
    name: string;
    program: string;
    cliArgs: string[];
    kind: string;
    rowAgentId: string | null;
    dir?: string;
    roleText?: string;
  },
): Promise<BridgeResponse> {
  const s = useProjects.getState();
  const project = s.projectOfGroup(ctx.groupId);
  if (!project) return err("yard: o grupo deste terminal não pertence a um projeto.\n");
  const alvo = findGroupByName(project.id, floorName);
  if (!alvo) {
    return err(
      `yard: não achei o andar "${floorName}" neste projeto. Rode \`yard floor list\`.\n`,
    );
  }
  const cwd = novo.dir ?? s.rootOfGroup(alvo.id) ?? ctx.caller.cwd;

  const idx = s.terminalsOf(alvo.id).length;
  const newId = s.addTerminal({
    groupId: alvo.id,
    title: novo.name,
    kind: novo.kind as "shell" | "agent",
    agentId: novo.rowAgentId,
    program: novo.program,
    args: novo.cliArgs,
    cwd,
  });
  commitCanvasExternal(alvo.id, (c) => ({
    ...c,
    nodes: { ...c.nodes, [newId]: autoNodeRect(idx) },
    roles: novo.roleText ? { ...(c.roles ?? {}), [newId]: novo.roleText } : c.roles,
  }));

  try {
    await spawnCard(newId, {
      program: novo.program,
      args: novo.cliArgs,
      cwd,
      kind: novo.kind,
      title: novo.name,
    });
  } catch (e) {
    return err(
      `yard: "${novo.name}" foi criado no andar "${alvo.name}", mas o processo não subiu: ${e}\n`,
    );
  }
  return ok(
    `Recrutado "${novo.name}" no andar "${alvo.name}" (cwd: ${cwd}). ` +
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
      const vivos = s.terminalsOf(g.id).filter((t) => t.alive).length;
      const tag =
        floor?.kind === "isolated"
          ? ` [branch ${floor.branch ?? "?"}]`
          : floor?.kind === "plain"
            ? " [sem git]"
            : i === 0
              ? " [chão]"
              : "";
      const aqui = g.id === ctx.groupId ? "  ← você" : "";
      out += `  - "${g.name}"${tag} — ${vivos} vivo(s)${aqui}\n`;
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
    if (findGroupByName(project.id, name)) {
      return err(`yard: já existe um grupo/andar chamado "${name}" neste projeto.\n`);
    }
    if (existing && !branch) {
      return err("yard: --existing-branch exige --branch com o nome da branch.\n");
    }

    let prov;
    try {
      prov = await ipc.worktreeProvision({
        projectPath: project.path,
        name,
        branch: branch ?? null,
        existingBranch: existing,
        noGit,
      });
    } catch (e) {
      return err(`yard: não consegui provisionar o andar: ${e}\n`);
    }

    const floor: FloorMeta =
      prov.kind === "isolated"
        ? { kind: "isolated", branch: prov.branch ?? undefined, worktreePath: prov.path }
        : { kind: "plain" };
    // Silent creation: the new group does NOT become the active group on screen.
    const gid = s.addGroup(project.id, name, { activate: false, layout: { floor } });

    if (copyGround) {
      const chao = s
        .groupsOf(project.id)
        .filter((g) => g.id !== gid)
        .sort((a, b) => a.sort - b.sort)[0];
      if (chao) {
        applyScore(serializeGroup(chao.id, name), gid, {
          cwd: prov.kind === "isolated" ? prov.path : project.path,
        });
      }
    }

    return ok(
      prov.kind === "isolated"
        ? `Andar "${name}" criado: branch ${prov.branch}, worktree em ${prov.path}.` +
            `${copyGround ? " Layout do chão clonado (terminais parados)." : ""}\n`
        : `Andar "${name}" criado SEM git (projeto sem repositório ou --no-git): ` +
            `os terminais dele usam o mesmo diretório do chão.\n`,
    );
  }

  return err('uso: yard floor create "Nome" [--branch x] [--existing-branch] [--no-git] [--copy-ground]\n     yard floor list\n');
}

// --- role and role presets ------------------------------------------------

const PRESETS_KEY = "rolePresets";

async function readGlobalPresets(): Promise<Record<string, string>> {
  try {
    const kv = await ipc.readPrefs();
    const parsed = JSON.parse(kv[PRESETS_KEY] ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** A preset by name: group scope first, then global. */
async function resolvePreset(ctx: Ctx, name: string): Promise<string | null> {
  const q = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(ctx.canvas.rolePresets ?? {})) {
    if (k.toLowerCase() === q) return v;
  }
  for (const [k, v] of Object.entries(await readGlobalPresets())) {
    if (k.toLowerCase() === q) return v;
  }
  return null;
}

/** Role text: if it matches a preset, expand; otherwise treat as literal. */
async function resolveRoleText(ctx: Ctx, textoOuPreset: string): Promise<string> {
  return (await resolvePreset(ctx, textoOuPreset)) ?? textoOuPreset;
}

async function cmdRole(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase();
  const roles = ctx.canvas.roles ?? {};

  if (sub === "show" || sub == null) {
    const name = args[1];
    if (!name) {
      const label = ctx.nameOf.get(ctx.caller.id)!;
      return ok(
        roles[ctx.caller.id]
          ? `${label}: ${roles[ctx.caller.id]}\n`
          : `${label}: (sem papel)\n`,
      );
    }
    const alvo = findAgent(ctx, name);
    if (alvo) {
      const label = ctx.nameOf.get(alvo.id)!;
      return ok(roles[alvo.id] ? `${label}: ${roles[alvo.id]}\n` : `${label}: (sem papel)\n`);
    }
    // Not a connected agent: maybe it is the name of a preset.
    const preset = await resolvePreset(ctx, name);
    if (preset) return ok(`preset "${name}":\n${preset}\n`);
    return err(`yard: "${name}" não está conectado a você e não é um preset.\n`);
  }

  if (sub === "set") {
    const [, name, text] = args;
    if (!name || text == null) {
      return err('uso: yard role set "Agente" "texto ou nome de preset"\n');
    }
    const isSelf = ctx.nameOf.get(ctx.caller.id)!.toLowerCase() === name.trim().toLowerCase();
    const id = isSelf ? ctx.caller.id : (findAgent(ctx, name)?.id ?? null);
    if (!id) return err(`yard: "${name}" não está conectado a você.\n`);
    const final = await resolveRoleText(ctx, text);
    commitCanvas(ctx.groupId, (c) => ({
      ...c,
      roles: { ...(c.roles ?? {}), [id]: final },
    }));
    return ok(
      `Papel de "${ctx.nameOf.get(id)}" definido${final !== text ? ` a partir do preset "${text}"` : ""}.\n`,
    );
  }

  if (sub === "list") {
    const local = ctx.canvas.rolePresets ?? {};
    const global = await readGlobalPresets();
    let out = "Presets de papel:\n";
    const linhas = [
      ...Object.keys(local).map((k) => ({ k, escopo: "current", texto: local[k] })),
      ...Object.keys(global)
        .filter((k) => !(k in local))
        .map((k) => ({ k, escopo: "global", texto: global[k] })),
    ];
    if (!linhas.length) {
      out += '  (nenhum — crie com `yard role create "Nome" "texto"`)\n';
    }
    for (const l of linhas) {
      out += `  - "${l.k}" [${l.escopo}] ${l.texto.split("\n")[0].slice(0, 60)}\n`;
    }
    return ok(out);
  }

  if (sub === "create" || sub === "write" || sub === "edit") {
    const p = parseFlags(args.slice(1), { "--scope": "string" });
    const pedido = p.string.scope?.toLowerCase();
    const escopo: "current" | "global" = pedido === "current" ? "current" : "global";
    const [name, text] = p.positional;
    if (!name || text == null) {
      return err(
        `uso: yard role ${sub} "Nome do preset" "texto" [--scope global|current]\n`,
      );
    }
    if (sub === "edit" && !(await resolvePreset(ctx, name))) {
      return err(`yard: preset "${name}" não existe — use \`role create\`.\n`);
    }
    if (escopo === "current") {
      commitCanvas(ctx.groupId, (c) => ({
        ...c,
        rolePresets: { ...(c.rolePresets ?? {}), [name]: text },
      }));
    } else {
      const todos = await readGlobalPresets();
      todos[name] = text;
      await ipc.writePref(PRESETS_KEY, JSON.stringify(todos));
    }
    return ok(`Preset "${name}" salvo (escopo ${escopo}).\n`);
  }

  if (sub === "delete") {
    const name = args[1];
    if (!name) return err('uso: yard role delete "Nome do preset"\n');
    let achou = false;
    if (ctx.canvas.rolePresets?.[name] != null) {
      achou = true;
      commitCanvas(ctx.groupId, (c) => ({
        ...c,
        rolePresets: setEntry(c.rolePresets, name, undefined),
      }));
    }
    const todos = await readGlobalPresets();
    if (name in todos) {
      achou = true;
      delete todos[name];
      await ipc.writePref(PRESETS_KEY, JSON.stringify(todos));
    }
    return achou
      ? ok(`Preset "${name}" removido.\n`)
      : err(`yard: preset "${name}" não existe.\n`);
  }

  return err(
    'uso: yard role show ["Agente"] | role set "Agente" "texto|preset"\n' +
      '     yard role create|edit|write "Preset" "texto" [--scope global|current]\n' +
      "     yard role list | role delete \"Preset\"\n",
  );
}

// --- routine ----------------------------------------------------------------

function cmdRoutine(ctx: Ctx, args: string[], req: BridgeRequest): BridgeResponse {
  const sub = args[0]?.toLowerCase() ?? "list";
  const routines = ctx.canvas.routines ?? [];
  const nomeDoAlvo = (id: string) => ctx.nameOf.get(id) ?? "(removido)";

  if (sub === "list") {
    if (!routines.length) {
      return ok(
        'Nenhuma rotina neste grupo. Crie com:\n  yard routine create "Agente" "prompt" --every 30\n',
      );
    }
    let out = "Rotinas do grupo:\n";
    for (const r of routines) {
      const quando = r.once ? `uma vez em ${r.everyMin} min` : `a cada ${r.everyMin} min`;
      const ultimo = r.lastRunAt
        ? ` último: ${new Date(r.lastRunAt).toLocaleTimeString()}`
        : "";
      out +=
        `  [${r.id}] "${nomeDoAlvo(r.terminalId)}" ${quando}` +
        `${r.enabled ? "" : " (pausada)"}${ultimo}\n      ${r.text.split("\n")[0].slice(0, 70)}\n`;
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
    const everyMin = p.number.every && p.number.every > 0 ? p.number.every : 30;
    const once = !!p.bool.once;
    const [alvoNome, textoPos] = p.positional;
    const text = p.fromStdin ? (req.stdin ?? "") : textoPos;
    if (!alvoNome || !text) {
      return err(
        'uso: yard routine create "Agente" "prompt" [--every 30] [--once]\n' +
          "     (o alvo pode ser você mesmo; --file/--stdin para prompt longo)\n",
      );
    }
    const isSelf =
      ctx.nameOf.get(ctx.caller.id)!.toLowerCase() === alvoNome.trim().toLowerCase();
    const alvo = isSelf ? ctx.caller : findAgent(ctx, alvoNome);
    if (!alvo) return err(`yard: "${alvoNome}" não está conectado a você.\n`);
    const nova: RoutineDef = {
      id: nanoid(6),
      terminalId: alvo.id,
      text,
      everyMin,
      enabled: true,
      once,
      createdAt: Date.now(),
    };
    commitCanvas(ctx.groupId, (c) => ({ ...c, routines: [...(c.routines ?? []), nova] }));
    return ok(
      `Rotina [${nova.id}] criada para "${ctx.nameOf.get(alvo.id)}" ` +
        `${once ? `daqui a ${everyMin} min (uma vez)` : `a cada ${everyMin} min`}. ` +
        "Só dispara com o terminal rodando e ocioso.\n",
    );
  }

  if (sub === "delete" || sub === "pause" || sub === "resume") {
    const id = args[1];
    const alvo = routines.find((r) => r.id === id);
    if (!alvo) return err(`yard: rotina "${id ?? ""}" não existe (\`routine list\`).\n`);
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

// --- score (arrangements) -----------------------------------------------------

async function cmdScore(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = args[0]?.toLowerCase() ?? "list";
  if (sub === "list") {
    const todas = await ipc.scoreList();
    if (!todas.length) return ok('Nenhuma partitura salva (`yard score save "Nome"`).\n');
    let out = "Partituras:\n";
    for (const s of todas) {
      out += `  - "${s.name}" (${new Date(s.updatedAt).toLocaleString()})\n`;
    }
    return ok(out);
  }
  if (sub === "save") {
    const name = args[1];
    if (!name) return err('uso: yard score save "Nome"\n');
    try {
      const path = await saveScore(ctx.groupId, name);
      return ok(`Partitura "${name}" salva em ${path}\n`);
    } catch (e) {
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

// --- portal -----------------------------------------------------------------

function portalMiss(ctx: Ctx, name?: string): string {
  const names = connectedPortals(ctx).map((p) => `"${ctx.portalNameOf.get(p.id)}"`);
  return (
    `yard: portal "${name ?? ""}" nao esta conectado a voce.` +
    (names.length ? ` Disponiveis: ${names.join(", ")}.` : " Nenhum portal conectado.") +
    "\n"
  );
}

async function ensurePortalOpen(p: {
  id: string;
  url: string;
  engine?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ua?: string;
  storage?: "instance" | "workspace" | "global";
  muted?: boolean;
}): Promise<void> {
  const projectId = useProjects.getState().activeProjectId;
  await ipc.portalOpen({
    id: p.id,
    url: p.url,
    engine: p.engine ?? "webview2",
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    ua: p.ua ?? null,
    storage: p.storage ?? "instance",
    muted: p.muted ?? false,
    projectId,
  });
}

async function evalPortal(id: string, js: string): Promise<string> {
  return ipc.portalEval(id, js);
}

async function cmdPortal(ctx: Ctx, args: string[]): Promise<BridgeResponse> {
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1);

  if (sub === "create") {
    const p = parseFlags(rest, { "--engine": "string", "--size": "string" });
    const engine = p.string.engine;
    let size: { w: number; h: number } | undefined;
    if (p.string.size != null) {
      const m = p.string.size.match(/^(\d+)x(\d+)$/i);
      if (!m) return err("yard: --size espera WxH (ex.: 390x844)\n");
      size = { w: Number(m[1]), h: Number(m[2]) };
    }
    const urlRaw = p.positional[0];
    if (!urlRaw) {
      return err(
        'uso: yard portal create URL ["Nome"] [--engine webview2|chrome|firefox|…] [--size WxH]\n',
      );
    }
    const href = normalizePortalUrl(urlRaw);
    const name = p.positional[1];
    const id = nanoid(8);
    const base = callerRect(ctx);
    const uaFromEngine =
      engine && engine !== "webview2" ? resolveUa(engine) : undefined;
    const item = {
      id,
      type: "portal" as const,
      x: base.x + base.w + 48,
      y: base.y + connectedPortals(ctx).length * 28,
      w: size?.w ?? PORTAL_DEFAULT_W,
      h: size?.h ?? PORTAL_DEFAULT_H,
      url: href,
      color: "#f5f5f5",
      engine: "webview2",
      ...(uaFromEngine ? { ua: uaFromEngine } : {}),
      ...(name ? { name } : {}),
    };
    commitCanvas(ctx.groupId, (c) =>
      addItems(c, item, connection(ctx.caller.id, id)),
    );
    try {
      await ensurePortalOpen(item);
    } catch (e) {
      return err(`yard: portal criado no canvas, mas o motor falhou: ${e}\n`);
    }
    const fresh = makeCtx(
      ctx.caller,
      ctx.groupId,
      useProjects.getState().layoutOf(ctx.groupId).canvas ?? ctx.canvas,
      ctx.terminals,
    );
    return ok(`Portal criado e conectado: "${fresh.portalNameOf.get(id) ?? name ?? portalName(item)}"\n`);
  }

  if (sub === "close") {
    const name = rest[0];
    if (!name) return err('uso: yard portal close "Nome"\n');
    const p = findPortal(ctx, name);
    if (!p) return err(portalMiss(ctx, name));
    void ipc.portalClose(p.id).catch(() => {});
    commitCanvas(ctx.groupId, (c) => removeItemAndEdges(c, p.id));
    return ok(`Portal "${ctx.portalNameOf.get(p.id)}" removido.\n`);
  }

  if (sub === "edit") {
    const name = rest[0];
    let url: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--url") url = rest[++i];
      else if (!url) url = rest[i];
    }
    if (!name || !url) return err('uso: yard portal edit "Nome" --url URL\n');
    const p = findPortal(ctx, name);
    if (!p) return err(portalMiss(ctx, name));
    const href = normalizePortalUrl(url);
    commitCanvas(ctx.groupId, (c) =>
      patchItemOfType(c, p.id, "portal", { url: href }),
    );
    try {
      await ipc.portalNavigate(p.id, href);
    } catch {
      await ensurePortalOpen({ ...p, url: href });
    }
    return ok(`Portal "${ctx.portalNameOf.get(p.id)}" agora em ${href}\n`);
  }

  const name = rest[0];
  if (!name && sub !== "ua" && sub) {
    return err(portalUsage());
  }

  const verbsNeedName = [
    "navigate",
    "info",
    "screenshot",
    "snapshot",
    "click",
    "fill",
    "type",
    "key",
    "hover",
    "focus",
    "select",
    "check",
    "uncheck",
    "scroll",
    "scrollintoview",
    "resize",
    "ua",
    "evaluate",
    "html",
    "text",
    "logs",
    "logs-start",
    "selectall",
    "clear",
  ];
  if (!verbsNeedName.includes(sub)) return err(portalUsage());

  const p = name ? findPortal(ctx, name) : null;
  if (!p) return err(portalMiss(ctx, name));

  const ready = async () => {
    try {
      await ipc.portalInfo(p.id);
    } catch {
      await ensurePortalOpen(p);
    }
  };

  const run = async (js: string): Promise<BridgeResponse> => {
    await ready();
    try {
      const out = await evalPortal(p.id, js);
      if (out === "missing") {
        return err(
          `yard: seletor nao encontrado. Rode \`yard portal snapshot "${ctx.portalNameOf.get(p.id)}"\` de novo.\n`,
        );
      }
      return ok((out.endsWith("\n") ? out : out + "\n"));
    } catch (e) {
      return err(`yard: portal eval falhou: ${e}\n`);
    }
  };

  switch (sub) {
    case "navigate": {
      const url = rest[1];
      if (!url) return err('uso: yard portal navigate "Nome" URL\n');
      const href = normalizePortalUrl(url);
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, p.id, "portal", { url: href }),
      );
      await ready();
      await ipc.portalNavigate(p.id, href);
      return ok(`ok ${href}\n`);
    }
    case "info": {
      await ready();
      const raw = await evalPortal(p.id, INFO_JS);
      return ok(raw.endsWith("\n") ? raw : raw + "\n");
    }
    case "snapshot":
      return run(SNAPSHOT_JS);
    case "click": {
      if (!rest[1]) return err('uso: yard portal click "Nome" @e3|#id|x,y\n');
      return run(clickJs(rest[1]));
    }
    case "fill": {
      if (!rest[1] || rest[2] == null) return err('uso: yard portal fill "Nome" @e2 "valor"\n');
      return run(fillJs(rest[1], rest.slice(2).join(" ")));
    }
    case "type": {
      if (rest[1] == null) return err('uso: yard portal type "Nome" [@e2] "texto"\n');
      const looksSel = rest[1].startsWith("@") || rest[1].startsWith("#") || /^\d+,\d+/.test(rest[1]);
      if (looksSel && rest[2] != null) return run(typeJs(rest[1], rest.slice(2).join(" ")));
      return run(typeJs(undefined, rest.slice(1).join(" ")));
    }
    case "key": {
      if (!rest[1]) return err('uso: yard portal key "Nome" Enter|Tab|ctrl+a\n');
      return run(keyJs(rest[1]));
    }
    case "hover":
      if (!rest[1]) return err('uso: yard portal hover "Nome" @e3\n');
      return run(hoverJs(rest[1]));
    case "focus":
      if (!rest[1]) return err('uso: yard portal focus "Nome" @e2\n');
      return run(focusJs(rest[1]));
    case "select":
      if (!rest[1] || rest[2] == null) return err('uso: yard portal select "Nome" @e5 "Opcao"\n');
      return run(selectJs(rest[1], rest.slice(2).join(" ")));
    case "check":
      if (!rest[1]) return err('uso: yard portal check "Nome" @e6\n');
      return run(checkJs(rest[1], true));
    case "uncheck":
      if (!rest[1]) return err('uso: yard portal uncheck "Nome" @e6\n');
      return run(checkJs(rest[1], false));
    case "scroll": {
      const dir = (rest[1] ?? "down").toLowerCase();
      const amount = Number(rest[2]) || 300;
      const at = rest[3];
      return run(scrollJs(dir, amount, at));
    }
    case "scrollintoview":
      if (!rest[1]) return err('uso: yard portal scrollintoview "Nome" @e10\n');
      return run(scrollIntoViewJs(rest[1]));
    case "resize": {
      const w = Number(rest[1]);
      const h = Number(rest[2]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 160) {
        return err('uso: yard portal resize "Nome" 390 844\n');
      }
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, p.id, "portal", { w, h, viewport: { w, h } }),
      );
      return ok(`viewport: ${w}x${h}\n`);
    }
    case "ua": {
      const preset = rest[1];
      if (!preset) {
        return ok(
          `ua atual: ${p.ua ?? "desktop"}\npresets: ${UA_PRESET_IDS.join(", ")}\n`,
        );
      }
      const resolved = resolveUa(preset);
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, p.id, "portal", { ua: resolved }),
      );
      await ready();
      await ipc.portalSetUa(p.id, resolved ?? null);
      return ok(`ua: ${preset}\n`);
    }
    case "evaluate": {
      const js = rest.slice(1).join(" ");
      if (!js) return err('uso: yard portal evaluate "Nome" "document.title"\n');
      return run(js);
    }
    case "html":
      return run(HTML_JS);
    case "text":
      if (!rest[1]) return err('uso: yard portal text "Nome" @e1\n');
      return run(textJs(rest[1]));
    case "logs-start":
      return run(LOGS_START_JS);
    case "logs":
      return run(LOGS_JS);
    case "screenshot": {
      await ready();
      try {
        const path = await ipc.portalScreenshot(p.id);
        return ok(`${path}\n`);
      } catch (e) {
        return err(`yard: screenshot falhou: ${e}\n`);
      }
    }
    case "selectall":
      return run(
        rest[1]
          ? `(() => { const el = document.querySelector('[data-yard-ref=${JSON.stringify(rest[1])}]') || document.activeElement; if (el && el.select) el.select(); return "ok"; })()`
          : `(() => { const el = document.activeElement; if (el && el.select) el.select(); return "ok"; })()`,
      );
    case "clear":
      return run(
        rest[1] ? fillJs(rest[1], "") : `(() => { const el = document.activeElement; if (el && "value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } return "ok"; })()`,
      );
    default:
      return err(portalUsage());
  }
}

function portalUsage(): string {
  return (
    "uso: yard portal create|edit|close|navigate|snapshot|click|fill|type|key|\n" +
    "             hover|focus|select|check|scroll|resize|ua|screenshot|evaluate|\n" +
    "             html|text|info|logs …  (veja `yard help`)\n"
  );
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
  yard note create ["conteúdo"] [--name "N"]   nota conectada a você
  yard note read "Nota" [início qtd]           lê com números de linha
  yard note write "Nota" "conteúdo"            substitui tudo (--file/--stdin)
  yard note edit "Nota" "antigo" "novo"        troca um trecho
  yard note delete "Nota"                      remove (destrutivo)
  yard connect "A" "B"                         liga agente/nota/portal
  yard portal create URL ["Nome"] [--engine id] [--size WxH]
  yard portal edit "Nome" --url URL            aponta o portal para outra URL
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
  yard role show ["Agente"] | role set "Agente" "texto|preset"
  yard role create|edit "Preset" "texto" [--scope global|current]
  yard role list | role delete "Preset"        presets de papel
  yard routine list                            prompts agendados do grupo
  yard routine create "Agente" "prompt" --every 30 [--once]
  yard routine pause|resume|delete <id>
  yard score save "Nome" | score list | score apply "Nome"
  yard notify "mensagem"                       notificação nativa ao usuário
  yard debug                                   diagnóstico da ponte

Comunicação exige conexão desenhada no canvas (ou criada por connect/recruit).
Notas travadas pelo usuário recusam escrita — peça a mudança a ele.
`;
