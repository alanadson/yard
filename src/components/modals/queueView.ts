import type { QueueItem } from "../../lib/queue";
import { QUEUE_INTERRUPTED } from "../../lib/queue";
import { t } from "../../lib/i18n";

export function queueContentsView(count: number, error: string | null) {
  return { showEmpty: count === 0 && !error,
    error: error ? t("Não foi possível sincronizar a fila. Confira os pedidos antes de continuar.") : null };
}

export function queueDeliveryError(error: string): string {
  if (error === "QUEUE_NATIVE_INTERRUPTED") return t(QUEUE_INTERRUPTED);
  if (error === "QUEUE_NATIVE_UNACKNOWLEDGED" || error === "QUEUE_NATIVE_UNCERTAIN") {
    return t("Não foi possível confirmar o registro da entrega. Confira o terminal antes de reenviar.");
  }
  return error;
}

/** Delivery state determines whether the user may remove or explicitly retry a prompt. */
export function queueDeliveryView(item: QueueItem) {
  if (item.delivery?.status === "sending") return {
    label: "Enviando", retryable: false, removable: false,
    explanation: "A entrega está em andamento.",
  };
  if (item.delivery?.status === "uncertain") return {
    label: "Conferir entrega", retryable: true, removable: true,
    explanation: "Confira o terminal antes de reenviar. A primeira tentativa pode ter chegado ao agente.",
  };
  return {
    label: "Aguardando", retryable: false, removable: true,
    explanation: "O prompt será enviado quando o agente estiver livre.",
  };
}
