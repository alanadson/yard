/**
 * "Read this terminal's session" — the one gesture behind the tab menu, the
 * card menu and the palette.
 *
 * The decision (which trail is this terminal's) is `sessionFind.ts`; this is
 * the effect around it: list, pick, open the transcript sheet, or say why
 * there is nothing to read.
 */
import { t } from "./i18n";
import { ipc, type TerminalRow } from "./ipc";
import { bestSessionFor } from "./sessionFind";
import { baseName } from "./terminals";
import { transcriptTitle } from "./transcript";
import { hasSessions } from "../stores/agentsStore";
import { useUI } from "../stores/uiStore";

export async function openTranscriptFor(term: TerminalRow): Promise<void> {
  const ui = useUI.getState();
  if (term.kind !== "agent" || !term.agentId || !hasSessions(term.agentId)) {
    ui.showToast(t("Esta CLI não guarda a sessão em disco — não há transcrição para ler."));
    return;
  }
  try {
    const sessions = await ipc.listAgentSessions(term.agentId, term.cwd);
    const session = bestSessionFor(sessions, term.resume);
    if (!session) {
      ui.showToast(t("Nenhuma sessão em disco para este terminal ainda."));
      return;
    }
    ui.openModal("transcript", {
      file: session.file,
      title: `${baseName(term)} — ${transcriptTitle(session)}`,
    });
  } catch (e) {
    ui.showToast(t("Não consegui achar a sessão: {e}", { e: String(e) }), "error");
  }
}
