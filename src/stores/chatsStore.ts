/** Transcript keys travel with the existing SQLite backup, separately from canvas undo. */
import { create } from "zustand";
import { CHAT_THREAD_COUNT, createChat, parseChat, setChatDelivery, setThreadDraft, type TerminalChat } from "../lib/chat";
import { ipc } from "../lib/ipc";
import type { PrefsSnapshot } from "../lib/prefs";

export const CHAT_KEY_PREFIX = "chat.terminal.";
/**
 * Each topic's draft has a row of its own (`chat.draft.<terminal>.<topic>`):
 * typing used to rewrite the whole transcript every 250 ms. The row wins over
 * the copy inside the transcript, which only older data still carries.
 */
export const CHAT_DRAFT_PREFIX = "chat.draft.";
const draftKey = (terminalId: string, thread: number) => `${CHAT_DRAFT_PREFIX}${terminalId}.${thread}`;
/** Draft rows known to hold text, per terminal: what `drop` has to empty. */
const draftRows = new Map<string, Set<string>>();
function noteDraftRow(terminalId: string, key: string): void {
  const rows = draftRows.get(terminalId) ?? new Set<string>();
  rows.add(key);
  draftRows.set(terminalId, rows);
}

const lanes = new Map<string, Promise<unknown>>();

function enqueue<T>(terminalId: string, run: () => Promise<T>): Promise<T> {
  const next = (lanes.get(terminalId) ?? Promise.resolve()).catch(() => {}).then(run);
  lanes.set(terminalId, next);
  const release = () => { if (lanes.get(terminalId) === next) lanes.delete(terminalId); };
  void next.then(release, release);
  return next;
}

interface ChatsState {
  byTerminal: Record<string, TerminalChat>;
  errors: Record<string, boolean>;
  load: (prefs: PrefsSnapshot) => void;
  update: (terminalId: string, change: (document: TerminalChat) => TerminalChat) => Promise<TerminalChat>;
  /** Saves one topic's draft without touching the transcript. */
  setDraft: (terminalId: string, thread: number, draft: string) => Promise<void>;
  drop: (terminalIds: Iterable<string>) => Promise<void>;
}

export const useChats = create<ChatsState>((set, get) => ({
  byTerminal: {},
  errors: {},
  load: (prefs) => {
    const byTerminal: Record<string, TerminalChat> = {};
    const errors: Record<string, boolean> = {};
    for (const [key, raw] of Object.entries(prefs)) {
      if (!key.startsWith(CHAT_KEY_PREFIX) || !raw) continue;
      const document = parseChat(raw);
      const id = key.slice(CHAT_KEY_PREFIX.length);
      if (document) byTerminal[id] = document.pending?.delivery === "sending"
        ? setChatDelivery(document, document.pending.id, "uncertain") : document;
      else errors[id] = true;
    }
    for (const [key, draft] of Object.entries(prefs)) {
      if (!key.startsWith(CHAT_DRAFT_PREFIX)) continue;
      const rest = key.slice(CHAT_DRAFT_PREFIX.length);
      const dot = rest.lastIndexOf(".");
      const id = rest.slice(0, dot);
      const thread = Number(rest.slice(dot + 1));
      if (dot <= 0 || errors[id] || !Number.isInteger(thread) || thread < 0 || thread >= CHAT_THREAD_COUNT) continue;
      if (draft) noteDraftRow(id, key);
      const current = byTerminal[id];
      if (!current && !draft) continue;
      byTerminal[id] = setThreadDraft(current ?? createChat(), thread, draft ?? "");
    }
    set({ byTerminal, errors });
  },
  update: (terminalId, change) => enqueue(terminalId, async () => {
    if (get().errors[terminalId]) throw new Error("The saved chat transcript could not be read; restore a backup before editing it");
    const before = get().byTerminal[terminalId] ?? createChat();
    const document = change(before);
    await ipc.writePref(CHAT_KEY_PREFIX + terminalId, JSON.stringify(document));
    set((state) => ({ byTerminal: { ...state.byTerminal, [terminalId]: document } }));
    // A turn that moved a draft (sent, cleared, restored) moves its row too,
    // after the transcript: a crash in between can only repeat a draft.
    for (const [thread, topic] of document.threads.entries()) {
      if (topic.draft === before.threads[thread]?.draft) continue;
      await ipc.writePref(draftKey(terminalId, thread), topic.draft);
      noteDraftRow(terminalId, draftKey(terminalId, thread));
    }
    return document;
  }),
  setDraft: (terminalId, thread, draft) => enqueue(terminalId, async () => {
    if (get().errors[terminalId]) throw new Error("The saved chat transcript could not be read; restore a backup before editing it");
    await ipc.writePref(draftKey(terminalId, thread), draft);
    noteDraftRow(terminalId, draftKey(terminalId, thread));
    set((state) => ({ byTerminal: { ...state.byTerminal,
      [terminalId]: setThreadDraft(state.byTerminal[terminalId] ?? createChat(), thread, draft) } }));
  }),
  drop: async (terminalIds) => {
    await Promise.all([...terminalIds].map((terminalId) => enqueue(terminalId, async () => {
      if (!get().byTerminal[terminalId] && !get().errors[terminalId]) return;
      await ipc.writePref(CHAT_KEY_PREFIX + terminalId, "");
      for (const key of draftRows.get(terminalId) ?? []) await ipc.writePref(key, "");
      draftRows.delete(terminalId);
      set((state) => {
        const byTerminal = { ...state.byTerminal };
        const errors = { ...state.errors };
        delete byTerminal[terminalId];
        delete errors[terminalId];
        return { byTerminal, errors };
      });
    })));
  },
}));
