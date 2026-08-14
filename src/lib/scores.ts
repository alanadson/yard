/**
 * Scores: save and reapply a group's entire arrangement.
 *
 * A score stores what repeats across projects — which CLIs exist, how they
 * are laid out, who talks to whom, the roles, the notes and the drawings —
 * and does **not** store what belongs to that project: absolute `cwd`, ids
 * and live processes. Applying creates everything stopped (`alive: false`),
 * with the destination project's `cwd`; starting remains the user's decision.
 *
 * The on-disk file lives in Rust (`scores.rs`); the format and id remapping
 * live here.
 */
import { nanoid } from "nanoid";

import { ipc, type PtyKind } from "./ipc";
import { baseName } from "./terminals";
import {
  EMPTY_CANVAS,
  itemBounds,
  normalizeCanvas,
  translateItem,
  type CanvasData,
  type CanvasItem,
  type CanvasNode,
} from "./canvas";
import { useProjects } from "../stores/projectsStore";

export const SCORE_VERSION = 1;

export interface ScoreTerminal {
  /** Terminal id at the origin — only used to rewire connections on the way back. */
  key: string;
  title: string;
  kind: PtyKind;
  agentId: string | null;
  program: string;
  args: string[];
}

export interface ScoreFile {
  v: number;
  name: string;
  savedAt: number;
  /** Origin group name, only as a hint for the user. */
  origin?: string;
  terminals: ScoreTerminal[];
  canvas: CanvasData;
}

/** Serializes the entire group. Does not touch any process. */
export function serializeGroup(groupId: string, name: string): ScoreFile {
  const s = useProjects.getState();
  const group = s.groups.find((g) => g.id === groupId);
  const canvas = s.layoutOf(groupId).canvas ?? EMPTY_CANVAS;
  const terminals = s.terminalsOf(groupId).map<ScoreTerminal>((t) => ({
    key: t.id,
    title: baseName(t),
    kind: t.kind,
    agentId: t.agentId ?? null,
    program: t.program,
    args: t.args,
  }));
  return {
    v: SCORE_VERSION,
    name,
    savedAt: Date.now(),
    origin: group?.name,
    terminals,
    canvas,
  };
}

export async function saveScore(groupId: string, name: string): Promise<string> {
  const score = serializeGroup(groupId, name);
  return ipc.scoreSave(name, JSON.stringify(score, null, 2));
}

export async function readScore(name: string): Promise<ScoreFile> {
  const raw = await ipc.scoreRead(name);
  const parsed = JSON.parse(raw) as Partial<ScoreFile>;
  const canvas = normalizeCanvas(parsed.canvas) ?? {
    ...EMPTY_CANVAS,
    viewport: { ...EMPTY_CANVAS.viewport },
  };
  const terminals = Array.isArray(parsed.terminals)
    ? parsed.terminals.filter(
        (t): t is ScoreTerminal =>
          !!t && typeof t.key === "string" && typeof t.program === "string",
      )
    : [];
  return {
    v: typeof parsed.v === "number" ? parsed.v : SCORE_VERSION,
    name: typeof parsed.name === "string" ? parsed.name : "partitura",
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    origin: typeof parsed.origin === "string" ? parsed.origin : undefined,
    terminals,
    canvas,
  };
}

/** Rightmost edge of what already exists on the canvas, so the score lands beside it. */
function occupiedRight(canvas: CanvasData): number {
  let right = -Infinity;
  for (const n of Object.values(canvas.nodes)) right = Math.max(right, n.x + n.w);
  for (const it of canvas.items) {
    const b = itemBounds(it, (id) => canvas.nodes[id]);
    if (b) right = Math.max(right, b.x + b.w);
  }
  return Number.isFinite(right) ? right : 0;
}

export interface ApplyResult {
  terminals: number;
  items: number;
}

/**
 * Recreates the score inside an existing group.
 *
 * Ids are all new (terminals and items), so applying twice in the same
 * group does not collide; connections are rewired via the old->new map.
 * When the group already has content, the arrangement lands to the right
 * of what exists instead of on top of it.
 *
 * `opts.cwd`: working root of the created terminals. It is how a floor
 * clones the ground's layout — same cards, worktree cwd.
 */
export function applyScore(
  score: ScoreFile,
  groupId: string,
  opts?: { cwd?: string },
): ApplyResult {
  const s = useProjects.getState();
  const project = s.projectOfGroup(groupId);
  const cwd = opts?.cwd ?? project?.path ?? "";
  const atual = s.layoutOf(groupId).canvas ?? EMPTY_CANVAS;
  const jaTem = Object.keys(atual.nodes).length > 0 || atual.items.length > 0;
  const dx = jaTem ? occupiedRight(atual) + 120 : 0;

  const idMap = new Map<string, string>();
  for (const t of score.terminals) {
    const novo = s.addTerminal({
      groupId,
      title: t.title,
      kind: t.kind,
      agentId: t.agentId,
      program: t.program,
      args: t.args,
      cwd,
    });
    idMap.set(t.key, novo);
  }
  for (const it of score.canvas.items) idMap.set(it.id, nanoid(8));

  const nodes: Record<string, CanvasNode> = {};
  for (const [oldId, rect] of Object.entries(score.canvas.nodes)) {
    const novo = idMap.get(oldId);
    if (novo) nodes[novo] = { ...rect, x: rect.x + dx };
  }

  const items: CanvasItem[] = [];
  for (const it of score.canvas.items) {
    const id = idMap.get(it.id)!;
    if (it.type === "connection") {
      const from = idMap.get(it.from);
      const to = idMap.get(it.to);
      // A connection to something the score did not load becomes junk: drop it.
      if (from && to) items.push({ ...it, id, from, to });
      continue;
    }
    // Only on the X axis: the score lands beside what exists, same height.
    items.push(dx === 0 ? { ...it, id } : translateItem({ ...it, id }, dx, 0));
  }

  const roles: Record<string, string> = {};
  for (const [oldId, role] of Object.entries(score.canvas.roles ?? {})) {
    const novo = idMap.get(oldId);
    if (novo) roles[novo] = role;
  }

  const routines = (score.canvas.routines ?? [])
    .filter((r) => idMap.has(r.terminalId))
    .map((r) => ({
      ...r,
      id: nanoid(8),
      terminalId: idMap.get(r.terminalId)!,
      createdAt: Date.now(),
      lastRunAt: undefined,
    }));

  s.updateCanvas(groupId, (c) => ({
    ...c,
    nodes: { ...c.nodes, ...nodes },
    items: [...c.items, ...items],
    roles: { ...(c.roles ?? {}), ...roles } as Record<string, string>,
    routines: [...(c.routines ?? []), ...routines],
    rolePresets: { ...(c.rolePresets ?? {}), ...(score.canvas.rolePresets ?? {}) },
  }));

  // Without this a new group would open in the automatic grid and the
  // arrangement — positions, notes, arrows — would be invisible: a score
  // only exists on the canvas.
  if (!jaTem) s.updateLayout(groupId, { mode: "canvas" });

  return { terminals: score.terminals.length, items: items.length };
}

