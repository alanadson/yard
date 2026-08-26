/**
 * Adding a project to the workspace — the one path behind every door that
 * offers it ("Novo projeto", the first-run sheet).
 *
 * The rules are small and easy to get subtly wrong twice: the path is really
 * trimmed (a pasted trailing space once made a root that never matched its
 * canonical form again), the folder that is already in the workspace is
 * named, the disk is asked whether the path is a folder, and the store's own
 * dedupe is still honoured — the `await` on the disk is a window in which
 * another door may have added the same folder.
 */
import { t } from "./i18n";
import { ipc } from "./ipc";
import { sameRoot } from "./roots";
import { useProjects, type ProjectStyle } from "../stores/projectsStore";

/** The last segment of a path, on either separator; the path itself when there is none. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function validateProjectPath(
  raw: string,
  projects: readonly { name: string; path: string }[],
): { path: string } | { error: string } {
  const path = raw.trim();
  if (!path) return { error: t("Escolha uma pasta.") };
  const owner = projects.find((p) => sameRoot(p.path, path));
  if (owner) return { error: t("Essa pasta já está no workspace como “{name}”.", { name: owner.name }) };
  return { path };
}

export type CreateProjectResult = { ok: true; id: string } | { ok: false; error: string };

export async function createProject(input: {
  path: string;
  name?: string;
  style?: ProjectStyle;
}): Promise<CreateProjectResult> {
  const checked = validateProjectPath(input.path, useProjects.getState().projects);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { path } = checked;
  if (!(await ipc.isDirectory(path))) {
    return { ok: false, error: t("Esse caminho não existe ou não é uma pasta.") };
  }
  const name = input.name?.trim() || folderName(path);
  const id = useProjects.getState().addProject(name, path, input.style);
  if (!id) return { ok: false, error: t("Essa pasta já está no workspace.") };
  return { ok: true, id };
}
