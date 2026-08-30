/**
 * Gathering a handoff and putting it in the composer (`lib/handoff.ts` writes
 * the message; this collects the four things it needs).
 *
 * It lands in the **composer**, not straight in another CLI, and that is the
 * whole design: handing work over is a decision, and the paragraph that does
 * it is worth reading and editing before it goes. The composer already knows
 * how to pick a destination, mention other agents and refuse a busy CLI —
 * this only fills the box.
 *
 * `yard handoff` is the same message without the pause, for when it is an
 * agent doing the handing over.
 */
import { handoffMessage } from "./handoff";
import { t } from "./i18n";
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { bestSessionFor } from "./sessionFind";
import { baseName } from "./terminals";
import { transcriptBlocks, type Block } from "./transcript";
import { hasSessions } from "../stores/agentsStore";
import { useChanges } from "../stores/changesStore";
import { useProjects } from "../stores/projectsStore";
import { COMPOSER_SCRATCH, useUI } from "../stores/uiStore";

export async function openHandoffFor(terminalId: string): Promise<void> {
  const s = useProjects.getState();
  const term = s.terminal(terminalId);
  if (!term) return;
  const group = s.groups.find((g) => g.id === term.groupId);
  const summary = group?.projectId
    ? useChanges.getState().gitByProject[group.projectId]
    : undefined;
  const role = s.layoutOf(term.groupId).canvas?.roles?.[term.id];

  // Best effort: a CLI that keeps no session file still hands over a useful
  // message — the role and the state of the tree are the half that saves the
  // most time, and neither comes from a transcript.
  let blocks: Block[] = [];
  try {
    if (term.agentId && hasSessions(term.agentId)) {
      const sessions = await ipc.listAgentSessions(term.agentId, term.cwd);
      const session = bestSessionFor(sessions, term.resume);
      if (session) blocks = transcriptBlocks(await ipc.sessionEvents(session.file));
    }
  } catch (e) {
    uiLog.warn(`bastão: não consegui ler a sessão de ${terminalId}: ${e}`);
  }

  const text = handoffMessage({
    from: baseName(term),
    role: role?.name ?? "",
    branch: summary?.branch ?? "",
    files: summary?.files.length ?? 0,
    additions: summary?.additions ?? 0,
    deletions: summary?.deletions ?? 0,
    blocks,
    left: "",
  });

  const ui = useUI.getState();
  // No destination on purpose: the box opens with the picker empty, because
  // choosing who takes over is the decision this whole gesture is about.
  ui.setComposerTarget(null);
  ui.setComposerDraft(COMPOSER_SCRATCH, text);
  ui.setComposerOpen(true);
  ui.showToast(
    t("Bastão montado a partir de {name} — escolha quem assume e revise antes de enviar.", {
      name: baseName(term),
    }),
  );
}
