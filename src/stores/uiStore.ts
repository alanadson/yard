/**
 * Purely visual state: modals, focus, preferences.
 * Preferences go into the SQLite `kv` table (§4.3).
 */
import { create } from "zustand";
import { ipc } from "../lib/ipc";

export type ModalKind =
  | null
  | "new-terminal"
  | "new-portal"
  | "new-project"
  | "new-floor"
  | "project-style"
  | "preferences"
  | "sessions"
  | "shortcuts"
  | "routines"
  | "scores";

export interface Prefs {
  fontSize: number;
  fontFamily: string;
  renderer: "canvas" | "webgl";
  scrollback: number;
  notifyOnFinish: boolean;
  confirmOnExit: boolean;
  cursorBlink: boolean;
  /** Sidebar widths, in px (draggable via the splitter). */
  sidebarWidth: number;
  changesWidth: number;
}

export const DEFAULT_PREFS: Prefs = {
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  // Canvas is the path proven stable on WebView2; WebGL sits behind
  // this preference (§3, target versions).
  renderer: "canvas",
  scrollback: 20000,
  notifyOnFinish: true,
  confirmOnExit: true,
  cursorBlink: true,
  sidebarWidth: 262,
  changesWidth: 340,
};

export const SIDEBAR_MIN = 190;
export const SIDEBAR_MAX = 460;
export const CHANGES_MIN = 260;
export const CHANGES_MAX = 620;

interface UIState {
  modal: ModalKind;
  modalPayload: unknown;
  focusedTerminalId: string | null;
  focusedSlot: number;
  sidebarOpen: boolean;
  /** Floating prompt composer (Ctrl+Enter). */
  composerOpen: boolean;
  /**
   * Per-terminal draft. Lives only in the session: a half-written prompt does
   * not deserve a SQLite write on every keystroke, and closing the app with a
   * draft is the same as abandoning it.
   */
  composerDrafts: Record<string, string>;
  prefs: Prefs;
  toast: { message: string; kind: "info" | "error" } | null;

  openModal: (modal: ModalKind, payload?: unknown) => void;
  closeModal: () => void;
  focusTerminal: (id: string | null, slot?: number) => void;
  toggleSidebar: () => void;
  setComposerOpen: (open: boolean) => void;
  toggleComposer: () => void;
  setComposerDraft: (terminalId: string, text: string) => void;
  loadPrefs: () => Promise<void>;
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  /** Change the preference without persisting — for continuous drag (splitters). */
  setPrefLocal: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
  dismissToast: () => void;
}

export const useUI = create<UIState>((set, get) => ({
  modal: null,
  modalPayload: null,
  focusedTerminalId: null,
  focusedSlot: 0,
  sidebarOpen: true,
  composerOpen: false,
  composerDrafts: {},
  prefs: { ...DEFAULT_PREFS },
  toast: null,

  openModal: (modal, payload) => set({ modal, modalPayload: payload ?? null }),
  closeModal: () => set({ modal: null, modalPayload: null }),
  focusTerminal: (id, slot) =>
    set((s) => ({
      focusedTerminalId: id,
      focusedSlot: slot ?? s.focusedSlot,
    })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  setComposerOpen: (open) => set({ composerOpen: open }),
  toggleComposer: () => set((s) => ({ composerOpen: !s.composerOpen })),
  setComposerDraft: (terminalId, text) =>
    set((s) => {
      const drafts = { ...s.composerDrafts };
      if (text) drafts[terminalId] = text;
      else delete drafts[terminalId];
      return { composerDrafts: drafts };
    }),

  loadPrefs: async () => {
    try {
      const raw = await ipc.readPrefs();
      const prefs = { ...DEFAULT_PREFS };
      for (const [key, value] of Object.entries(raw)) {
        if (!(key in prefs)) continue;
        const current = prefs[key as keyof Prefs];
        // kv stores everything as text; convert back using the default's type.
        (prefs as Record<string, unknown>)[key] =
          typeof current === "number"
            ? Number(value)
            : typeof current === "boolean"
              ? value === "true"
              : value;
      }
      set({ prefs });
    } catch (e) {
      console.warn("[yard] nao consegui ler preferencias", e);
    }
  },

  setPref: (key, value) => {
    set((s) => ({ prefs: { ...s.prefs, [key]: value } }));
    void ipc.writePref(String(key), String(value));
  },

  setPrefLocal: (key, value) =>
    set((s) => ({ prefs: { ...s.prefs, [key]: value } })),

  showToast: (message, kind = "info") => {
    set({ toast: { message, kind } });
    // Errors stay on screen longer: nobody reads a failure in 4 s.
    const ms = kind === "error" ? 7000 : 4000;
    setTimeout(() => {
      if (get().toast?.message === message) set({ toast: null });
    }, ms);
  },

  dismissToast: () => set({ toast: null }),
}));
