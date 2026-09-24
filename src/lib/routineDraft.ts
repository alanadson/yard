import { clampRoutineInterval } from "./canvas";
import { validateNumericDraft } from "./numericField";

export function routineDraftIsDirty(
  draft: { text: string; interval: string; once: boolean },
  saved: { interval: string; once: boolean },
) {
  return (
    !!draft.text ||
    draft.interval !== saved.interval ||
    draft.once !== saved.once
  );
}

export function validateRoutineDraft(text: string, interval: string) {
  const numeric = validateNumericDraft(interval, clampRoutineInterval);
  if (!numeric.valid) return { valid: false, field: "interval" } as const;
  if (!text.trim()) return { valid: false, field: "text" } as const;
  return { valid: true, text: text.trim(), everyMin: numeric.value } as const;
}
