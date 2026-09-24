export function connectionIssue(
  endpoints: readonly string[],
  wires: readonly { from: string; to: string }[],
  from: string,
  to: string,
) {
  if (!endpoints.includes(from) || !endpoints.includes(to)) return "missing";
  if (from === to) return "same";
  if (wires.some((wire) => wire.from === from && wire.to === to))
    return "duplicate";
  return null;
}
