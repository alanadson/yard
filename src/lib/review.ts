/**
 * Review annotations: comments dropped on diff lines and shipped back to the
 * agent that wrote them.
 *
 * The gap this closes: reading a diff and wanting three small changes meant
 * retyping the file, the line and the context into the terminal by hand — so
 * in practice nobody did it, and the review turned into "refaça" or into
 * fixing it yourself. The comment is written where it is thought.
 *
 * The format below is the **contract** between the review and whatever CLI
 * receives it: deterministic, quote-safe, and readable by a human in the
 * terminal scrollback, because that is where it lands.
 */

export interface ReviewComment {
  id: string;
  projectId: string;
  /**
   * Worktree the comment was written against — the ground's path, or the
   * floor's. A project id is not enough: a floor shares the project and has
   * its own `src/a.ts`, so annotations written on one showed up glued to the
   * same lines of the other, and "Limpar tudo" took both.
   *
   * Empty on rows written before this field existed; those still match any
   * root of their project, which is the old (leaky) behaviour and disappears
   * as soon as the review is sent or cleared.
   */
  root: string;
  /** Path relative to the repo root, git style (`/` separators). */
  path: string;
  /**
   * Anchor line. `null` means the comment is about the file as a whole —
   * "this file should not exist" has no line to point at.
   */
  line: number | null;
  /** The anchor is a line of the *old* side (a deletion). */
  onOld: boolean;
  /** The line's text at the time of writing, quoted back for context. */
  code: string;
  body: string;
  createdAt: number;
}

/**
 * Backtick-safe inline code: a snippet full of backticks gets a longer fence.
 * Diff lines are arbitrary source, and Markdown inside a prompt is still read
 * by the agent as Markdown.
 */
export function inlineCode(content: string): string {
  let longest = 0;
  let run = 0;
  for (const char of content) {
    if (char !== "`") {
      run = 0;
      continue;
    }
    run += 1;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(longest + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

/** One line, whitespace collapsed — a comment body is a note, not a document. */
function oneLine(value: string, max = 600): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface ReviewContext {
  projectName?: string;
  branch?: string | null;
}

/**
 * Turns the annotations into the message the agent receives.
 *
 * Grouped by file and ordered by line: an agent reading top to bottom then
 * edits the file top to bottom, and does not have to re-open it four times.
 */
export function formatReview(
  comments: readonly ReviewComment[],
  ctx: ReviewContext = {},
): string {
  if (comments.length === 0) return "";

  const byFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const list = byFile.get(comment.path);
    if (list) list.push(comment);
    else byFile.set(comment.path, [comment]);
  }

  const files = [...byFile.keys()].sort();
  const where = [ctx.projectName, ctx.branch ? `branch ${ctx.branch}` : null]
    .filter(Boolean)
    .join(", ");

  const lines: string[] = [
    `Revisão do diff — ${plural(comments.length, "anotação", "anotações")} em ` +
      `${plural(files.length, "arquivo", "arquivos")}${where ? ` (${where})` : ""}.`,
    "",
  ];

  for (const path of files) {
    const rows = [...byFile.get(path)!].sort(
      (a, b) => (a.line ?? -1) - (b.line ?? -1) || a.createdAt - b.createdAt,
    );
    lines.push(`### ${path}`);
    for (const row of rows) {
      const anchor =
        row.line == null
          ? "**arquivo**"
          : `**linha ${row.line}${row.onOld ? " (removida)" : ""}**`;
      const code = row.code.trim() ? ` — ${inlineCode(row.code.trim())}` : "";
      lines.push(`- ${anchor}${code}`);
      lines.push(`  ${oneLine(row.body)}`);
    }
    lines.push("");
  }

  lines.push(
    "Aplique o que está pedido acima e me diga, em uma linha por item, o que mudou.",
  );
  return lines.join("\n");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Key a comment anchors to inside one file's diff. */
export function anchorKey(line: number | null, onOld: boolean): string {
  return line == null ? "file" : `${onOld ? "o" : "n"}${line}`;
}
