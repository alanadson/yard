/**
 * Why an agent went quiet: it **finished**, or it is **waiting on you**.
 *
 * The gap this closes: the only signal the app had was the clock. The reader
 * emits `agent_idle` after 4.5 s of silence (`pty/reader.rs`), and silence is
 * ambiguous by nature — an agent that printed "done, 4 files changed" and an
 * agent stopped at `Do you want to proceed? (y/n)` look identical to a timer.
 * They were the same badge, the same notification and the same position in the
 * `Ctrl+Shift+A` queue, which is exactly backwards: one costs nothing to leave
 * alone, the other is dead time until you walk over.
 *
 * Silence says *that* it stopped; only the text on screen says *why*. So this
 * module reads the tail of the output and answers one question — is the last
 * thing drawn a request for input?
 *
 * Three rules keep it honest:
 *
 * - **Off the hot path.** The tail is accumulated as a raw string (no regex,
 *   no allocation beyond a slice) on every chunk; the expensive part — strip,
 *   split, match — runs once, when the idle event fires. That is once per
 *   agent turn instead of once per frame.
 * - **A miss is cheaper than a false alarm.** A badge that cries "travado"
 *   when the agent is fine teaches the user to ignore the badge, and then the
 *   feature is worse than nothing. Every rule below asks for two independent
 *   signals (a question *and* a selector, a keyword *and* the end of the
 *   line), and when in doubt it returns `null`.
 * - **Conventions, not products.** The patterns describe how terminal UIs ask
 *   things — numbered menus with a cursor, `(y/N)`, a prompt ending in
 *   `Password:` — not what a given CLI ships this month. A per-brand table
 *   would be a table of guesses that rots; these shapes have outlived every
 *   CLI that uses them.
 *
 * Known limit: a TUI that repaints by moving the cursor and rewriting single
 * cells leaves interleaved fragments in the tail, because stripping the escape
 * sequences also throws away the geometry. Full-line repaints — what agent
 * prompts do — survive it.
 */
import { stripTerminalControls } from "./advertised";

/** Which shape fired. Named so a test failure says what regressed. */
export type BlockedRule = "choices" | "yes-no" | "secret" | "press-key";

export interface BlockedAsk {
  /** One line of what it wants: badge tooltip and notification body. */
  ask: string;
  rule: BlockedRule;
}

/**
 * Raw bytes kept per terminal. Two full repaints of a tall pane fit here, and
 * the last one is the one that matters.
 */
export const TAIL_CAP = 16 * 1024;
/** How far back a prompt block may start. A menu is never taller than this. */
const TAIL_LINES = 14;
const ASK_MAX = 120;

/**
 * Frame characters a boxed prompt puts around every line. They are drawing,
 * not content, and they sit between the regex and the text it needs to see.
 */
const FRAME_EDGE = /^[\s│┃║╎┆┇┊┋|]+|[\s│┃║╎┆┇┊┋|]+$/gu;
/** A line that is only the frame: `╭────╮`, `╰────╯`, `───`. */
const FRAME_ONLY = /^[\s─━═╌╍┄┅┈┉╭╮╯╰┌┐└┘├┤┬┴┼╔╗╚╝║│┃▁▔_-]*$/u;

/** Appends to a terminal's tail, keeping only what still fits. */
export function appendTail(current: string, chunk: string): string {
  if (!chunk) return current;
  const next = current + chunk;
  return next.length > TAIL_CAP ? next.slice(-TAIL_CAP) : next;
}

/**
 * The tail as the lines a person would see.
 *
 * `\r` without `\n` is a terminal rewriting the line in place — a spinner, a
 * progress bar, a countdown. Only what comes after the last one was ever
 * visible, so the earlier passes are dropped rather than joined; otherwise a
 * progress bar arrives as one 4 KB line and every rule anchored to the end of
 * a line stops matching.
 */
export function visibleLines(raw: string, max = TAIL_LINES): string[] {
  const out: string[] = [];
  // The carriage returns have to be read *before* the controls are stripped:
  // `\r` is itself a control character, and removing it first would glue every
  // pass of a progress bar into one long line.
  for (const physical of raw.split("\n")) {
    // The `\r` of a CRLF closes the line, it does not rewrite it — and a PTY
    // on Windows puts one at the end of every single line. Only the ones left
    // *inside* the line are somebody drawing over their own work.
    const body = physical.endsWith("\r") ? physical.slice(0, -1) : physical;
    const drawn = body.includes("\r")
      ? body.slice(body.lastIndexOf("\r") + 1)
      : body;
    const line = stripTerminalControls(drawn).replace(FRAME_EDGE, "");
    if (!line || FRAME_ONLY.test(line)) continue;
    out.push(line);
  }
  return out.slice(-max);
}

