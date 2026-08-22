/**
 * Purely visual state: modals, focus, preferences.
 * Preferences go into the SQLite `kv` table (§4.3).
 */
import { create } from "zustand";
import {
  persistJsonPref,
  persistPref,
  readPrefs,
  type PrefsSnapshot,
} from "../lib/prefs";

/**
 * Draft slot used while the composer has no destination. A prompt is written
 * long before it is sent — the text has to have somewhere to live even with no
 * terminal in focus, and it moves to the destination as soon as one is chosen.
 */
export const COMPOSER_SCRATCH = "__sem-destino__";

export type ModalKind =
  | null
  | "new-terminal"
  | "new-portal"
  | "new-project"
  | "new-floor"
  | "new-task"
  | "land-floor"
  | "close-floor"
  | "compare-floors"
  | "project-style"
  | "preferences"
  | "extensions"
  | "sessions"
  | "shortcuts"
  | "routines"
  | "role"
  | "scores"
  | "scm-confirm"
  | "flow";

export interface Prefs {
  fontSize: number;
  /** Terminal font, as a CSS stack (xterm measures the first family that resolves). */
  fontFamily: string;
  /**
   * Ligatures in the terminal (`=>` drawn as one glyph). Off by default: it
   * only has an effect when the chosen font has them, and it costs the
   * renderer a character joiner per frame.
   */
  termLigatures: boolean;
  /** App (interface) font family; empty string = the Yard default stack. */
  uiFontFamily: string;
  /** Code font (file editor, diffs, code blocks); empty = the default `--mono`. */
  codeFontFamily: string;
  /**
   * Ligatures in code surfaces. On by default because that is what CSS
   * already does — the checkbox exists mostly to turn them *off*.
   */
  codeLigatures: boolean;
  /**
   * Metrics of the file editor's text. They used to be literals inside the
   * CodeMirror theme (`cm.ts`), which made "this font is too small" a change
   * only someone with the source could make — and the code font is the one a
   * person stares at for hours.
   */
  codeFontSize: number;
  /** Line height as a multiple of the code font size. */
  codeLineHeight: number;
  /** How many columns a tabulation is worth, and how wide one indent step is. */
  codeTabSize: number;
  /** Indent with a real `	` instead of `codeTabSize` spaces. */
  codeHardTabs: boolean;
  /** The line-number column of the editor. */
  codeLineNumbers: boolean;
  renderer: "canvas" | "webgl";
  scrollback: number;
  notifyOnFinish: boolean;
  /**
   * The "this agent is waiting for you" balloon — a question, a `(y/N)` or a
   * password on the last line. It was born alongside `notifyOnFinish` and
   * shared its switch; turning off the "finished" notice (the noisy one) took
   * with it the only one that costs dead time to ignore. Separate now, and on
   * by default.
   */
  notifyBlocked: boolean;
  /**
   * The usage-limit meter in the title bar. Whoever has none of the three
   * accounts connected watched the strip take up the right side of the bar
   * with nothing to show, and there was no door to hide it.
   */
  usageWidget: boolean;
  confirmOnExit: boolean;
  cursorBlink: boolean;
  /** Sidebar widths, in px (draggable via the splitter). */
  sidebarWidth: number;
  changesWidth: number;
  benchWidth: number;
}

export const DEFAULT_PREFS: Prefs = {
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  termLigatures: false,
  uiFontFamily: "",
  codeFontFamily: "",
  codeLigatures: true,
  // The two numbers the CodeMirror theme carried before there was a knob for
  // them: keeping them as the defaults is what makes this change invisible to
  // whoever never opens Preferências.
  codeFontSize: 12.5,
  codeLineHeight: 1.55,
  codeTabSize: 2,
  codeHardTabs: false,
  codeLineNumbers: true,
  // Canvas is the path proven stable on WebView2; WebGL sits behind
  // this preference (§3, target versions).
  renderer: "canvas",
  scrollback: 20000,
  notifyOnFinish: true,
  notifyBlocked: true,
  usageWidget: true,
  confirmOnExit: true,
  cursorBlink: true,
  sidebarWidth: 262,
  changesWidth: 340,
  benchWidth: 312,
};

