/**
 * The tray icon's tooltip and the summon hotkey, kept alive from the UI.
 *
 * The icon itself is built in Rust (`tray.rs`) — this side only feeds it:
 * the counts of blocked and running agents when they change (debounced,
 * because a fan-out flips six runtimes in one tick), and the global hotkey
 * from the preference, registered through the global-shortcut plugin and
 * re-registered whenever the user changes it in Settings. "Sair" picked in
 * the tray menu arrives as an event and runs the window's own exit flow
 * (`lib/quit.ts`), so quitting from the tray saves exactly what the X does.
 */
import { useEffect } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";

import { ipc, on } from "../lib/ipc";
import { uiLog } from "../lib/log";
import { requestQuit } from "../lib/quit";
import { normalizeHotkey, sameStatus, trayStatus, type TrayStatus } from "../lib/tray";
import { useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

const STATUS_DEBOUNCE_MS = 300;

export function useTray() {
  const hotkey = useUI((s) => s.prefs.summonHotkey);

  // --- tooltip ------------------------------------------------------------
  useEffect(() => {
    let last: TrayStatus = { blocked: -1, running: -1 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      const next = trayStatus(useTerminals.getState().byId);
      if (sameStatus(next, last)) return;
      last = next;
      ipc.traySetStatus(next.blocked, next.running).catch((e) => {
        uiLog.warn(`bandeja: não consegui atualizar a dica: ${e}`);
      });
    };
    push();
    const unsubscribe = useTerminals.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, STATUS_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // --- summon hotkey ------------------------------------------------------
  useEffect(() => {
    const accelerator = hotkey.trim() ? normalizeHotkey(hotkey) : null;
    if (!accelerator) return;
    let registered = false;
    register(accelerator, (event) => {
      if (event.state !== "Pressed") return;
      ipc
        .windowSummon()
        .then((did) => uiLog.info(`atalho global: ${did}`))
        .catch((e) => uiLog.warn(`atalho global: falha ao trazer a janela: ${e}`));
    })
      .then(() => {
        registered = true;
        uiLog.info(`atalho global registrado: ${accelerator}`);
      })
      .catch((e) => {
        // Taken by another app, or left behind by a reload: the hotkey then
        // fires nothing, and the log is where that shows.
        uiLog.warn(`atalho global ${accelerator} não registrado: ${e}`);
      });
    return () => {
      if (!registered) return;
      unregister(accelerator).catch(() => {});
    };
  }, [hotkey]);

  // --- "Sair" from the tray menu ------------------------------------------
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    on.trayQuit(() => {
      if (!requestQuit()) uiLog.warn("bandeja: Sair antes do boot terminar — ignorado");
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        /* outside Tauri (tests) */
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
