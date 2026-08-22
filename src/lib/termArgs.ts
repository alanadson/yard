/**
 * The command line that "New terminal" hands to the CLI.
 *
 * Two things live here: turning the free-text "extra arguments" field into an
 * `argv`, and the one flag per CLI that turns the permission prompts off.
 *
 * That flag used to be one row among dozens in a cheat-sheet menu, which put
 * the thing everybody actually reaches for — "stop asking me before every
 * edit" — behind knowing whether this CLI spells it `--dangerously-skip-
 * permissions`, `--yolo` or `--yes-always`. It is a checkbox now, and the
 * catalog below is what that checkbox writes; the rest of the menu is gone,
 * because a flag you already know is faster to type than to hunt for in a
 * list.
 *
 * The one rule the catalog does not tell: **a flag is a token sequence, not a
 * word.** Ticking and unticking looks for (and removes) the whole sequence,
 * otherwise a stray value would be left behind on the command line.
 */

export interface SkipFlag {
  /** Tokens exactly as they go into argv. */
  args: string[];
  /**
   * What saying yes costs, in one clause. It is read right after the flag
   * itself ("`--yolo` · aprova …"), so it starts lowercase and does not
   * repeat the name.
   */
  hint: string;
}

/**
 * Every agent that has a way to skip the confirmations, keyed by the catalog
 * id in `agents/resolver.rs`. The names were checked against each CLI's
 * `--help` (Claude Code, Codex) and against the official documentation of the
 * rest.
 *
 * Being absent is a real answer, not an oversight: Grok, OpenCode and Goose
 * have no such flag we could verify, and inventing one would mean a terminal
 * that dies on an unknown option before printing anything.
 */
const SKIP_FLAGS: Record<string, SkipFlag> = {
  claude: {
    args: ["--dangerously-skip-permissions"],
    hint: "não pergunta antes de editar arquivos nem de rodar comandos",
  },
  codex: {
    args: ["--dangerously-bypass-approvals-and-sandbox"],
    hint: "sem sandbox e sem confirmação, só em ambiente isolado",
  },
  gemini: {
    args: ["--yolo"],
    hint: "aprova todas as ferramentas automaticamente",
  },
  "cursor-agent": {
    args: ["--force"],
    hint: "aplica as mudanças nos arquivos sem confirmar",
  },
  aider: {
    args: ["--yes-always"],
    hint: "responde sim a todas as perguntas",
  },
  "gh-copilot": {
    args: ["--allow-all-tools"],
    hint: "libera todas as ferramentas sem perguntar",
  },
};

/**
 * The flag of the CLI that was chosen, or null.
 *
 * A shell never has one — there is nothing asking for permission on the other
 * side — and neither does an agent we have no verified flag for. Null is what
 * hides the checkbox: better no checkbox than one that writes a flag the CLI
 * does not know.
 */
export function skipFlagOf(kind: "shell" | "agent", id: string): SkipFlag | null {
  if (kind !== "agent") return null;
  return SKIP_FLAGS[id] ?? null;
}

/**
 * Splits the "extra arguments" field into an `argv`, honouring quotes.
 *
 * A plain `split(/\s+/)` turned `--append-system-prompt "seja breve"` into
 * three arguments — the CLI then died in the PTY with a usage error and
 * nothing on screen connected the two. Since the field is a command line, a
 * value with a space in it is an expected input, not an exotic one.
 *
 * Backslash is **not** an escape character here, on purpose: this is a
 * Windows app and `--add-dir C:\repo\api` is the common case. Quoting is the
 * only grouping mechanism, which is also how `cmd.exe` behaves.
 */
export function tokenizeArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  // Distinct from `atual !== ""` so that an explicit `""` survives as an
  // empty argument instead of vanishing.
  let isOpen = false;
  let quoteChar: '"' | "'" | null = null;

  for (const ch of value) {
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      isOpen = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (isOpen) {
        out.push(current);
        current = "";
        isOpen = false;
      }
      continue;
    }
    current += ch;
    isOpen = true;
  }
  // Unclosed quotes: whatever was written up to the end of the line counts,
  // instead of discarding the whole argument while the user is still typing.
  if (isOpen) out.push(current);
  return out;
}

/** One token, quoted only if it needs to be to survive `tokenizeArgs`. */
function quoteToken(token: string): string {
  if (token !== "" && !/[\s"']/.test(token)) return token;
  if (!token.includes('"')) return `"${token}"`;
  if (!token.includes("'")) return `'${token}'`;
  // With no escapes, a token holding both quote kinds has no exact form;
  // preserving the text matters more than preserving the double quotes.
  return `"${token.replaceAll('"', "")}"`;
}

/** Inverse of `tokenizeArgs`: the round trip has to be stable. */
export function quoteArgs(tokens: string[]): string {
  return tokens.map(quoteToken).join(" ");
}

/** Where the sequence starts inside the tokens, or -1. */
function indexOfArgs(tokens: string[], args: readonly string[]): number {
  if (args.length === 0) return -1;
  for (let i = 0; i + args.length <= tokens.length; i++) {
    if (args.every((arg, j) => tokens[i + j] === arg)) return i;
  }
  return -1;
}

/** Whether the whole sequence is on the command line — the checkbox's tick. */
export function hasFlag(value: string, args: readonly string[]): boolean {
  return indexOfArgs(tokenizeArgs(value), args) >= 0;
}

/**
 * Puts the flag on the command line, or takes it off, preserving everything
 * else — including what the user typed by hand, which the checkbox knows
 * nothing about.
 *
 * Turning on what is already on returns the text untouched, spacing and all:
 * the checkbox must not reformat a line nobody asked it to reformat.
 */
export function withFlag(value: string, args: readonly string[], on: boolean): string {
  const tokens = tokenizeArgs(value);
  const at = indexOfArgs(tokens, args);
  if (on) return at >= 0 ? value : quoteArgs([...tokens, ...args]);
  // Every occurrence, not just the first: unticking has to mean the flag is
  // gone, even from a line where it was typed twice.
  for (let i = at; i >= 0; i = indexOfArgs(tokens, args)) tokens.splice(i, args.length);
  return at >= 0 ? quoteArgs(tokens) : value;
}
