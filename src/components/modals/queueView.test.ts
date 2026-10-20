/** The queue must distinguish a prompt awaiting delivery from one that may already have reached an agent. */
import { expect, it } from "vitest";
import { queueDeliveryView } from "./queueView";
import type { QueueItem } from "../../lib/queue";
import * as queueRules from "./queueView";

it("shows a queue failure without claiming that an unread queue is empty", () => {
  expect(queueRules.queueContentsView(0, "Database unavailable")).toEqual({
    showEmpty: false, error: "Não foi possível sincronizar a fila. Confira os pedidos antes de continuar.",
  });
  expect(queueRules.queueContentsView(0, null)).toEqual({ showEmpty: true, error: null });
  expect(queueRules.queueContentsView(2, "Database unavailable").showEmpty).toBe(false);
});

it("explains native interruption and missing acknowledgment using review instructions", () => {
  expect(queueRules.queueDeliveryError("QUEUE_NATIVE_INTERRUPTED"))
    .toBe("A entrega foi interrompida antes da confirmação. Confira o terminal antes de reenviar.");
  expect(queueRules.queueDeliveryError("QUEUE_NATIVE_UNACKNOWLEDGED"))
    .toBe("Não foi possível confirmar o registro da entrega. Confira o terminal antes de reenviar.");
});

it("offers a reviewed retry only for uncertain delivery and disables actions while sending", () => {
  const item: QueueItem = { id: "request", terminalId: "agent", text: "Review login", at: 1_000, source: "user", delivery: { status: "uncertain", attemptedAt: 2_000, error: "The terminal closed" } };
  expect(queueDeliveryView(item)).toEqual({
    label: "Conferir entrega", retryable: true, removable: true,
    explanation: "Confira o terminal antes de reenviar. A primeira tentativa pode ter chegado ao agente.",
  });
  expect(queueDeliveryView({ ...item, delivery: { status: "sending", attemptedAt: 2_000 } })).toEqual({
    label: "Enviando", retryable: false, removable: false,
    explanation: "A entrega está em andamento.",
  });
  expect(queueDeliveryView({ ...item, delivery: undefined })).toEqual({
    label: "Aguardando", retryable: false, removable: true,
    explanation: "O prompt será enviado quando o agente estiver livre.",
  });
});
