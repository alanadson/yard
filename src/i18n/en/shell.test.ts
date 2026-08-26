/**
 * The shell — title bar, sidebar, pane tabs, the empty pane, the exit banner
 * — is what an English user sees before opening anything else. Every one of
 * its sentences goes through `t()`, so each needs its English line: a missing
 * one would leave a Portuguese button in the middle of an English window.
 */
import { describe, expect, it } from "vitest";

import shell from "./shell";

const VISIBLE = [
  "Adicionar projeto",
  "Novo grupo",
  "Nova aba",
  "Configurações",
  "Fechar aba",
  "Suspender grupo",
  "Excluir grupo",
  "Esperando uma resposta sua",
  "Arraste a aba de outro painel para cá, ou abra uma CLI nova.",
  "Começar do zero",
  "Tentar de novo",
  "Nenhum terminal neste grupo",
  "Mostrar ou esconder a barra lateral",
  "Agentes",
];

describe("the shell in English", () => {
  it("every visible sentence of the title bar, status bar, sidebar, pane and exit banner has its line", () => {
    for (const text of VISIBLE) {
      expect(shell[text as keyof typeof shell], `"${text}"`).toBeTruthy();
    }
  });
});
