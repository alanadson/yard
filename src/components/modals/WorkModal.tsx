import { useEffect, useMemo, useState, type FormEvent } from "react";
import { nanoid } from "nanoid";
import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { useUI } from "../../stores/uiStore";
import { useWork } from "../../stores/workStore";
import { useProjects } from "../../stores/projectsStore";
import { useQueue } from "../../stores/queueStore";
import { useChats } from "../../stores/chatsStore";
import { openTaskConversation, relatedTaskChats } from "../../lib/chatTask";
import { ipc } from "../../lib/ipc";
import { ask } from "../../lib/confirmation";
import { baseName } from "../../lib/terminals";
import { queueTask } from "../../lib/taskQueue";
import { flowsOf, flowAgents } from "../../lib/flow";
import { startFlow } from "../../lib/flowRun";
import { taskResourceAction } from "../../lib/workResources";
import { useCheckpoints } from "../../stores/checkpointsStore";
import { useEditor } from "../../stores/editorStore";
import { locale } from "../../lib/i18n";
import type { DeliveryRecord, TaskEvent, TaskResource } from "../../lib/work";
import { canCancelWork, previousDeliveries, TASK_STATUS_LABELS as STATUS_LABELS, taskTimelineText, validationResultLabel, workQueueAction, workExecutionLabel } from "./workReview";
import "./work.css";

// i18n-scan: tables, translated when rendered.
const EVENT_LABELS: Record<string, string> = {
  created: "Tarefa criada", queued: "Tarefa enviada para a fila", started: "Execução iniciada",
  status_changed: "Estado atualizado", submitted: "Entrega registrada", approved: "Entrega aprovada",
  interrupted: "Execução interrompida", resumed: "Tarefa reenviada para a fila",
  linked: "Referência vinculada",
  checkpoint_failed: "Checkpoint indisponível",
};

