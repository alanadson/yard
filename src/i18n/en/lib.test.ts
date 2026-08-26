/**
 * The strings born in `src/lib` — confirms, menu labels, toasts — are the
 * ones a user meets even when no component of their own is on screen (a
 * native `ask()` dialog, a context menu, a toast after a background job).
 * Each of these needs its English line, or an English interface answers
 * a click with Portuguese.
 */
import { describe, expect, it } from "vitest";

import lib from "./lib";

const VISIBLE = [
  // lifecycle confirms and the terminal menu
  "Excluir CLI",
  "Reiniciar",
  "Matar processo",
  "Salvar saída…",
  // the broadcast strip and its toasts
  "Transmissão desligada.",
  // backup and update flows
  "Restauração cancelada — o workspace atual continua.",
  "O Yard já está na versão mais nova.",
  // sendability, project creation, the text menu
  "Esse terminal não existe mais.",
  "Escolha uma pasta.",
  "Não consegui copiar.",
];

describe("lib strings in English", () => {
  it("every confirm, menu label and toast a user meets from src/lib has its line", () => {
    for (const text of VISIBLE) {
      expect(lib[text as keyof typeof lib], `"${text}"`).toBeTruthy();
    }
  });
});
