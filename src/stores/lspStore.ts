/**
 * Language-server clients for the file editor.
 *
 * One `LSPClient` per (project root, server program), started by the first
 * file that needs it and shared by every other file of that root the same
 * server takes — a TypeScript server already holds the whole project in
 * memory, and two of them would hold it twice. A server that fails to start
 * or dies is reported once and left alone until the user presses "Procurar
 * de novo": restarting a crashing `rust-analyzer` in a loop is worse than
 * having none. Servers whose root has no file open are stopped after a grace
 * period, so switching projects and coming back does not pay the start-up
 * twice.
 *
 * The state that matters to the editor is the client; the state that matters
 * to Settings is the catalog (`detected`) and the failures.
 */
import { create } from "zustand";
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";

import { t } from "../lib/i18n";
import { ipc, on, type LspServerInfo } from "../lib/ipc";
import { uiLog } from "../lib/log";
import { clientKey, requestTimeoutMs, rootUri, serverFor } from "../lib/lsp/servers";
import { IpcTransport } from "../lib/lsp/transport";
import {
  dropRoot,
  NO_PROBLEMS,
  receive,
  type ProblemsState,
} from "../lib/lsp/problems";
import { useUI } from "./uiStore";

/** How long a root with no file open keeps its servers alive. */
export const PRUNE_GRACE_MS = 30_000;



export interface ClientEntry {
  key: string;
  /** The id handed to `lsp_start`; the process manager's name for it. */
  id: string;
  root: string;
  program: string;
  client: LSPClient;
  transport: IpcTransport;
}

interface LspState {
  detected: LspServerInfo[] | null;
  loading: boolean;
  error: string | null;
  clients: Record<string, ClientEntry>;
  /**
   * Every problem the servers have reported, for the whole project and not
   * only for the files that happen to be open (`lib/lsp/problems.ts`).
   */
  problems: ProblemsState;
  /** Servers that failed to start or died, by client key, with the reason. */
  failed: Record<string, string>;

  load: (refresh?: boolean) => Promise<LspServerInfo[]>;
  clientFor: (root: string, languageId: string) => Promise<LSPClient | null>;
  /** Stops, after a grace period, the servers of every root not in the set. */
  pruneRoots: (openRoots: Set<string>) => void;
  stopAll: () => void;
  /** Test seam: forgets everything without touching the backend. */
  reset: () => void;
}

let seq = 0;
let inFlightLoad: Promise<LspServerInfo[]> | null = null;
const pendingStarts = new Map<string, Promise<LSPClient | null>>();
const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Ids we asked to stop: their exit is not a failure. */
const stopping = new Set<string>();
let exitWatch: Promise<() => void> | null = null;

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function tearDown(entry: ClientEntry) {
  try {
    entry.client.disconnect();
  } catch {
    /* already gone */
  }
  entry.transport.dispose();
}

