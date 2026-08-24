/**
 * Browser tabs in the pane grid — the portal engine, worn as a tab.
 *
 * A portal card on the canvas and a browser tab in a pane are the same object
 * underneath: one WebView2 in the backend registry, keyed by id. What this
 * store adds is the *tab* life — which pane it lives in, which URL it is on,
 * and surviving a restart (kv `panes.browsers`). The rows here are also what
 * `retainLivePortals` counts as "still owned": a tab removed from this list
 * without closing its engine would leak a browser process with no UI left to
 * reach it, exactly like a canvas card erased by an undo.
 */
import { create } from "zustand";
import { nanoid } from "nanoid";

import { ipc, on } from "../lib/ipc";
import { persistJsonPref, readPrefs, type PrefsSnapshot } from "../lib/prefs";
import { normalizePortalUrl } from "../lib/portals";
import type { PortalStorage } from "../lib/canvas";
import { useEditor } from "./editorStore";
import { useProjects } from "./projectsStore";
import { useUI } from "./uiStore";

export interface PaneBrowser {
  id: string;
  groupId: string;
  slot: number;
  url: string;
  /** Last title the page reported — the tab's label when present. */
  title?: string;
  /** User-given name; wins over the page's title. */
  name?: string;
  ua?: string;
  storage?: PortalStorage;
  muted?: boolean;
  /** Auto-reload when a local address starts serving something new. */
  live?: boolean;
}

const KV_TABS = "panes.browsers";

const STORAGES: PortalStorage[] = ["instance", "workspace", "global"];

/** kv gives back text; never trust the saved format. */
export function parsePaneBrowsers(raw: string | undefined): PaneBrowser[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PaneBrowser[] = [];
  for (const v of parsed) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    if (typeof r.groupId !== "string" || !r.groupId) continue;
    if (typeof r.url !== "string" || !r.url) continue;
    const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
    out.push({
      id: r.id,
      groupId: r.groupId,
      slot: typeof r.slot === "number" && Number.isFinite(r.slot) ? Math.max(0, r.slot | 0) : 0,
      url: r.url,
      title: str(r.title),
      name: str(r.name),
      ua: str(r.ua),
      storage: STORAGES.includes(r.storage as PortalStorage)
        ? (r.storage as PortalStorage)
        : undefined,
      muted: r.muted === true ? true : undefined,
      live: typeof r.live === "boolean" ? r.live : undefined,
    });
  }
  return out;
}

/** Writes without blocking the UI (and without exploding outside Tauri). */
const persist = (tabs: PaneBrowser[]) =>
  persistJsonPref(KV_TABS, tabs, (error) =>
    console.warn(`[yard] não consegui gravar ${KV_TABS}`, error),
  );

interface BrowsersState {
  tabs: PaneBrowser[];
  load: (prefs?: PrefsSnapshot) => Promise<void>;
  /** Drops rows whose group left the workspace while nobody was looking. */
  prune: () => void;
  /** Creates a tab (default `about:blank`) and makes it the pane's active one. */
  open: (input: { groupId: string; slot: number; url?: string }) => string;
  patch: (id: string, p: Partial<Omit<PaneBrowser, "id">>) => void;
  /**
   * Moves the tab to another pane (or another position in the same bar),
   * landing right before the tab `beforeId` — or at the end of that pane's
   * section when `beforeId` is null.
   */
  move: (id: string, groupId: string, slot: number, beforeId?: string | null) => void;
  close: (id: string) => void;
  /** Group(s) leaving the workspace — rows and engines go together. */
  dropGroups: (groupIds: Iterable<string>) => void;
}

