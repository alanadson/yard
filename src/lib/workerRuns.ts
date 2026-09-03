/**
 * Workers as one object for the CLI (`yard worker …`).
 *
 * A worker is a front opened for a task (`FloorMeta.task`) with an agent card
 * inside it: `fanOutTask` makes them, "Nova tarefa" makes them, and until now
 * a caller wanting to drive one had to find the front by name, the terminal
 * inside it, the branch on the floor and the runtime of the card, each with
 * its own command. Here the four are read as one row, with one state, found
 * by one name. Effects (git, PTY, the store) stay in `bridge.ts`; everything
 * here is a function of what it is given.
 */
import type { FloorMeta, FloorTask } from "./floors";
import type { LandPreview } from "./ipc";
import type { TerminalRuntime } from "../stores/terminalsStore";

export type WorkerState =
  | "starting"
  | "working"
  | "done"
  | "blocked"
  | "permission"
  | "stopped"
  | "exited";

export interface WorkerRow {
  groupId: string;
  name: string;
  agentId: string | null;
  branch: string | null;
  worktreePath: string | null;
  /** The card that speaks for the worker, or `null` when it was closed. */
  terminalId: string | null;
  task: FloorTask;
  state: WorkerState;
  /** What it is asking, when `blocked`/`permission`. */
  ask: string | null;
}

/** An isolated front with a task: what `fanOutTask` and "Nova tarefa" make. */
export function isWorkerFloor(floor: FloorMeta | undefined): floor is FloorMeta & { task: FloorTask } {
  return floor?.kind === "isolated" && !!floor.task;
}

/**
 * One word for the runtime mirror, in the order a human asks: is it up, is
 * it waiting on me (and for what), did it finish.
 */
export function workerStateOf(rt: TerminalRuntime | undefined): WorkerState {
  if (!rt || rt.state === "idle") return "stopped";
  if (rt.state === "exited" || rt.state === "error") return "exited";
  if (rt.state === "starting") return "starting";
  if (rt.blocked && rt.permission) return "permission";
  if (rt.blocked) return "blocked";
  if (rt.finished) return "done";
  return "working";
}

/** The agent card of the front; a shell only when there is nothing else. */
export function workerTerminal<T extends { id: string; kind: string }>(
  terminals: readonly T[],
): T | undefined {
  return terminals.find((t) => t.kind === "agent") ?? terminals[0];
}

export interface WorkerSources {
  groups: readonly { id: string; name: string }[];
  floorOf: (groupId: string) => FloorMeta | undefined;
  terminalsOf: (groupId: string) => readonly { id: string; kind: string }[];
  runtimeOf: (terminalId: string) => TerminalRuntime | undefined;
}

export function workerRows(src: WorkerSources): WorkerRow[] {
  const rows: WorkerRow[] = [];
  for (const g of src.groups) {
    const floor = src.floorOf(g.id);
    if (!isWorkerFloor(floor)) continue;
    const card = workerTerminal(src.terminalsOf(g.id));
    const rt = card ? src.runtimeOf(card.id) : undefined;
    rows.push({
      groupId: g.id,
      name: g.name,
      agentId: floor.agentId ?? null,
      branch: floor.branch ?? null,
      worktreePath: floor.worktreePath ?? null,
      terminalId: card?.id ?? null,
      task: floor.task,
      state: workerStateOf(rt),
      ask: rt?.blocked ? (rt.blockedAsk ?? null) : null,
    });
  }
  return rows;
}

/**
 * By name (exact, case-insensitive), by group id, or by a prefix of the
 * name when that prefix names exactly one. An ambiguous prefix finds
 * nothing rather than the wrong one.
 */
export function findWorker(rows: readonly WorkerRow[], query: string): WorkerRow | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = rows.find((r) => r.name.toLowerCase() === q);
  if (exact) return exact;
  const byId = rows.find((r) => r.groupId === query.trim());
  if (byId) return byId;
  const prefixed = rows.filter((r) => r.name.toLowerCase().startsWith(q));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** A kept worker is a plain front from here on: same branch, no task. */
export function keptFloor(floor: FloorMeta): FloorMeta {
  const { task: _task, agentId: _agentId, ...rest } = floor;
  return rest;
}

export function formatWorkerList(rows: readonly WorkerRow[], projectName: string): string {
  if (rows.length === 0) {
    return (
      `Nenhum worker em "${projectName}".\n` +
      '  Crie um com `yard worker create "Nome" --task "pedido"`.\n'
    );
  }
  let out = `Workers de "${projectName}":\n`;
  for (const r of rows) {
    const agent = r.agentId ? ` ${r.agentId}` : "";
    const branch = r.branch ? ` (${r.branch})` : "";
    const ask = r.ask ? ` (pergunta: ${r.ask})` : "";
    out += `  - "${r.name}" [${r.state}]${agent}${branch}${ask}\n`;
  }
  return out;
}

export function formatWorkerInspect(row: WorkerRow): string {
  const when = new Date(row.task.createdAt).toISOString();
  return (
    `Worker "${row.name}" [${row.state}]\n` +
    `  agente: ${row.agentId ?? "?"}\n` +
    `  branch: ${row.branch ?? "?"}\n` +
    `  worktree: ${row.worktreePath ?? "?"}\n` +
    `  cartão: ${row.terminalId ?? "(fechado)"}\n` +
    `  grupo: ${row.groupId}\n` +
    (row.ask ? `  pergunta: ${row.ask}\n` : "") +
    `  criado: ${when}\n` +
    `  tarefa:\n` +
    row.task.prompt
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n") +
    "\n"
  );
}

/** The branch against the ground, the way `apply` will see it. */
export function formatWorkerReview(p: LandPreview): string {
  let out = `${p.floorBranch} vs ${p.groundBranch}:\n`;
  if (p.alreadyMerged) return out + "  já no chão: nada a aplicar.\n";
  if (p.conflictPaths.length) {
    out += `  ${p.conflictPaths.length} conflito(s) previstos; apply vai recusar até resolver:\n`;
    for (const c of p.conflictPaths) out += `    ! ${c}\n`;
  }
  if (p.groundDirty) out += "  o chão tem mudanças não commitadas (apply recusa).\n";
  if (p.floorDirty) out += "  o worktree tem mudanças não commitadas (apply recusa).\n";
  for (const f of p.files) {
    const add = f.additions == null ? "" : ` +${f.additions}`;
    const del = f.deletions == null ? "" : ` -${f.deletions}`;
    out += `  ${f.status.padEnd(9)} ${f.path}${add}${del}\n`;
  }
  out += `  ${p.files.length} arquivo(s), +${p.additions} -${p.deletions}\n`;
  return out;
}

export const WORKER_USAGE =
  'uso: yard worker create "Nome" --task "pedido" [--agent claude|codex|…] [--copy-ground]\n' +
  "     yard worker list [--json]\n" +
  '     yard worker inspect "Nome"\n' +
  '     yard worker wait "Nome" [--until stopped|done|blocked] [--timeout s]\n' +
  '     yard worker send "Nome" "texto" [--queue]      (ou --stdin)\n' +
  '     yard worker review "Nome"                       (a branch contra o chão)\n' +
  '     yard worker apply "Nome" [--keep-front] [--close-siblings]\n' +
  '     yard worker keep "Nome"                         (vira uma frente comum)\n' +
  '     yard worker discard "Nome"                      (fecha a frente, apaga o worktree)\n' +
  '     yard worker stop "Nome"                         (mata o processo, a frente fica)\n';
