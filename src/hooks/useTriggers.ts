/**
 * The runtime side of triggers (`lib/triggers.ts`): watches the terminals'
 * runtime mirror, turns each snapshot pair into edges, and delivers the
 * actions of whatever trigger is due — a prompt typed into another CLI (through
 * the same sendability gate a routine goes through), a native notification, or
 * a flow started on the terminal that fired.
 *
 * The stamp (`lastRunAt`, `enabled` for a one-shot) is written *before* the
 * delivery starts: the delivery waits on the target being idle, and a second
 * edge arriving meanwhile must find the trigger already spent. Failures are
 * reported with a toast and stay stamped — the cooldown is the retry policy,
 * not the failure.
 */
import { useEffect } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { commitCanvasExternal } from "../lib/canvasWrite";
import { findFlow } from "../lib/flow";
import { startFlow } from "../lib/flowRun";
import { t } from "../lib/i18n";
import { injectPrompt } from "../lib/inject";
import { uiLog } from "../lib/log";
import { pushOut } from "../lib/notifyOut";
import { waitUntilSendable } from "../lib/sendable";
import { baseName } from "../lib/terminals";
import {
  afterFire,
  dueTriggers,
  renderText,
  transitions,
  type TriggerFire,
} from "../lib/triggers";
import type { TriggerDef } from "../lib/canvas";
import { useProjects } from "../stores/projectsStore";
import { useTerminals, type TerminalRuntime } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";

/** Deliveries in progress, by trigger id — an edge never overlaps its own delivery. */
const inFlight = new Set<string>();

async function notifyUser(body: string): Promise<void> {
  useUI.getState().showToast(body);
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title: t("Yard — gatilho"), body });
    pushOut(t("Yard, gatilho"), body, "trigger");
  } catch (e) {
    // Lacking notification permission is not a trigger failure: the toast landed.
    uiLog.warn(`gatilho: notificação indisponível: ${e}`);
  }
}

async function deliver(groupId: string, def: TriggerDef, fire: TriggerFire): Promise<void> {
  const s = useProjects.getState();
  const source = s.terminal(fire.terminalId);
  const name = source ? baseName(source) : t("(CLI removida)");
  const ctx = { name, ask: fire.ask ?? null };

  switch (def.action.kind) {
    case "ask": {
      const target = s.terminal(def.action.targetId);
      if (!target) throw new Error(t("a CLI alvo não existe mais"));
      const gate = await waitUntilSendable(target.id);
      if (!gate.ok) throw new Error(gate.message ?? `${baseName(target)}: ${gate.reason ?? t("indisponível")}`); // i18n-ok — a name and a reason, both already in the user's language
      await injectPrompt(target.id, renderText(def.action.text, ctx));
      return;
    }
    case "notify":
      await notifyUser(renderText(def.action.text, ctx));
      return;
    case "flow": {
      const flow = findFlow(s.layoutOf(groupId).canvas, def.action.flowId);
      if (!flow) throw new Error(t("o fluxo não existe mais neste grupo"));
      const terminalId = def.sourceId === "*" ? fire.terminalId : def.sourceId;
      const r = startFlow(groupId, flow, renderText(def.action.text, ctx), { terminalId });
      if (!r.ok) throw new Error(r.message);
      return;
    }
  }
}

function fireFor(id: string, fire: TriggerFire): void {
  const s = useProjects.getState();
  const row = s.terminal(id);
  if (!row) return;
  const groupId = row.groupId;
  const defs = s.layoutOf(groupId).canvas?.triggers;
  if (!defs?.length) return;
  const now = Date.now();
  const due = dueTriggers(defs, { ...fire, terminalId: id }, now).filter((d) => !inFlight.has(d.id));
  if (!due.length) return;

  const ids = new Set(due.map((d) => d.id));
  commitCanvasExternal(groupId, (c) => ({
    ...c,
    triggers: (c.triggers ?? []).map((t) => (ids.has(t.id) ? afterFire(t, now) : t)),
  }));

  for (const def of due) {
    inFlight.add(def.id);
    uiLog.info(`gatilho ${def.id} disparado por ${id} (${fire.event})`);
    void deliver(groupId, def, { ...fire, terminalId: id })
      .catch((e) => {
        uiLog.error(`gatilho ${def.id} falhou: ${e}`);
        useUI
          .getState()
          .showToast(
            t("O gatilho [{id}] não completou: {reason}", {
              id: def.id,
              reason: e instanceof Error ? e.message : String(e),
            }),
            "error",
          );
      })
      .finally(() => inFlight.delete(def.id));
  }
}

/**
 * The one edge that does not come from a terminal: the day's spend crossing
 * the ceiling (`lib/budget.ts`, `hooks/useBudgetWatch.ts`). It fires on every
 * group of the workspace, because the budget is the workspace's, and only
 * triggers armed for "qualquer CLI" can match a fire with no source.
 *
 * A `flow` action is skipped rather than run: a flow runs *on the CLI that
 * fired*, and this one fired on nobody. `parseTriggerCreate` refuses that
 * combination too, so this only catches a board written by an older build.
 */
export function fireBudgetEdge(level: "warn" | "over"): void {
  const s = useProjects.getState();
  const now = Date.now();
  const fire: TriggerFire = { event: "budget", terminalId: "", ask: level };
  for (const group of s.groups) {
    const defs = s.layoutOf(group.id).canvas?.triggers;
    if (!defs?.length) continue;
    const due = dueTriggers(defs, fire, now).filter(
      (d) => !inFlight.has(d.id) && d.action.kind !== "flow",
    );
    if (!due.length) continue;

    const ids = new Set(due.map((d) => d.id));
    commitCanvasExternal(group.id, (c) => ({
      ...c,
      triggers: (c.triggers ?? []).map((t) => (ids.has(t.id) ? afterFire(t, now) : t)),
    }));

    for (const def of due) {
      inFlight.add(def.id);
      uiLog.info(`gatilho ${def.id} disparado pelo orçamento (${level})`);
      void deliver(group.id, def, fire)
        .catch((e) => uiLog.error(`gatilho ${def.id} falhou: ${e}`))
        .finally(() => inFlight.delete(def.id));
    }
  }
}

export function useTriggers() {
  useEffect(() => {
    const unsubscribe = useTerminals.subscribe((state, previous) => {
      const next = state.byId;
      const prev: Record<string, TerminalRuntime> = previous.byId;
      if (next === prev) return;
      for (const [id, rt] of Object.entries(next)) {
        const before = prev[id];
        if (before === rt) continue;
        for (const fire of transitions(before, rt)) fireFor(id, fire);
      }
    });
    return unsubscribe;
  }, []);
}
