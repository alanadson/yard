/** A conversation is another view of the running terminal, with its own durable topics. */
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, Link, Paperclip, Pencil, Quote, Search, Send, Square, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { nanoid } from "nanoid";
import { useDraftText } from "./DomItems";
import { useT } from "../../hooks/useT";
import { useChats } from "../../stores/chatsStore";
import { useUI } from "../../stores/uiStore";
import { CHAT_TEXT_MAX, CHAT_TOPIC_NAME_MAX, CHAT_VISIBLE_PAGE, clearThread, createChat, markThreadRead, matchingMessages, messageWindow, quoteMessage, releaseUncertainTurn, renameThread, selectThread, type ChatMessage, type TerminalChat } from "../../lib/chat";
import { requestChatInterrupt } from "../../lib/chatRecovery";
import { associateChatTask, chatTaskCandidates } from "../../lib/chatTask";
import type { TaskCursor, WorkTask } from "../../lib/work";
import { sendChat } from "../../lib/chatDelivery";
import { exportChatTopic } from "../../lib/chatExport";
import { copyText } from "../../lib/clipboard";
import { pickPastedImage, saveClipboardImage, withPathAtCaret } from "../../lib/clipboardImage";
import { writeDragPaths } from "../../lib/canvasDrop";
import { ask } from "../../lib/confirmation";
import { ipc, type TerminalRow } from "../../lib/ipc";
import { spawnPortalNear } from "../../lib/portalSpawn";
import "./chat.css";
import "../CodeEditor/editor.css";

