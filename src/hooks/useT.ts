/**
 * `t` for components: the same function `lib/i18n.ts` exports, plus the
 * subscription that re-renders the caller when the language flips. A
 * component that also needs `tn` imports it from `lib/i18n` and calls
 * `useT()` once — the subscription is what matters, not which of the two it
 * renders with.
 *
 *   const t = useT();
 *   <button>{t("Salvar")}</button>
 */
import { t } from "../lib/i18n";
import { useResolvedLang } from "../stores/langStore";

export function useT(): typeof t {
  useResolvedLang();
  return t;
}
