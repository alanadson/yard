/**
 * The cost limits of the `yard` CLI: what an agent may raise, how much text
 * flows back into its context, and how many asks of a batch run at once.
 *
 * Every number here is a turn somebody pays for. An agent that recruits
 * agents that recruit agents, a `yard ask` that pours 30 000 characters of
 * another CLI's screen into the caller's context, a 200 KB prompt pasted into
 * a terminal, a batch of ten asks started in the same instant: none of these
 * shows up on screen, only on the bill. The bridge (`bridge.ts`) applies
 * them; the rules live here, pure.
 */

/** Live agent terminals per project that agents may grow to by themselves. */
export const AGENT_CAP_PER_PROJECT = 8;

/** Refusal when raising `adding` agents would pass the cap, `null` when it fits. */
export function agentCapReply(live: number, adding: number): string | null {
  if (live + adding <= AGENT_CAP_PER_PROJECT) return null;
  return (
    `yard: este projeto já tem ${live} agente(s) vivo(s), e o teto para agentes criados por agentes é ` +
    `${AGENT_CAP_PER_PROJECT}. Dispense algum (\`yard dismiss\`) ou peça ao usuário para abrir mais.\n`
  );
}

/**
 * A worker is one level deep: it does its task, it does not raise its own
 * team. Without this, one fan-out of four could become sixteen.
 */
export function workerDepthReply(callerIsWorker: boolean, verb: string): string | null {
  if (!callerIsWorker) return null;
  return (
    `yard: um worker não cria outros agentes (\`yard ${verb}\` recusado). ` +
    "Termine a sua tarefa e deixe a divisão do trabalho para quem criou você.\n"
  );
}

/** What `yard ask` hands back by default: enough for an answer, not a scrollback. */
export const ASK_REPLY_DEFAULT_CHARS = 8_000;
/** The most `--max-chars` may ask for. */
export const ASK_REPLY_MAX_CHARS = 30_000;

export function askReplyChars(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return ASK_REPLY_DEFAULT_CHARS;
  return Math.min(ASK_REPLY_MAX_CHARS, Math.round(asked));
}

/** Past this a prompt is written to a file and the agent is told where. */
export const ASK_INLINE_MAX_BYTES = 32 * 1024;

export function needsPromptFile(text: string): boolean {
  return new TextEncoder().encode(text).length > ASK_INLINE_MAX_BYTES;
}

/** What is typed into the agent instead of a prompt too large to paste. */
export function largePromptMessage(path: string, bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return (
    `O pedido tem ${kb} KB, grande demais para colar no terminal. ` + // i18n-ok, typed into the agent
    `Leia o arquivo inteiro e siga o que ele pede: ${path}` // i18n-ok
  );
}

/**
 * `fn` over `items` with at most `limit` running at once, results in input
 * order. What `yard ask --batch` uses so a batch respects
 * `automationMaxAgents` instead of waking every addressed agent at once.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
