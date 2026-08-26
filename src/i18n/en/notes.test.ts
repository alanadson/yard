/**
 * The notebook, the composer, the palette and the Live overlay are rendered
 * through `t()`: each of their visible sentences needs its English line, or
 * an English interface shows Portuguese in the middle of a menu. These are
 * the ones a user meets first — the rail, the status names, the send button,
 * the palette's section titles, the overlay's headings, the attention toast.
 */
import { describe, expect, it } from "vitest";

import notes from "./notes";

const VISIBLE = [
  // NotesView rail and list
  "Todas as notas",
  "Cadernos",
  "Etiquetas",
  "Novo caderno",
  "Nova nota (Ctrl+N)",
  "Buscar nas anotações",
  // note status
  "Concluída",
  // composer
  "Enviar",
  "Destino do prompt",
  // palette
  "Buscar no workspace",
  "Ações",
  "Agentes e terminais",
  "Anotações",
  // Live overlay
  "Linha do tempo",
  "Arquivos tocados",
  "Plano do agente",
  // attention
  "Nenhum agente pedindo atenção agora.",
];

describe("notebook, composer, palette and Live overlay in English", () => {
  it("every visible sentence of the area has its English line", () => {
    for (const text of VISIBLE) {
      expect(notes[text as keyof typeof notes], `"${text}"`).toBeTruthy();
    }
  });
});
