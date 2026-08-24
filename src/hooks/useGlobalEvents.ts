/**
 * Global subscriptions: resources, agent-finished, and session changes.
 *
 * Also does **post-reload reconciliation**: the UI may have been reloaded
 * (HMR, F5, WebView crash) while the processes stayed alive in Rust.
 * On boot we ask the backend who is running instead of assuming.
 */
import { useEffect } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { classifyPrompt, TAIL_CAP } from "../lib/blocked";
import { AsyncDisposer } from "../lib/disposables";
import { isFrontOnScreen } from "../lib/frontTab";
import { ipc, on } from "../lib/ipc";
import { shouldNotify } from "../lib/notifyAgent";
import { useChanges } from "../stores/changesStore";
import { useEditor } from "../stores/editorStore";
import { notesCenterVisible, notesOverlayVisible } from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";
import { readTail, useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";
import { useUsage } from "../stores/usageStore";

/**
 * Is this terminal **in view right now**?
 *
 * The native notification fired even with the window focused and the agent in
 * front of the pane: Windows popped a balloon saying what the user had just
 * watched happen. Noise like that teaches people to turn the feature off — and
 * whoever turns it off loses the notice that matters along with it (the agent
 * stuck in a group nobody is looking at).
 *
 * When in doubt, notify: only the clearly visible case is silenced.
 */
function isInFront(id: string): boolean {
  if (!document.hasFocus()) return false;
  const ui = useUI.getState();
  // Any surface covering the workspace takes the terminal out of view.
  if (ui.modal || ui.composerOpen || ui.paletteOpen) return false;
  if (useEditor.getState().open || useChanges.getState().viewer) return false;
  if (notesOverlayVisible() || notesCenterVisible()) return false;

  const s = useProjects.getState();
  const row = s.terminal(id);
  if (!row || row.groupId !== s.activeGroupId) return false;

  return isFrontOnScreen(
    s.layoutOf(row.groupId),
    row,
    s.terminalsOn(row.groupId, "grid"),
  );
}

export function useGlobalEvents() {
  useEffect(() => {
    const subscriptions = new AsyncDisposer((error) => {
      console.warn("[yard] falha ao remover listener global", error);
    });

    void (async () => {
      // 1. Who is already running? (Only the runtime mirror here: the
      //    persisted `alive` flag is reconciled in `App`, after the workspace
      //    has loaded — this effect runs before it and would see no rows.)
      try {
        const alive = await ipc.listPtys();
        const store = useTerminals.getState();
        for (const p of alive) store.markRunning(p.id, p.pid);
      } catch (e) {
        console.warn("[yard] falha ao reconciliar PTYs", e);
      }
      if (subscriptions.disposed) return;

      // 2. Resource HUD.
      await subscriptions.add(
        on.resources((tick) => {
          useTerminals.getState().applyResources(tick.perPty, {
            totalRssMb: tick.totalRssMb,
            availableMb: tick.systemAvailableMb,
            totalMb: tick.systemTotalMb,
          });
        }),
      );

      // 3. Feed of files touched in watched projects. The tree and the files
      //    open in the editor follow the same feed: whatever the agent writes
      //    shows up without anyone asking for a refresh.
      await subscriptions.add(
        on.filesActivity((p) => {
          useChanges.getState().applyActivity(p);
          useEditor.getState().applyActivity(p);
        }),
      );

      // 4. "The agent stopped" (§5.7) — and *why*.
      //
      //    The event is a timer: 4.5 s of silence. Silence alone cannot tell
      //    an agent that finished from one waiting at `(y/n)`, and those two
      //    do not deserve the same badge, the same words, or the same place
      //    in the attention queue. The text on screen can, so it is read here.
      await subscriptions.add(
        on.agentIdle(async (p) => {
          // The tail is fed by a mounted `XTermView`; a terminal in another
          // group has none. Asking the backend for the same bytes keeps the
          // off-screen agents — exactly the ones nobody is watching — from
          // being filed as "finished" by default.
          let tail = readTail(p.id);
          if (!tail) {
            try {
              tail = (await ipc.ptyReadSince(p.id, 0, TAIL_CAP)).data;
            } catch (e) {
              console.warn("[yard] falha ao ler a cauda do PTY", e);
            }
          }
          const asking = classifyPrompt(tail);

          if (asking) useTerminals.getState().markBlocked(p.id, asking.ask);
          else useTerminals.getState().markFinished(p.id);

          // Usage changes exactly when an agent finishes a turn — recheck
          // right away instead of waiting for the 60 s cycle.
          useUsage.getState().nudge();
          const { prefs } = useUI.getState();
          // Two reasons, two switches (`lib/notifyAgent.ts`): whoever turns
          // off the "finished" balloon is still told about the agent stopped
          // at a question.
          if (!shouldNotify(!!asking, prefs)) return;
          // The balloon is for whoever is not looking. Whoever is has seen it.
          if (isInFront(p.id)) return;

          const term = useProjects.getState().terminal(p.id);
          const project = term
            ? useProjects.getState().projectOfGroup(term.groupId)
            : undefined;
          const where = project ? ` em ${project.name}` : "";
          try {
            let ok = await isPermissionGranted();
            if (!ok) ok = (await requestPermission()) === "granted";
            if (ok) {
              sendNotification({
                title: "Yard",
                body: asking
                  ? `${p.title} está esperando você${where}: ${asking.ask}`
                  : `${p.title} terminou${where}.`,
              });
            }
          } catch (e) {
            console.warn("[yard] notificacao indisponivel", e);
          }
        }),
      );
      // 5. Agent usage limits (title bar).
      await subscriptions.add(
        on.usage((snap) => {
          useUsage.getState().apply(snap);
        }),
      );
      // The event only arrives for future changes; after a reload/HMR the
      // current snapshot has to be pulled.
      try {
        const snapshot = await ipc.usageSnapshot();
        if (!subscriptions.disposed) useUsage.getState().apply(snapshot);
      } catch (e) {
        console.warn("[yard] falha ao ler snapshot de uso", e);
      }
    })();

    // Came back to the window after running agents elsewhere? Recheck.
    const onFocus = () => useUsage.getState().nudge();
    window.addEventListener("focus", onFocus);

    return () => {
      subscriptions.dispose();
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