/** `❯ 1. Yes` / `2) No` — a menu entry, with or without the cursor on it. */
const NUMBERED = /^(?<mark>[❯➤▸▶►→>›»*]\s*)?(?<n>\d{1,2})[.)]\s+(?<text>\S.*)$/u;
/** `● Yes` / `○ No` / `(x) Overwrite` — the same menu drawn as radio buttons. */
const RADIO = /^(?<mark>[●◉◆✔✓☑]|\(\s*[x*]\s*\)|\[\s*[x*]\s*\])\s+(?<text>\S.*)$/iu;
const RADIO_EMPTY = /^(?:[○◯◇☐]|\(\s*\)|\[\s*\])\s+\S/u;

/** A line that asks something. The `?` is the whole signal — deliberately. */
const QUESTION = /\?\s*$/;

const YES_NO = /[([]\s*(?:y|yes|s|sim)\s*\/\s*(?:n|no|nao|não)\s*[)\]]/i;
// The line has to *end* at the colon and stay short: `Password for
// 'https://github.com':` is a prompt, a paragraph that happens to mention a
// password and end in a colon is a paragraph.
const SECRET =
  /^(?=.{0,90}$).*\b(?:password|passphrase|senha|token|api[\s_-]?key|secret|otp|2fa|c[oó]digo de verifica[cç][aã]o|verification code)\b.*:\s*$/i;
const PRESS_KEY =
  /(?:press\s+(?:any\s+key|enter|return|\[enter\])|pressione\s+(?:enter|qualquer\s+tecla)|^--\s*more\s*--$|^\(end\)$)/i;

/** How far from the end a one-line prompt may sit. It waits with the cursor. */
const YES_NO_REACH = 4;
const SECRET_REACH = 2;
const PRESS_REACH = 3;

function tidy(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > ASK_MAX ? `${flat.slice(0, ASK_MAX - 1)}…` : flat;
}

/**
 * A menu the user is standing in: at least two entries of the same shape, one
 * of them selected, and a question above them.
 *
 * All three conditions carry weight. Two entries alone is any numbered list an
 * agent ever wrote. Entries plus a cursor is a markdown quote of a numbered
 * list (`> 1. Do X`). It takes the question to separate "here is my plan" from
 * "which one do you want".
 */
function matchChoices(lines: string[]): BlockedAsk | null {
  // Counted per shape, and the cursor only counts for the shape it sits on:
  // one marked numbered line next to two unmarked radio lines is not a menu,
  // and pooling the two would call it one.
  let numbered = 0;
  let numberedMarked = false;
  let radio = 0;
  let radioMarked = false;
  let firstOption = -1;

  lines.forEach((line, i) => {
    const num = NUMBERED.exec(line);
    if (num) {
      numbered++;
      if (num.groups?.mark) numberedMarked = true;
      if (firstOption === -1) firstOption = i;
      return;
    }
    const filled = RADIO.test(line);
    if (filled || RADIO_EMPTY.test(line)) {
      radio++;
      if (filled) radioMarked = true;
      if (firstOption === -1) firstOption = i;
    }
  });

  const menu = (numbered >= 2 && numberedMarked) || (radio >= 2 && radioMarked);
  if (!menu || firstOption === -1) return null;

  // The question is above the menu; the nearest one wins, because a long
  // preamble can carry sentences that also end in `?`.
  for (let i = firstOption - 1; i >= 0; i--) {
    if (QUESTION.test(lines[i])) return { ask: tidy(lines[i]), rule: "choices" };
  }
  return null;
}

function matchTail(
  lines: string[],
  reach: number,
  pattern: RegExp,
  rule: BlockedRule,
): BlockedAsk | null {
  const window = lines.slice(-reach);
  for (let i = window.length - 1; i >= 0; i--) {
    if (pattern.test(window[i])) return { ask: tidy(window[i]), rule };
  }
  return null;
}

/**
 * Is the last thing on screen a request for input? `null` means "no reason to
 * think so" — which is the answer for every ordinary end of a turn.
 */
export function classifyPrompt(raw: string): BlockedAsk | null {
  if (!raw) return null;
  const lines = visibleLines(raw);
  if (lines.length === 0) return null;
  return (
    matchChoices(lines) ??
    matchTail(lines, YES_NO_REACH, YES_NO, "yes-no") ??
    matchTail(lines, SECRET_REACH, SECRET, "secret") ??
    matchTail(lines, PRESS_REACH, PRESS_KEY, "press-key")
  );
}
