/**
 * The storage scope a new portal starts with, and the scopes the "Novo
 * portal" dialog offers.
 *
 * "Isolado" gives each card a WebView2 profile folder of its own, which is a
 * browser process tree per card. A new portal starts in the project's shared
 * profile instead. Saved cards are untouched: one without the field still
 * opens as isolated (`portalSpawn.ts`, `PortalCard`), so existing logins stay
 * where they are.
 */
import type { PortalStorage } from "./canvas";

export const NEW_PORTAL_STORAGE: PortalStorage = "workspace";

// i18n-scan: tables (rendered through `t()` in the picker).
export const PORTAL_STORAGE_OPTIONS: { value: PortalStorage; label: string }[] = [
  { value: "instance", label: "Isolado" },
  { value: "workspace", label: "Deste projeto" },
  { value: "global", label: "Global" },
];
