/**
 * Mounts the appearance switch once, in `App`: the preference and the OS
 * query drive `<html>` through `stores/themeStore.startTheme`, and the
 * subscription goes away with the component (a hot reload must not leave two
 * listeners painting).
 */
import { useEffect } from "react";

import { startTheme } from "../stores/themeStore";

const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

export function useTheme(): void {
  useEffect(() => {
    const query = typeof window.matchMedia === "function" ? window.matchMedia(SYSTEM_QUERY) : null;
    return startTheme(document.documentElement, query);
  }, []);
}
