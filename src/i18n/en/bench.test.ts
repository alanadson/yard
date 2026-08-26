/**
 * The bench is where the user acts on the repository — stage, discard, commit,
 * branch — and every one of those verbs goes through a confirm or a menu
 * whose text is tested code (`scmConfirm.ts`, `scmMenu.ts`…). Rendering them
 * through `t()` only helps if the English line exists: a missing one would
 * leave a Portuguese warning in the middle of an English screen, on the
 * exact button that cannot be undone.
 */
import { describe, expect, it } from "vitest";

import bench from "./bench";

const VISIBLE = [
  "Isso não dá para desfazer.",
  "Descartar todas as alterações?",
  "Abrir no editor",
  "Copiar caminho",
  "Histórico deste arquivo",
  "Novo arquivo",
  "Nova pasta",
  "Não há nada para commitar",
  "Alterações",
  "Histórico",
  "Arquivos",
  "Mostrar na pasta",
];

describe("bench sentences in English", () => {
  it("the confirms, menus and tabs the bench renders have their English line", () => {
    for (const text of VISIBLE) {
      expect(bench[text as keyof typeof bench], `"${text}"`).toBeTruthy();
    }
  });
});
