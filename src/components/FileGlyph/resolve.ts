export function folded(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k.toLowerCase()] = v;
  return out;
}

export function resolveFileIcon(
  name: string,
  FILE_NAMES: Record<string, string>,
  FILE_EXTS: Record<string, string>,
  fallback: string,
  urlOf: (name: string | undefined) => string | null,
): string | null {
  const lower = name.toLowerCase();
  const exact = urlOf(FILE_NAMES[lower]);
  if (exact) return exact;
  let dot = lower.indexOf(".");
  while (dot !== -1) {
    const hit = urlOf(FILE_EXTS[lower.slice(dot + 1)]);
    if (hit) return hit;
    dot = lower.indexOf(".", dot + 1);
  }
  return urlOf(fallback);
}
