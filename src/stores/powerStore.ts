/**
 * Keep-awake mode ("modo energético" in the UI) — whether Yard keeps Windows
 * from suspending the PC and turning the display off.
 *
 * Three modes: `off` (Windows decides, the default), `always` (awake while
 * the app is open) and `agents` (awake only while some agent CLI is actually
 * working). The backend owns the OS side (`SetThreadExecutionState`, see
 * `power.rs`); this store owns the *decision* and only crosses the IPC when
 * the answer changes. The choice lives in kv (`power.mode`), like every
 * preference.
 *
 * "An agent is working" reuses the runtime mirror: an `agent`-kind terminal
 * whose process is up and that has not hit the idle latch (`finished`). The
 * latch is released by focusing the pane, so a freshness guard on the
 * activity heartbeat keeps a focused-but-quiet REPL from holding the PC
 * awake all night.
 */
import { create } from "zustand";

import { runBackground } from "../lib/background";
import { ipc } from "../lib/ipc";
import { persistPref, type PrefsSnapshot } from "../lib/prefs";
import { useProjects } from "./projectsStore";
import { getActivity, isLive, useTerminals } from "./terminalsStore";

export type PowerMode = "off" | "always" | "agents";

const KV_MODE = "power.mode";

/**
 * How often the `agents` answer is re-evaluated. Windows sleep timeouts are
 * measured in minutes; seconds of slack cost nothing — and a clock beats
 * subscribing to `byId`, which the resource tick rebuilds every second.
 */
const TICK_MS = 5_000;

/**
 * No output for this long = not working, whatever the latches say. A working
 * agent CLI repaints its spinner many times a second, so a genuine turn never
 * goes quiet for two minutes without `finished` latching first.
 */
const QUIET_MS = 2 * 60_000;

export function parseMode(raw: string | undefined): PowerMode {
  return raw === "always" || raw === "agents" || raw === "off" ? raw : "off";
}

/** Is any agent CLI mid-turn right now? */
export function agentWorking(now = Date.now()): boolean {
  const byId = useTerminals.getState().byId;
  return useProjects.getState().terminals.some((t) => {
    if (t.kind !== "agent") return false;
    const rt = byId[t.id];
    if (!rt || !isLive(rt) || rt.finished) return false;
    const { lastByteAt } = getActivity(t.id);
    // No byte yet = it just spawned; the banner is on its way.
    return lastByteAt === 0 || now - lastByteAt < QUIET_MS;
  });
}

interface PowerState {
  mode: PowerMode;
  /** Is the OS block applied right now? (feeds the title-bar dot) */
  engaged: boolean;
  load: (prefs: PrefsSnapshot) => void;
  setMode: (mode: PowerMode) => void;
}

export const usePower = create<PowerState>((set, get) => ({
  mode: "off",
  engaged: false,

  load: (prefs) => set({ mode: parseMode(prefs[KV_MODE]) }),

  setMode: (mode) => {
    if (mode === get().mode) return;
    set({ mode });
    persistPref(KV_MODE, mode, (error) =>
      console.warn("[yard] não consegui gravar o modo energético", error),
    );
  },
}));

/**
 * Starts the reconciler: recomputes the desired state on a clock in `agents`
 * mode (and on every store change, which covers `setMode` and `load`) and
 * tells the backend only on transitions. The cleanup releases the block:
 * HMR re-runs the App effect, and a stale `true` left on the backend's
 * dedicated thread would outlive every store on this side.
 */
export function startKeepAwake(): () => void {
  /** The screen half of what the backend holds right now. */
  let display = false;
  const push = (on: boolean, lit: boolean) => {
    display = lit;
    usePower.setState({ engaged: on });
    runBackground(() => ipc.setKeepAwake(on, lit), {
      error: (error) =>
        console.warn("[yard] não consegui aplicar o modo energético", error),
    });
  };
  // The clock only matters while the answer depends on the agents: "off"
  // and "always" are settled by the mode alone, and a 5 s re-read of every
  // terminal for them was work with no possible outcome.
  let timer: ReturnType<typeof setInterval> | null = null;
  const reconcile = () => {
    const s = usePower.getState();
    if (s.mode === "agents" && timer === null) timer = setInterval(reconcile, TICK_MS);
    if (s.mode !== "agents" && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const want = s.mode === "always" || (s.mode === "agents" && agentWorking());
    // "agents" keeps the PC from suspending and lets the screen sleep.
    const lit = want && s.mode === "always";
    if (want !== s.engaged || lit !== display) push(want, lit);
  };
  reconcile();
  const unsub = usePower.subscribe(reconcile);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    unsub();
    if (usePower.getState().engaged) push(false, false);
  };
}
