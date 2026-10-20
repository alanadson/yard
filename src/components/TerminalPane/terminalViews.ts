/** Live terminals stay attached; only the two most recent stopped views stay warm. */
export interface TerminalViewSource {
  id: string;
  alive: boolean;
}

export function retainedTerminalViews(
  previous: readonly string[],
  terminals: readonly TerminalViewSource[],
  activeId: string | null,
): readonly string[] {
  const sources = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  const order = [
    ...(activeId === null ? [] : [activeId]),
    ...previous,
    ...terminals.filter((terminal) => terminal.alive).map((terminal) => terminal.id),
  ];
  const retained = new Set<string>();
  let stopped = 0;
  for (const id of order) {
    const terminal = sources.get(id);
    if (!terminal || retained.has(id)) continue;
    if (!terminal.alive && stopped >= 2) continue;
    retained.add(id);
    if (!terminal.alive) stopped += 1;
  }
  const next = [...retained];
  return next.length === previous.length && next.every((id, index) => id === previous[index])
    ? previous
    : next;
}
