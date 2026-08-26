/**
 * The process actions of a terminal, as menu entries.
 *
 * Restart / suspend / kill / delete are the same four verbs wherever a
 * terminal is listed — the sidebar tree, the pane's tab bar and the canvas
 * card — and they were written out three times, with the same labels, the
 * same icons, the same IPC calls and the same `disabled` rule. Changing a
 * word meant remembering all three.
 *
 * Callers keep their own entries (colour, role, routines, "Ao Vivo"): this
 * only owns the block that must not diverge.
 */
import {
  ArrowDown,
  ArrowUp,
  Ban,
  FileText,
  Download,
  PauseCircle,
  Pencil,
  RotateCw,
  Trash2,
} from "lucide-react";

import { t } from "./i18n";
import { ipc } from "./ipc";
import { exportTerminalOutput } from "./termExportFlow";
import {
  confirmCloseTerminal,
  confirmKillTerminal,
  confirmRestartTerminal,
} from "./lifecycle";
import type { Action } from "../hooks/useAction";
import type { MenuEntry } from "../components/ContextMenu";
import { openTranscriptFor } from "./transcriptOpen";
import { hasSessions } from "../stores/agentsStore";
import { useProjects } from "../stores/projectsStore";

function canReadSession(id: string): boolean {
  const term = useProjects.getState().terminal(id);
  return term?.kind === "agent" && hasSessions(term.agentId);
}

export interface TerminalActionsOptions {
  id: string;
  /** Whether the process is up — the three process verbs need it. */
  running: boolean;
  /** Runs an IPC call and reports failure as a toast (`useAction`). */
  run: Action;
  /** Opens the in-place rename. Omit to leave the entry out. */
  onRename?: () => void;
  /**
   * Reorders the CLI among its siblings in the same pane. Omitted, the two
   * entries do not show — only the tree has a list where "up" means something.
   */
  reorder?: { canUp: boolean; canDown: boolean; run: (delta: -1 | 1) => void };
  /** Called after a confirmed delete, for hosts that need to react. */
  onDeleted?: () => void;
}

/** `Renomear` + separator + restart/suspend/kill + separator + delete. */
export function terminalActionEntries({
  id,
  running,
  run,
  onRename,
  reorder,
  onDeleted,
}: TerminalActionsOptions): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (onRename) {
    entries.push({
      id: "rename",
      label: t("Renomear"),
      icon: <Pencil size={13} />,
      onSelect: onRename,
    });
  }
  if (reorder) {
    entries.push(
      {
        id: "up",
        label: t("Mover para cima"),
        icon: <ArrowUp size={13} />,
        disabled: !reorder.canUp,
        onSelect: () => reorder.run(-1),
      },
      {
        id: "down",
        label: t("Mover para baixo"),
        icon: <ArrowDown size={13} />,
        disabled: !reorder.canDown,
        onSelect: () => reorder.run(1),
      },
    );
  }
  if (onRename || reorder) entries.push({ kind: "sep" });
  entries.push(
    {
      id: "restart",
      label: t("Reiniciar"),
      icon: <RotateCw size={13} />,
      disabled: !running,
      onSelect: () =>
        void confirmRestartTerminal(id).then((ok) => {
          if (ok) void run(() => ipc.restartPty(id), t("falha ao reiniciar"));
        }),
    },
    {
      id: "suspend",
      label: t("Suspender"),
      icon: <PauseCircle size={13} />,
      disabled: !running,
      onSelect: () => void run(() => ipc.suspendPty(id), t("falha ao suspender")),
    },
    {
      id: "kill",
      label: t("Matar processo"),
      icon: <Ban size={13} />,
      disabled: !running,
      danger: true,
      onSelect: () =>
        void confirmKillTerminal(id).then((ok) => {
          if (ok) void run(() => ipc.killPty(id), t("falha ao matar"));
        }),
    },
    // Never disabled by `running`: the scrollback of a CLI that just died is
    // exactly the one people want to save.
    {
      id: "export",
      label: t("Salvar saída…"),
      icon: <Download size={13} />,
      onSelect: () => void exportTerminalOutput(id),
    },
    // Only a CLI that writes its session to disk has a transcript to read;
    // for the others the entry would be a toast saying so.
    ...(canReadSession(id)
      ? ([
          {
            id: "transcript",
            label: t("Transcrição da sessão…"),
            icon: <FileText size={13} />,
            onSelect: () => {
              const term = useProjects.getState().terminal(id);
              if (term) void openTranscriptFor(term);
            },
          },
        ] satisfies MenuEntry[])
      : []),
    { kind: "sep" },
    {
      id: "delete",
      label: t("Excluir CLI"),
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: () => {
        void confirmCloseTerminal(id).then((done) => {
          if (done) onDeleted?.();
        });
      },
    },
  );
  return entries;
}
