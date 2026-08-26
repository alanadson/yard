/**
 * First run — the rules behind the welcome sheet.
 *
 * The sheet is shown once, to a fresh install, and the proof it was shown is
 * a single key in `kv` (`onboarding.done`). Everything that decides *whether*
 * to show it lives here, pure, because the two failure modes are silent: a
 * sheet that never appears (nobody learns that `yard` is on the PATH) and a
 * sheet that greets an existing user as a newcomer after an upgrade.
 */

// i18n-scan: tables — `FIRST_RUN_SHORTCUTS` is translated where the sheet renders it.
import { locale } from "./i18n";

/** The kv key. Any value counts as "done" — the sheet writes `"1"`. */
export const KV_ONBOARDING = "onboarding.done";

export type FirstRun =
  /** Fresh install: open the sheet. */
  | "show"
  /**
   * The key is missing but the workspace already has projects — a build that
   * predates the onboarding. Mark it done without a word.
   */
  | "adopt"
  /** Already seen. */
  | "done";

export function firstRunDecision(input: {
  done: string | undefined;
  projects: number;
}): FirstRun {
  if (input.done !== undefined) return "done";
  return input.projects > 0 ? "adopt" : "show";
}

export function needsOnboarding(input: { done: string | undefined; projects: number }): boolean {
  return firstRunDecision(input) === "show";
}

export interface AgentRow {
  id: string;
  name: string;
  found: boolean;
  version: string | null;
}

/**
 * The catalog as the sheet lists it: what is installed first (that is the
 * good news), alphabetically inside each half so the order is stable across
 * machines.
 */
export function agentRows(
  catalog: readonly { id: string; name: string; installed: boolean; version: string | null }[],
): AgentRow[] {
  return [...catalog]
    .sort((a, b) => {
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return a.name.localeCompare(b.name, locale());
    })
    .map((a) => ({ id: a.id, name: a.name, found: a.installed, version: a.version }));
}

/**
 * The six gestures worth learning on day one. Keys first so the sheet draws
 * them as `<kbd>`s; the sentence is what the gesture does, not its name.
 */
export const FIRST_RUN_SHORTCUTS: readonly (readonly [readonly string[], string])[] = [
  [["Ctrl", "T"], "Nova aba — uma CLI, um shell ou um navegador"],
  [["Ctrl", "P"], "Busca — agentes, arquivos, notas e ações, tudo num campo só"],
  [["Ctrl", "Enter"], "Compositor — escrever um prompt longo fora do terminal"],
  [["Ctrl", "Shift", "A"], "Ir para o agente que parou e está esperando você"],
  [["Ctrl", "Shift", "B"], "Bancada — arquivos, tarefas, prompts e controle de versão"],
  [["Ctrl", "Shift", "N"], "Anotações — o caderno markdown fora de qualquer projeto"],
];
