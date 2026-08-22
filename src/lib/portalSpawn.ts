/**
 * Creating a portal from outside the canvas view.
 *
 * The `yard portal create` verb already did this for agents; the same gesture
 * is now reachable from the UI (a detected dev-server address, the Busca), and
 * the two must not drift — a portal opened one way and a portal opened the
 * other have to be the same object, with the same engine defaults.
 */
import { nanoid } from "nanoid";

import {
  autoNodeRect,
  PORTAL_DEFAULT_H,
  PORTAL_DEFAULT_W,
  type PortalStorage,
} from "./canvas";
import { addItems, connection } from "./canvasOps";
import { commitCanvasExternal } from "./canvasWrite";
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { normalizePortalUrl } from "./portals";
import { useBrowsers } from "../stores/browsersStore";
import { parseLayout, useProjects } from "../stores/projectsStore";

export interface PortalSpawn {
  id: string;
  url: string;
  engine?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ua?: string;
  storage?: PortalStorage;
  muted?: boolean;
  /**
   * Group the card lives in. It is what decides the project behind a
   * `storage: "workspace"` profile — reading the *active* project instead
   * meant a portal an agent created in another project's group got the cookie
   * jar of whatever the user happened to be looking at.
   */
  groupId?: string;
}

/** Boots the native webview behind a portal card. */
export async function openPortalEngine(p: PortalSpawn): Promise<void> {
  const projects = useProjects.getState();
  const projectId = p.groupId
    ? (projects.projectOfGroup(p.groupId)?.id ?? null)
    : projects.activeProjectId;
  await ipc.portalOpen({
    id: p.id,
    url: p.url,
    engine: p.engine ?? "webview2",
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    ua: p.ua ?? null,
    storage: p.storage ?? "instance",
    muted: p.muted ?? false,
    projectId,
  });
}

/**
 * Closes every engine whose card no longer exists on any canvas.
 *
 * Unmounting a `PortalCard` only *hides* the engine (1x1, invisible) — that is
 * deliberate, because leaving canvas mode or switching groups must not throw
 * away a page the user is watching. The cost was that every path which removes
 * a card **without** going through "excluir portal" leaked a live WebView2:
 * a `Ctrl+Z` past the card's creation, a score replacing the canvas, a group
 * or project deleted. Each one kept a browser process for the rest of the
 * session with nothing on screen to reach it.
 *
 * The backend registry is the authority on what is running, so the front end
 * only has to say what it still owns. Cheap enough to call on every one of
 * those paths: one IPC hop and a walk over the group list.
 */
export async function retainLivePortals(): Promise<void> {
  const { groups } = useProjects.getState();
  const keep: string[] = [];
  for (const g of groups) {
    for (const item of parseLayout(g.layoutJson).canvas?.items ?? []) {
      if (item.type === "portal") keep.push(item.id);
    }
  }
  // Browser tabs in the panes ride the same engine registry: without them in
  // `keep`, reconciling after a canvas undo would close the tab beside it.
  for (const t of useBrowsers.getState().tabs) keep.push(t.id);
  try {
    const closed = await ipc.portalRetain(keep);
    if (closed > 0) uiLog.info(`portais órfãos fechados: ${closed}`);
  } catch (e) {
    uiLog.warn(`não consegui reconciliar os portais abertos: ${e}`);
  }
}

/**
 * Puts a portal card on a group's canvas and, when a terminal is given, wires
 * it to that card.
 *
 * The wire is not decoration: connections are the bridge's access control, so
 * a portal born beside an agent is a portal that agent can already drive with
 * `yard portal snapshot/click/fill`.
 *
 * Returns the new card's id. Throws only if the engine refuses — the card is
 * on the canvas either way, which is what lets the user retry from the card.
 */
export async function spawnPortalNear(opts: {
  groupId: string;
  url: string;
  nearTerminalId?: string | null;
  name?: string;
}): Promise<string> {
  const projects = useProjects.getState();
  const canvas = projects.layoutOf(opts.groupId).canvas;
  const terminals = projects.terminalsOf(opts.groupId);

  const near = opts.nearTerminalId
    ? (canvas?.nodes?.[opts.nearTerminalId] ??
      autoNodeRect(terminals.findIndex((t) => t.id === opts.nearTerminalId)))
    : null;
  // No anchor: drop it where a new card would land, so it never covers one.
  const base = near ?? autoNodeRect(terminals.length + (canvas?.items.length ?? 0));
  // Portals already beside the anchor step down, instead of stacking exactly.
  const stacked = (canvas?.items ?? []).filter(
    (i) => i.type === "portal" && Math.abs(i.x - (base.x + base.w + 48)) < 4,
  ).length;

  const id = nanoid(8);
  const item = {
    id,
    type: "portal" as const,
    x: base.x + base.w + 48,
    y: base.y + stacked * 28,
    w: PORTAL_DEFAULT_W,
    h: PORTAL_DEFAULT_H,
    url: normalizePortalUrl(opts.url),
    color: "#f5f5f5",
    engine: "webview2",
    ...(opts.name ? { name: opts.name } : {}),
  };

  commitCanvasExternal(opts.groupId, (c) =>
    opts.nearTerminalId
      ? addItems(c, item, connection(opts.nearTerminalId, id))
      : addItems(c, item),
  );
  await openPortalEngine({ ...item, groupId: opts.groupId });
  return id;
}