export const useLsp = create<LspState>((set, get) => {
  const watchExits = () => {
    if (exitWatch) return;
    exitWatch = on.lspExit(({ id, code }) => {
      const entry = Object.values(get().clients).find((c) => c.id === id);
      if (!entry) return;
      tearDown(entry);
      const clients = { ...get().clients };
      delete clients[entry.key];
      if (stopping.delete(id)) {
        set({ clients });
        return;
      }
      const reason = t("{program} encerrou (código {code})", { program: entry.program, code: code ?? "?" });
      uiLog.warn(`lsp: ${reason}`);
      set({ clients, failed: { ...get().failed, [entry.key]: reason } });
      useUI
        .getState()
        .showToast(
          t(
            'O servidor de linguagem {program} parou. Reabra o arquivo depois de "Procurar de novo" em Configurações → Editor.',
            { program: entry.program },
          ),
          "error",
        );
    });
  };

  return {
    detected: null,
    loading: false,
    error: null,
    clients: {},
    failed: {},
    problems: NO_PROBLEMS,

    load: (refresh = false) => {
      if (inFlightLoad && !refresh) return inFlightLoad;
      if (!refresh && get().detected) return Promise.resolve(get().detected ?? []);
      set({ loading: true, error: null, ...(refresh ? { failed: {} } : {}) });
      const task = ipc
        .lspDetect(refresh)
        .then((list) => {
          set({ detected: list, loading: false });
          return list;
        })
        .catch((e) => {
          set({ loading: false, error: String(e) });
          uiLog.warn(`lsp: não consegui ler o catálogo de servidores: ${e}`);
          return [] as LspServerInfo[];
        })
        .finally(() => {
          if (inFlightLoad === task) inFlightLoad = null;
        });
      inFlightLoad = task;
      return task;
    },

    clientFor: async (root, languageId) => {
      // A catalog that could not be read is not read again per file: the
      // refresh button in Settings is the retry.
      const detected = get().detected ?? (get().error ? [] : await get().load());
      const server = serverFor(languageId, detected);
      if (!server) return null;
      const key = clientKey(root, server.program);
      const existing = get().clients[key];
      if (existing) return existing.client;
      if (get().failed[key]) return null;
      const pending = pendingStarts.get(key);
      if (pending) return pending;

      const start = (async () => {
        const id = `lsp-${++seq}`;
        try {
          await ipc.lspStart(id, server.program, server.args, root);
        } catch (e) {
          const reason = String(e);
          uiLog.warn(`lsp: ${server.program} não iniciou: ${reason}`);
          set({ failed: { ...get().failed, [key]: reason } });
          useUI
            .getState()
            .showToast(
              t("Não consegui iniciar {program}: {reason}", { program: server.program, reason }),
              "error",
            );
          return null;
        }
        watchExits();
        const transport = new IpcTransport(id);
        const client = new LSPClient({
          // The project-wide diagnostics feed. Deliberately answers `false`:
          // `serverDiagnostics()` from `languageServerExtensions` is the next
          // handler in the chain, and it is what paints the squiggles inside
          // the open document. Claiming the notification here would trade the
          // squiggles for the panel.
          notificationHandlers: {
            "textDocument/publishDiagnostics": (_client, params) => {
              const uri = params?.uri;
              if (typeof uri === "string") {
                set({ problems: receive(get().problems, root, uri, params?.diagnostics) });
              }
              return false;
            },
          },
          rootUri: rootUri(root),
          // Per server: a project indexer gets room for its first answer,
          // anything that reads one file keeps a short leash (`servers.ts`).
          timeout: requestTimeoutMs(server.program),
          extensions: languageServerExtensions(),
        });
        client.connect(transport);
        // A server that never answers `initialize` rejects here after the
        // timeout; nobody awaits it, so the rejection needs a home.
        client.initializing.catch((e) => {
          uiLog.warn(`lsp: ${server.program} não respondeu ao initialize: ${e}`);
        });
        const entry: ClientEntry = { key, id, root, program: server.program, client, transport };
        set({ clients: { ...get().clients, [key]: entry } });
        return client;
      })().finally(() => pendingStarts.delete(key));
      pendingStarts.set(key, start);
      return start;
    },

    pruneRoots: (openRoots) => {
      const open = new Set([...openRoots].map(normalizeRoot));
      const roots = new Set(Object.values(get().clients).map((c) => normalizeRoot(c.root)));
      for (const root of roots) {
        const timer = pruneTimers.get(root);
        if (open.has(root)) {
          if (timer) {
            clearTimeout(timer);
            pruneTimers.delete(root);
          }
          continue;
        }
        if (timer) continue;
        pruneTimers.set(
          root,
          setTimeout(() => {
            pruneTimers.delete(root);
            const clients = { ...get().clients };
            for (const entry of Object.values(clients)) {
              if (normalizeRoot(entry.root) !== root) continue;
              stopping.add(entry.id);
              tearDown(entry);
              delete clients[entry.key];
              void ipc.lspStop(entry.id).catch(() => stopping.delete(entry.id));
            }
            // The servers of this root are gone; so are their findings.
            set({ clients, problems: dropRoot(get().problems, root) });
          }, PRUNE_GRACE_MS),
        );
      }
    },

    stopAll: () => {
      for (const timer of pruneTimers.values()) clearTimeout(timer);
      pruneTimers.clear();
      for (const entry of Object.values(get().clients)) {
        stopping.add(entry.id);
        tearDown(entry);
        void ipc.lspStop(entry.id).catch(() => {});
      }
      set({ clients: {}, problems: NO_PROBLEMS });
    },

    reset: () => {
      for (const timer of pruneTimers.values()) clearTimeout(timer);
      pruneTimers.clear();
      pendingStarts.clear();
      stopping.clear();
      for (const entry of Object.values(get().clients)) tearDown(entry);
      inFlightLoad = null;
      if (exitWatch) {
        void exitWatch.then((u) => u());
        exitWatch = null;
      }
      set({
        detected: null,
        loading: false,
        error: null,
        clients: {},
        failed: {},
        problems: NO_PROBLEMS,
      });
    },
  };
});
