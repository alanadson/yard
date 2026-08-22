/**
 * Backend PTY events, watched for **every terminal in the workspace** — not
 * only the ones with a pane mounted on screen.
 *
 * These two subscriptions used to live inside `XTermView`, which means they
 * existed only while a pane was painting the terminal. Everything downstream
 * inherited that blind spot:
 *
 * - `pty://activity` feeds `markActivity`, which is what `sendability()` reads
 *   to answer "is this CLI busy?". With no view mounted the answer was always
 *   "free", so the composer, the bench, the diff review, the flow engine and —
 *   worst of all — the routine scheduler (built precisely for groups that are
 *   *not* on screen) would push a prompt into an agent mid-task, or onto a
 *   `(y/N)` whose answer becomes the injected Enter.
 * - `pty://exit` feeds `markExited`, which decides the badge, the "N alive"
 *   counts in the floors popover and the close dialog, whether `yard list`
 *   reports an agent as idle or stopped, and the persisted `alive` flag that
 *   auto-starts a pane on the next boot. A process that died in a background
 *   group stayed "running" for the rest of the session.
 *
 * The backend emits both for every PTY regardless of visibility (the pump only
 * slows the *output* coalescing down to 450 ms when hidden), so the fix is
 * simply to listen from outside the view. The view keeps what is genuinely
 * about painting: the `[processo encerrado]` line it writes into the screen.
 */
import { on, type UnlistenFn } from "./ipc";
import { forgetTyped } from "./flowIntercept";
import { uiLog } from "./log";
import { useAdvertised } from "../stores/advertisedStore";
import { useProjects } from "../stores/projectsStore";
import { clearTail, markActivity, useTerminals } from "../stores/terminalsStore";

/**
 * Idle time below which the process counts as actively writing. The heartbeat
 * runs every 450 ms (`ACTIVITY_MS` in `pty/reader.rs`), so anything under a
 * second means bytes arrived between two beats.
 */
const WRITING_MS = 1_000;

/**
 * Starts watching every terminal row, and keeps up as rows come and go.
 * Returns the teardown.
 */
export function startPtyWatch(): () => void {
  /** id -> the listeners being (or already) registered for it. */
  const watches = new Map<string, Promise<UnlistenFn[]>>();
  /** Signature of the id list, so a plain `updateTerminal` costs nothing. */
  let signature = "";
  let stopped = false;

  const drop = (id: string) => {
    const pending = watches.get(id);
    watches.delete(id);
    if (!pending) return;
    void pending
      .then((fns) => fns.forEach((off) => off()))
      .catch((e) => uiLog.warn(`falha ao soltar o watch de ${id}: ${e}`));
  };

  const add = (id: string) => {
    if (watches.has(id)) return;
    const pending = Promise.all([
      on.exit(id, (p) => {
        useTerminals.getState().markExited(id, p.code, p.reason);
        // What it was serving died with it — except across a restart, where
        // the same server is about to print the same address again.
        if (p.reason !== "restarted") useAdvertised.getState().forget(id);
        // The tail goes on every exit, restart included: what the dead run
        // left on screen is not what the new one is asking.
        clearTail(id);
        // The mirror of what was being typed dies with the process.
        forgetTyped(id);
      }),
      on.activity(id, (p) => {
        markActivity(id, p.lastByteAt, p.idleMs);
        // Writing again means the question was answered — and the answer does
        // not have to have come from the pane (`yard ask`, a routine, another
        // agent). The heartbeat is the cheap place to notice.
        if (p.idleMs < WRITING_MS) useTerminals.getState().clearBlocked(id);
      }),
    ]);
    watches.set(id, pending);
    // The row may have been removed (or the app torn down) while the two
    // listeners were still being registered.
    void pending
      .then((fns) => {
        if (stopped || watches.get(id) !== pending) fns.forEach((off) => off());
      })
      .catch((e) => uiLog.warn(`falha ao observar o terminal ${id}: ${e}`));
  };

  const sync = () => {
    const ids = useProjects.getState().terminals.map((t) => t.id);
    const next = ids.join("|");
    if (next === signature) return;
    signature = next;
    const alive = new Set(ids);
    for (const id of ids) add(id);
    for (const id of [...watches.keys()]) if (!alive.has(id)) drop(id);
  };

  sync();
  const unsubscribe = useProjects.subscribe(sync);

  return () => {
    stopped = true;
    unsubscribe();
    for (const id of [...watches.keys()]) drop(id);
  };
}
