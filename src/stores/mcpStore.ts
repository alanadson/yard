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

import { ipc, type McpHealth, type McpRow, type McpSecrets, type McpServer } from "../lib/ipc";
import { t } from "../lib/i18n";

export type McpProbeState = { state: "pending" } | { state: "healthy"; result: McpHealth } | { state: "failed"; error: string };

interface McpState {
  health: Record<string, McpProbeState>;
  probe: (row: McpRow) => Promise<void>;
  rows: McpRow[];
  /** Files the backend could not read, each naming its path. */
  fileErrors: string[];
  loading: boolean;
  /** The last failed operation for the current project; cleared by the next success. */
  error: string | null;
  /** The project root the listing was read for (`null` = no project). */
  root: string | null;

  load: (root: string | null) => Promise<void>;
  save: (cli: string, scope: string, server: McpServer, expectedRoot?: string | null) => Promise<boolean>;
  remove: (cli: string, scope: string, name: string, expectedRoot?: string | null) => Promise<boolean>;
  secrets: (cli: string, scope: string, name: string, sourceRoot?: string | null) => Promise<McpSecrets>;
}

let request = 0;

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useMcp = create<McpState>((set, get) => ({
  health: {},
  probe: async (row) => {
    const version = request;
    const root = get().root;
    const key = `${row.cli}:${row.scope}:${row.name}`;
    if (get().health[key]?.state === "pending") return;
    set({ health: { ...get().health, [key]: { state: "pending" } } });
    try {
      const result = await ipc.mcpProbe(row.cli, row.scope, root, row.name);
      if (version !== request || root !== get().root) return;
      set({ health: { ...get().health, [key]: { state: "healthy", result } } });
    } catch (error) {
      if (version !== request || root !== get().root) return;
      set({ health: { ...get().health, [key]: { state: "failed", error: reason(error) } } });
    }
  },
  rows: [],
  fileErrors: [],
  loading: false,
  error: null,
  root: null,

  load: async (root) => {
    const mine = ++request;
    const changed = get().root !== root;
    set({ loading: true, root, health: {}, ...(changed ? { rows: [], fileErrors: [], error: null } : {}) });
    try {
      const listing = await ipc.mcpList(root);
      if (mine !== request) return;
      set({ rows: listing.rows, fileErrors: listing.errors, loading: false, error: null });
    } catch (e) {
      if (mine !== request) return;
      set({ loading: false, error: reason(e) });
    }
  },

  save: async (cli, scope, server, expectedRoot = get().root) => {
    const { root } = get();
    if (scope !== "user" && root !== expectedRoot) {
      set({ error: t("O projeto mudou. Confira os servidores MCP antes de continuar.") });
      return false;
    }
    try {
      await ipc.mcpSave(cli, scope, root, server);
    } catch (e) {
      if (scope === "user" || get().root === root) set({ error: reason(e) });
      return false;
    }
    if (scope === "user" || get().root === root) await get().load(get().root);
    return true;
  },

  remove: async (cli, scope, name, expectedRoot = get().root) => {
    const { root } = get();
    if (scope !== "user" && root !== expectedRoot) {
      set({ error: t("O projeto mudou. Confira os servidores MCP antes de continuar.") });
      return false;
    }
    try {
      await ipc.mcpDelete(cli, scope, root, name);
    } catch (e) {
      if (scope === "user" || get().root === root) set({ error: reason(e) });
      return false;
    }
    if (scope === "user" || get().root === root) await get().load(get().root);
    return true;
  },

  secrets: (cli, scope, name, sourceRoot = get().root) => ipc.mcpEnvValues(cli, scope, sourceRoot, name),
}));
