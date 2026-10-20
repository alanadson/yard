import { Modal } from "./Modal";
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { checkpointFailureText, type CheckpointNotice } from "../../lib/checkpointNotices";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";
import { copyText } from "../../lib/clipboard";
import { locale } from "../../lib/i18n";

export function NotificationsModal() {
  const t = useT();
  const history = useUI((state) => state.toastHistory);
  const close = useUI((state) => state.closeModal);
  const [recovery, setRecovery] = useState<CheckpointNotice[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void ipc.checkpointNoticeHistory().then((notices) => { if (active) setRecovery(notices); }, (error) => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, []);
  return (
    <Modal title={t("Histórico de notificações")} onClose={close} wide>
      {error && <p className="hint hint--error" role="alert">{error}</p>}
      {recovery.length > 0 && <section><h3>{t("Falhas de recuperação registradas")}</h3><ol className="notification-history">{[...recovery].reverse().map((notice) => <li key={`${notice.id}:${notice.at}`}><time>{new Date(notice.at).toLocaleString(locale())}</time><p>{checkpointFailureText(notice.root, notice.reason)}</p></li>)}</ol></section>}
      <p className="hint">
        {t(
          "As últimas 100 notificações desta sessão ficam aqui, mesmo depois de sair da tela.",
        )}
      </p>
      {history.length === 0 && (
        <p className="hint">{t("Nenhuma notificação nesta sessão.")}</p>
      )}
      <ol className="notification-history">
        {[...history].reverse().map((notice) => (
          <li key={notice.id}>
            <div className="notification-history-head">
              <strong>
                {notice.kind === "error" ? t("Erro") : t("Informação")}
              </strong>
              <span>{notice.source}</span>
              <time dateTime={new Date(notice.createdAt ?? 0).toISOString()}>
                {new Date(notice.createdAt ?? 0).toLocaleTimeString(locale())}
              </time>
              <button
                className="btn btn--sm"
                onClick={() =>
                  void copyText(
                    `${notice.source ?? "Yard"}\n${notice.message}`,
                  ).then((copied) =>
                    useUI
                      .getState()
                      .showToast(
                        copied ? t("Copiado.") : t("Não consegui copiar."),
                        copied ? "info" : "error",
                      ),
                  )
                }
              >
                {t("Copiar detalhes")}
              </button>
            </div>
            <p>{notice.message}</p>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
