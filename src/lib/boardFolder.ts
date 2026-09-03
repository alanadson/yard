/**
 * The folder a new card on a board is offered.
 *
 * A board belongs to no project, so the dialog cannot infer where a CLI
 * should run the way it does inside a project: the folder is a question, and
 * this is the best default answer to it. Two cards in a row almost always
 * want the same place, so the folder of the card created last comes first;
 * on an empty board the caller's fallback (the home folder) is what is left.
 */
export function suggestBoardFolder(
  cards: readonly { cwd: string; createdAt: number }[],
  fallback: string,
): string {
  let best: { cwd: string; createdAt: number } | null = null;
  for (const card of cards) {
    if (!card.cwd.trim()) continue;
    if (!best || card.createdAt > best.createdAt) best = card;
  }
  return best?.cwd ?? fallback;
}
