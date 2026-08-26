/**
 * "Ombro" (Shoulder) — the digest of every agent of a group, read from the
 * sessions on disk.
 *
 * One read per agent, all in parallel, each row on its own: a CLI that keeps
 * no session says so (instead of the endless wait "Ao Vivo" once had), a
 * folder without a trail says so, and a read that fails marks its row — the
 * panel never blanks because one file was unreadable.
 */
import { create } from "zustand";

import { ipc, type AgentSession, type TerminalRow } from "../lib/ipc";
import { bestSessionFor } from "../lib/sessionFind";
import { digest, type SessionDigest } from "../lib/shoulder";
import { baseName } from "../lib/terminals";
import { hasSessions } from "./agentsStore";
import { useProjects } from "./projectsStore";

export type ShoulderRowState = "loading" | "ready" | "none" | "unsupported" | "error";

export interface ShoulderRow {
  terminalId: string;
  title: string;
  agentId: string | null;
  cwd: string;
  state: ShoulderRowState;
  session: AgentSession | null;
  digest: SessionDigest | null;
  error: string | null;
}

interface ShoulderState {
  groupId: string | null;
  rows: ShoulderRow[];
  loading: boolean;
  /** Reads the group's agents; a second call for another group replaces the rows. */
  load: (groupId: string) => Promise<void>;
  refresh: () => Promise<void>;
  clear: () => void;
}

let generation = 0;

function seed(term: TerminalRow): ShoulderRow {
  return {
    terminalId: term.id,
    title: baseName(term),
    agentId: term.agentId ?? null,
    cwd: term.cwd,
    state: hasSessions(term.agentId) ? "loading" : "unsupported",
    session: null,
    digest: null,
    error: null,
  };
}

async function readRow(term: TerminalRow): Promise<Partial<ShoulderRow>> {
  if (!term.agentId || !hasSessions(term.agentId)) return { state: "unsupported" };
  try {
    const sessions = await ipc.listAgentSessions(term.agentId, term.cwd);
    const session = bestSessionFor(sessions, term.resume);
    if (!session) return { state: "none", session: null };
    const events = await ipc.sessionEvents(session.file);
    return { state: "ready", session, digest: digest(events), error: null };
  } catch (e) {
    return { state: "error", error: String(e) };
  }
}

export const useShoulder = create<ShoulderState>((set, get) => ({
  groupId: null,
  rows: [],
  loading: false,

  load: async (groupId) => {
    const gen = ++generation;
    const terms = useProjects
      .getState()
      .terminalsOf(groupId)
      .filter((t) => t.kind === "agent");
    set({ groupId, rows: terms.map(seed), loading: true });

    await Promise.all(
      terms.map(async (term) => {
        const patch = await readRow(term);
        // A newer load (another group, a refresh) owns the rows now.
        if (gen !== generation) return;
        set((s) => ({
          rows: s.rows.map((r) => (r.terminalId === term.id ? { ...r, ...patch } : r)),
        }));
      }),
    );
    if (gen === generation) set({ loading: false });
  },

  refresh: async () => {
    const id = get().groupId;
    if (id) await get().load(id);
  },

  clear: () => {
    generation++;
    set({ groupId: null, rows: [], loading: false });
  },
}));