export const SIDEBAR_MIN = 190;
export const SIDEBAR_MAX = 460;
export const CHANGES_MIN = 260;
export const CHANGES_MAX = 620;
/**
 * 248 of usable panel plus the 20px the floating glass spends on its own
 * gutter (10px each side, `.bench { padding: 10px }`). The width the user
 * drags is the whole slot, so the minimum has to pay for the gap too —
 * otherwise the narrowest bench is 20px narrower than the one this number
 * was measured for.
 */
export const BENCH_MIN = 268;
export const BENCH_MAX = 560;

/**
 * Valid range for each numeric preference.
 *
 * These existed only as drag limits and as the fields' `min`/`max` — that is,
 * interface validation. `kv` stores text and is editable from outside (an
 * imported backup, a file touched by hand): `sidebarWidth: -900` or
 * `fontSize: 0` came straight in and broke the layout with no way back
 * through the UI.
 */
const RANGES: Partial<
  Record<keyof Prefs, { min: number; max: number; step?: number }>
> = {
  fontSize: { min: 8, max: 28 },
  scrollback: { min: 1000, max: 200000 },
  sidebarWidth: { min: SIDEBAR_MIN, max: SIDEBAR_MAX },
  changesWidth: { min: CHANGES_MIN, max: CHANGES_MAX },
  benchWidth: { min: BENCH_MIN, max: BENCH_MAX },
  // `passo` here is not the spinner's arrow — it is the grid the *stored*
  // value snaps to. The line height is the app's first fractional preference,
  // and without it a 1.5333333 typed into the field went to the `kv` whole
  // and came back in the field like that at the next boot.
  codeFontSize: { min: 9, max: 32, step: 0.5 },
  codeLineHeight: { min: 1, max: 2.4, step: 0.05 },
  codeTabSize: { min: 1, max: 8, step: 1 },
};

/** Clamps a numeric value to its key's range (no range, it passes through). */
export function clampPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Prefs[K] {
  const range = RANGES[key];
  if (!range || typeof value !== "number" || !Number.isFinite(value)) return value;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  if (!range.step) return clamped as Prefs[K];
  // `toFixed` because binary floats: 31 * 0.05 is 1.5500000000000003, and that
  // is what would reach both the `kv` and the field.
  const stepped = Math.round(clamped / range.step) * range.step;
  return Number(stepped.toFixed(4)) as Prefs[K];
}

