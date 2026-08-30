/**
 * The day, written down.
 *
 * Everything a session leaves behind is scattered across four places that
 * each forget on their own schedule: the commits are in git, the spend is in
 * the CLIs' session files, the agents are cards that get closed, and what it
 * was *for* is in the user's head. The next morning the only one of those
 * that is still legible is git, and it does not say why.
 *
 * So the journal folds the three machine-readable ones into a note (the
 * markdown notebook, which is the app's place for things that outlive a
 * session) and leaves a heading for the fourth. The value is not the report:
 * it is that the note starts already filled in, so writing the one paragraph
 * that matters costs nothing.
 *
 * The one rule with teeth is inherited from the costs panel: a spend with an
 * unpriced model in it is a **floor** and has to say so. A journal that
 * records "US$ 4.20" for a day that actually cost more is worse than a
 * journal with no number, because it will be read as fact next month.
 *
 * The headings are the body of a note the user then edits, not chrome:
 * they stay in Portuguese like every other text the product writes
 * *into* something rather than *on* something.
 */
// i18n-scan: tables

export interface JournalCommit {
  hash: string;
  subject: string;
}

export interface JournalInput {
  /** `YYYY-MM-DD`, local. */
  day: string;
  project: string;
  commits: readonly JournalCommit[];
  /** Estimated spend of the day, in US dollars. Zero means "no estimate". */
  spendUsd: number;
  /** Some rows had no price: the sum is a floor. */
  spendPartial: boolean;
  /** Names of the agents that were up. */
  agents: readonly string[];
}

export function journalMarkdown(input: JournalInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.day} — ${input.project}`, "");

  lines.push("## O que entrou");
  if (input.commits.length === 0) {
    lines.push("Nenhum commit neste dia.");
  } else {
    for (const commit of input.commits) {
      lines.push(`- ${commit.subject} (\`${commit.hash.slice(0, 7)}\`)`);
    }
  }
  lines.push("");

  if (input.agents.length > 0) {
    lines.push("## Quem trabalhou", input.agents.join(", "), "");
  }

  if (input.spendUsd > 0) {
    const value = input.spendUsd.toFixed(2);
    lines.push(
      "## Custo estimado",
      input.spendPartial
        ? `pelo menos US$ ${value} (algum modelo ficou fora da tabela de preços)`
        : `US$ ${value}`,
      "",
    );
  }

  lines.push("## Notas", "");
  return lines.join("\n");
}
