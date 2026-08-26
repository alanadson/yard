/**
 * Data and backup — where the workspace lives, and how to take it along.
 */
import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, RefreshCw, RotateCw, Upload } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";

import { cancelBackupRestore, restartIntoBackup } from "../../../lib/backupFlow";
import { LOADING, load, type LoadState } from "../../../lib/loading";
import { locale, t, tn } from "../../../lib/i18n";
import { ipc, type AppPaths } from "../../../lib/ipc";
import { useT } from "../../../hooks/useT";
import { useUI } from "../../../stores/uiStore";
import { SwitchRow } from "../rows";
import { checkForUpdates, installUpdate } from "../../../lib/updateFlow";
import { progressLabel } from "../../../lib/updater";
import { useUpdater } from "../../../stores/updaterStore";
import { Card, GroupTitle, NumberRow, PickerRow, Row } from "../rows";
import { useNow } from "../../../hooks/useNow";
import { AUTO_BACKUP_MODES, describeLast, nextBackupAt, type AutoBackupMode } from "../../../lib/autoBackup";
import { useAutoBackup } from "../../../stores/autoBackupStore";
import { LifeBuoy } from "lucide-react";
import { copyText } from "../../../lib/clipboard";
import { bundleFileName, issueBody, TRACKER_URL } from "../../../lib/support";
import type { SupportSummary } from "../../../lib/ipc";

