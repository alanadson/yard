/**
 * What a font picker offers — the rule, outside the JSX that draws it.
 *
 * Three states that are easy to confuse:
 *
 * - **scan running** (`fontes === null`): only the current choice goes in.
 *   With nothing searched yet, any "não encontrada" label would be a guess.
 * - **scan done, chosen font missing**: the family saved in `kv` may have
 *   been uninstalled. It stays in the list, marked — removing it would swap
 *   the user's choice for another, silently, at the next boot.
 * - **scan done, chosen font present**: the normal list.
 *
 * `padrao`, when given, is the "use Yard's default" row (empty value) — and
 * it goes first because it is the answer of whoever opened the picker not
 * knowing what to choose.
 */
import { t } from "./i18n";
import type { FontFamilyInfo } from "./ipc";
import type { SelectOption } from "../components/Select";

export function fontOptions(
  fonts: FontFamilyInfo[] | null,
  monoOnly: boolean,
  currentValue: string,
  defaultLabel?: string,
): SelectOption[] {
  const opts: SelectOption[] =
    fonts === null
      ? currentValue
        ? [{ value: currentValue, label: currentValue }]
        : []
      : fonts
          .filter((f) => !monoOnly || f.mono)
          .map((f) => ({ value: f.family, label: f.family }));
  if (fonts !== null && currentValue && !opts.some((o) => o.value === currentValue)) {
    opts.unshift({ value: currentValue, label: t("{font} (não encontrada)", { font: currentValue }) });
  }
  if (defaultLabel !== undefined) opts.unshift({ value: "", label: defaultLabel });
  return opts;
}