export const useBrowsers = create<BrowsersState>((set, get) => ({
  tabs: [],

  load: async (prefs) => {
    try {
      const raw = prefs ?? (await readPrefs());
      set({ tabs: parsePaneBrowsers(raw[KV_TABS]) });
    } catch (e) {
      console.warn("[yard] não consegui carregar as abas de navegador", e);
    }
  },

  prune: () => {
    const groups = new Set(useProjects.getState().groups.map((g) => g.id));
    const tabs = get().tabs.filter((t) => groups.has(t.groupId));
    if (tabs.length === get().tabs.length) return;
    set({ tabs });
    persist(tabs);
  },

  open: ({ groupId, slot, url }) => {
    const id = nanoid(8);
    const href = url ? normalizePortalUrl(url) || "about:blank" : "about:blank";
    const tabs = [...get().tabs, { id, groupId, slot, url: href }];
    set({ tabs });
    persist(tabs);
    // Active like a document, not like a CLI: the pane's bar points here, and
    // the focused *terminal* is cleared so keys do not keep going to one.
    useProjects.getState().setActiveTab(groupId, slot, id);
    useUI.getState().focusTerminal(null, slot);
    return id;
  },

  patch: (id, p) => {
    const tabs = get().tabs.map((t) => (t.id === id ? { ...t, ...p } : t));
    set({ tabs });
    persist(tabs);
  },

  move: (id, groupId, slot, beforeId = null) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || beforeId === id) return;
    if (tab.groupId === groupId && tab.slot === slot && beforeId === null) return;
    // Per-pane order is the array order, exactly like the editor's docs.
    const rest = get().tabs.filter((t) => t.id !== id);
    let i = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
    if (i < 0) i = rest.length;
    const tabs = [...rest.slice(0, i), { ...tab, groupId, slot }, ...rest.slice(i)];
    set({ tabs });
    persist(tabs);
    useProjects.getState().setActiveTab(groupId, slot, id);
    useUI.getState().focusTerminal(null, slot);
  },

  close: (id) => {
    const closed = get().tabs.find((t) => t.id === id) ?? null;
    const tabs = get().tabs.filter((t) => t.id !== id);
    set({ tabs });
    persist(tabs);
    // Closing the tab closes the page. Unmounting alone only hides the
    // engine — that is right for a group switch, wrong for an X.
    void ipc.portalClose(id).catch(() => {});
    if (!closed) return;
    // The pane's bar pointed at this tab: hand it to a neighbour in the same
    // pane — another browser, a CLI, a document — before it points at nothing.
    const { layoutOf, setActiveTab, terminalsOn } = useProjects.getState();
    if (layoutOf(closed.groupId).activeBySlot[closed.slot] !== id) return;
    const other = tabs.find(
      (t) => t.groupId === closed.groupId && t.slot === closed.slot,
    );
    const terminal = terminalsOn(closed.groupId, "grid").find(
      (t) => t.slot === closed.slot,
    );
    const doc = useEditor
      .getState()
      .docs.find((d) => d.groupId === closed.groupId && d.slot === closed.slot);
    if (other) {
      setActiveTab(closed.groupId, closed.slot, other.id);
    } else if (terminal) {
      setActiveTab(closed.groupId, closed.slot, terminal.id);
      useUI.getState().focusTerminal(terminal.id, closed.slot);
    } else if (doc) {
      setActiveTab(closed.groupId, closed.slot, doc.id);
    }
  },

  dropGroups: (groupIds) => {
    const outside = new Set(groupIds);
    const orphaned = get().tabs.filter((t) => outside.has(t.groupId));
    if (orphaned.length === 0) return;
    const tabs = get().tabs.filter((t) => !outside.has(t.groupId));
    set({ tabs });
    persist(tabs);
    // `retainLivePortals` would catch these too, but only if it runs and
    // succeeds — closing here keeps the engines' fate tied to the rows'.
    for (const t of orphaned) void ipc.portalClose(t.id).catch(() => {});
  },
}));

/**
 * The page-side events a tab has to hear even while its pane is not mounted:
 * a redirect in a background group must move the stored URL, or the next
 * mount would navigate the page *back* to the address it left.
 *
 * Registered once at boot (`App`), beside the bridge — per-component
 * listeners would go deaf the moment the component unmounts.
 */
export function watchPaneBrowserEvents(): () => void {
  let gone = false;
  const unsubs: Array<() => void> = [];
  const keep = (u: () => void) => {
    if (gone) u();
    else unsubs.push(u);
  };
  void on
    .portalNav((p) => {
      if (gone) return;
      const tab = useBrowsers.getState().tabs.find((t) => t.id === p.id);
      if (!tab) return;
      useBrowsers.getState().patch(tab.id, {
        url: p.url,
        ...(p.title !== null ? { title: p.title } : {}),
      });
    })
    .then(keep);
  void on
    .portalPopup((p) => {
      if (gone) return;
      // window.open in a pane browser opens a tab beside it — the same
      // gesture a real browser answers with, minus the popup window.
      const parent = useBrowsers.getState().tabs.find((t) => t.id === p.parentId);
      if (!parent) return;
      useBrowsers.getState().open({ groupId: parent.groupId, slot: parent.slot, url: p.url });
    })
    .then(keep);
  return () => {
    gone = true;
    unsubs.forEach((u) => u());
  };
}
