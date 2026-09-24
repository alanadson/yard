import { t } from "../../lib/i18n";
import type { SearchStatus } from "../../stores/searchStore";

export function searchAnnouncement(
  status: SearchStatus,
  fresh: boolean,
  result: {
    hits: number;
    filesHit: number;
    filesScanned: number;
    truncated: boolean;
  } | null,
  error: string | null,
): string {
  if (status === "searching") return t("buscando…");
  if (status === "error") return error ?? "";
  if (status !== "done" || !fresh || !result) return "";
  const summary =
    result.hits === 0
      ? t("Nenhum resultado em {files} arquivos.", {
          files: result.filesScanned,
        })
      : t("{hits} linha(s) em {files} arquivo(s).", {
          hits: result.hits,
          files: result.filesHit,
        });
  return (
    summary +
    (result.truncated
      ? ` ${t("A lista atingiu o limite. Refine a busca para ver outros resultados.")}`
      : "")
  );
}
