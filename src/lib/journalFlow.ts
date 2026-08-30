/**
 * Gathering the day and writing it into a note (`lib/journal.ts` composes the
 * text).
 *
 * Three reads, all of things the app already has: the commits of the active
 * project since local midnight, the day's estimated spend, and the names of
 * the agents that are up. It lands in the markdown notebook because that is
 * where things that outlive a session live here — and because a note can be
 * edited, which is the point: the machine fills in what it knows so the
 * person only has to add why.
 */
import { journalMarkdown, type JournalCommit } from "./journal";
import { localDay, totals } from "./costs";
import { t } from "./i18n";
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { baseName } from "./terminals";
import { useNotes } from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

/** Commits are asked for in a page; a day past this is not a day. */
const LOG_LIMIT = 200;

export async function writeTodaysJournal(): Promise<void> {
  const s = useProjects.getState();
  const project = s.projects.find((p) => p.id === s.activeProjectId);
  if (!project) {
    useUI.getState().showToast(t("Abra um projeto antes de escrever o diário."), "error");
    return;
  }
  const now = new Date();
  const day = localDay(now);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  let commits: JournalCommit[] = [];
  try {
    const log = await ipc.scmLog(project.path, { limit: LOG_LIMIT });
    commits = log
      // `date` is epoch **seconds** from git; the cut is local midnight.
      .filter((c) => c.date * 1000 >= midnight)
      .map((c) => ({ hash: c.hash, subject: c.subject }));
  } catch (e) {
    // A folder with no git still has a day worth writing down.
    uiLog.warn(`diário: sem log de git em ${project.path}: ${e}`);
  }

  let spendUsd = 0;
  let spendPartial = false;
  try {
    const rows = await ipc.usageHistory(1);
    const sum = totals(rows.filter((row) => row.day === day));
    spendUsd = sum.costUsd ?? 0;
    spendPartial = !sum.priced;
  } catch (e) {
    uiLog.warn(`diário: sem custos: ${e}`);
  }

  const runtimes = useTerminals.getState().byId;
  const agents = s.terminals
    .filter((term) => term.kind === "agent" && isLive(runtimes[term.id]))
    .map((term) => baseName(term));

  const body = journalMarkdown({
    day,
    project: project.name,
    commits,
    spendUsd,
    spendPartial,
    agents: [...new Set(agents)],
  });

  const notes = useNotes.getState();
  const id = notes.createNote();
  notes.updateNote(id, { title: `${day} — ${project.name}`, body });
  notes.openView();
  useUI.getState().showToast(
    t("Diário de {day} criado nas Anotações.", { day }),
  );
}
