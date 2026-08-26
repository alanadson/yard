/**
 * The MCP manager's state: the listing of every CLI's servers for the
 * project on screen, and the three writes that change it.
 *
 * The screen never edits its own copy: a save or a delete goes to the file
 * and the files are read again, because the file is the truth the CLI will
 * read at its next start. Secret values are fetched per server, for the
 * form, and never sit in this store (nor in the listing — the backend only
 * sends key names).
 */
import { create } from "zustand";

import { ipc, type McpRow, type McpSecrets, type McpServer } from "../lib/ipc";

interface McpState {
  rows: McpRow[];
  /** Files the backend could not read, each naming its path. */
  fileErrors: string[];
  loading: boolean;
  /** The last failed operation, in words; cleared by the next success. */
  error: string | null;
  /** The project root the listing was read for (`null` = no project). */
  root: string | null;

  load: (root: string | null) => Promise<void>;
  save: (cli: string, scope: string, server: McpServer) => Promise<boolean>;
  remove: (cli: string, scope: string, name: string) => Promise<boolean>;
  secrets: (cli: string, scope: string, name: string) => Promise<McpSecrets>;
}

let request = 0;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useMcp = create<McpState>((set, get) => ({
  rows: [],
  fileErrors: [],
  loading: false,
  error: null,
  root: null,

  load: async (root) => {
    const mine = ++request;
    set({ loading: true, root });
    try {
      const listing = await ipc.mcpList(root);
      if (mine !== request) return;
      set({ rows: listing.rows, fileErrors: listing.errors, loading: false, error: null });
    } catch (e) {
      if (mine !== request) return;
      set({ loading: false, error: reason(e) });
    }
  },

  save: async (cli, scope, server) => {
    const { root } = get();
    try {
      await ipc.mcpSave(cli, scope, root, server);
    } catch (e) {
      set({ error: reason(e) });
      return false;
    }
    await get().load(root);
    return true;
  },

  remove: async (cli, scope, name) => {
    const { root } = get();
    try {
      await ipc.mcpDelete(cli, scope, root, name);
    } catch (e) {
      set({ error: reason(e) });
      return false;
    }
    await get().load(root);
    return true;
  },

  secrets: (cli, scope, name) => ipc.mcpEnvValues(cli, scope, get().root, name),
}));
