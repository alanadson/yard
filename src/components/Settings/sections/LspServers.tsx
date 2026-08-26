/**
 * The language-server catalog, as Settings shows it: which servers this
 * machine has (with version), which are missing (with the install line),
 * and which failed since the app opened. The list is the backend's
 * `lsp_detect`; the only decision here is how to say it.
 */
import { useEffect } from "react";
import { RefreshCw } from "lucide-react";

import { useT } from "../../../hooks/useT";
import { t } from "../../../lib/i18n";
import type { LspServerInfo } from "../../../lib/ipc";
import { useLsp } from "../../../stores/lspStore";
import { Row } from "../rows";

/** The one-line status of a catalog entry, in the user's words. */
export function serverStatus(
  server: LspServerInfo,
  failure: string | undefined,
): { text: string; tone: "ok" | "missing" | "failed" } {
  if (failure) return { text: t("parou: {failure}", { failure }), tone: "failed" };
  if (!server.found) {
    return {
      text: t("não encontrado — instale com: {hint}", { hint: server.installHint }),
      tone: "missing",
    };
  }
  return { text: server.version ?? t("instalado (versão desconhecida)"), tone: "ok" };
}

export function LspServerRows() {
  const t = useT();
  const detected = useLsp((s) => s.detected);
  const loading = useLsp((s) => s.loading);
  const error = useLsp((s) => s.error);
  const failed = useLsp((s) => s.failed);
  const load = useLsp((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Row
        label={t("Servidores nesta máquina")}
        desc={t("Um por linguagem; o editor usa o que estiver instalado e ignora o resto.")}
      >
        <button className="btn" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw size={13} /> {loading ? t("Procurando…") : t("Procurar de novo")}
        </button>
      </Row>
      {error && (
        <p className="hint hint--error" role="alert">
          {t("Não consegui ler o catálogo de servidores: {error}", { error })}
        </p>
      )}
      {(detected ?? []).map((server) => {
        const failure = Object.entries(failed).find(([key]) =>
          key.endsWith(`::${server.program}`),
        )?.[1];
        const status = serverStatus(server, failure);
        return (
          <Row
            key={server.program}
            label={<code>{server.program}</code>}
            desc={
              <>
                {server.languageIds.join(", ")}
                {" · "}
                <span className={`set-lsp-status set-lsp-status--${status.tone}`}>
                  {status.text}
                </span>
              </>
            }
          >
            <span />
          </Row>
        );
      })}
    </>
  );
}
