/**
 * The modals are where the app talks the most — every dialog that asks,
 * confirms or explains. Each sentence rendered through `t()` needs its
 * English line, or an English user meets Portuguese in the middle of a
 * form. This locks the most visible ones; the full list is the dictionary.
 */
import { describe, expect, it } from "vitest";

import modals from "./modals";

const VISIBLE = [
  // Nova aba
  "Nova aba",
  "Um clique abre. Como cada CLI abre — flags, papel, nome — fica em Configurações › Agentes.",
  "Detectar de novo",
  // Novo projeto / portal
  "Novo projeto",
  "Novo portal",
  "Informe o endereço da página.",
  // Rotinas e gatilhos
  "Remover rotina",
  "Remover gatilho",
  "Intervalo mínimo (s)",
  // Onboarding
  "Começar",
  "Pular",
  "Seis atalhos que valem o dia",
  // Sessões
  "Sessões de agentes",
  "Ler a conversa do começo, sem retomar o processo",
  // Modal chrome
  "Fechar (Esc)",
];

describe("Modals in English", () => {
  it("every visible sentence of the dialogs has its English line", () => {
    for (const text of VISIBLE) {
      expect(modals[text as keyof typeof modals], `"${text}"`).toBeTruthy();
    }
  });
});
