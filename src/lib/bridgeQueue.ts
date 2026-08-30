/**
 * How the CLI talks about the queue (`lib/queue.ts`).
 *
 * The whole reason this is its own module with its own tests is one sentence:
 * `--queue` returns success for a prompt **nobody has read**. Every other
 * `yard ask` either delivered the text or failed. An agent that reads
 * "enviado" here will call `yard wait` next and sit there until the timeout,
 * because the target has not even been typed into yet. So the wording says
 * "na fila", says the position, and never says "enviado".
 */
import type { QueueItem } from "./queue";

export function queuedLine(target: string, position: number): string {
  const where =
    position === 1
      ? "é o próximo a entrar"
      : `é o ${position}º da fila`;
  return (
    `na fila de "${target}": ${where}. ` +
    "Ele ainda não viu esse texto — entra sozinho quando a CLI ficar livre.\n"
  );
}

/** First line only: a queued prompt is often a paragraph, and this is a list. */
function headline(text: string): string {
  const [first = ""] = text.split("\n");
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

export function formatQueue(
  items: readonly QueueItem[],
  nameOf: (terminalId: string) => string,
): string {
  if (items.length === 0) return "Nada na fila.\n";
  const byTerminal = new Map<string, QueueItem[]>();
  for (const item of items) {
    const list = byTerminal.get(item.terminalId);
    if (list) list.push(item);
    else byTerminal.set(item.terminalId, [item]);
  }
  let out = "";
  for (const [terminalId, list] of byTerminal) {
    out += `"${nameOf(terminalId)}"\n`;
    list.forEach((item, index) => {
      out += `  ${index + 1}. ${headline(item.text)}\n`;
    });
  }
  return out;
}