export function WorkModal() {
  const t = useT();
  const close = useUI((state) => state.closeModal);
  const tasks = useWork((state) => state.tasks);
  const selectedId = useWork((state) => state.selectedId);
  const total = useWork((state) => state.total);
  const loading = useWork((state) => state.loading);
  const next = useWork((state) => state.next);
  const filter = useWork((state) => state.filter);
  const attentionTotal = useWork((state) => state.attentionTotal);
  const projects = useProjects((state) => state.projects);
  const terminals = useProjects((state) => state.terminals);
  const groups = useProjects((state) => state.groups);
  const terminalNames = useMemo(() => Object.fromEntries(terminals.map((terminal) => [terminal.id, baseName(terminal)])), [terminals]);
  const selected = tasks.find((task) => task.id === selectedId);
  const chats = useChats((state) => state.byTerminal);
  const conversations = selected ? relatedTaskChats(chats, selected.id) : [];
  const queueAction = selected ? workQueueAction(selected, terminals.filter((terminal) => terminal.kind === "agent").map((terminal) => terminal.id)) : null;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [criteria, setCriteria] = useState("");
  const [projectId, setProjectId] = useState(useProjects.getState().activeProjectId ?? "");
  const [targetId, setTargetId] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [referenceKind, setReferenceKind] = useState<TaskResource["kind"]>("pull_request");
  const [referenceId, setReferenceId] = useState("");
  const [referenceRoot, setReferenceRoot] = useState("");
  const target = terminals.find((terminal) => terminal.id === targetId);
  const targetCanvas = target ? useProjects.getState().layoutOf(target.groupId).canvas : undefined;
  const pipelines = flowsOf(targetCanvas).filter((flow) => targetCanvas && flowAgents(targetCanvas, flow.id, target ? [target] : []).length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [deliveryHistory, setDeliveryHistory] = useState<DeliveryRecord[]>([]);
  const previousReports = selected ? previousDeliveries(selected.id, deliveryHistory) : [];

  const errorText = (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "acceptance_missing") return t("A aprovação exige evidências de todos os critérios e validações aprovadas.");
    if (code === "invalid_input") return t("Preencha o título e o pedido da tarefa.");
    if (code === "conflict") return t("A tarefa mudou durante a operação. Os dados foram atualizados.");
    if (code === "queue_full") return t("A fila deste agente está cheia.");
    const reason = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    return t("Não foi possível atualizar a tarefa: {reason}.", { reason });
  };

  useEffect(() => {
    let active = true;
    const refresh = () => void useWork.getState().refresh().catch((error) => { if (active) setError(errorText(error)); });
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { setTargetId(queueAction?.terminalId ?? ""); }, [selected?.id, queueAction?.terminalId]);
  useEffect(() => {
    let active = true;
    setEvents([]);
    setDeliveryHistory([]);
    if (selected) void Promise.all([ipc.taskEvents(selected.id), ipc.taskDeliveries(selected.id)]).then(([rows, reports]) => {
      if (active) { setEvents(rows); setDeliveryHistory(reports); }
    }).catch((error) => { if (active) setError(errorText(error)); });
    return () => { active = false; };
  }, [selected?.id, selected?.revision]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); await useWork.getState().refresh().catch((error) => setError(errorText(error))); }
  };
  const createTask = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      await useWork.getState().create({ id: nanoid(), title, request, criteria: criteria.split(/\r?\n/), links: { projectId: projectId || null, terminalIds: [] } });
      setTitle(""); setRequest(""); setCriteria(""); setCreating(false);
    });
  };
  const approve = async () => {
    if (!selected) return;
    if (await ask(t("Você conferiu a entrega, as evidências e os resultados de validação?"), { title: t("Aprovar entrega"), okLabel: t("Aprovar") })) {
      await perform(() => ipc.taskApprove(selected.id, selected.revision, t("Revisado no painel de tarefas.")));
    }
  };
  const cancel = async () => {
    if (!selected) return;
    if (await ask(t("Cancelar esta tarefa e retirar seus prompts pendentes?"), { title: t("Cancelar tarefa"), kind: "warning" })) {
      await perform(async () => {
        await ipc.taskTransition(selected.id, selected.revision, "cancelled");
        for (const item of useQueue.getState().items.filter((item) => item.taskId === selected.id)) await useQueue.getState().cancel(item.id);
      });
    }
  };
  const loadMore = () => void useWork.getState().loadMore().catch((error) => setError(errorText(error)));
  const sendTask = async () => {
    if (!selected || !queueAction || !targetId) return;
    if (queueAction.type === "resend" && !await ask(t("O agente pode ter iniciado o trabalho antes da interrupção. Confira o histórico antes de reenviar."), {
      title: t("Reenviar tarefa interrompida"), kind: "warning", okLabel: t("Reenviar"),
    })) return;
    const pipeline = pipelines.find((flow) => flow.id === pipelineId);
    if (pipeline && target) {
      await perform(async () => {
        const result = await startFlow(target.groupId, pipeline, selected.request, { terminalId: targetId, work: { id: selected.id, revision: selected.revision } });
        if (!result.ok) throw new Error(result.message);
      });
    } else await perform(() => queueTask(selected.id, selected.revision, targetId, nanoid()));
  };

  const openReference = async (resource: TaskResource) => {
    if (!selected) return;
    const action = taskResourceAction(resource, groups);
    if (!action) return;
    if (action.kind === "front") { useProjects.getState().setActiveGroup(action.id); close(); }
    if (action.kind === "checkpoint") {
      await useCheckpoints.getState().open({ root: action.root, taskId: selected.id, taskLabel: selected.title });
      await useCheckpoints.getState().select(action.id);
    }
    if (action.kind === "diff") {
      useEditor.getState().setRoot(selected.links.projectId, action.root);
      useEditor.getState().openDiff(action.path, { source: "tree", side: "head", origPath: null });
      close();
    }
    if (action.kind === "pull_request") await ipc.openExternal(action.url);
  };

  const toolbar = <div className="work-toolbar-area"><div className="work-toolbar">
      <span>{t("{n} tarefa(s)", { n: total })}</span>
      <button className="btn btn--sm" aria-pressed={filter === "all"} disabled={busy || loading} onClick={() => void perform(() => useWork.getState().setFilter("all"))}>{t("Todas")}</button>
      <button className="btn btn--sm" aria-pressed={filter === "attention"} disabled={busy || loading} onClick={() => void perform(() => useWork.getState().setFilter("attention"))}>{t("Precisa de atenção ({n})", { n: attentionTotal })}</button>
      <button className="btn btn--sm" onClick={() => setCreating(true)}>{t("Nova tarefa")}</button>
      <button className="btn btn--sm" disabled={loading || busy} onClick={() => void perform(() => useWork.getState().refresh())}>{t("Atualizar")}</button>
    </div>
    {error && <p className="hint hint--error" role="alert">{error}</p>}</div>;

  return <Modal title={t("Tarefas e entregas")} onClose={close} wide toolbar={toolbar} dirty={creating && !!(title || request || criteria)}>
    {creating ? <form className="work-form" onSubmit={createTask}>
      <label>{t("Título da tarefa")}<input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t("Pedido original")}<textarea required rows={4} value={request} onChange={(event) => setRequest(event.target.value)} /></label>
      <label>{t("Critérios de aceite, um por linha")}<textarea rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} /></label>
      <label>{t("Projeto")}<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{t("Sem projeto")}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <div className="work-toolbar"><button type="button" className="btn" onClick={() => setCreating(false)}>{t("Voltar")}</button><button type="submit" className="btn btn--primary" disabled={busy}>{t("Criar tarefa")}</button></div>
    </form> : <div className="work-layout">
      <nav className="work-list" aria-label={t("Lista de tarefas")}>
        {tasks.map((task) => <button key={task.id} className={`work-task ${task.id === selectedId ? "is-selected" : ""}`} onClick={() => useWork.setState({ selectedId: task.id })}>
          <strong>{task.title}</strong><span>{t(STATUS_LABELS[task.status] ?? "Estado desconhecido")}</span>
        </button>)}
        {tasks.length === 0 && <p className="hint">{loading ? t("Carregando…") : t("Nenhuma tarefa registrada.")}</p>}
        {next && <button className="btn btn--sm" disabled={busy} onClick={loadMore}>{t("Carregar mais")}</button>}
      </nav>
      {selected && <article className="work-detail">
        <h3>{selected.title}</h3><p className="hint">{t(STATUS_LABELS[selected.status] ?? "Estado desconhecido")}</p>
        <h4>{t("Pedido original")}</h4><p className="work-pre">{selected.request}</p>
        <section className="work-references"><h4>{t("Trabalho e evidências")}</h4>
          {(selected.links.resources ?? []).map((resource, index) => <p key={index}><button className="btn btn--sm" disabled={busy || !taskResourceAction(resource, groups)} onClick={() => void perform(() => openReference(resource))}>{resource.label}</button><span className="hint"> {resource.id}</span></p>)}
          <details><summary>{t("Vincular referência")}</summary><form className="work-form" onSubmit={(event) => { event.preventDefault(); void perform(() => ipc.taskLink(selected.id, selected.revision, { kind: referenceKind, id: referenceId, root: referenceRoot || null, label: referenceId })); }}>
            <label>{t("Tipo de referência")}<select value={referenceKind} onChange={(event) => setReferenceKind(event.target.value as TaskResource["kind"])}><option value="pull_request">{t("Pull request")}</option><option value="diff">{t("Arquivo alterado")}</option><option value="front">{t("Frente")}</option><option value="checkpoint">{t("Checkpoint")}</option></select></label>
            <label>{t("URL, caminho ou identificador")}<input required value={referenceId} onChange={(event) => setReferenceId(event.target.value)} /></label>
            {(referenceKind === "diff" || referenceKind === "checkpoint") && <label>{t("Pasta do trabalho")}<input required value={referenceRoot} onChange={(event) => setReferenceRoot(event.target.value)} /></label>}
            <button className="btn btn--sm" type="submit" disabled={busy}>{t("Vincular referência")}</button>
          </form></details>
        </section>
        <h4>{t("Critérios de aceite")}</h4><ol>{selected.criteria.map((criterion) => <li key={criterion.id}>{criterion.text}{criterion.evidence.map((reference) => <p className="hint work-pre" key={reference}>{reference}</p>)}</li>)}</ol>
        {conversations.length > 0 && <section className="work-chats"><h4>{t("Conversas relacionadas")}</h4>{conversations.map((conversation) => <button className="btn btn--sm" key={`${conversation.terminalId}:${conversation.thread}`} disabled={busy}
          onClick={() => void perform(() => openTaskConversation(conversation.terminalId, conversation.thread))}>
          {t("{agent}, {topic}: {n} mensagem(ns)", { agent: terminalNames[conversation.terminalId] ?? conversation.terminalId,
            topic: conversation.name ?? t("Tópico {n}", { n: conversation.thread + 1 }), n: conversation.messages })}
        </button>)}</section>}
        {queueAction && <div className="work-send">{queueAction.terminalMissing && <p className="hint">{t("O agente executor não está mais disponível. Escolha outro agente.")}</p>}
          <label>{t("Agente executor")}<select value={targetId} onChange={(event) => { setTargetId(event.target.value); setPipelineId(""); }}><option value="">{t("Escolha um agente")}</option>{terminals.filter((terminal) => terminal.kind === "agent").map((terminal) => <option key={terminal.id} value={terminal.id}>{baseName(terminal)}</option>)}</select></label>
          {pipelines.length > 0 && <label>{t("Executar com fluxo")}<select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}><option value="">{t("Execução direta")}</option>{pipelines.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</select></label>}
          <button className="btn btn--primary" disabled={busy || !targetId} onClick={() => void sendTask()}>{t(workExecutionLabel(queueAction.type, pipelines.some((flow) => flow.id === pipelineId)))}</button></div>}
        {selected.delivery && <section><h4>{t("Entrega registrada")}</h4><p className="work-pre">{selected.delivery.summary}</p><p className="hint">{t("Resultados e referências reportados na entrega.")}</p>{selected.delivery.checks.map((check, index) => <p key={index} className={check.passed ? "hint" : "hint hint--error"}>{check.name}: {t(validationResultLabel(check.passed))}<br />{check.evidence}</p>)}{selected.delivery.artifacts.map((artifact) => <p className="hint work-pre" key={artifact}>{artifact}</p>)}</section>}
        <div className="work-toolbar">
          {selected.status === "in_review" && <button className="btn btn--primary" disabled={busy} onClick={() => void approve()}>{t("Aprovar entrega")}</button>}
          {selected.status === "in_review" && <button className="btn" disabled={busy} onClick={() => void perform(() => ipc.taskTransition(selected.id, selected.revision, "running"))}>{t("Reabrir para ajustes")}</button>}
          {canCancelWork(selected.status) && <button className="btn" disabled={busy} onClick={() => void cancel()}>{t("Cancelar tarefa")}</button>}
        </div>
        <h4>{t("Linha do tempo")}</h4><ol className="notification-history">{events.map((event) => {
          const detail = taskTimelineText(event, terminalNames, (text) => t(text));
          return <li key={event.id}><strong>{t(EVENT_LABELS[event.kind] ?? "Estado atualizado")}</strong><time className="hint"> {new Date(event.at).toLocaleString(locale())}</time>{detail && <p className="work-pre hint">{detail}</p>}</li>;
        })}</ol>
        {previousReports.length > 0 && <details className="work-history"><summary>{t("Histórico de entregas ({n})", { n: previousReports.length })}</summary>{previousReports.map((record) => <section key={record.revision}>
          <h4>{record.delivery.summary}</h4><time className="hint">{new Date(record.at).toLocaleString(locale())}</time>
          <ol>{record.criteria.map((criterion) => <li key={criterion.id}>{criterion.text}{criterion.evidence.map((reference) => <p className="hint work-pre" key={reference}>{reference}</p>)}</li>)}</ol>
          {record.delivery.artifacts.map((reference) => <p className="hint work-pre" key={reference}>{reference}</p>)}
          {record.delivery.checks.map((check, index) => <p className={check.passed ? "hint work-pre" : "hint hint--error work-pre"} key={index}>{check.name}: {t(validationResultLabel(check.passed))}<br />{check.evidence}</p>)}
        </section>)}</details>}
      </article>}
    </div>}
  </Modal>;
}