interface UIState {
  modal: ModalKind;
  modalPayload: unknown;
  focusedTerminalId: string | null;
  focusedSlot: number;
  sidebarOpen: boolean;
  /** Floating prompt composer (Ctrl+Enter). */
  composerOpen: boolean;
  /** Busca — the command palette (Ctrl+P). */
  paletteOpen: boolean;
  /**
   * What the Busca starts with. A scope prefix (`>`, `@`, `#`, `/`) lets a
   * caller open it already filtered; the box is cleared on the next open, so
   * this is a hand-off, not a saved query.
   */
  paletteSeed: string;
  /**
   * "Take me to this thing on the canvas." Written by the Busca, consumed by
   * `CanvasView` in an effect.
   *
   * A window event would have been the obvious route, but the target group's
   * canvas may not be mounted yet when the row is picked — the reveal has to
   * survive until the component that answers it exists.
   */
  canvasReveal: { groupId: string; id: string } | null;
  /**
   * Draft per destination — the terminal's id, or `COMPOSER_SCRATCH` while
   * there is no destination.
   *
   * Persisted (with half a second of breathing room, never per keystroke):
   * closing Yard in the middle of a long prompt is the same loss as closing it
   * in the middle of a file, and the editor already kept its draft. Comes back
   * on the next boot, with the destination it belonged to.
   */
  composerDrafts: Record<string, string>;
  /**
   * Destination chosen inside the composer itself. `null` means "follow the
   * focused terminal" — and when nothing is focused either, the draft lives in
   * the scratch slot: writing a prompt must never require a terminal.
   */
  composerTargetId: string | null;
  prefs: Prefs;
  /**
   * Notices on screen, oldest first.
   *
   * It used to be a single slot, and a second message simply replaced the
   * first — so a burst (the routine scheduler reports one failure per routine,
   * the composer can complain about the destination and the mentions in the
   * same send) showed only the last one, with no trace of the others. Capped
   * because a stack taller than that stops being readable.
   */
  toasts: Toast[];
  /**
   * Notices the cap pushed out before anyone dismissed them. The stack shows
   * this as a "+N avisos" caption instead of discarding in silence.
   */
  toastOverflow: number;
  /**
   * A restored backup is staged for the next boot. While true, everything the
   * user does lands in the database that will be discarded — so the warning
   * is a persistent bar in App, not only a paragraph inside Preferences.
   */
  backupPending: boolean;
  /**
   * Which rows of the project tree are collapsed, by id.
   *
   * Session state until it was not: with half a dozen projects registered,
   * every boot came back with all of them expanded, and the badge that says
   * "an agent is waiting for you" was three scrolls down. Lives outside
   * `prefs` because it is a map, not a knob — but persists in the same `kv`.
   */
  treeCollapsed: Record<string, boolean>;

  openModal: (modal: ModalKind, payload?: unknown) => void;
  closeModal: () => void;
  focusTerminal: (id: string | null, slot?: number) => void;
  toggleSidebar: () => void;
  setComposerOpen: (open: boolean) => void;
  toggleComposer: () => void;
  openPalette: (seed?: string) => void;
  closePalette: () => void;
  revealOnCanvas: (groupId: string, id: string) => void;
  clearCanvasReveal: () => void;
  setComposerDraft: (slot: string, text: string) => void;
  setComposerTarget: (id: string | null) => void;
  /** Drops text into whatever slot the composer is on and opens it. */
  sendToComposer: (text: string) => void;
  /** Drops the drafts of terminals that no longer exist (called at boot). */
  pruneComposerDrafts: (liveIds: Set<string>) => void;
  loadPrefs: (prefs?: PrefsSnapshot) => Promise<void>;
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  /** Change the preference without persisting — for continuous drag (splitters). */
  setPrefLocal: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  /** Returns every preference to the factory default (and writes it). */
  resetPrefs: () => void;
  showToast: (message: string, kind?: "info" | "error") => void;
  dismissToast: (id?: number) => void;
  setBackupPending: (pending: boolean) => void;
  /** Collapses (or expands) a project/group row of the tree, and remembers it. */
  toggleTreeNode: (id: string) => void;
  /**
   * Collapses (or expands) several nodes at once — the sidebar menu's
   * "collapse all". One `toggleTreeNode` per project would do the opposite of
   * what was asked on the ones already closed, and write the kv once per row.
   */
  setTreeCollapsed: (ids: readonly string[], collapsed: boolean) => void;
}

/** One notice at the bottom of the window. */
export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

let toastSeq = 0;

/** How many notices may be stacked before the oldest gives way. */
const TOAST_CAP = 3;

/** `kv` key of the collapsed rows of the project tree. */
const KV_TREE = "ui.treeCollapsed";
/** `kv` key of the composer drafts, by destination. */
const KV_DRAFTS = "composer.drafts";

/**
 * Writes the drafts with breathing room: writing on every keystroke would put
 * a trip to SQLite in the path of someone typing a ten-line prompt.
 */
let draftTimer: ReturnType<typeof setTimeout> | null = null;
function saveDrafts(drafts: Record<string, string>) {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    persistJsonPref(KV_DRAFTS, drafts, (error) =>
      console.warn(`[yard] não consegui salvar ${KV_DRAFTS}`, error),
    );
  }, 500);
}

