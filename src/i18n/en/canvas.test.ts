/**
 * The board is where the user spends the session: a toolbar tooltip, a card
 * badge or a floors button left in Portuguese in the middle of an English
 * interface is the kind of hole nobody files a bug about. These are the
 * sentences most eyes land on; each one needs its English line.
 */
import { describe, expect, it } from "vitest";

import canvas from "./canvas";

const MUST_HAVE = [
  // toolbar and board
  "Conectar terminais",
  "Fluxo de agentes (encadear em sequência)",
  "Canvas vazio.",
  "Enquadrar a seleção",
  "Mostrar o minimapa",
  // cards and notes
  "Travado — precisa de você",
  "Esperando uma resposta sua",
  "Nova nota neste fichário",
  "Formatação da nota",
  "Fechar portal",
  // floors
  "Andares: cópias isoladas do repositório, cada uma com o próprio canvas",
  "Aterrissar este andar no chão",
  "Criar andar",
  "Nova tarefa",
  // libs: menus, confirms, toasts
  "Encerrar o andar…",
  "A tarefa chegou vazia.",
  "dê um nome ao andar",
];

describe("Canvas in English", () => {
  it("every sentence the board shows first has its English line", () => {
    for (const text of MUST_HAVE) {
      expect(canvas[text as keyof typeof canvas], `"${text}"`).toBeTruthy();
    }
  });
});
