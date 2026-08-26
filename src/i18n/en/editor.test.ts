/**
 * The file editor's chrome is rendered through `t()`: the four markdown
 * modes, the search counter, the document banners, the tab menu and the
 * media viewer. Each of those sentences needs its English line — without it
 * the English interface would show a Portuguese word in the middle of the
 * toolbar, and nothing else would notice.
 */
import { describe, expect, it } from "vitest";

import editor from "./editor";

const VISIBLE = [
  // the four ways to look at a markdown file
  "Editar",
  "Fonte do markdown",
  "Dividido",
  "Ler",
  // the search bar's counter
  "regex inválida",
  "sem ocorrências",
  // the disk banners
  "Salvar por cima",
  "Ver a diferença",
  "Esse arquivo não está mais no disco — alguém apagou ou moveu.",
  // the tab menu
  "Fechar as outras",
  "Copiar caminho completo",
  // the media viewer and the path bar
  "Abrir no aplicativo padrão",
  "Caber na janela",
  "Sumário dos títulos",
  // the formatting bar
  "Negrito",
  "Lista de tarefas",
  // the diff tab (a comparison beside the CLIs)
  "Visão unificada",
  "Unificado",
  "Abrir o arquivo no editor",
  "Abrir o arquivo para editar",
  "O que este commit fez neste arquivo",
  "O que mudou no disco e ainda não foi preparado (índice → disco)",
  "O que está preparado para o próximo commit (HEAD → índice)",
  "O disco comparado com o último commit (HEAD → disco)",
  "Este commit não mudou o texto deste arquivo.",
  "Preparado",
  "comparação",
  "{path} — ações do arquivo",
];

describe("the editor in English", () => {
  it("every visible sentence of the editor's chrome has its English line", () => {
    for (const text of VISIBLE) {
      expect(editor[text as keyof typeof editor], `"${text}"`).toBeTruthy();
    }
  });
});