/** kv holds text and can be edited from outside; never trust the shape. */
function parseDrafts(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [slot, text] of Object.entries(data)) {
      if (typeof text === "string" && text) out[slot] = text;
    }
    return out;
  } catch {
    return {};
  }
}

/** kv holds text and can be edited from outside; never trust the shape. */
function parseCollapsed(raw: string | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(data)) if (on === true) out[id] = true;
    return out;
  } catch {
    return {};
  }
}

export const useUI = create<UIState>((set, get) => ({
  modal: null,
  modalPayload: null,
  focusedTerminalId: null,
  focusedSlot: 0,
  sidebarOpen: true,
  composerOpen: false,
  paletteOpen: false,
  paletteSeed: "",
  canvasReveal: null,
  composerDrafts: {},
  composerTargetId: null,
  prefs: { ...DEFAULT_PREFS },
  toasts: [],
  toastOverflow: 0,
  backupPending: false,
  treeCollapsed: {},

  openModal: (modal, payload) => set({ modal, modalPayload: payload ?? null }),
  closeModal: () => set({ modal: null, modalPayload: null }),
  focusTerminal: (id, slot) =>
    set((s) => ({
      focusedTerminalId: id,
      focusedSlot: slot ?? s.focusedSlot,
      // Focusing is an explicit gesture (a click on the card, a tab, the
      // Busca) and it is the more recent one — it retakes the composer from a
      // destination picked earlier inside the box.
      composerTargetId: null,
    })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  setComposerOpen: (open) => set({ composerOpen: open }),
  toggleComposer: () => set((s) => ({ composerOpen: !s.composerOpen })),

  openPalette: (seed = "") => set({ paletteOpen: true, paletteSeed: seed }),
  closePalette: () => set({ paletteOpen: false, paletteSeed: "" }),

  revealOnCanvas: (groupId, id) => set({ canvasReveal: { groupId, id } }),
  clearCanvasReveal: () => set({ canvasReveal: null }),
  setComposerDraft: (slot, text) =>
    set((s) => {
      const drafts = { ...s.composerDrafts };
      if (text) drafts[slot] = text;
      else delete drafts[slot];
      saveDrafts(drafts);
      return { composerDrafts: drafts };
    }),

  pruneComposerDrafts: (liveIds) =>
    set((s) => {
      const drafts: Record<string, string> = {};
      for (const [slot, text] of Object.entries(s.composerDrafts)) {
        if (slot === COMPOSER_SCRATCH || liveIds.has(slot)) drafts[slot] = text;
      }
      const changed =
        Object.keys(drafts).length !== Object.keys(s.composerDrafts).length;
      if (!changed) return s;
      saveDrafts(drafts);
      return { composerDrafts: drafts };
    }),
  setComposerTarget: (id) => set({ composerTargetId: id }),
  sendToComposer: (text) =>
    set((s) => {
      const slot = s.composerTargetId ?? s.focusedTerminalId ?? COMPOSER_SCRATCH;
      const currentValue = s.composerDrafts[slot] ?? "";
      return {
        composerDrafts: {
          ...s.composerDrafts,
          [slot]: currentValue ? `${currentValue}\n${text}` : text,
        },
        composerOpen: true,
      };
    }),

  loadPrefs: async (bootPrefs) => {
    try {
      const raw = bootPrefs ?? (await readPrefs());
      const prefs = { ...DEFAULT_PREFS };
      for (const [key, value] of Object.entries(raw)) {
        if (!(key in prefs)) continue;
        const current = prefs[key as keyof Prefs];
        // kv stores everything as text; convert back using the default's type.
        let parsed: unknown = value;
        if (typeof current === "number") {
          const number = Number(value);
          parsed = Number.isFinite(number) ? number : current;
        } else if (typeof current === "boolean") {
          parsed = value === "true" ? true : value === "false" ? false : current;
        } else if (key === "renderer" && value !== "canvas" && value !== "webgl") {
          parsed = current;
        }
        (prefs as Record<string, unknown>)[key] = clampPref(
          key as keyof Prefs,
          parsed as Prefs[keyof Prefs],
        );
      }
      set({
        prefs,
        treeCollapsed: parseCollapsed(raw[KV_TREE]),
        composerDrafts: parseDrafts(raw[KV_DRAFTS]),
      });
    } catch (e) {
      console.warn("[yard] nao consegui ler preferencias", e);
    }
  },

  setPref: (key, value) => {
    const bounded = clampPref(key, value);
    set((s) => ({ prefs: { ...s.prefs, [key]: bounded } }));
    persistPref(String(key), String(bounded), (error) =>
      console.warn(`[yard] não consegui salvar preferência ${String(key)}`, error),
    );
  },

  setPrefLocal: (key, value) =>
    set((s) => ({ prefs: { ...s.prefs, [key]: clampPref(key, value) } })),

  /**
   * After trying out font, size, scrollback and renderer, the way back was
   * remembering every value. The defaults already existed in `DEFAULT_PREFS`;
   * what was missing was the door.
   */
  resetPrefs: () => {
    set({ prefs: { ...DEFAULT_PREFS } });
    for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
      persistPref(key, String(value), (error) =>
        console.warn(`[yard] não consegui restaurar a preferência ${key}`, error),
      );
    }
  },

  showToast: (message, kind = "info") => {
    // Its own identity, not the text: two identical notices in a row (two
    // failures of the same hook, for instance) made the first one's timer
    // clear the second before its time.
    const id = ++toastSeq;
    set((s) => {
      const full = [...s.toasts, { id, message, kind }];
      const dropped = Math.max(0, full.length - TOAST_CAP);
      // A burst (N floors × hooks) used to push the oldest notice out in
      // silence; the stack now keeps count of what it had to hide.
      return {
        toasts: full.slice(-TOAST_CAP),
        toastOverflow: s.toastOverflow + dropped,
      };
    });
    // Errors stay until dismissed: the detail (paths, hook output) is the
    // only diagnostic the user gets, and 7 s was not enough to read it.
    if (kind !== "error") setTimeout(() => get().dismissToast(id), 4000);
  },

  setBackupPending: (pending) => set({ backupPending: pending }),

  toggleTreeNode: (id) =>
    set((s) => {
      const treeCollapsed = { ...s.treeCollapsed };
      // Absence means expanded, so the map only ever grows with what the user
      // deliberately closed — a workspace nobody collapsed writes `{}`.
      if (treeCollapsed[id]) delete treeCollapsed[id];
      else treeCollapsed[id] = true;
      persistJsonPref(KV_TREE, treeCollapsed, (error) =>
        console.warn(`[yard] não consegui salvar ${KV_TREE}`, error),
      );
      return { treeCollapsed };
    }),

  setTreeCollapsed: (ids, collapsed) =>
    set((s) => {
      const treeCollapsed = { ...s.treeCollapsed };
      // Absence is "expanded": expanding removes the key instead of writing `false`.
      for (const id of ids) {
        if (collapsed) treeCollapsed[id] = true;
        else delete treeCollapsed[id];
      }
      persistJsonPref(KV_TREE, treeCollapsed, (error) =>
        console.warn(`[yard] não consegui salvar ${KV_TREE}`, error),
      );
      return { treeCollapsed };
    }),

  /** Without an id, clears everything on screen (the × of the last notice). */
  dismissToast: (id) =>
    set((s) => {
      const toasts = id === undefined ? [] : s.toasts.filter((t) => t.id !== id);
      // The overflow caption is anchored to the stack; an empty stack has
      // nothing left to explain.
      return { toasts, toastOverflow: toasts.length === 0 ? 0 : s.toastOverflow };
    }),
}));
