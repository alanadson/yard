/**
 * Helpers of a canvas portal: addressing name, URL cleanup and the UA
 * presets the CLI/`ua` command share with the card chrome.
 *
 * Nothing here talks to Tauri — the live webview lives in Rust
 * (`src-tauri/src/portal.rs`). This file is what the UI and the `yard`
 * bridge both import so a hostname and a preset never drift.
 */
import { hostnameOf, portalName, type CanvasItem } from "./canvas";
import { uniqueLabels } from "./names";

export type PortalItem = Extract<CanvasItem, { type: "portal" }>;

export const PORTAL_CHROME_H = 58;

/** UA strings the `yard portal ua` verb accepts (names kept stable for compatibility). */
export const UA_PRESETS: Record<string, string> = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "firefox-android":
    "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
  "edge-android":
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.0.0",
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
};

export const UA_PRESET_IDS = [
  "ios",
  "android",
  "firefox-android",
  "edge-android",
  "chrome",
  "firefox",
  "edge",
  "desktop",
] as const;

export type UaPresetId = (typeof UA_PRESET_IDS)[number];

/**
 * Rows of the "Agente de usuario" picker. Everything runs inside
 * WebView2; Chrome/Firefox/Edge here only change the UA string.
 */
export interface UaChoice {
  id: string;
  label: string;
  kind: "ua" | "custom";
  engine: string;
  ua?: string;
  group: "default" | "engine" | "device";
}

export const UA_CHOICES: UaChoice[] = [
  { id: "default", label: "Padrão (WebView2)", kind: "ua", engine: "webview2", group: "default" },
  { id: "chrome", label: "Chrome (só o user-agent)", kind: "ua", engine: "webview2", ua: "chrome", group: "engine" },
  { id: "firefox", label: "Firefox (só o user-agent)", kind: "ua", engine: "webview2", ua: "firefox", group: "engine" },
  { id: "msedge", label: "Microsoft Edge (só o user-agent)", kind: "ua", engine: "webview2", ua: "edge", group: "engine" },
  { id: "ios", label: "Safari (iPhone)", kind: "ua", engine: "webview2", ua: "ios", group: "device" },
  { id: "android", label: "Chrome (Android)", kind: "ua", engine: "webview2", ua: "android", group: "device" },
  {
    id: "firefox-android",
    label: "Firefox (Android)", // i18n-ok
    kind: "ua",
    engine: "webview2",
    ua: "firefox-android",
    group: "device",
  },
  {
    id: "edge-android",
    label: "Microsoft Edge (Android)", // i18n-ok
    kind: "ua",
    engine: "webview2",
    ua: "edge-android",
    group: "device",
  },
  { id: "custom", label: "Personalizado…", kind: "custom", engine: "webview2", group: "device" },
];

/** Resolve a preset id or return the raw string. `desktop` clears the override. */
export function resolveUa(ua?: string | null): string | undefined {
  if (!ua) return undefined;
  const key = ua.trim().toLowerCase();
  if (!key || key === "desktop") return undefined;
  return UA_PRESETS[key] ?? ua.trim();
}

/**
 * Turns what the user typed into a URL the engine can open.
 * `localhost:5173` becomes `http://…`; a bare host becomes `https://…`.
 */
/**
 * Schemes a portal serves — the mirror of `SCHEMES` in `portal.rs`.
 *
 * The check lives on both sides on purpose: the backend is the authority (it
 * is what an agent's `yard portal create` hits), and the front end asks first
 * so a refused address never leaves a dead card on the canvas.
 */
export function isSupportedPortalUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s === "about:blank") return true;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s)?.[1]?.toLowerCase();
  // No scheme (or a bare `host:port`, which the normalizer turns into
  // http/https) is fine; a real one has to be the web.
  if (!scheme) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\d+(\/|$)/.test(s)) return true;
  return scheme === "http" || scheme === "https";
}

export function normalizePortalUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s === "about:blank") return s;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) || /^about:/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
    return `http://${s}`;
  }
  return `https://${s}`;
}

/**
 * Same dedup rule as notes/terminals: `"Portal"`, `"Portal (2)"`.
 *
 * Lives here rather than in `bridgeCore` only to avoid an import cycle
 * (`bridgeCore` already imports this module for `PortalItem`); the rule
 * itself is `uniqueLabels`, shared with the other two.
 */
export function uniquePortalNames(portals: PortalItem[]): Map<string, string> {
  return uniqueLabels(portals, portalName);
}

export { hostnameOf, portalName };

/**
 * Device sizes a portal can take. The card *is* the viewport (the page gets
 * the body's size, and `yard portal resize` keeps that rule), so a preset is
 * a card size: the page plus the chrome around it.
 */
export interface PortalViewport {
  id: "phone" | "tablet" | "desktop";
  /** What the menu prints; translated where drawn. */
  label: string;
  w: number;
  h: number;
}

// i18n-scan: tables
export const PORTAL_VIEWPORTS: readonly PortalViewport[] = [
  { id: "phone", label: "Celular", w: 390, h: 844 },
  { id: "tablet", label: "Tablet", w: 768, h: 1024 },
  { id: "desktop", label: "Desktop", w: 1280, h: 800 },
];

/** The card that shows a page of that size, never below the card's floor. */
export function cardSizeForViewport(p: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(320, p.w + 2), h: p.h + PORTAL_CHROME_H };
}
