/**
 * Takes a picked element (Modo Design) to the composer of an agent that can
 * act on it. Shared by the canvas portal card and the pane browser tab — the
 * two are the same engine, and pointing at a button must mean the same thing
 * in both.
 *
 * The screenshot crop is captured here, *before* the composer opens: the
 * composer is a full-screen surface and the portal blanks under it — one
 * frame later there would be nothing left to photograph.
 *
 * Which agent: one **wired to this portal on the canvas**, first choice. The
 * connections are the bridge's access control, so the agent that can already
 * drive this portal is the one that should hear about it. Failing that, the
 * focused terminal — the user is looking at it. A pane browser has no wire,
 * so for it the focused terminal is the normal path, not a fallback.
 *
 * It lands in the composer instead of going straight down the PTY on purpose:
 * the description answers "which element", and only the user can answer "what
 * changes". The text ends on `O que muda aqui: ` with the caret after it.
 */
import { buildEdges } from "./bridgeCore";
import { formatGrab, grabLabel, type GrabPick } from "./grab";
import { ipc } from "./ipc";
import { baseName } from "./terminals";
import { useProjects } from "../stores/projectsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

export async function deliverGrab(
  portalId: string,
  pick: GrabPick,
  showToast: (message: string, kind?: "info" | "error") => void,
): Promise<void> {
  const projects = useProjects.getState();
  // Only the active group's canvas or panes are mounted, so the portal that
  // produced this pick lives in it.
  const groupId = projects.activeGroupId;
  if (!groupId) return;

  const canvas = projects.layoutOf(groupId).canvas;
  const terminals = projects.terminalsOf(groupId);
  const edges = buildEdges(canvas?.items ?? []);
  const wired = terminals.filter((t) => edges.get(portalId)?.has(t.id));
  const runtimes = useTerminals.getState().byId;

  const target =
    wired.find((t) => isLive(runtimes[t.id])) ??
    wired[0] ??
    terminals.find((t) => t.id === useUI.getState().focusedTerminalId) ??
    null;

  if (!target) {
    showToast(
      "Ligue este portal a um agente no canvas — ou foque um terminal — para mandar o elemento.",
      "error",
    );
    return;
  }

  // Best-effort: without the crop, the selector and the styles still answer
  // "which element" — a failed capture must not hold the message back.
  const shot = await ipc.portalGrabShot(portalId, pick.rect).catch(() => null);

  const ui = useUI.getState();
  const current = ui.composerDrafts[target.id] ?? "";
  const theText = formatGrab(pick, shot);
  ui.setComposerDraft(target.id, current ? `${current}\n\n${theText}` : theText);
  ui.focusTerminal(target.id, target.slot);
  ui.setComposerOpen(true);
  showToast(`${grabLabel(pick)} → ${baseName(target)}. Diga o que muda e envie.`);
}
