/**
 * Prompt composer (§P1.1): a floating box over the workspace for writing a
 * long prompt **outside** the terminal.
 *
 * Why it exists: inside the CLI, Enter submits. Writing ten lines there
 * becomes ten submits — or a shift+enter gymnastic that each agent treats
 * differently. Here the text only leaves when the user sends it, and it
 * leaves via the same injection that the `yard ask` CLI uses (bracketed
 * paste + a separate Enter), so it arrives whole.
 *
 * `@Name` mentions an agent **connected to the target on the canvas** — the
 * same gate as the bridge. Mentioning also sends the same prompt to the
 * mentioned agent.
 *
 * Out of scope: pasting an image/screenshot inline. WebView2 even delivers
 * the blob, but there is no good way to stuff an image into a PTY; the CLIs
 * expect a file path. Recorded as a conscious absence.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Send, X } from "lucide-react";

import { composerContext, injectPrompt } from "../../lib/bridge";
import { findMentions } from "../../lib/bridgeCore";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";

export function Composer() {
  const open = useUI((s) => s.composerOpen);
  const setOpen = useUI((s) => s.setComposerOpen);
  const drafts = useUI((s) => s.composerDrafts);
  const setDraft = useUI((s) => s.setComposerDraft);
  const showToast = useUI((s) => s.showToast);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const terminals = useProjects((s) => s.terminals);
  const runtimes = useTerminals((s) => s.byId);

  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState<{ query: string; at: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const target = useMemo(
    () => terminals.find((t) => t.id === focusedTerminalId) ?? null,
    [terminals, focusedTerminalId],
  );

  // Recalculated on every open/target switch: connections change on the
  // canvas all the time and a stale list would offer a mention the bridge would refuse.
  const ctx = useMemo(
    () => (target && open ? composerContext(target.id) : null),
    // `terminals` is included on purpose: recruit/dismiss changes the connected set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.id, open, terminals],
  );

  const draft = target ? (drafts[target.id] ?? "") : "";
  const mentioned = useMemo(
    () => (ctx ? findMentions(draft, ctx.agents.map((a) => a.name)) : []),
    [draft, ctx],
  );

  useEffect(() => {
    if (open) setTimeout(() => areaRef.current?.focus(), 30);
  }, [open, target?.id]);

  if (!open) return null;

  if (!target) {
    return (
      <div className="composer" role="dialog" aria-label="Compositor de prompts">
        <div className="composer-head">
          <strong>Compositor</strong>
          <button className="icon-btn" aria-label="Fechar" onClick={() => setOpen(false)}>
            <X size={13} />
          </button>
        </div>
        <p className="composer-empty">
          Clique num terminal primeiro — o prompt vai para o que estiver em foco.
        </p>
      </div>
    );
  }

  const rt = runtimes[target.id];
  const running = isLive(rt);
  const sugestoes =
    menu && ctx
      ? ctx.agents.filter((a) => a.name.toLowerCase().startsWith(menu.query.toLowerCase()))
      : [];

  const onChange = (value: string) => {
    setDraft(target.id, value);
    // Mention menu: only while the most recent `@` is still being typed
    // (no space after it) and only when it opens a word.
    const caret = areaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    const abrePalavra = at === 0 || (at > 0 && /\s|[([{,;]/.test(before[at - 1]));
    const trecho = at >= 0 ? before.slice(at + 1) : "";
    if (at >= 0 && abrePalavra && !/[\n]/.test(trecho)) {
      setMenu({ query: trecho, at });
      setHighlight(0);
    } else {
      setMenu(null);
    }
  };

  const aplicarMencao = (nome: string) => {
    if (!menu) return;
    const antes = draft.slice(0, menu.at);
    const caret = areaRef.current?.selectionStart ?? draft.length;
    const depois = draft.slice(caret);
    const novo = `${antes}@${nome} ${depois}`;
    setDraft(target.id, novo);
    setMenu(null);
    setTimeout(() => {
      areaRef.current?.focus();
      const pos = antes.length + nome.length + 2;
      areaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const enviar = async () => {
    const texto = draft.trim();
    if (!texto || sending) return;
    if (!running) {
      showToast("O terminal em foco não está rodando — inicie antes de enviar.", "error");
      return;
    }
    setSending(true);
    try {
      const alvos = [
        target.id,
        ...mentioned
          .map((nome) => ctx?.agents.find((a) => a.name === nome)?.id)
          .filter((id): id is string => !!id && id !== target.id),
      ];
      for (const id of alvos) await injectPrompt(id, texto);
      setDraft(target.id, "");
      setMenu(null);
      if (alvos.length > 1) {
        showToast(`Prompt enviado para ${alvos.length} terminais.`);
      }
    } catch (e) {
      showToast(`Falha ao enviar: ${e}`, "error");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && sugestoes.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % sugestoes.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + sugestoes.length) % sugestoes.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.shiftKey)) {
        e.preventDefault();
        aplicarMencao(sugestoes[highlight].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void enviar();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="composer" role="dialog" aria-label="Compositor de prompts">
      <div className="composer-head">
        <strong>{ctx?.me ?? target.title ?? target.program}</strong>
        <span className={`dot dot--${rt?.state ?? "idle"}`} />
        {mentioned.length > 0 && (
          <span className="composer-chip" data-tip-side="top" data-tip="Também recebe este prompt">
            +{mentioned.join(", +")}
          </span>
        )}
        <button
          className="icon-btn"
          aria-label="Fechar compositor"
          data-tip-side="top" data-tip="Fechar (Esc)"
          onClick={() => setOpen(false)}
        >
          <X size={13} />
        </button>
      </div>

      <div className="composer-area">
        <textarea
          ref={areaRef}
          className="composer-input"
          value={draft}
          rows={5}
          spellCheck={false}
          placeholder={
            ctx?.agents.length
              ? "Prompt de várias linhas… use @ para mencionar um agente conectado."
              : "Prompt de várias linhas. Enter quebra linha; Ctrl+Enter envia."
          }
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {menu && sugestoes.length > 0 && (
          <ul className="composer-mentions" role="listbox">
            {sugestoes.map((a, i) => (
              <li key={a.id}>
                <button
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? "is-active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    aplicarMencao(a.name);
                  }}
                >
                  @{a.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="composer-foot">
        <span className="composer-hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> envia · <kbd>Esc</kbd> fecha · rascunho
          guardado por terminal
        </span>
        <button
          className="btn btn--primary"
          disabled={!draft.trim() || sending}
          onClick={() => void enviar()}
        >
          {sending ? <CornerDownLeft size={13} /> : <Send size={13} />} Enviar
        </button>
      </div>
    </div>
  );
}
