/**
 * What the card's status line says about a terminal, from the runtime mirror
 * (`stores/terminalsStore.ts`). The kind is the CSS class; the label is the
 * text. Kept out of the JSX so the order of the rules has a test.
 */
import { t } from "../../lib/i18n";

export interface HudRuntime {
  state: string;
  blocked?: boolean;
  finished?: boolean;
  /** The block is a permission prompt the CLI reported itself (`yard hook`). */
  permission?: boolean;
}

export function hudKind(rt: HudRuntime | undefined): string {
  if (rt?.blocked && rt.permission) return "permission";
  if (rt?.blocked) return "blocked";
  if (rt?.finished) return "ready";
  if (rt?.state === "running" || rt?.state === "starting") return "work";
  if (rt?.state === "error") return "error";
  return "idle";
}

export function hudLabel(rt: HudRuntime | undefined): string {
  if (rt?.blocked && rt.permission) return t("Pedindo permissão: aprove na CLI");
  if (rt?.blocked) return t("Travado — precisa de você");
  if (rt?.finished) return t("Pronto");
  if (rt?.state === "starting") return t("Iniciando");
  if (rt?.state === "running") return t("Trabalhando");
  if (rt?.state === "error") return t("Erro");
  if (rt?.state === "exited") return t("Encerrado");
  return t("Parado");
}
