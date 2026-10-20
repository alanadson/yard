import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { useUI } from "../../stores/uiStore";
import { useProjects } from "../../stores/projectsStore";
import { useOutputHistory } from "../../stores/outputHistoryStore";
import { ipc } from "../../lib/ipc";
import { baseName } from "../../lib/terminals";
import { exportFileName, exportModeFor } from "../../lib/termExport";
import { locale } from "../../lib/i18n";
import { archivePage, retentionCandidates, type ArchivedOutput } from "../../lib/outputHistory";
import { ask } from "../../lib/confirmation";
import "./outputHistory.css";

export function OutputHistoryModal() {
  const t = useT();
  const close = useUI((state) => state.closeModal);
  const payload = useUI((state) => state.modalPayload) as { terminalId?: string } | null;
  const [scope, setScope] = useState(payload?.terminalId ?? null);
  const [busy, setBusy] = useState(false);
  const [retentionDays, setRetentionDays] = useState(0);
  const records = useOutputHistory((state) => state.records);
  const selected = useOutputHistory((state) => state.selected);
  const preview = useOutputHistory((state) => state.preview);
  const loading = useOutputHistory((state) => state.loading);
  const previewLoading = useOutputHistory((state) => state.previewLoading);
  const error = useOutputHistory((state) => state.error);
  const terminals = useProjects((state) => state.terminals);
  const [visible, setVisible] = useState(200);
  const page = archivePage(records, visible);
  const candidates = retentionCandidates(records, retentionDays, Date.now());
  const nameOf = (id: string) => {
    const terminal = terminals.find((terminal) => terminal.id === id);
    return terminal ? baseName(terminal) : t("Terminal {id}", { id });
  };
  useEffect(() => { setVisible(200); void useOutputHistory.getState().load(scope); }, [scope]);
  const exportOutput = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const dest = await save({ title: t("Salvar saída arquivada"), defaultPath: exportFileName(nameOf(selected.terminalId), new Date(selected.at)),
        filters: [{ name: t("Texto"), extensions: ["txt"] }, { name: t("Registro ANSI (com cores)"), extensions: ["ansi"] }] });
      if (!dest) return;
      const bytes = await ipc.ptyArchiveExport(selected.terminalId, selected.name, dest, exportModeFor(dest) === "plain");
      useUI.getState().showToast(t("Saída salva ({kb} KB).", { kb: Math.max(1, Math.round(bytes / 1024)) }));
    } catch (error) { useOutputHistory.setState({ error: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  const remove = async (records: ArchivedOutput[]) => {
    if (records.length === 0) return;
    setBusy(true);
    let removed = 0;
    try {
      if (!await ask(t("Excluir {n} registro(s) arquivado(s)? A saída atual do terminal é preservada.", { n: records.length }), {
        title: t("Excluir registros arquivados"), kind: "warning", okLabel: t("Excluir"),
      })) return;
      for (const record of records) if (await ipc.ptyArchiveDelete(record.terminalId, record.name)) removed++;
      await useOutputHistory.getState().load(scope);
      useUI.getState().showToast(t("{n} registro(s) removido(s).", { n: removed }));
    } catch (error) {
      await useOutputHistory.getState().load(scope);
      useOutputHistory.setState({ error: error instanceof Error ? error.message : String(error) });
      if (removed) useUI.getState().showToast(t("{n} registro(s) removido(s).", { n: removed }));
    } finally { setBusy(false); }
  };
  const toolbar = <div className="output-history-toolbar">
    <span>{t("{n} registro(s)", { n: records.length })}</span>
    {scope && <button className="btn btn--sm" disabled={busy || loading} onClick={() => setScope(null)}>{t("Ver todos os terminais")}</button>}
    <button className="btn btn--sm" disabled={busy || loading} onClick={() => void useOutputHistory.getState().load(scope)}>{t("Atualizar")}</button>
    <button className="btn btn--sm" disabled={busy || !selected} onClick={() => void exportOutput()}>{t("Salvar saída…")}</button>
    <button className="btn btn--sm" disabled={busy || !selected} onClick={() => selected && void remove([selected])}>{t("Excluir registro")}</button>
    {error && <p className="hint hint--error" role="alert">{t("Não foi possível acessar o histórico: {reason}.", { reason: error })}</p>}
  </div>;
  return <Modal title={t("Histórico de saída")} onClose={close} wide toolbar={toolbar}>
    <p className="hint">{t("Saídas anteriores são preservadas ao começar do zero. Limpar a saída atual mantém estes registros.")}</p>
    <div className="output-history-retention"><label>{t("Remover registros antigos")}<select value={retentionDays} disabled={busy || loading} onChange={(event) => setRetentionDays(Number(event.target.value))}>
      <option value={0}>{t("Escolha um período")}</option><option value={30}>{t("Mais de 30 dias")}</option><option value={90}>{t("Mais de 90 dias")}</option><option value={365}>{t("Mais de 365 dias")}</option>
    </select></label><button className="btn btn--sm" disabled={busy || candidates.length === 0} onClick={() => void remove(retentionCandidates(records, retentionDays, Date.now()))}>{t("Remover {n} registro(s)", { n: candidates.length })}</button></div>
    {records.length === 0 ? <p className="hint">{loading ? t("Carregando…") : t("Nenhuma sessão arquivada.")}</p> : <div className="output-history-layout">
      <nav aria-label={t("Lista de registros")} className="output-history-list">
        {page.records.map((record) => <button key={record.name} className={`output-history-record${record.name === selected?.name ? " is-selected" : ""}`} disabled={busy || loading} onClick={() => void useOutputHistory.getState().select(record)}>
          <strong>{nameOf(record.terminalId)}</strong><time>{new Date(record.at).toLocaleString(locale())}</time><span>{Math.max(1, Math.round(record.bytes / 1024))} KB</span>
        </button>)}
        {page.nextLimit !== null && <button className="btn btn--sm" onClick={() => setVisible(page.nextLimit!)}>{t("Carregar mais")}</button>}
      </nav>
      <section className="output-history-preview" aria-busy={previewLoading}>
        {selected && <h3>{nameOf(selected.terminalId)}</h3>}
        {previewLoading && <p className="hint">{t("Carregando…")}</p>}
        {preview?.truncated && <p className="hint">{t("Exibindo apenas o trecho final. A exportação inclui o registro completo.")}</p>}
        <pre>{preview?.text ?? ""}</pre>
      </section>
    </div>}
  </Modal>;
}