const EMPTY_CHAT = createChat();
const readOnlyTask = () => {};
const TOPIC_COLORS = ["#60a5fa", "#4ade80", "#c084fc", "#fb923c", "#f472b6", "#22d3ee", "#facc15"];
const MarkdownPreview = lazy(() => import("../CodeEditor/MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })));

interface Props {
  terminal: TerminalRow;
  visible: boolean;
  focused: boolean;
  onFocus: () => void;
}

function ChatCardImpl({ terminal, visible, focused, onFocus }: Props) {
  const t = useT();
  const stored = useChats((state) => state.byTerminal[terminal.id]);
  const broken = useChats((state) => state.errors[terminal.id]);
  const document = stored ?? EMPTY_CHAT;
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [linking, setLinking] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const fail = useCallback((error: unknown) => useUI.getState().showToast(t("Não consegui salvar a conversa: {error}", { error: String(error) }), "error"), [t]);
  const update = useCallback((change: (current: TerminalChat) => TerminalChat) => useChats.getState().update(terminal.id, change), [terminal.id]);
  const thread = document.activeThread;
  const topic = document.threads[thread];
  const topicName = topic.name?.trim() || t("Tópico {n}", { n: thread + 1 });
  const saveName = async () => {
    setBusy(true);
    try { await update((current) => renameThread(current, thread, nameDraft)); setRenaming(false); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const exportTopic = async () => {
    setBusy(true);
    try { if (await exportChatTopic(document, terminal.id, thread, topicName, new Date())) useUI.getState().showToast(t("Tópico exportado.")); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!visible || !focused || broken || topic.readCount === topic.messages.length) return;
    void update((current) => current.face === "chat" && current.activeThread === thread ? markThreadRead(current, thread) : current).catch(fail);
  }, [visible, focused, broken, topic.readCount, topic.messages.length, thread, update, fail]);

  const clear = async () => {
    if (!(await ask(t("Limpar o tópico {n}? As mensagens serão removidas. A memória do agente não muda.", { n: thread + 1 }), { title: t("Limpar este tópico"), kind: "warning" }))) return;
    try {
      await update((current) => clearThread(current, thread));
      setGeneration((value) => value + 1);
    } catch (error) { fail(error); }
  };

  return (
    <section className="cv-chat" aria-label={t("Conversa do agente")} onPointerDown={(event) => { event.stopPropagation(); onFocus(); }}>
      <div className="cv-chat-topics" role="tablist" aria-label={t("Tópicos da conversa")}>
        {document.threads.map((current, index) => (
          <button key={index} role="tab" aria-selected={index === thread} aria-label={current.name?.trim() || t("Tópico {n}", { n: index + 1 })} title={current.name?.trim() || t("Tópico {n}", { n: index + 1 })}
            style={{ "--topic-color": TOPIC_COLORS[index] } as React.CSSProperties}
            data-active={index === thread} data-filled={current.messages.length > 0}
            disabled={busy || renaming || linking || !!document.pending || !!broken}
            onClick={() => void update((value) => selectThread(value, index)).catch(fail)}>{index + 1}</button>
        ))}
        <span className="cv-chat-topic-label" title={topicName}>{topicName}</span>
        <button className="icon-btn" disabled={busy || !!document.pending || !!broken} aria-label={t("Associar tarefa")} aria-pressed={!!topic.taskId} onClick={() => setLinking(true)}><Link size={13} /></button>
        <button className="icon-btn" disabled={busy || !!broken} aria-label={t("Exportar tópico")} onClick={() => void exportTopic()}><Download size={13} /></button>
        <button className="icon-btn" disabled={busy || !!broken} aria-label={t("Renomear tópico")} onClick={() => { setNameDraft(topic.name ?? ""); setRenaming(true); }}><Pencil size={13} /></button>
        <button className="icon-btn" disabled={busy || !!document.pending || !!broken} aria-label={t("Limpar este tópico")} onClick={() => void clear()}><Trash2 size={13} /></button>
      </div>
      {renaming && <form className="cv-chat-rename" onSubmit={(event) => { event.preventDefault(); void saveName(); }} onKeyDown={(event) => event.stopPropagation()}>
        <input autoFocus value={nameDraft} maxLength={CHAT_TOPIC_NAME_MAX} aria-label={t("Nome do tópico")} placeholder={t("Nome do tópico")} disabled={busy} onChange={(event) => setNameDraft(event.target.value)} />
        <button className="btn btn--sm" type="submit" disabled={busy}>{t("Salvar")}</button><button className="btn btn--sm" type="button" disabled={busy} onClick={() => setRenaming(false)}>{t("Cancelar")}</button>
      </form>}
      {linking && <ChatTaskPicker terminalId={terminal.id} taskId={topic.taskId} busy={busy} onCancel={() => setLinking(false)} onFailure={fail}
        onSave={async (taskId) => {
          setBusy(true);
          try { await associateChatTask(terminal.id, thread, taskId); setLinking(false); }
          catch (error) { fail(error); }
          finally { setBusy(false); }
        }} />}
      {topic.taskId && <ChatTaskContext taskId={topic.taskId} />}
      {broken ? <p className="cv-chat-error" role="alert">{t("Não consegui recuperar esta conversa. Restaure um backup antes de editá-la.")}</p>
        : <ChatTopic key={`${thread}:${generation}`} terminal={terminal} document={document} onBusy={setBusy} onFailure={fail} />}
    </section>
  );
}

function ChatTaskContext({ taskId }: { taskId: string }) {
  const t = useT();
  const [title, setTitle] = useState(taskId);
  useEffect(() => {
    let active = true;
    setTitle(taskId);
    void ipc.taskGet(taskId).then((task) => { if (active) setTitle(task.title); }).catch(() => {});
    return () => { active = false; };
  }, [taskId]);
  return <p className="cv-chat-task-context" title={taskId}><Link size={12} />{t("Tarefa associada: {name}", { name: title })}</p>;
}

function ChatTaskPicker({ terminalId, taskId, busy, onSave, onCancel, onFailure }: {
  terminalId: string; taskId?: string; busy: boolean; onSave: (id: string | null) => Promise<void>; onCancel: () => void; onFailure: (error: unknown) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(taskId ?? "");
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [cursor, setCursor] = useState<TaskCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void ipc.taskList(null, 200, false).then((page) => {
      if (active.current) { setTasks(page.tasks); setCursor(page.next); }
    }).catch(onFailure).finally(() => { if (active.current) setLoading(false); });
    return () => { active.current = false; };
  }, [onFailure]);
  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await ipc.taskList(cursor, 200, false);
      if (active.current) { setTasks((previous) => [...previous, ...page.tasks.filter((task) => !previous.some((old) => old.id === task.id))]); setCursor(page.next); }
    } catch (error) { onFailure(error); }
    finally { if (active.current) setLoading(false); }
  };
  const candidates = chatTaskCandidates(tasks, terminalId);
  return <form className="cv-chat-task-picker" onSubmit={(event) => { event.preventDefault(); void onSave(selected || null); }} onKeyDown={(event) => event.stopPropagation()}>
    <label>{t("Tarefa deste tópico")}<select value={selected} disabled={busy || loading} onChange={(event) => setSelected(event.target.value)}>
      <option value="">{t("Sem tarefa associada")}</option>
      {taskId && !candidates.some((task) => task.id === taskId) && <option value={taskId}>{taskId}</option>}
      {candidates.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
    </select></label>
    <p className="hint">{t("Apenas tarefas atribuídas a este agente. A associação não altera o estado da tarefa.")}</p>
    <div className="cv-chat-task-actions">{cursor && <button className="btn btn--sm" type="button" disabled={busy || loading} onClick={() => void loadMore()}>{t("Carregar mais")}</button>}
      <button className="btn btn--sm" type="submit" disabled={busy || loading}>{t("Salvar")}</button>
      <button className="btn btn--sm" type="button" disabled={busy} onClick={onCancel}>{t("Cancelar")}</button>
    </div>
  </form>;
}

function ChatTopic({ terminal, document, onBusy, onFailure }: {
  terminal: TerminalRow; document: TerminalChat; onBusy: (busy: boolean) => void; onFailure: (error: unknown) => void;
}) {
  const t = useT();
  const thread = document.activeThread;
  const topic = document.threads[thread];
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // The draft has a row of its own: typing never rewrites the transcript.
  const commit = useCallback((value: string) => {
    void useChats.getState().setDraft(terminal.id, thread, value).catch(onFailure);
  }, [terminal.id, thread, onFailure]);
  const { draft, onChange, flush } = useDraftText(topic.draft, true, commit);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const quote = useCallback((text: string) => { onChange(draftRef.current + quoteMessage(text)); area.current?.focus(); }, [onChange]);
  // Only the newest messages are drawn (each one is a Markdown preview);
  // older ones wait behind "Carregar mais".
  const [limit, setLimit] = useState(CHAT_VISIBLE_PAGE);
  const { visible: messages, hidden } = messageWindow(matchingMessages(topic.messages, query), limit);

  useEffect(() => {
    const host = list.current;
    if (host && !query) host.scrollTop = host.scrollHeight;
  }, [topic.messages.length, query]);

  const send = async () => {
    if (sending || document.pending || !draft.trim()) return;
    setSending(true);
    onBusy(true);
    setError("");
    flush();
    try {
      await sendChat(terminal.id, draft, nanoid(12), Date.now(), thread);
      onChange("");
      flush();
    } catch (failure) { setError(String(failure)); }
    finally { setSending(false); onBusy(false); }
  };

  const interrupt = async () => {
    try { await requestChatInterrupt(terminal.id); }
    catch (failure) { setError(String(failure)); }
  };

  const recover = async () => {
    const turn = document.pending?.id;
    if (!turn) return;
    flush();
    if (!(await ask(t("Confira o terminal e interrompa o agente se ele ainda estiver trabalhando. Liberar este turno? O pedido voltará ao rascunho, sem envio automático."),
      { title: t("Revisar envio pendente"), kind: "warning", okLabel: t("Já conferi, liberar") }))) return;
    try {
      const recovered = await useChats.getState().update(terminal.id, (current) => releaseUncertainTurn(current, turn));
      onChange(recovered.threads[thread].draft);
      flush();
      setError("");
    } catch (failure) { setError(String(failure)); }
  };

  const insertPaths = (paths: string[]) => {
    const field = area.current;
    const inserted = withPathAtCaret(draft, field?.selectionStart ?? draft.length, field?.selectionEnd ?? draft.length, paths.map((path) => JSON.stringify(path.replaceAll("\\", "/"))).join(" "));
    onChange(inserted.text);
    field?.focus();
  };

  return (
    <div className="cv-chat-topic" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); search.current?.focus(); }
    }}>
      <label className="cv-chat-search"><Search size={12} /><input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Pesquisar neste tópico")} aria-label={t("Pesquisar neste tópico")} /></label>
      <div ref={list} className="cv-chat-messages" role="log" aria-live="polite">
        {hidden > 0 && <button className="btn btn--sm cv-chat-more" type="button" onClick={() => setLimit((value) => value + CHAT_VISIBLE_PAGE)}>{t("Carregar mais")}</button>}
        {messages.length === 0 ? <p className="cv-chat-empty">{query ? t("Nenhuma mensagem encontrada.") : t("Sem mensagens neste tópico.")}</p> : messages.map((message) => (
          <ChatMessageView key={message.id} message={message} terminal={terminal} onQuote={quote} />
        ))}
        {document.pending ? <div className="cv-chat-pending" role="status"><span className="cv-chat-pulse" />
          <span>{document.pending.delivery === "uncertain" ? t("Envio sem confirmação. Confira o terminal antes de reenviar.") : t("Resposta em andamento")}</span>
          {document.pending.delivery === "uncertain"
            ? <button className="btn btn--sm" type="button" onClick={() => void recover()}>{t("Revisar envio pendente")}</button>
            : <button className="icon-btn" aria-label={t("Interromper resposta")} onClick={() => void interrupt()}><Square size={12} /></button>}
        </div> : null}
      </div>
      {error ? <p role="alert" className="cv-chat-error">{t("Não consegui enviar a mensagem: {error}", { error })}</p> : null}
      <form className="cv-chat-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea ref={area} value={draft} maxLength={CHAT_TEXT_MAX} disabled={sending}
          onChange={(event) => onChange(event.target.value)} onBlur={flush}
          aria-label={t("Mensagem para o agente")} placeholder={t("Digite uma mensagem para o agente…")}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
          onPaste={(event) => {
            if (event.clipboardData.getData("text/plain")) return;
            const image = pickPastedImage(event.clipboardData);
            if (!image) return;
            event.preventDefault();
            void saveClipboardImage(image).then((path) => insertPaths([path])).catch(onFailure);
          }} />
        <div className="cv-chat-compose-actions">
          <button className="icon-btn" type="button" disabled={sending} aria-label={t("Anexar arquivo")} onClick={async () => {
            try { const paths = await open({ multiple: true, directory: false }); if (paths) insertPaths(Array.isArray(paths) ? paths : [paths]); }
            catch (failure) { onFailure(failure); }
          }}><Paperclip size={14} /></button>
          <span className="hint">{t("Shift+Enter para nova linha")}</span>
          <button className="btn btn--primary" type="submit" disabled={sending || !!document.pending || !draft.trim()} aria-label={t("Enviar mensagem")}><Send size={13} />{t("Enviar")}</button>
        </div>
      </form>
    </div>
  );
}

