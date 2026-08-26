/**
 * Closing a terminal in the workspace also kills the process.
 *
 * Closing the *view* never kills anything (§4.3). Removing the terminal from
 * the tree is another story: with no owner in the UI, the PTY becomes an
 * orphan. That is why deleting a group, project, or tab goes through here.
 */
import { ask } from "@tauri-apps/plugin-dialog";

import { removeNodeAndEdges } from "./canvasOps";
import { commitCanvasExternal } from "./canvasWrite";
import { spawnEnvFor } from "./spawnEnv";
import { t } from "./i18n";
import { ipc, type PtyKind } from "./ipc";
import { retainLivePortals } from "./portalSpawn";
import { sendability } from "./sendable";
import { baseName } from "./terminals";
import { useBench } from "../stores/benchStore";
import { useBrowsers } from "../stores/browsersStore";
import { useChanges } from "../stores/changesStore";
import { useEditor } from "../stores/editorStore";
import { useNotes } from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";
import { useReview } from "../stores/reviewStore";
import { isLive, useTerminals } from "../stores/terminalsStore";

/**
 * Brings the persisted `alive` flag back in line with the backend.
 *
 * `alive` decides whether a pane auto-starts, and it is only cleared by
 * whoever *sees* the process go down — the mounted pane. A CLI that died in a
 * background tab, or while the UI was reloading, would keep the flag and come
 * back from the dead on the next launch. Run once, after the workspace loads:
 * anything `list_ptys` does not report is down.
 */
export async function reconcileAliveFlags(): Promise<void> {
  const alive = new Set((await ipc.listPtys()).map((p) => p.id));
  const store = useProjects.getState();
  for (const row of store.terminals) {
    if (row.alive && !alive.has(row.id)) {
      store.updateTerminal(row.id, { alive: false });
    }
  }
}

/**
 * Starts the process behind a card that has no view mounted yet (a floor
 * just created by fan-out, a `yard recruit --floor`). Geometry is a
 * default size: the user resizes the card later, and a PTY born at the
 * pane's real size would still be wrong the moment the canvas is zoomed.
 */
export async function startTerminalProcess(
  id: string,
  opts: {
    program: string;
    args: string[];
    cwd: string;
    kind: PtyKind;
    title: string;
  },
): Promise<void> {
  await ipc.spawnPty({
    id,
    program: opts.program,
    args: opts.args,
    cwd: opts.cwd,
    kind: opts.kind,
    title: opts.title,
    rows: 38,
    cols: 120,
    // The cache lifetime rides in the environment, which a PTY fixes at spawn
    // (`lib/spawnEnv.ts`).
    env: spawnEnvFor(id),
  });
  useProjects.getState().updateTerminal(id, { alive: true });
}

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

/**
 * Deletes a CLI: process, row in the workspace, **and its footprint on the
 * canvas**.
 *
 * That last part used to live only in `yard dismiss`, so the two ways of
 * deleting the same terminal left the group in different states: closing the
 * tab kept `nodes[id]`, `roles[id]`, the terminal's routines and every wire
 * pointing at it inside `layoutJson` forever. The wires render as nothing
 * (the layer skips a connection with a missing endpoint), which is exactly
 * why it went unnoticed while the group's persisted JSON grew, `yard routine
 * list` reported routines for terminals that no longer exist, and a floor
 * created with "clone the ground" inherited the debris.
 *
 * The canvas is cleared **before** the row leaves the store: `removeTerminal`
 * is what makes the id unresolvable, and `updateCanvas` needs the group.
 */
export async function closeTerminal(id: string): Promise<void> {
  await disposePty(id);
  const row = useProjects.getState().terminal(id);
  if (row) commitCanvasExternal(row.groupId, (c) => removeNodeAndEdges(c, id));
  useProjects.getState().removeTerminal(id);
}

/**
 * Deletes a CLI, asking first.
 *
 * The question used to appear **only** for a running process — "confirming the
 * removal of an already-dead tab is friction with nothing to protect". That
 * was wrong about what is at stake: a stopped CLI still owns the scrollback on
 * disk (`disposePty` forgets it), its card and wires on the canvas, its role
 * and its routines (`closeTerminal`). The whole product exists so that none of
 * that is lost, and the cheapest gesture in the app — a middle click on the
 * tab — was throwing it away without a word.
 *
 * Returns whether the terminal was actually closed.
 */
export async function confirmCloseTerminal(id: string): Promise<boolean> {
  const term = useProjects.getState().terminal(id);
  if (!term) return false;
  const alive = isLive(useTerminals.getState().byId[id]);
  const name = baseName(term);
  const ok = await ask(
    alive
      ? t(
          "Excluir “{name}”? O processo será encerrado e o histórico desta CLI, junto com o cartão e as conexões dela no canvas, vai embora.",
          { name },
        )
      : t(
          "Excluir “{name}”? O histórico desta CLI, o cartão e as conexões dela no canvas e as rotinas dela vão embora. Fechar a aba não apaga nada — só excluir.",
          { name },
        ),
    { title: t("Excluir CLI"), kind: "warning" },
  );
  if (!ok) return false;
  await closeTerminal(id);
  return true;
}

