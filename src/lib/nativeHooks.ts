/** Native hook events and boot snapshots share one monotonic receiver per page. */
import type { HookEvent } from "./hookEvents";
import { classifyPrompt } from "./blocked";
import { t } from "./i18n";
import { useTerminals } from "../stores/terminalsStore";

export interface NativeHookReport {
  terminalId: string;
  sequence: number;
  at?: number;
  event: HookEvent;
}

export function inferredIdleOutcome(phase: "working" | "permission" | "ready" | undefined, knownAsk: string | null | undefined, tail: string):
  { kind: "working" | "finished" } | { kind: "blocked" | "permission"; ask: string } {
  if (phase === "working") return { kind: "working" };
  if (phase === "permission") return { kind: "permission", ask: knownAsk || t("Pedindo permissão") };
  const detected = classifyPrompt(tail);
  return detected ? { kind: "blocked", ask: detected.ask } : { kind: "finished" };
}

export function applyInferredIdle(id: string, tail: string): ReturnType<typeof inferredIdleOutcome> {
  const mirror = useTerminals.getState();
  const current = mirror.byId[id];
  const inferred = inferredIdleOutcome(current?.hookPhase, current?.blockedAsk, tail);
  if (inferred.kind === "permission") mirror.markPermission(id, inferred.ask, current?.finishedAt);
  else if (inferred.kind === "blocked") mirror.markBlocked(id, inferred.ask);
  else if (inferred.kind === "finished") mirror.markFinished(id, current?.hookPhase === "ready" ? current.finishedAt : undefined);
  return inferred;
}

export function applyHookEvent(id: string, event: HookEvent, at?: number): void {
  const mirror = useTerminals.getState();
  if (event.kind !== "session") {
    mirror.patch(id, { hookPhase: event.kind === "permission" ? "permission" : event.kind === "turn-end" ? "ready" : "working" });
  }
  switch (event.kind) {
    case "turn-start": mirror.hookTurnStart(id); break;
    case "turn-end": mirror.markFinished(id, at); break;
    case "permission": mirror.markPermission(id, event.ask || t("Pedindo permissão"), at); break;
    case "working": mirror.hookWorking(id); break;
    case "session": break;
  }
}

export function createNativeHookReceiver(): { accept(value: unknown): boolean } {
  const latest = new Map<string, number>();
  return {
    accept(value) {
      if (!value || typeof value !== "object") return false;
      const report = value as Record<string, unknown>;
      if (typeof report.terminalId !== "string" || !report.terminalId.trim()
        || typeof report.sequence !== "number" || !Number.isSafeInteger(report.sequence) || report.sequence < 1
        || (report.at !== undefined && (typeof report.at !== "number" || !Number.isSafeInteger(report.at) || report.at < 0))
        || !report.event || typeof report.event !== "object") return false;
      const event = report.event as Record<string, unknown>;
      if (typeof event.kind !== "string" || !["turn-start", "turn-end", "permission", "working", "session"].includes(event.kind)
        || (event.kind === "permission" && typeof event.ask !== "string")) return false;
      if (report.sequence <= (latest.get(report.terminalId) ?? 0)) return false;
      latest.set(report.terminalId, report.sequence);
      applyHookEvent(report.terminalId, event as unknown as HookEvent, report.at as number | undefined);
      return true;
    },
  };
}
