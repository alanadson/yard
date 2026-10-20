/** Export uses a snapshot of the selected topic and leaves the conversation unchanged. */
import { save } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { exportFileName } from "./termExport";
import { chatExportFormat, exportThreadJson, exportThreadMarkdown, type TerminalChat } from "./chat";
import { splitOsPath } from "./paths";
import { ipc } from "./ipc";

export async function exportChatTopic(document: TerminalChat, terminalId: string, thread: number, title: string, now: Date): Promise<boolean> {
  const dest = await save({ title: t("Exportar tópico"), defaultPath: exportFileName(title, now).replace(/\.txt$/, ".json"),
    filters: [{ name: "JSON", extensions: ["json"] }, { name: "Markdown", extensions: ["md"] }] });
  if (!dest) return false;
  const body = chatExportFormat(dest) === "json" ? exportThreadJson(document, terminalId, thread)
    : exportThreadMarkdown(document, thread, { title, user: t("Você"), assistant: t("Agente"), attachments: t("Anexos"), draft: t("Rascunho"), task: t("Tarefa") });
  const { dir, base } = splitOsPath(dest);
  if (!dir) throw new Error("Export destination must be an absolute file path");
  await ipc.fsWriteText(dir, base, body, null, false, false);
  return true;
}