/**
 * Killing or restarting an agent **mid-work** asks first.
 *
 * The two actions lived in the menu with no friction at all, one line below
 * "Suspender" — and a slipping finger takes down the process tree of an agent
 * in the middle of a refactor. The turn in progress does not come back.
 *
 * The question only appears when there is something to protect: with the CLI
 * idle at the prompt (or already dead) killing costs nothing, and asking
 * there would be the causeless friction the app avoids everywhere. Who
 * answers "is it busy?" is the same `sendability` the five text senders use.
 */
async function confirmInterrupt(
  id: string,
  theTitle: string,
  verb: string,
): Promise<boolean> {
  const term = useProjects.getState().terminal(id);
  if (!term) return false;
  const state = sendability(id);
  // `busy` = wrote bytes seconds ago; `blocked` = stopped at a question that
  // is still on screen. In both cases there is work (or a decision) to lose;
  // in the others, there is not.
  if (state.ok || (state.reason !== "busy" && state.reason !== "blocked")) {
    return true;
  }
  const name = baseName(term);
  return ask(
    state.reason === "busy"
      ? t(
          "{name} está trabalhando agora. {verb} interrompe a tarefa em andamento — o que já foi feito no disco fica, o turno não volta.",
          { name, verb },
        )
      : t("{name} está parado esperando uma resposta sua. {verb} descarta a pergunta que está na tela.", {
          name,
          verb,
        }),
    { title: theTitle, kind: "warning" },
  );
}

/** Restarts the CLI, asking if it is in the middle of something. */
export async function confirmRestartTerminal(id: string): Promise<boolean> {
  return confirmInterrupt(id, t("Reiniciar CLI"), t("Reiniciar"));
}

/** Kills the process tree, asking if it is in the middle of something. */
export async function confirmKillTerminal(id: string): Promise<boolean> {
  return confirmInterrupt(id, t("Matar processo"), t("Matar o processo"));
}

/**
 * Asks before wiping a terminal's scrollback.
 *
 * "Limpar terminal" sat in the menu with a neutral label, no danger styling
 * and no question, two items below "Colar no terminal" — and it throws away
 * the agent's whole trail, which is the one artifact this app exists to keep.
 * The gesture is one click; the loss is unrecoverable.
 */
export async function confirmClearTerminal(id: string): Promise<boolean> {
  const term = useProjects.getState().terminal(id);
  const name = term ? baseName(term) : t("este terminal");
  return ask(
    t(
      "Limpar o histórico de “{name}”? Tudo o que já foi escrito nele some daqui e do disco — não dá para desfazer. O processo continua rodando.",
      { name },
    ),
    { title: t("Limpar terminal"), kind: "warning" },
  );
}

/**
 * Deletes the group and every CLI inside it.
 *
 * The portals go too. Their engines are OS-level browser processes that a
 * card only ever *hides* on unmount — so a group closed with two portals on
 * its canvas used to leave two WebView2 running for the rest of the session,
 * invisible and unreachable. `retainLivePortals` runs after the group is gone
 * from the store, which is what makes its cards count as orphans.
 */
export async function closeGroup(groupId: string): Promise<void> {
  const ids = useProjects
    .getState()
    .terminals.filter((t) => t.groupId === groupId)
    .map((t) => t.id);
  await Promise.all(ids.map(disposePty));
  useProjects.getState().removeGroup(groupId);
  // The files open in this group's panes go too. Left behind they point at a
  // `groupId` nothing resolves: no pane ever draws them again, but they keep
  // being restored at every boot and keep showing up in the "unsaved files"
  // warning on the way out — a file the user cannot open to save.
  useEditor.getState().dropScope({ groupId });
  // And the browser tabs in those panes — rows and engines together.
  useBrowsers.getState().dropGroups([groupId]);
  // The notebook's dock, if it lived here, falls back to the overlay.
  useNotes.getState().dropGroups([groupId]);
  await retainLivePortals();
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
  // The tabs open on this project's files — same reason as `closeGroup`, and
  // the editor was the last store still keeping its rows after the id that
  // explains them had left the workspace.
  useEditor.getState().dropScope({ projectId });
  // The browser tabs hang from the groups, computed above before they left.
  useBrowsers.getState().dropGroups(gids);
  // The notebook's dock too, when its group belonged to this project.
  useNotes.getState().dropGroups(gids);
  // The bench keeps its tasks in a kv of its own, so nothing above touches
  // them: left behind, they would be invisible forever (no project to show
  // them under) and still counted in "Todas".
  useBench.getState().dropProject(projectId);
  // Same for the diff annotations: their own kv, keyed by a project id that
  // will never resolve again. Nothing would ever show or delete them.
  useReview.getState().clearProject(projectId);
  // And the per-project caches the feed and `git status` accumulate.
  useChanges.getState().dropProject(projectId);
  await retainLivePortals();
}
