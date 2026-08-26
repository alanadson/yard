/**
 * "Take me to the agent that is waiting."
 *
 * This used to live inside `CanvasView`, which made the product's central
 * shortcut — answering whoever stopped to ask something — a feature of one
 * layout mode only. In Grid, with six panes open, the way there was hunting
 * for the yellow dot in the tree.
 *
 * The order is the same as before, and so is the reason: **whoever is blocked
 * goes first**, all of them, ahead of anyone who merely finished. An agent
 * stuck on a question burns time; one that finished does not.
 */
import { t } from "./i18n";
import { goToTerminal } from "./navigate";
import { useProjects } from "../stores/projectsStore";
import { useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";
import type { TerminalRow } from "./ipc";

/** Where the round stopped — the shortcut is a tour, not a jump to the same one every time. */
let step = 0;

/** Attention queue for a set of terminals: blocked ones first. */
function queue(pool: TerminalRow[]): TerminalRow[] {
  const rt = useTerminals.getState().byId;
  const blocked = pool.filter((t) => rt[t.id]?.blocked);
  const rest = pool.filter(
    (t) => !rt[t.id]?.blocked && (rt[t.id]?.finished || rt[t.id]?.unread),
  );
  return [...blocked, ...rest];
}

/**
 * Goes to the next agent asking for attention — in any layout mode.
 *
 * Starts with the group on screen, because that is where the user is working;
 * if nobody there is waiting, it searches the whole workspace instead of
 * saying there is nothing (the blocked agent may be on another floor).
 */
export function jumpToAttention(): void {
  const s = useProjects.getState();
  const ofGroup = s.activeGroupId ? queue(s.terminalsOf(s.activeGroupId)) : [];
  const targets = ofGroup.length ? ofGroup : queue(s.terminals);
  if (targets.length === 0) {
    useUI.getState().showToast(t("Nenhum agente pedindo atenção agora."));
    return;
  }
  goToTerminal(targets[step++ % targets.length]);
}
