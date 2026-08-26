/**
 * The tray icon's numbers and the summon hotkey — the two rules behind
 * `hooks/useTray.ts`.
 *
 * With the window hidden (closed to the tray) or behind something else, the
 * tooltip of the icon is the only place the state of the agents still shows;
 * `trayStatus` is what it says. The hotkey is typed by the user in Settings
 * and handed to the global-shortcut plugin, which wants its own spelling
 * (`CommandOrControl+Alt+Y`) and fails silently on anything else —
 * `normalizeHotkey` is the translation, and `null` is the inline error.
 */
import { isLive, type TerminalRuntime } from "../stores/terminalsStore";

export interface TrayStatus {
  /** Live agents stopped on a question. */
  blocked: number;
  /** Live terminals that are not blocked. */
  running: number;
}

/** What the tray tooltip counts: only what is alive, blocked ones apart. */
export function trayStatus(runtimes: Record<string, TerminalRuntime>): TrayStatus {
  let blocked = 0;
  let running = 0;
  for (const rt of Object.values(runtimes)) {
    if (!isLive(rt)) continue;
    if (rt.blocked) blocked += 1;
    else running += 1;
  }
  return { blocked, running };
}

export function sameStatus(a: TrayStatus, b: TrayStatus): boolean {
  return a.blocked === b.blocked && a.running === b.running;
}

// ---------------------------------------------------------------------------
// hotkey
// ---------------------------------------------------------------------------

/** The plugin's modifier names, in the order the accelerator is written. */
const MODIFIER_ORDER = ["CommandOrControl", "Super", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIERS: Record<string, Modifier> = {
  ctrl: "CommandOrControl",
  control: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  commandorcontrol: "CommandOrControl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  win: "Super",
  windows: "Super",
  meta: "Super",
  cmd: "Super",
  command: "Super",
};

/** Named keys the plugin knows, keyed by their lower-case spelling. */
const NAMED_KEYS: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

function normalizeKey(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  const fn = lower.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (fn) return `F${fn[1]}`;
  return null;
}

/**
 * The accelerator the plugin accepts, or `null` when the text cannot become
 * one. A key with no modifier is refused on purpose: registered globally it
 * would take that key away from every other application.
 */
export function normalizeHotkey(input: string): string | null {
  const parts = input
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  // A trailing `+` ("Ctrl+") leaves fewer parts than separators: no key.
  if (input.trim().endsWith("+")) return null;
  const key = normalizeKey(parts[parts.length - 1]);
  if (!key) return null;
  const mods = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) return null;
    mods.add(mod);
  }
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}
