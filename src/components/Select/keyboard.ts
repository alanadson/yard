export function selectTabTarget<T>(
  items: readonly T[],
  trigger: T,
  backwards: boolean,
  wrap: boolean,
): T | null {
  const index = items.indexOf(trigger);
  if (index < 0 || items.length === 0) return null;
  const next = index + (backwards ? -1 : 1);
  return items[wrap ? (next + items.length) % items.length : next] ?? null;
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export function selectTypeahead(
  options: readonly { value: string; label: string; disabled?: boolean }[],
  active: string | null,
  key: string,
  previous: { text: string; at: number },
  now: number,
) {
  const old = now - previous.at < 700 ? previous.text : "";
  const combined = old + normalize(key);
  const repeated = [...combined].every((char) => char === combined[0]);
  const text = repeated ? combined[0] : combined;
  const enabled = options.filter((option) => !option.disabled);
  const current = enabled.findIndex((option) => option.value === active);
  const start = Math.max(0, current + (!old || repeated ? 1 : 0));
  for (let offset = 0; offset < enabled.length; offset++) {
    const option = enabled[(start + offset) % enabled.length];
    if (normalize(option.label).startsWith(text))
      return { value: option.value, text, at: now };
  }
  return { value: active, text, at: now };
}
