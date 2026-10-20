/**
 * The hop guard of `yard ask`: how deep in an agent-to-agent chain a prompt
 * is, and the two limits that keep such chains short.
 *
 * Every prompt `yard ask` injects opens with a stamp, `[Yard · de "A" ·
 * salto n]`. `n` is one more than the hop of the last stamped prompt the
 * *caller* received, as long as that one arrived in the last thirty minutes
 * (an older one belongs to work that already ended), and 1 when there is none.
 * A fourth hop is refused: A asks B, B asks C, C asks D is already a long way
 * from anything the user typed. And one pair of agents (either direction)
 * gets six asks per ten minutes; past that it is a conversation between two
 * agents that bills one turn per line.
 *
 * Pure: the ledger is a value and the clock is a parameter. The bridge keeps
 * the one ledger of the session.
 */

/** The deepest hop a prompt may carry. */
export const MAX_HOPS = 3;
/** How long a received stamp still counts as the caller's current chain. */
export const HOP_WINDOW_MS = 30 * 60_000;
/** The window of the pair limit. */
export const PAIR_WINDOW_MS = 10 * 60_000;
/** Asks one pair may exchange inside the window. */
export const PAIR_MAX = 6;

export interface HopLedger {
  /** The last stamped prompt each terminal received: its hop and when. */
  received: Readonly<Record<string, { hop: number; at: number }>>;
  /** The asks of the last ten minutes, for the pair limit. */
  asks: readonly { from: string; to: string; at: number }[];
}

export function emptyLedger(): HopLedger {
  return { received: {}, asks: [] };
}

export type AskPlan = { ok: true; hop: number } | { ok: false; message: string };

/** Whether `from` may ask `to` now, and at which hop. */
export function planAsk(ledger: HopLedger, from: string, to: string, now: number): AskPlan {
  const last = ledger.received[from];
  const hop = (last && now - last.at < HOP_WINDOW_MS ? last.hop : 0) + 1;
  if (hop > MAX_HOPS) {
    return {
      ok: false,
      message:
        `yard: esta conversa já está no salto ${hop - 1} de agente para agente (o limite é ${MAX_HOPS}). ` +
        "Responda a quem perguntou com o que você tem, em vez de acionar mais um agente.\n",
    };
  }
  const exchanged = ledger.asks.filter(
    (a) =>
      now - a.at < PAIR_WINDOW_MS &&
      ((a.from === from && a.to === to) || (a.from === to && a.to === from)),
  ).length;
  if (exchanged >= PAIR_MAX) {
    return {
      ok: false,
      message:
        `yard: vocês dois já trocaram ${exchanged} pedidos em 10 min (o limite é ${PAIR_MAX}). ` +
        "Junte o que falta num pedido só, ou peça ao usuário para seguir.\n",
    };
  }
  return { ok: true, hop };
}

/** The ledger after `from` asked `to` at `hop`. */
export function recordAsk(ledger: HopLedger, from: string, to: string, hop: number, now: number): HopLedger {
  return {
    received: { ...ledger.received, [to]: { hop, at: now } },
    asks: [...ledger.asks.filter((a) => now - a.at < PAIR_WINDOW_MS), { from, to, at: now }],
  };
}

/** The first line of a prompt `yard ask` injects. */
export function askStamp(fromName: string, hop: number): string {
  return `[Yard · de "${fromName}" · salto ${hop}]`; // i18n-ok, typed into the agent
}
