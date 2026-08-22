/**
 * Behavior — confirmations, and the door back to the defaults.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { RotateCcw } from "lucide-react";

import { useUI } from "../../../stores/uiStore";
import { Card, GroupTitle, Row, SwitchRow } from "../rows";

export function SecBehavior() {
  const showToast = useUI((s) => s.showToast);

  return (
    <>
      <Card>
        <SwitchRow
          pref="confirmOnExit"
          label="Confirmar ao sair com terminais vivos"
          desc="Um aviso antes de fechar a janela quando ainda há processos rodando"
        />
      </Card>

      <GroupTitle>Restaurar</GroupTitle>
      <Card>
        <Row
          label="Restaurar padrões"
          desc="Fontes, métricas do editor, renderizador, histórico e larguras dos painéis voltam como vieram. Projetos, terminais e extensões não são tocados."
        >
          {/* The way out that was missing from any experiment with font, size,
              scrollback and renderer. */}
          <button
            className="btn"
            onClick={() => {
              void ask(
                "Restaurar as preferências ao padrão do Yard? Fontes, tamanho e altura da linha do editor, tabulação, numeração, renderizador, linhas de histórico e larguras dos painéis voltam como vieram. Projetos, terminais e extensões não são tocados.",
                { title: "Restaurar padrões", kind: "warning" },
              ).then((ok) => {
                if (!ok) return;
                useUI.getState().resetPrefs();
                showToast("Preferências restauradas.");
              });
            }}
          >
            <RotateCcw size={13} /> Restaurar
          </button>
        </Row>
      </Card>
    </>
  );
}
