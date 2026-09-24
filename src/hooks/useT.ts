/**
 * `t` for components: the same function `lib/i18n.ts` exports, plus the
 * subscription that re-renders the caller when the language flips. A
 * component that also needs `tn` imports it from `lib/i18n` and calls
 * `useT()` once — the subscription is what matters, not which of the two it
 * renders with.
 *
 *   const t = useT();
 *   <button>{t("Salvar")}</button>
 *
 * It follows the *active* language, the one `t()` speaks, not the resolved
 * preference. They used to flip in the same instant; now English waits for
 * its dictionary (`stores/langStore.ts`), and a component re-rendered the
 * moment the preference said English would read Portuguese and then never
 * hear about the lines landing.
 */
import { useSyncExternalStore } from "react";

import { activeLang, subscribeActiveLang, t } from "../lib/i18n";

export function useT(): typeof t {
  useSyncExternalStore(subscribeActiveLang, activeLang, activeLang);
  return t;
}
