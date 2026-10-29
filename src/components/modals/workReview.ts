import type { DeliveryRecord, TaskEvent, WorkTask } from "../../lib/work";

export function reviewCandidates<T extends { id: string; kind: string }>(task: Pick<WorkTask, "status" | "links">, terminals: readonly T[]): T[] {
  const authors = new Set([...task.links.terminalIds, task.links.executorTerminalId]);
  return terminals.filter((terminal) => terminal.kind === "agent" && !authors.has(terminal.id));
}

// i18n-scan: result labels are translated by the renderer.
export function independentReviewLabel(review: { deliveryRevision: number; task: Pick<WorkTask, "status" | "criteria" | "delivery"> }, latestRevision: number): string {
  if (review.deliveryRevision !== latestRevision) return "Entrega anterior";
  if (review.task.status !== "in_review" && review.task.status !== "completed") return TASK_STATUS_LABELS[review.task.status] ?? "Estado desconhecido";
  const { delivery, criteria } = review.task;
  if (delivery) {
    if (delivery.checks.some((check) => !check.passed)) return "Precisa de ajustes";
    if (!delivery.checks.length || delivery.checks.some((check) => !check.evidence.trim()) || !criteria.length || criteria.some((criterion) => !criterion.evidence.length)) return "Parecer inconclusivo";
    return "Parecer favorável";
  }
  return TASK_STATUS_LABELS[review.task.status] ?? "Estado desconhecido";
}

// i18n-scan: status labels are translated by the renderer.
export const TASK_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho", queued: "Na fila", running: "Em execução", in_review: "Aguardando revisão",
  completed: "Concluída", cancelled: "Cancelada", blocked: "Precisa de atenção", failed: "Falhou",
};

export function previousDeliveries(taskId: string, records: DeliveryRecord[]): DeliveryRecord[] {
  return records.filter((record) => record.taskId === taskId).sort((left, right) => left.revision - right.revision).slice(0, -1).reverse();
}

// i18n-scan: result labels are translated by the renderer.
export function validationResultLabel(passed: boolean): "Passou" | "Falhou" {
  return passed ? "Passou" : "Falhou";
}

export function workQueueAction(task: Pick<WorkTask, "status" | "links">, available?: readonly string[]): { type: "enqueue" | "resend"; terminalId: string; terminalMissing?: boolean } | null {
  if (task.links.executionId) return null;
  if (task.status !== "draft" && task.status !== "blocked") return null;
  const terminalId = task.links.executorTerminalId ?? task.links.terminalIds[0] ?? "";
  const type = task.status === "blocked" ? "resend" : "enqueue";
  if (terminalId && available && !available.includes(terminalId)) return { type, terminalId: "", terminalMissing: true };
  return { type, terminalId };
}

// i18n-scan: interruption explanations are translated by the renderer.
const INTERRUPTION_TEXT: Record<string, string> = {
  queue_missing: "O prompt da tarefa não foi encontrado na fila. Confira o agente antes de reenviar.",
  app_restarted: "O aplicativo reiniciou antes da entrega.",
  normal: "O agente encerrou a sessão antes de registrar uma entrega.",
  killed: "A sessão do agente foi encerrada.",
  suspended: "A sessão do agente foi suspensa.",
  restarted: "A sessão do agente foi reiniciada.",
};

export function taskTimelineDetail(event: Pick<TaskEvent, "kind" | "detail">): { text: string; translated: boolean } {
  if (event.kind !== "interrupted") return { text: event.detail, translated: false };
  return { text: INTERRUPTION_TEXT[event.detail] ?? "A execução foi interrompida. Confira o agente antes de reenviar.", translated: true };
}

export function taskTimelineText(event: Pick<TaskEvent, "kind" | "detail">, names: Record<string, string>, translate: (text: string) => string): string {
  if (event.kind === "linked") {
    try {
      const resource = JSON.parse(event.detail) as { label?: string; id?: string };
      if (resource.label && resource.id) return `${resource.label}: ${resource.id}`;
    } catch { return translate("Referência indisponível"); }
  }
  if (["queued", "started", "resumed", "review_requested"].includes(event.kind)) return names[event.detail] ?? event.detail;
  if (event.kind === "status_changed" && TASK_STATUS_LABELS[event.detail]) return translate(TASK_STATUS_LABELS[event.detail]);
  const detail = taskTimelineDetail(event);
  return detail.translated ? translate(detail.text) : detail.text;
}

export function canCancelWork(status: string): boolean {
  return ["draft", "queued", "blocked"].includes(status);
}

// i18n-scan: action labels are translated by the renderer.
export function workExecutionLabel(action: "enqueue" | "resend", pipeline: boolean): string {
  if (pipeline) return "Iniciar fluxo da tarefa";
  return action === "resend" ? "Reenviar tarefa interrompida" : "Enviar para a fila do agente";
}

