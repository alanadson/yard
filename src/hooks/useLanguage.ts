/**
 * Mounts the language switch once, in `App`: the preference and the OS
 * language drive `lib/i18n.ts` and `<html lang>` through
 * `stores/langStore.startLanguage`, and the subscription goes away with the
 * component (a hot reload must not leave two writers).
 */
import { useEffect } from "react";

import { startLanguage } from "../stores/langStore";

export function useLanguage(): void {
  useEffect(() => {
    const navigatorLanguage =
      typeof navigator !== "undefined" && typeof navigator.language === "string"
        ? navigator.language
        : undefined;
    return startLanguage(document.documentElement, navigatorLanguage);
  }, []);
}
