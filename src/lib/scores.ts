/**
 * Scores: save and reapply a group's entire arrangement.
 *
 * A score stores what repeats across boards (which CLIs exist, how they
 * are laid out, who talks to whom, the roles, the notes and the drawings)
 * and does **not** store where they ran: absolute `cwd`, ids and live
 * processes. A score is an arrangement of the canvas, and the canvas is the
 * boards (`lib/surface.ts`), so it only ever lands on a board. Applying
 * creates everything stopped (`alive: false`), in the folder the caller
 * names or, failing that, the one the board's last card was given; starting
 * remains the user's decision.
 *
 * The on-disk file lives in Rust (`scores.rs`); the format and id remapping
 * live here.
 */
import { nanoid } from "nanoid";

import { suggestBoardFolder } from "./boardFolder";
import { commitCanvasExternal } from "./canvasWrite";
import { t } from "./i18n";
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
  type CardRole,
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
  // A score is the *board*: its cards, their wires and their roles. The
  // group's tabs are not part of it — they have no position to restore.
  const terminals = s.terminalsOn(groupId, "canvas").map<ScoreTerminal>((t) => ({
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

/** The backend refused because a score with this name is already on disk. */
export const SCORE_EXISTS = "JA_EXISTE:";

export function scoreAlreadyExists(error: unknown): boolean {
  return String(error).includes(SCORE_EXISTS);
}

export async function saveScore(
  groupId: string,
  name: string,
  overwrite = false,
): Promise<string> {
  const score = serializeGroup(groupId, name);
  return ipc.scoreSave(name, JSON.stringify(score, null, 2), overwrite);
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
 * `opts.cwd`: working root of the created terminals; without it, the folder
 * of the board's newest card, which is what two cards in a row usually want.
 *
 * Throws on a project's group: it has no canvas to arrange, and the cards
 * would be tabs with rectangles nobody can see.
 */
export function applyScore(
  score: ScoreFile,
  groupId: string,
  opts?: { cwd?: string },
): ApplyResult {
  const s = useProjects.getState();
  if (!s.isBoard(groupId)) {
    throw new Error(
      t("Uma partitura só se aplica num quadro: ela é um arranjo do canvas, e o canvas são os quadros."),
    );
  }
  const cwd = opts?.cwd ?? suggestBoardFolder(s.terminalsOf(groupId), "");
  const current = s.layoutOf(groupId).canvas ?? EMPTY_CANVAS;
  const hasContent = Object.keys(current.nodes).length > 0 || current.items.length > 0;
  const dx = hasContent ? occupiedRight(current) + 120 : 0;

  const idMap = new Map<string, string>();
  for (const term of score.terminals) {
    const fresh = s.addTerminal({
      groupId,
      title: term.title,
      kind: term.kind,
      agentId: term.agentId,
      program: term.program,
      args: term.args,
      cwd,
    });
    idMap.set(term.key, fresh);
  }
  for (const it of score.canvas.items) idMap.set(it.id, nanoid(8));

  const nodes: Record<string, CanvasNode> = {};
  for (const [oldId, rect] of Object.entries(score.canvas.nodes)) {
    const newValue = idMap.get(oldId);
    if (newValue) nodes[newValue] = { ...rect, x: rect.x + dx };
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

  const roles: Record<string, CardRole> = {};
  for (const [oldId, role] of Object.entries(score.canvas.roles ?? {})) {
    const next = idMap.get(oldId);
    if (next) roles[next] = role;
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


  // External commit: undo keeps whole-canvas snapshots, and a score that lands
  // without pushing one leaves the stack holding the board from before it —
  // so the next `Ctrl+Z`, aimed at something else entirely, would wipe every
  // card the score just brought in.
  commitCanvasExternal(groupId, (c) => ({
    ...c,
    nodes: { ...c.nodes, ...nodes },
    items: [...c.items, ...items],
    roles: { ...(c.roles ?? {}), ...roles },
    routines: [...(c.routines ?? []), ...routines],
    rolePresets: { ...(c.rolePresets ?? {}), ...(score.canvas.rolePresets ?? {}) },
  }));

  return { terminals: score.terminals.length, items: items.length };
}

