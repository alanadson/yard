/**
 * The Settings menu is the reference migration: every category's label,
 * title and description is rendered through `t()`, so each one needs its
 * English line — a missing one would show Portuguese in the middle of an
 * English menu. (Lines identical in both languages, like "Interface", are
 * deliberately absent; the fallback returns the key.)
 */
import { describe, expect, it } from "vitest";

import { SETTINGS_CATEGORIES } from "../../components/Settings/categories";
import settings from "./settings";

const SAME_IN_ENGLISH = new Set(["Interface", "Terminal"]);

/**
 * The sections: one visible sentence per screen, so a section whose lines
 * never reached the dictionary fails here instead of showing Portuguese in
 * the middle of an English window.
 */
const SECTION_SENTENCES = [
  // Terminal
  "Fonte do terminal",
  // The colour-scheme slot each surface carries — one in Terminal, one in
  // Editor, and the sentence that says where the other half lives.
  "Tema de cor",
  "O tema de cor troca os 16 tons ANSI, o fundo e o cursor dos terminais; o editor tem o dele, em Ajustes → Editor de código. O cromo do Yard não muda: tema é cor de conteúdo, não de moldura.",
  // The features that used to live on the store shelf: one sentence per group
  // they landed in, so a whole group with no English line fails here.
  "Recursos do terminal",
  "Imagens no terminal",
  "Recursos do editor",
  "Minimapa",
  "Ícones de arquivo",
  "Tema de ícones",
  "Nenhum",
  "Diagramas Mermaid",
  "Fontes de código embutidas",
  "Tamanho da fonte",
  "Linhas de histórico",
  "Cursor piscante",
  // Editor de código
  "Fonte do código",
  "Servidores de linguagem (LSP)",
  "Servidores nesta máquina",
  // Agentes
  "Sem pedir permissão",
  "Roda em",
  "Notificar quando um agente terminar",
  // Comportamento
  "Confirmar ao sair com terminais vivos",
  "Restaurar padrões",
  // Atalhos
  "Fora da janela",
  "Atalho global para trazer o Yard",
  // Dados e backup
  "Atualizações",
  "Backup do workspace",
  "Relatar um problema",
  "Backup automático",
  // Servidores MCP
  "Adicionar servidor",
  // Interface — the status bar rows
  "Barra de status",
  "Mostrar a barra de status",
];

describe("Settings sections in English", () => {
  it("every section's headline sentences have their English line", () => {
    for (const text of SECTION_SENTENCES) {
      expect(settings[text as keyof typeof settings], `"${text}"`).toBeTruthy();
    }
  });
});

describe("Settings categories in English", () => {
  it("every label, title and description has its line, unless it reads the same in English", () => {
    for (const c of SETTINGS_CATEGORIES) {
      for (const text of [c.label, c.title, c.desc]) {
        if (SAME_IN_ENGLISH.has(text)) continue;
        expect(settings[text as keyof typeof settings], `"${text}"`).toBeTruthy();
      }
    }
  });
});
