import { useEffect, useMemo, useState } from "react";
import { Camera, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { useNow } from "../../hooks/useNow";
import { useCheckpoints } from "../../stores/checkpointsStore";
import { useEditor, isDirty } from "../../stores/editorStore";
import { useProjects } from "../../stores/projectsStore";
import { useTerminals, isLive } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import { useScm } from "../../stores/scmStore";
import { restoreBlockReason, checkpointChangeLabel, checkpointRootsOverlap, type CheckpointComparison } from "../../lib/checkpoints";
import { canSend } from "../../lib/sendable";
import { ipc } from "../../lib/ipc";
import { ask } from "../../lib/confirmation";
import { unifiedDiff } from "../../lib/unified";
import { diffLineClass } from "../../lib/diff";
import { locale } from "../../lib/i18n";
import "./checkpoints.css";

function restoreGuard(root: string): string | null {
  const busy = useProjects.getState().terminals.some((terminal) =>
    checkpointRootsOverlap(root, terminal.cwd) && isLive(useTerminals.getState().byId[terminal.id]) && !canSend(terminal.id));
  return restoreBlockReason(root, useEditor.getState().docs, busy);
}

export function CheckpointsModal() {
  const t = useT();
  const state = useCheckpoints();
  const [label, setLabel] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [comparison, setComparison] = useState<CheckpointComparison | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  useNow(1000);
  const root = state.scope?.root;
  const selected = state.rows.find((row) => row.id === state.selectedId);
  const blocked = state.preview?.blockedReason ?? (root ? restoreGuard(root) : null);

  useEffect(() => { setPath(null); }, [state.selectedId, state.preview]);
  useEffect(() => {
    let current = true;
    setComparison(null);
    setFileError(null);
    if (root && state.selectedId && path) {
      void ipc.checkpointCompare(root, state.selectedId, path).then(
        (value) => { if (current) setComparison(value); },
        (error) => { if (current) setFileError(String(error)); },
      );
    }
    return () => { current = false; };
  }, [root, state.selectedId, path]);
  const diff = useMemo(() => comparison && !comparison.binary && path
    ? unifiedDiff(comparison.before ?? "", comparison.after ?? "", path) : null, [comparison, path]);

  const restore = async () => {
    const recovery = await state.restore(restoreGuard, (message) => ask(message, {
      title: t("Restaurar checkpoint"), kind: "warning", okLabel: t("Restaurar arquivos"),
    }));
    if (!recovery || !root) return;
    useUI.getState().showToast(t("Arquivos restaurados. Use o checkpoint de recuperação para desfazer."));
    await Promise.allSettled(useEditor.getState().docs.filter((doc) => checkpointRootsOverlap(doc.root, root) && !isDirty(doc))
      .map((doc) => useEditor.getState().reload(doc.id)));
    await useScm.getState().refresh(root, true);
  };
  const remove = async () => {
    if (!selected || !root) return;
    if (await ask(t('Excluir o checkpoint "{label}"? Os arquivos de trabalho serão mantidos.', { label: selected.label }), {
      title: t("Excluir checkpoint"), kind: "warning", okLabel: t("Excluir checkpoint"),
    })) {
      if (useCheckpoints.getState().scope?.root === root) await state.remove(selected.id);
    }
  };
  const create = async () => {
    const saved = await state.create(label);
    if (saved) { setLabel(""); await state.select(saved.id); }
  };

  return <Modal title={t("Checkpoints de código")} onClose={state.close} wide
    footer={<>
      <span className="checkpoint-footer-note">{t("O stage e os commits do Git são preservados.")}</span>
      <button className="btn" disabled={!selected || state.busy} onClick={() => void remove()}><Trash2 size={13} />{t("Excluir checkpoint")}</button>
      <button className="btn btn--primary" disabled={!state.preview?.files.length || !!blocked || state.busy} onClick={() => void restore()}>
        <RotateCcw size={13} />{state.busy ? t("Aguarde...") : t("Restaurar arquivos")}
      </button>
    </>}>
    <div className="checkpoint-manager" aria-busy={state.busy}>
      <div className="checkpoint-scope"><strong>{state.scope?.taskLabel}</strong><code>{root}</code></div>
      <p className="checkpoint-help">{t("Cada checkpoint guarda os arquivos salvos de toda esta pasta. Outros agentes que usam a mesma pasta também serão afetados pela restauração.")}</p>
      <form className="checkpoint-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <input aria-label={t("Nome do checkpoint")} placeholder={t("Antes de refatorar, primeira versão...")} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} disabled={state.busy} />
        <button className="btn" disabled={!label.trim() || state.busy}><Camera size={13} />{t("Criar checkpoint")}</button>
        <button className="btn" type="button" disabled={state.busy || state.loading} aria-label={t("Atualizar checkpoints")} onClick={() => void state.refresh()}><RefreshCw size={13} /></button>
      </form>
      {state.error && <p className="checkpoint-error" role="alert">{t(state.error)}</p>}
      <div className="checkpoint-columns">
        <div className="checkpoint-list" aria-label={t("Checkpoints nesta pasta")}>
          {state.loading && <p role="status">{t("Carregando checkpoints...")}</p>}
          {!state.loading && !state.rows.length && <p>{t("Nenhum checkpoint nesta pasta. Crie um acima ou envie uma tarefa a um agente local pelo Yard.")}</p>}
          {state.rows.map((row) => <button key={row.id} className="checkpoint-row" aria-pressed={row.id === state.selectedId} disabled={state.busy} onClick={() => void state.select(row.id)}>
            <strong>{t(row.label)}</strong><span>{row.taskLabel}</span>
            <small>{new Date(row.createdAt).toLocaleString(locale())} · {t("{n} arquivos", { n: row.fileCount })} · {(row.bytes / 1024 / 1024).toFixed(1)} MB</small>
          </button>)}
        </div>
        <div className="checkpoint-review">
          {state.comparing && <p role="status">{t("Comparando arquivos...")}</p>}
          {!state.selectedId && <p>{t("Selecione um checkpoint para comparar com os arquivos atuais.")}</p>}
          {blocked && state.preview && <p className="checkpoint-warning" role="status">{t(blocked)}</p>}
          {state.preview && <>
            <div className="checkpoint-review-title"><strong>{t("{n} arquivos serão alterados", { n: state.preview.files.length })}</strong>
              <button className="btn btn--sm" disabled={state.busy} onClick={() => void state.select(state.selectedId!)}>{t("Comparar novamente")}</button></div>
            {!state.preview.files.length && <p>{t("Os arquivos já correspondem a este checkpoint.")}</p>}
            <div className="checkpoint-files">{state.preview.files.map((file) => <button key={file.path} className="checkpoint-file" aria-pressed={path === file.path} onClick={() => setPath(file.path)}>
              <code>{file.path}</code><small>{checkpointChangeLabel(file.status)}</small>
            </button>)}</div>
          </>}
          {path && <div className="checkpoint-comparison">
            <strong>{t("Checkpoint → arquivo atual")}</strong>
            {fileError ? <p role="alert">{t(fileError)}</p> : !comparison ? <p role="status">{t("Comparando arquivos...")}</p>
              : comparison.binary ? <p>{t("Arquivo binário ou grande demais para exibir. A restauração preserva seu conteúdo completo.")}</p>
              : diff === null ? <p>{t("As diferenças são grandes demais para exibir.")}</p>
              : !diff ? <p>{t("Sem diferenças de texto. O formato ou os finais de linha podem ter mudado.")}</p>
              : <pre className="checkpoint-diff" tabIndex={0}>{diff.split("\n").map((line, index) => <span key={index} className={diffLineClass(line)}>{line}{"\n"}</span>)}</pre>}
          </div>}
        </div>
      </div>
    </div>
  </Modal>;
}
