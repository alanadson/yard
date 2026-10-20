/** Native execution records supplement saved routine definitions without overwriting edits. */
import type { RoutineDef } from "./canvas";

export interface RoutineExecution {
  groupId: string;
  routineId: string;
  routine: RoutineDef;
  status: "queued" | "uncertain" | "delivered" | "cancelled";
  scheduledAt: number;
  lastRunAt: number | null;
  queueId: string;
}

export type EffectiveRoutine = RoutineDef & { executionStatus?: RoutineExecution["status"] };

/**
 * Switching on is also the user's approval of a routine an agent created
 * (`awaitingApproval`), so the flag goes and does not come back.
 */
export function setRoutineEnabled(routine: RoutineDef, enabled: boolean, now: number): RoutineDef {
  const { awaitingApproval: _pending, ...approved } = routine;
  const base = enabled ? approved : routine;
  if (enabled && routine.once) {
    const { lastRunAt: _previousDelivery, ...definition } = base;
    return { ...definition, enabled, createdAt: now };
  }
  return { ...base, enabled };
}

export function routineExecutionView(routine: EffectiveRoutine): { label: string; message: string | null } {
  if (routine.once && routine.executionStatus === "delivered") return { label: " · entregue", message: "Lembrete entregue." };
  if (routine.once && routine.executionStatus === "cancelled") return { label: " · cancelada", message: "Ocorrência cancelada." };
  if (routine.executionStatus === "queued") return { label: "", message: "Pedido registrado na fila." };
  if (routine.executionStatus === "uncertain") return { label: "", message: "Confira a entrega na fila antes de reenviar." };
  return { label: routine.enabled ? "" : " · pausada", message: null };
}

export function effectiveRoutine(groupId: string, routine: RoutineDef, executions: readonly RoutineExecution[]): EffectiveRoutine {
  const report = executions.find((entry) => entry.groupId === groupId && entry.routineId === routine.id
    && (["terminalId", "text", "everyMin", "createdAt"] as const).every((field) => entry.routine?.[field] === routine[field])
    && !!entry.routine?.once === !!routine.once);
  if (!report) return routine;
  return { ...routine, executionStatus: report.status,
    ...(report.lastRunAt !== null ? { lastRunAt: Math.max(routine.lastRunAt ?? 0, report.lastRunAt) } : {}),
    enabled: routine.enabled && !(routine.once && (report.status === "delivered" || report.status === "cancelled")) };
}
