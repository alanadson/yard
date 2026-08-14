/**
 * Closing a terminal in the workspace also kills the process.
 *
 * Closing the *view* never kills anything (§4.3). Removing the terminal from
 * the tree is another story: with no owner in the UI, the PTY becomes an
 * orphan. That is why deleting a group, project, or tab goes through here.
 */
import { ask } from "@tauri-apps/plugin-dialog";

import { ipc } from "./ipc";
import { baseName } from "./terminals";
import { useProjects } from "../stores/projectsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";

/** Kills the PTY (if alive), forgets the scrollback and drops the runtime from memory. */
export async function disposePty(id: string): Promise<void> {
  try {
    if (await ipc.ptyExists(id)) await ipc.killPty(id);
  } catch {
    /* already dead */
  }
  try {
    await ipc.forgetPty(id);
  } catch {
    /* no scrollback on disk */
  }
  useTerminals.getState().forget(id);
}

/** Deletes a CLI: process + row in the workspace. */
export async function closeTerminal(id: string): Promise<void> {
  await disposePty(id);
  useProjects.getState().removeTerminal(id);
}

/**
 * Deletes a CLI, asking first when something is alive behind it.
 *
 * The question only appears for a running process: confirming the removal of
 * an already-dead tab is friction with nothing to protect. Returns whether
 * the terminal was actually closed.
 */
export async function confirmCloseTerminal(id: string): Promise<boolean> {
  const term = useProjects.getState().terminal(id);
  if (!term) return false;
  if (isLive(useTerminals.getState().byId[id])) {
    const ok = await ask(`Excluir “${baseName(term)}”? O processo será encerrado.`, {
      title: "Excluir CLI",
      kind: "warning",
    });
    if (!ok) return false;
  }
  await closeTerminal(id);
  return true;
}

/** Deletes the group and every CLI inside it. */
export async function closeGroup(groupId: string): Promise<void> {
  const ids = useProjects
    .getState()
    .terminals.filter((t) => t.groupId === groupId)
    .map((t) => t.id);
  await Promise.all(ids.map(disposePty));
  useProjects.getState().removeGroup(groupId);
}

/** Deletes the project and everything it carries. */
export async function closeProject(projectId: string): Promise<void> {
  const { groups, terminals, removeProject } = useProjects.getState();
  const gids = new Set(
    groups.filter((g) => g.projectId === projectId).map((g) => g.id),
  );
  const ids = terminals.filter((t) => gids.has(t.groupId)).map((t) => t.id);
  await Promise.all(ids.map(disposePty));
  removeProject(projectId);
}