const ChatMessageView = memo(function ChatMessageView({ message, terminal, onQuote }: { message: ChatMessage; terminal: TerminalRow; onQuote: (text: string) => void }) {
  const t = useT();
  const openPath = useCallback((path: string) => { void ipc.openExternal(`${terminal.cwd}/${path}`).catch(() => {}); }, [terminal.cwd]);
  const openUrl = useCallback((url: string) => { void spawnPortalNear({ groupId: terminal.groupId, nearTerminalId: terminal.id, url }).catch(() => {}); }, [terminal.groupId, terminal.id]);
  return (
    <article className="cv-chat-message" data-role={message.role}>
      <header><strong>{message.role === "user" ? t("Você") : t("Agente")}</strong><span className="cv-chat-message-actions">
        <button className="icon-btn" aria-label={t("Copiar mensagem")} onClick={() => void copyText(message.text)}><Copy size={12} /></button>
        <button className="icon-btn" aria-label={t("Citar mensagem")} onClick={() => onQuote(message.text)}><Quote size={12} /></button>
      </span></header>
      {message.taskId && <p className="cv-chat-task-context" title={message.taskId}>{t("Referência da tarefa: {id}", { id: message.taskId })}</p>}
      <Suspense fallback={<p className="cv-chat-plain">{message.text}</p>}>
        <MarkdownPreview text={message.text} root={terminal.cwd} path="conversation.md" onTask={readOnlyTask} onOpenPath={openPath} onOpenUrl={openUrl} />
      </Suspense>
      {message.attachments.map((attachment) => <button key={attachment.path} className="cv-chat-attachment" draggable
        onDragStart={(event) => { event.stopPropagation(); writeDragPaths(event.dataTransfer, [{ path: attachment.path }]); }}
        onClick={() => void ipc.openExternal(attachment.path).catch(() => {})}><Paperclip size={12} />{attachment.name}</button>)}
    </article>
  );
});

export const ChatCard = memo(ChatCardImpl);
