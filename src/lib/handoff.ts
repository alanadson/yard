/**
 * Passing the baton: what one agent tells the next one.
 *
 * This happens all day and has always been done by hand — you read what the
 * first agent did, you remember what is half-finished, you type a paragraph
 * into the second one, and you get it wrong in the same way every time: you
 * describe the *task* and forget the *state*. The new agent then re-reads
 * twenty files to discover what the first one already changed.
 *
 * So the message is assembled from three sources that the app already has and
 * a human would have to gather by hand:
 *
 * - the **role** the first agent was given (`canvas.roles`);
 * - the **state of the tree** — branch and diffstat. This is the part no
 *   transcript contains and the part that saves the most time;
 * - the **last few turns** of what it said (`lib/transcript.ts`), capped hard.
 *   A transcript pasted whole spends the next agent's context window on a log
 *   instead of on the work, and the tool calls are left out entirely: the new
 *   agent will run its own.
 *
 * What the user says is left to do goes **first**, because it is the one part
 * that is not derivable from anything and the one part that is an
 * instruction rather than context.
 *
 * The sentences here are **not** chrome and do not go through `t()`:
 * they are typed into a CLI, the same way `lib/review.ts` and the
 * bridge's own answers are. The interface's English half never sees
 * them.
 */
// i18n-scan: tables
import type { Block } from "./transcript";

/** How many of the last turns travel. */
export const TURNS = 6;
/** How much of a single turn travels. */
export const SAY_CAP = 1200;

export interface HandoffInput {
  /** Who is handing over. */
  from: string;
  /** Their role, if they had one. */
  role: string;
  branch: string;
  files: number;
  additions: number;
  deletions: number;
  /** The transcript of the session so far. */
  blocks: readonly Block[];
  /** What the user says is left — free text, may be empty. */
  left: string;
}

function clip(text: string): string {
  const flat = text.trim();
  return flat.length > SAY_CAP ? `${flat.slice(0, SAY_CAP - 1)}…` : flat;
}

export function handoffMessage(input: HandoffInput): string {
  const lines: string[] = [];
  lines.push(
    `Estou assumindo o trabalho de "${input.from}"${
      input.role ? ` (papel: ${input.role})` : ""
    }. Contexto abaixo; não refaça o que já está feito.`,
  );

  if (input.left.trim()) {
    lines.push("", "**O que falta**", input.left.trim());
  }

  lines.push("", "**Estado da árvore**");
  lines.push(input.branch ? `Branch: \`${input.branch}\`` : "Sem branch (HEAD solto).");
  lines.push(
    input.files > 0
      ? `${input.files} arquivo(s) alterados, +${input.additions} −${input.deletions} — rode um \`git diff\` antes de editar.`
      : "Árvore limpa: nada pendente no git.",
  );

  // Prose only: `prompt` (what was asked) and `say` (what was answered). The
  // thinking is not addressed to anybody, and the tool calls are a log.
  const prose = input.blocks.filter(
    (b): b is Extract<Block, { kind: "prompt" | "say" }> =>
      (b.kind === "prompt" || b.kind === "say") && !!b.text.trim(),
  );
  const tail = prose.slice(-TURNS);
  if (tail.length) {
    lines.push("", `**Últimos ${tail.length} turno(s) de "${input.from}"**`);
    for (const block of tail) {
      lines.push(
        `- ${block.kind === "prompt" ? "pedido" : "resposta"}: ${clip(block.text)}`,
      );
    }
  }

  return lines.join("\n");
}
