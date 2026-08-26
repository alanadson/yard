/**
 * The "Ombro" (Shoulder) digest — what an agent did, read from its session
 * after the fact.
 *
 * The overlay ("Ao Vivo") answers *what is it doing now*; this answers *what
 * happened while I was not looking*, for every agent of a group at once. The
 * files, the plan and the usage come out of the same reducer the overlay
 * uses (`liveModel.ts`), so the two never disagree on a count; the few
 * numbers only a summary needs — turns, last words, commands, failures —
 * are counted here.
 */
import { t, tn } from "./i18n";
import type { FeedEvent } from "./ipc";
import { emptyFeedModel, localIds, reduceFeed, type LiveUsage } from "./liveModel";

export interface DigestFile {
  path: string;
  edits: number;
  writes: number;
  reads: number;
}

export interface SessionDigest {
  /** User turns — one per prompt typed (or injected) into the CLI. */
  turns: number;
  lastPrompt: string | null;
  /** First line of the last thing the assistant *said* (thinking excluded). */
  lastSay: string | null;
  /** Epoch ms of the last event with a timestamp; 0 when none. */
  lastAt: number;
  /** Sorted by touches, most touched first. */
  files: DigestFile[];
  /** Shell commands run (`op === "run"`). */
  commands: number;
  /** Sub-agents launched. */
  agents: number;
  /** Progress of the last plan the CLI wrote; null without a plan. */
  plan: { done: number; total: number } | null;
  /** Cumulative usage; null until the session reports any. */
  usage: LiveUsage | null;
  /** Tool calls whose result came back as an error. */
  failures: number;
}

/** A summary shows an opening line, not a paragraph. */
const SAY_CAP = 140;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > SAY_CAP ? `${trimmed.slice(0, SAY_CAP - 1)}…` : trimmed;
}

export function digest(events: readonly FeedEvent[]): SessionDigest {
  // The shared reducer, with no timeline cap: a digest of a long session must
  // see every file, not the last four hundred entries.
  const model = reduceFeed(emptyFeedModel(), events, localIds(), Infinity);

  let turns = 0;
  let lastPrompt: string | null = null;
  let lastSay: string | null = null;
  let commands = 0;
  let agents = 0;
  let failures = 0;
  let sawUsage = false;
  for (const ev of events) {
    switch (ev.kind) {
      case "prompt":
        turns++;
        lastPrompt = ev.text ?? lastPrompt;
        break;
      case "say":
        if (ev.text?.trim()) lastSay = firstLine(ev.text);
        break;
      case "tool":
        if (ev.op === "run") commands++;
        else if (ev.op === "agent") agents++;
        break;
      case "result":
        if (ev.ok === false) failures++;
        break;
      case "usage":
        sawUsage = true;
        break;
      default:
        break;
    }
  }

  const files: DigestFile[] = Object.values(model.files)
    .map((f) => ({ path: f.path, edits: f.edits, writes: f.writes, reads: f.reads }))
    .sort((a, b) => touches(b) - touches(a) || a.path.localeCompare(b.path));

  let plan: SessionDigest["plan"] = null;
  if (model.todos.length > 0) {
    plan = {
      done: model.todos.filter((t) => t.status === "completed").length,
      total: model.todos.length,
    };
  } else {
    const cards = Object.values(model.plan);
    if (cards.length > 0) {
      plan = { done: cards.filter((c) => c.status === "completed").length, total: cards.length };
    }
  }

  return {
    turns,
    lastPrompt,
    lastSay,
    lastAt: model.lastEventAt,
    files,
    commands,
    agents,
    plan,
    usage: sawUsage ? model.usage : null,
    failures,
  };
}

function touches(f: DigestFile): number {
  return f.edits + f.writes + f.reads;
}

/** One sentence for a card: `12 turnos · 5 arquivos · último: “ok, testes verdes”`. */
export function digestLine(d: SessionDigest): string {
  if (d.turns === 0 && d.files.length === 0 && !d.lastSay) return t("sem turnos ainda");
  const parts = [tn(d.turns, "{n} turno", "{n} turnos")];
  if (d.files.length > 0) parts.push(tn(d.files.length, "{n} arquivo", "{n} arquivos"));
  if (d.lastSay) parts.push(t("último: “{say}”", { say: d.lastSay }));
  return parts.join(" · ");
}
