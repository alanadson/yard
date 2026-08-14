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

import { ipc, on, type UnlistenFn } from "../lib/ipc";
import { useChanges } from "../stores/changesStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

export function useGlobalEvents() {
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    void (async () => {
      // 1. Who is already running?
      try {
        const alive = await ipc.listPtys();
        const store = useTerminals.getState();
        for (const p of alive) store.markRunning(p.id, p.pid);
      } catch (e) {
        console.warn("[yard] falha ao reconciliar PTYs", e);
      }
      if (cancelled) return;

      // 2. Resource HUD.
      unlisteners.push(
        await on.resources((tick) => {
          useTerminals.getState().applyResources(tick.perPty, {
            totalRssMb: tick.totalRssMb,
            availableMb: tick.systemAvailableMb,
            totalMb: tick.systemTotalMb,
          });
        }),
      );

      // 3. Feed of files touched in watched projects.
      unlisteners.push(
        await on.filesActivity((p) => {
          useChanges.getState().applyActivity(p);
        }),
      );

      // 4. "The agent finished" (§5.7).
      unlisteners.push(
        await on.agentIdle(async (p) => {
          useTerminals.getState().markFinished(p.id);
          const { prefs } = useUI.getState();
          if (!prefs.notifyOnFinish) return;

          const term = useProjects.getState().terminal(p.id);
          const project = term
            ? useProjects.getState().projectOfGroup(term.groupId)
            : undefined;
          const onde = project ? ` em ${project.name}` : "";
          try {
            let ok = await isPermissionGranted();
            if (!ok) ok = (await requestPermission()) === "granted";
            if (ok) {
              sendNotification({
                title: "Yard",
                body: `${p.title} terminou${onde}.`,
              });
            }
          } catch (e) {
            console.warn("[yard] notificacao indisponivel", e);
          }
        }),
      );
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);
}