/** "Próximo: hoje às 04:17" — the hourly look rounds it up to the next hour. */
function describeNext(next: number | null, now: number): string {
  if (next === null) return "";
  if (next <= now) return t("Próximo: na próxima verificação (o Yard confere a cada hora).");
  const d = new Date(next);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const when = d.toLocaleString(locale(), {
    ...(sameDay ? {} : { day: "2-digit", month: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
  });
  return sameDay
    ? t("Próximo: hoje às {when} (o Yard confere a cada hora).", { when })
    : t("Próximo: {when} (o Yard confere a cada hora).", { when });
}

export function SecData() {
  const t = useT();
  const showToast = useUI((s) => s.showToast);
  /**
   * The restored backup stands by waiting for the next boot. It lives in
   * `uiStore` (the App asks the backend at boot and shows a permanent bar) —
   * here the screen only reads it and flips it on import.
   */
  const pending = useUI((s) => s.backupPending);
  const setPending = useUI((s) => s.setBackupPending);
  const setPref = useUI((s) => s.setPref);
  const autoBackup = useUI((s) => s.prefs.autoBackup);
  const autoBackupDir = useUI((s) => s.prefs.autoBackupDir);
  const lastAutoAt = useAutoBackup((s) => s.lastAutoAt);
  const autoRunning = useAutoBackup((s) => s.running);
  const autoError = useAutoBackup((s) => s.lastError);
  const now = useNow(30_000);

  const pickBackupDir = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string" && dir.trim()) setPref("autoBackupDir", dir);
  };
  const [paths, setPaths] = useState<LoadState<AppPaths>>(LOADING);
  const upd = useUpdater();
  /** The installed version, from the binary — the manifest is compared against it. */
  const [installed, setInstalled] = useState<string>("");
  useEffect(() => {
    void getVersion()
      .then(setInstalled)
      .catch(() => setInstalled("?"));
  }, []);
  const version = installed || "…";
  const updaterDesc = upd.lastCheckAt
    ? t("Versão instalada: {version} · última verificação: {when}", {
        version,
        when: new Date(upd.lastCheckAt).toLocaleString(locale()),
      })
    : t("Versão instalada: {version} · ainda não verificado", { version });
  const progress = progressLabel(upd.phase, upd.progress);
  /** The last bundle written this session; its name goes into the issue skeleton. */
  const [support, setSupport] = useState<SupportSummary | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);

  const bundleIt = async () => {
    const dest = await save({
      defaultPath: bundleFileName(new Date()),
      filters: [{ name: t("Pacote de suporte"), extensions: ["zip"] }],
    });
    if (!dest) return;
    setSupportError(null);
    try {
      const summary = await ipc.supportBundle(dest);
      setSupport(summary);
      showToast(
        t("Pacote gerado ({kb} KB).", { kb: Math.max(1, Math.round(summary.bytes / 1024)) }),
      );
    } catch (e) {
      setSupportError(String(e));
    }
  };

  // Copied, never opened: nothing in the app launches a browser.
  const copyTracker = async () => {
    const name = support?.path.split(/[\\/]/).pop();
    const ok = await copyText(
      `${TRACKER_URL}\n\n${issueBody({ version: support?.version, bundleName: name })}`,
    );
    if (ok) showToast(t("Link e roteiro copiados. Cole na issue e anexe o .zip."));
    else showToast(t("Não consegui copiar para a área de transferência."), "error");
  };

  useEffect(() => {
    setPaths(LOADING);
    void load(ipc.appPaths()).then(setPaths);
  }, []);

  const exportIt = async () => {
    const dest = await save({
      defaultPath: `yard-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: t("Backup do Yard"), extensions: ["zip"] }],
    });
    if (!dest) return;
    try {
      await ipc.exportBackup(dest);
      showToast(t("Backup exportado."));
    } catch (e) {
      showToast(t("Falha ao exportar: {error}", { error: String(e) }), "error");
    }
  };

  /**
   * Importing **stages** the backup; the swap happens on the next boot,
   * because the database this session is holding cannot be replaced from
   * under it. That is why the text changed: the old notice said "restart" in
   * passing while the app kept writing, on top of the restored state, exactly
   * the state that was about to be discarded.
   */
  const importIt = async () => {
    const src = await open({
      multiple: false,
      filters: [{ name: t("Backup do Yard"), extensions: ["zip"] }],
    });
    if (typeof src !== "string") return;
    try {
      await ipc.importBackup(src);
      setPending(true);
      showToast(t("Backup preparado. Ele entra no lugar quando o Yard reabrir."));
    } catch (e) {
      showToast(t("Falha ao importar: {error}", { error: String(e) }), "error");
    }
  };

  return (
    <>
      {pending && (
        <p className="hint hint--error" role="alert">
          {t(
            "Há um backup restaurado esperando. Ele substitui o workspace atual quando o Yard reabrir — até lá, tudo o que você fizer vai para o estado que será descartado.",
          )}
        </p>
      )}

      <Card>
        <Row label={t("Atualizações")} desc={updaterDesc}>
          <div className="set-actions">
            <button
              className="btn"
              disabled={upd.phase === "checking"}
              onClick={() => void checkForUpdates()}
            >
              <RefreshCw size={13} />{" "}
              {upd.phase === "checking" ? t("Verificando…") : t("Verificar agora")}
            </button>
          </div>
        </Row>
        {upd.phase === "available" && (
          <Row
            label={t("Versão {version} disponível", { version: upd.version ?? "" })}
            desc={upd.notes.length ? upd.notes.join(" · ") : t("Assinada e pronta para instalar.")}
          >
            <div className="set-actions">
              <button className="btn btn--primary" onClick={() => void installUpdate()}>
                <Download size={13} /> {t("Instalar e reiniciar")}
              </button>
              <button className="btn" onClick={() => useUpdater.getState().skip()}>
                {t("Ignorar esta versão")}
              </button>
            </div>
          </Row>
        )}
        {progress && (
          <p className="hint" role="status">
            {progress}
          </p>
        )}
        {upd.error && (
          <p className="hint hint--error" role="alert">
            {upd.phase === "error"
              ? t("Não consegui verificar atualizações: {error}", { error: upd.error })
              : t("Não consegui instalar: {error}", { error: upd.error })}
          </p>
        )}
        <SwitchRow
          pref="autoCheckUpdates"
          label={t("Verificar automaticamente")}
          desc={t("A cada seis horas, em silêncio quando não há nada novo.")}
        />
      </Card>

      <Card>
        <Row
          label={t("Backup do workspace")}
          desc={t(
            "Um .zip com projetos, grupos, layout e histórico. O backup importado entra no lugar quando o Yard reabrir.",
          )}
        >
          <div className="set-actions">
            <button className="btn" onClick={() => void exportIt()}>
              <Download size={13} /> {t("Exportar")}
            </button>
            <button className="btn" onClick={() => void importIt()}>
              <Upload size={13} /> {t("Importar")}
            </button>
          </div>
        </Row>
        {/* Shared with the App's permanent bar — one text, one
            behavior. */}
        {pending && (
          <Row
            label={t("Backup restaurado esperando")}
            desc={t("O Yard reabre já com ele no lugar; cancelar descarta o que foi importado.")}
          >
            <div className="set-actions">
              <button className="btn btn--primary" onClick={() => void restartIntoBackup()}>
                <RotateCw size={13} /> {t("Reiniciar agora")}
              </button>
              <button className="btn" onClick={() => void cancelBackupRestore()}>
                {t("Cancelar")}
              </button>
            </div>
          </Row>
        )}
        <Row
          label={t("Relatar um problema")}
          desc={t(
            "Gera um .zip com os logs dos últimos dois dias e a lista de CLIs desta máquina — sem banco, sem histórico dos terminais, sem anotações.",
          )}
        >
          <div className="set-actions">
            <button className="btn" onClick={() => void bundleIt()}>
              <LifeBuoy size={13} /> {t("Gerar pacote…")}
            </button>
            <button className="btn" onClick={() => void copyTracker()}>
              {t("Copiar link do rastreador")}
            </button>
          </div>
        </Row>
        {support && (
          <Row
            label={t("Pacote gerado")}
            desc={tn(support.entries.length, "{n} item: {list}", "{n} itens: {list}", {
              list: support.entries.join(", "),
            })}
          >
            <button className="btn" onClick={() => void ipc.revealPath(support.path)}>
              {t("Mostrar na pasta")}
            </button>
          </Row>
        )}
        {supportError && (
          <p className="hint hint--error" role="alert">
            {t("Não consegui gerar o pacote: {error}", { error: supportError })}
          </p>
        )}
        <PickerRow
          label={t("Backup automático")}
          value={autoBackup}
          options={[
            { value: "off", label: t("Desligado") },
            { value: "daily", label: t("Diário") },
            { value: "weekly", label: t("Semanal") },
          ]}
          onChange={(v) =>
            setPref(
              "autoBackup",
              AUTO_BACKUP_MODES.includes(v as AutoBackupMode) ? (v as AutoBackupMode) : "off",
            )
          }
        />
        <NumberRow
          pref="autoBackupKeep"
          label={t("Guardar as últimas cópias")}
          min={1}
          max={60}
          step={1}
        />
        <Row
          label={t("Pasta dos backups")}
          desc={
            autoBackupDir.trim()
              ? autoBackupDir
              : paths.state === "pronto"
                ? t("{dir} (padrão)", { dir: paths.data.backupsDir })
                : t("A pasta backups dentro dos dados do Yard (padrão)")
          }
        >
          <div className="set-actions">
            <button className="btn" onClick={() => void pickBackupDir()}>
              <FolderOpen size={13} /> {t("Escolher…")}
            </button>
            {autoBackupDir.trim() && (
              <button className="btn" onClick={() => setPref("autoBackupDir", "")}>
                {t("Padrão")}
              </button>
            )}
          </div>
        </Row>
        <Row
          label={t("Último backup automático: {when}", { when: describeLast(lastAutoAt, now) })}
          desc={
            autoBackup === "off"
              ? t(
                  "Ligue acima para o Yard copiar sozinho. Fazer agora grava uma cópia mesmo desligado.",
                )
              : describeNext(nextBackupAt({ mode: autoBackup, lastAt: lastAutoAt, now }), now)
          }
        >
          <button
            className="btn"
            disabled={autoRunning}
            onClick={() => void useAutoBackup.getState().runNow()}
          >
            {autoRunning ? t("Gravando…") : t("Fazer agora")}
          </button>
        </Row>
        {autoError && (
          <p className="hint hint--error" role="alert">
            {t("O último backup automático falhou: {error}", { error: autoError })}
          </p>
        )}
        <Row label={t("Pasta de dados")} desc={t("Banco, scrollback e logs, com rotação diária.")}>
          <button
            className="btn"
            disabled={paths.state !== "pronto"}
            onClick={() => {
              if (paths.state !== "pronto") return;
              void ipc
                .revealPath(paths.data.appDir)
                .catch((e) => showToast(String(e), "error"));
            }}
          >
            <FolderOpen size={13} /> {t("Abrir pasta")}
          </button>
        </Row>
      </Card>

      {/* Before, a failure here took the list **and** the button above with
          it, without a word — the whole section simply did not exist. */}
      {paths.state === "falhou" && (
        <p className="hint hint--error" role="alert">
          {t("Não consegui descobrir onde ficam os dados do Yard: {reason}.", {
            reason: paths.reason,
          })}
        </p>
      )}
      {paths.state === "pronto" && (
        <>
          <GroupTitle>{t("Caminhos")}</GroupTitle>
          <ul className="paths">
            <li>
              <span>{t("Banco")}</span>
              <code>{paths.data.dbPath}</code>
            </li>
            <li>
              <span>{t("Logs")}</span>
              <code>{paths.data.logsDir}</code>
            </li>
          </ul>
        </>
      )}
    </>
  );
}
