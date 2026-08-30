/**
 * The boundary of the reconciliation: it reads git and the disk, hands the
 * facts to `reconcile()` and says what came back.
 *
 * It runs once at boot, after the workspace is loaded, because that is the
 * moment the app's picture of its fronts is at its oldest: whatever happened
 * while it was closed (a folder deleted from Explorer, a repository moved, a
 * batch that died mid-`worktree add`) happened without anyone watching.
 *
 * It writes nothing. Not a prune, not an adoption, not a removal. The most it
 * does is put a sentence in front of a person, and everything else goes to
 * the log where it can be read on purpose.
 */
import { ipc } from "../ipc";
import { uiLog } from "../log";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { t } from "../i18n";
import { reconcile, type FrontRecord, type Reconciliation } from "./reconcile";

/** The isolated fronts of one project, as the app has them written down. */
function frontsOf(projectId: string): FrontRecord[] {
  const s = useProjects.getState();
  const out: FrontRecord[] = [];
  for (const g of s.groupsOf(projectId)) {
    const floor = s.floorOf(g.id);
    if (floor.kind !== "isolated" || !floor.worktreePath) continue;
    out.push({
      groupId: g.id,
      name: g.name,
      path: floor.worktreePath,
      adopted: floor.adopted === true,
    });
  }
  return out;
}

/** One project's reading, or `null` when there was nothing to read. */
export async function reconcileProject(
  projectId: string,
  projectPath: string,
): Promise<Reconciliation | null> {
  const fronts = frontsOf(projectId);
  const worktrees = await ipc.worktreeList(projectPath).catch(() => []);
  if (fronts.length === 0 && worktrees.length <= 1) return null;

  const paths = [...new Set([projectPath, ...fronts.map((f) => f.path), ...worktrees.map((w) => w.path)])];
  const exists = Object.fromEntries(
    await Promise.all(
      paths.map(async (p) => [p, await ipc.isDirectory(p).catch(() => false)] as const),
    ),
  );
  return reconcile({ groundPath: projectPath, fronts, worktrees, exists });
}

/**
 * Every project, at boot.
 *
 * The toast is spent only on a front that lost its folder or its git entry.
 * A worktree nobody opened is a fact about the repository, not a problem with
 * the app, and a boot that opens with a warning about somebody's own
 * `git worktree add` is a boot people learn to click past.
 */
export async function reconcileFronts(): Promise<void> {
  const projects = useProjects.getState().projects;
  const hurt: string[] = [];

  for (const project of projects) {
    let reading: Reconciliation | null;
    try {
      reading = await reconcileProject(project.id, project.path);
    } catch (e) {
      uiLog.warn(`não consegui reconciliar as frentes de "${project.name}": ${e}`); // i18n-ok: log line
      continue;
    }
    if (!reading) continue;

    if (reading.unregistered.length) {
      uiLog.info(
        `"${project.name}": ${reading.unregistered.length} worktree(s) sem frente ` + // i18n-ok: log line
          `(${reading.unregistered.map((w) => w.path).join(", ")})`,
      );
    }
    if (reading.prunable.length) {
      uiLog.info(
        `"${project.name}": ${reading.prunable.length} registro(s) de worktree apontam ` + // i18n-ok: log line
          `para pasta que não existe (${reading.prunable.join(", ")}); \`git worktree prune\` limparia`,
      );
    }
    if (reading.needsAttention) {
      uiLog.warn(`"${project.name}": ${reading.summary}`); // i18n-ok: log line
      hurt.push(`${project.name}: ${reading.summary}`);
    }
  }

  if (hurt.length) {
    useUI
      .getState()
      .showToast(
        t("Frentes fora do lugar: {detail}", { detail: hurt.join(" | ") }),
        "error",
      );
  }
}
