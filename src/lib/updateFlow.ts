/**
 * The two gestures around an update — "check now" and "install and restart"
 * — with their rules separated from their delivery (a toast, a dialog).
 *
 * Installing restarts the app, and the restart takes every live CLI with it
 * (the Job Objects do the killing, the same as closing the window). So the
 * install asks first when something is running, in the same words the exit
 * confirmation uses; with nothing running there is nothing to ask.
 */
import { ask } from "@tauri-apps/plugin-dialog";

import { t } from "./i18n";
import { useProjects } from "../stores/projectsStore";
import { isLive, useTerminals } from "../stores/terminalsStore";
import { useUI } from "../stores/uiStore";
import { useUpdater, type UpdaterPhase } from "../stores/updaterStore";

/** The question before an install over live agents, or `null` when none run. */
export function installQuestion(live: number): string | null {
  if (live <= 0) return null;
  return live === 1
    ? t("Instalar a atualização vai fechar e reabrir o Yard. {n} CLI em execução será encerrada — o histórico de cada uma fica no disco. Continuar?", { n: live })
    : t("Instalar a atualização vai fechar e reabrir o Yard. {n} CLIs em execução serão encerradas — o histórico de cada uma fica no disco. Continuar?", { n: live });
}

export interface FlowToast {
  message: string;
  kind: "info" | "error";
}

/** What a manual check says back, per phase; nothing while it still runs. */
export function checkToast(
  phase: UpdaterPhase,
  version: string | null,
  error?: string | null,
): FlowToast | null {
  switch (phase) {
    case "none":
      return { message: t("O Yard já está na versão mais nova."), kind: "info" };
    case "available":
      return {
        message: t("Versão {version} disponível — instale em Configurações → Dados e backup.", {
          version: version ?? t("nova"),
        }),
        kind: "info",
      };
    case "error":
      return {
        message: t("Não consegui verificar atualizações: {error}", {
          error: error ?? t("erro desconhecido"),
        }),
        kind: "error",
      };
    default:
      return null;
  }
}

function liveCount(): number {
  const rt = useTerminals.getState().byId;
  return useProjects.getState().terminals.filter((t) => isLive(rt[t.id])).length;
}

/** "Verificar agora": runs the check and says what it found. */
export async function checkForUpdates(): Promise<void> {
  await useUpdater.getState().check({ manual: true });
  const s = useUpdater.getState();
  const toast = checkToast(s.phase, s.version, s.error);
  if (toast) useUI.getState().showToast(toast.message, toast.kind);
}

/** "Instalar e reiniciar": asks when agents are running, then installs. */
export async function installUpdate(): Promise<void> {
  const question = installQuestion(liveCount());
  if (question) {
    const proceed = await ask(question, { title: t("Instalar a atualização?"), kind: "warning" });
    if (!proceed) return;
  }
  await useUpdater.getState().install();
  const { phase, error } = useUpdater.getState();
  if (phase === "available" && error) {
    useUI.getState().showToast(t("Não consegui instalar a atualização: {error}", { error }), "error");
  }
}
