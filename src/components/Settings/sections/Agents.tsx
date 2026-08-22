/**
 * Agents — the two balloons a CLI's silence triggers.
 *
 * They used to be a single switch. Turning off the "finished" one — the first
 * thing you do with six CLIs open — also killed the warning that costs dead
 * time to ignore. `lib/notifyAgent.ts` is what tells the two apart.
 */
import { Card, GroupTitle, SwitchRow } from "../rows";

export function SecAgents() {
  return (
    <>
      <GroupTitle>Notificações</GroupTitle>
      <Card>
        <SwitchRow
          pref="notifyOnFinish"
          label="Notificar quando um agente terminar"
          desc="Notificação nativa do Windows quando a saída fica quieta"
        />
        <SwitchRow
          pref="notifyBlocked"
          label="Avisar quando um agente travar"
          desc="Uma pergunta, um (y/N) ou uma senha na última linha viram notificação com a pergunta dentro — o badge amarelo no cartão aparece de qualquer jeito"
        />
      </Card>
      <p className="hint">
        Um agente conta como "parou" depois de ~4,5 s de silêncio seguindo
        atividade. O silêncio diz que parou; a cauda da saída diz por quê — um
        menu com cursor, um (y/N) ou um Password: na última linha viram
        "travado" em vez de "terminou". O balão só sai quando o painel não está
        à vista: o que você acabou de ver acontecer não vira notificação.
      </p>
    </>
  );
}
