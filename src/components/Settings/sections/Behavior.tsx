/**
 * Behavior — confirmations, and the door back to the defaults.
 */
import { ask } from "../../../lib/confirmation";
import { RotateCcw } from "lucide-react";

import { useT } from "../../../hooks/useT";
import { useUI } from "../../../stores/uiStore";
import { Card, GroupTitle, NumberRow, Row, SwitchRow } from "../rows";

export function SecBehavior() {
  const t = useT();
  const showToast = useUI((s) => s.showToast);

  return (
    <>
      <Card>
        <SwitchRow
          pref="confirmOnExit"
          label={t("Confirmar ao sair com terminais vivos")}
          desc={t("Um aviso antes de fechar a janela quando ainda há processos rodando")}
        />
        <SwitchRow
          pref="closeToTray"
          label={t("Fechar para a bandeja")}
          desc={t(
            "O X esconde a janela; as CLIs continuam. Sair fica no menu do ícone da bandeja (e na busca).",
          )}
        />
      </Card>

      <GroupTitle>{t("Execução automática")}</GroupTitle>
      <p className="hint">{t("A fila e as rotinas aguardam uma vaga quando o limite de agentes ativos é atingido.")}</p>
      <Card>
        <NumberRow pref="automationMaxAgents" label={t("Máximo de agentes ativos")} min={1} max={16} />
        <SwitchRow pref="automationLockDirectories" label={t("Um agente por pasta durante a execução automática")}
          desc={t("Pedidos automáticos aguardam enquanto outro agente trabalha na mesma pasta inicial.")} />
      </Card>

      <GroupTitle>{t("Restaurar")}</GroupTitle>
      <Card>
        <Row
          label={t("Restaurar padrões")}
          desc={t(
            "Fontes, métricas do editor, renderizador, histórico e larguras dos painéis voltam como vieram. Projetos, terminais e extensões não são tocados.",
          )}
        >
          {/* The way out that was missing from any experiment with font, size,
              scrollback and renderer. */}
          <button
            className="btn"
            onClick={() => {
              void ask(
                t(
                  "Restaurar as preferências ao padrão do Yard? Fontes, tamanho e altura da linha do editor, tabulação, numeração, renderizador, linhas de histórico e larguras dos painéis voltam como vieram. Projetos, terminais e extensões não são tocados.",
                ),
                { title: t("Restaurar padrões"), kind: "warning" },
              ).then((ok) => {
                if (!ok) return;
                useUI.getState().resetPrefs();
                showToast(t("Preferências restauradas."));
              });
            }}
          >
            <RotateCcw size={13} /> {t("Restaurar")}
          </button>
        </Row>
      </Card>
    </>
  );
}
