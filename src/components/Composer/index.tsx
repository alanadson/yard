import "./composer.css";

/**
 * Prompt composer (§P1.1): a dialog in the middle of the window for writing a
 * long prompt **outside** the terminal.
 *
 * Why it exists: inside the CLI, Enter submits. Writing ten lines there
 * becomes ten submits — or a shift+enter gymnastic that each agent treats
 * differently. Here the text only leaves when the user says so, and it
 * leaves via the same injection that the `yard ask` CLI uses (bracketed
 * paste + a separate Enter), so it arrives whole.
 *
 * It leaves by one of two doors, and the difference is who presses Enter:
 *
 * - **Enviar** — paste plus the Enter, the way `yard ask` does it. The prompt
 *   is gone and the agent is already working on it.
 * - **Colocar na CLI** — paste and stop. The text lands on the terminal's own
 *   prompt line, the window closes, focus goes back to the CLI, and the Enter
 *   stays with the user. This is the one for a prompt you want to read once
 *   more on the agent's own screen — and the only safe one when the CLI is
 *   mid-question and a stray Enter would answer it.
 *
 * It used to be a small box glued to the bottom-right corner, on the theory
 * that you write a prompt while looking at the workspace. In practice the only
 * button that opened it lived on a canvas card, so in the grid it was a
 * keyboard secret; and 560px in the corner is a cramped place to write the
 * thing the whole session depends on.
 *
 * `@Name` mentions an agent **connected to the target on the canvas** — the
 * same gate as the bridge. Mentioning also sends the same prompt to the
 * mentioned agent.
 *
 * Writing does not require a destination. With nothing in focus the text goes
 * to a scratch slot and the box stays fully usable — edit, save to the
 * library — until the user picks where it goes in the head's selector; the
 * draft follows that choice. Only *sending* needs a terminal.
 *
 * Pasting a screenshot here works: the image becomes a file in `%TEMP%` and
 * what goes into the draft is the path (`lib/clipboardImage.ts`). Note the
 * difference from the terminal: there the paste is *only* the path and the CLI
 * attaches the picture itself; here it travels in the middle of the prompt, so
 * the agent can simply open the file. Either way the image arrives.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, CornerDownLeft, ListPlus, Send, TerminalSquare, X } from "lucide-react";

import { Select } from "../Select";
import { composerContext } from "../../lib/bridge";
import { injectPrompt } from "../../lib/inject";
import { canSend, sendability } from "../../lib/sendable";
import { isTopLayer } from "../../lib/layers";
import {
  pickPastedImage,
  saveClipboardImage,
  withPathAtCaret,
} from "../../lib/clipboardImage";
import { findMentions } from "../../lib/bridgeCore";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { baseName } from "../../lib/terminals";
import { useBench } from "../../stores/benchStore";
import { useProjects } from "../../stores/projectsStore";
import { useTerminals } from "../../stores/terminalsStore";
import { useQueue } from "../../stores/queueStore";
import { composerAction } from "./action";
import { COMPOSER_SCRATCH, useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

export function Composer() {
  const open = useUI((s) => s.composerOpen);
  const setOpen = useUI((s) => s.setComposerOpen);
  const drafts = useUI((s) => s.composerDrafts);
  const setDraft = useUI((s) => s.setComposerDraft);
  const setComposerTarget = useUI((s) => s.setComposerTarget);
  const showToast = useUI((s) => s.showToast);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const composerTargetId = useUI((s) => s.composerTargetId);
  const t = useT();
  const terminals = useProjects((s) => s.terminals);
  const groups = useProjects((s) => s.groups);

  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState<{ query: string; at: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // `aria-modal` was declared without the behaviour: Tab escaped through the
  // backdrop into the app behind, and closing never gave focus back.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true, "compositor");
  /**
   * Is the mention menu **on screen**? Read by the window's `Escape` handler,
   * which is not re-created per key. It tracks the drawn list and not the
   * `menu` state: an `@` still being typed with nothing matching it shows
   * nothing, and there `Esc` has to close the dialog like anywhere else.
   */
  const menuRef = useRef(false);

  // A destination picked in the box wins over focus; focusing a terminal
  // clears that pick, so the more recent gesture is always the one in charge.
  const targetId = composerTargetId ?? focusedTerminalId;
  const target = useMemo(
    () => terminals.find((t) => t.id === targetId) ?? null,
    [terminals, targetId],
  );
  const runtimeState = useTerminals((s) =>
    target ? s.byId[target.id]?.state : undefined,
  );

  /**
   * What the main button will do, send now, or park it in the target's queue
   * (`Composer/action.ts`). Part of "ready" is a stretch of *silence*, and the
   * last byte of an agent's answer produces no further event, so a store
   * subscription alone would leave the button saying "Enfileirar" for a CLI
   * that has been free for a minute. Hence the tick, cheap because the
   * composer is a transient overlay.
   */
  const [readyTick, setReadyTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setReadyTick((n) => n + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);
  const willQueue = useMemo(
    () => (target ? composerAction(sendability(target.id)) === "queue" : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.id, runtimeState, readyTick, open],
  );

  // Anything can be picked, running or not: choosing where the prompt goes and
  // starting the agent are two separate decisions, and sending already refuses
  // a stopped terminal with a message that says what to do.
  const destinations = useMemo(() => {
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    return terminals.map((t) => ({
      value: t.id,
      label: baseName(t),
      group: groupName.get(t.groupId),
    }));
  }, [terminals, groups]);

  // Recalculated on every open/target switch: connections change on the
  // canvas all the time and a stale list would offer a mention the bridge would refuse.
  const ctx = useMemo(
    () => (target && open ? composerContext(target.id) : null),
    // `terminals` is included on purpose: recruit/dismiss changes the connected set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.id, open, terminals],
  );

  /** Where the text being edited lives: the destination, or the scratch. */
  const slot = target?.id ?? COMPOSER_SCRATCH;
  const draft = drafts[slot] ?? "";
  const mentioned = useMemo(
    () => (ctx ? findMentions(draft, ctx.agents.map((a) => a.name)) : []),
    [draft, ctx],
  );

  useEffect(() => {
    if (open) setTimeout(() => areaRef.current?.focus(), 30);
  }, [open, target?.id]);

  /**
   * `Escape` on the window, and not only in the textarea: now that there is a
   * backdrop, focus can be on a footer button when the key comes. The mention
   * menu gets first refusal — closing the whole window because someone
   * dismissed an autocomplete would eat the draft's context.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isTopLayer("compositor")) return;
      e.preventDefault();
      if (menuRef.current) {
        setMenu(null);
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // A destination that stopped existing (card deleted) hands the box back to
  // the focused terminal instead of pinning it to a dead id.
  useEffect(() => {
    if (composerTargetId && !terminals.some((t) => t.id === composerTargetId)) {
      setComposerTarget(null);
    }
  }, [composerTargetId, terminals, setComposerTarget]);

  // A draft written with no destination follows the first one chosen —
  // otherwise the text just typed would vanish from the box at the exact
  // moment the user says where it goes.
  useEffect(() => {
    if (!open || !target) return;
    const ui = useUI.getState();
    const loose = ui.composerDrafts[COMPOSER_SCRATCH] ?? "";
    if (!loose.trim()) return;
    const existing = ui.composerDrafts[target.id] ?? "";
    ui.setComposerDraft(
      target.id,
      existing.trim() ? `${existing}\n\n${loose}` : loose,
    );
    ui.setComposerDraft(COMPOSER_SCRATCH, "");
    if (existing.trim()) {
      showToast(`Juntei o rascunho solto ao texto de ${baseName(target)}.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id]);

  if (!open) return null;

  const running = runtimeState === "running" || runtimeState === "starting";
  const suggestions =
    menu && ctx
      ? ctx.agents.filter((a) => a.name.toLowerCase().startsWith(menu.query.toLowerCase()))
      : [];
  menuRef.current = suggestions.length > 0;

  const onChange = (value: string) => {
    setDraft(slot, value);
    // Mention menu: only while the most recent `@` is still being typed
    // (no space after it) and only when it opens a word.
    const caret = areaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    const opensWord = at === 0 || (at > 0 && /\s|[([{,;]/.test(before[at - 1]));
    const snippet = at >= 0 ? before.slice(at + 1) : "";
    if (at >= 0 && opensWord && !/[\n]/.test(snippet)) {
      setMenu({ query: snippet, at });
      setHighlight(0);
    } else {
      setMenu(null);
    }
  };

  /**
   * Image paste: writes the file and fits the path where the caret was. Text
   * wins — copying from a page usually brings both, and whoever copied text
   * wants the text.
   *
   * The draft is re-read from inside the callback (`getState`), not captured:
   * writing the file takes a tick and the user may have kept typing.
   */
  const pasteImage = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.getData("text/plain")) return;
    const image = pickPastedImage(e.clipboardData);
    if (!image) return;
    e.preventDefault();
    const area = areaRef.current;
    const start = area?.selectionStart ?? draft.length;
    const end = area?.selectionEnd ?? start;
    void saveClipboardImage(image)
      .then((path) => {
        const currentValue = useUI.getState().composerDrafts[slot] ?? "";
        const { text, caret } = withPathAtCaret(
          currentValue,
          Math.min(start, currentValue.length),
          Math.min(end, currentValue.length),
          path,
        );
        setDraft(slot, text);
        setMenu(null);
        setTimeout(() => {
          areaRef.current?.focus();
          areaRef.current?.setSelectionRange(caret, caret);
        }, 0);
      })
      .catch((err) => showToast(t("Não consegui colar a imagem: {err}", { err: String(err) }), "error"));
  };

  const applyMention = (itemName: string) => {
    if (!menu) return;
    const before = draft.slice(0, menu.at);
    const caret = areaRef.current?.selectionStart ?? draft.length;
    const after = draft.slice(caret);
    const fresh = `${before}@${itemName} ${after}`;
    setDraft(slot, fresh);
    setMenu(null);
    setTimeout(() => {
      areaRef.current?.focus();
      const pos = before.length + itemName.length + 2;
      areaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const send = async () => {
    const theText = draft.trim();
    if (!theText || sending) return;
    if (!target) {
      showToast(
        destinations.length
          ? t("Escolha o destino no topo do compositor antes de enviar.")
          : t("Nenhum terminal para receber — crie um antes de enviar."),
        "error",
      );
      return;
    }
    // Running is not enough: `injectPrompt` ends with Enter, so a prompt
    // handed to a CLI stuck on a question becomes its answer, and one handed
    // over mid-task arrives broken. The draft stays in the box, so refusing
    // costs the user nothing.
    const ready = sendability(target.id);
    // Busy or blocked is temporary by definition, and the queue exists for
    // exactly that: the prompt is parked and typed in the moment the CLI is
    // free. Dead or gone still refuses out loud (`Composer/action.ts`).
    const what = composerAction(ready);
    if (what === "refuse") {
      showToast(ready.message ?? t("{name} não pode receber agora.", { name: baseName(target) }), "error");
      return;
    }
    if (what === "queue") {
      const parked = useQueue.getState().enqueue(target.id, theText, "user");
      if (!parked.ok) {
        showToast(
          t("A fila de {name} está cheia, espere ela andar.", { name: baseName(target) }),
          "error",
        );
        return;
      }
      showToast(
        t("Na fila de {name} ({n}º), entra sozinho quando ele estiver livre.", {
          name: baseName(target),
          n: parked.position ?? 1,
        }),
      );
      // Same ending as a real send: the sentence is finished, and the sheet
      // covers the very agent the work was just handed to.
      setDraft(slot, "");
      setMenu(null);
      setOpen(false);
      return;
    }
    setSending(true);
    try {
      // A mention that is not running receives nothing: only the focused
      // terminal used to be checked, so an `@name` for a stopped agent went
      // to a dead PTY and the prompt vanished without warning. Same rule for
      // one that is busy or blocked — it is left out and named in the toast.
      const mentionedAgents = mentioned
        .map((name) => ctx?.agents.find((a) => a.name === name))
        .filter((a): a is NonNullable<typeof a> => !!a && a.id !== target.id);
      const notStarted = mentionedAgents.filter((a) => !canSend(a.id));
      const targets = [
        { id: target.id, name: ctx?.me ?? baseName(target) },
        ...mentionedAgents
          .filter((a) => canSend(a.id))
          .map((a) => ({ id: a.id, name: a.name })),
      ];

      // Run serially, a failure midway aborted the rest — the first ones had
      // already received it, the draft stayed intact, and resending
      // duplicated it for them.
      const outcomes = await Promise.allSettled(
        targets.map((recipient) => injectPrompt(recipient.id, theText)),
      );
      const failed = (i: number) => outcomes[i].status === "rejected";
      const primaryOk = !failed(0);
      const failures = targets.filter((_, i) => failed(i)).map((a) => a.name);

      // The draft only leaves the screen once the main recipient received it —
      // and so does the window. Back when this was a box in the corner, staying
      // open was the point: you could fire one prompt after another while
      // watching the workspace. In the middle of the screen it is a sheet over
      // everything, so an empty box left standing after Enviar hides the very
      // agent you just gave work to. It closes here for the same reason
      // "Deixar na CLI" does: the sentence is finished.
      if (primaryOk) {
        setDraft(slot, "");
        setMenu(null);
        setOpen(false);
        // And the eye lands where the answer will appear.
        useProjects.getState().setActiveTab(target.groupId, target.slot, target.id);
        useUI.getState().focusTerminal(target.id, target.slot);
      }

      const warnings: string[] = [];
      if (failures.length) warnings.push(t("não chegou em {names}", { names: failures.join(", ") }));
      if (notStarted.length) {
        warnings.push(
          t("{names} não estava livre para receber e ficou de fora", {
            names: notStarted.map((a) => a.name).join(", "),
          }),
        );
      }

      if (!primaryOk) {
        showToast(t("Falha ao enviar: {details}.", { details: warnings.join("; ") }), "error");
      } else if (warnings.length) {
        showToast(t("Prompt enviado, mas {details}.", { details: warnings.join("; ") }), "error");
      } else if (targets.length > 1) {
        showToast(t("Prompt enviado para {n} terminais.", { n: targets.length }));
      }
    } catch (e) {
      showToast(t("Falha ao enviar: {e}", { e: String(e) }), "error");
    } finally {
      setSending(false);
    }
  };

  /**
   * The other door: the text goes to the CLI's prompt line and stops there.
   *
   * Mentions are deliberately ignored here. "Send to everyone who was
   * mentioned" is an act; leaving text on a command line is a place, and there
   * is only one line in front of the user. Whoever wants the copies presses
   * Enviar.
   */
  const deliver = async () => {
    const text = draft.replace(/\s+$/, "");
    if (!text || sending) return;
    if (!target) {
      showToast(
        destinations.length
          ? t("Escolha o destino no topo do compositor antes.")
          : t("Nenhum terminal para receber — crie um antes."),
        "error",
      );
      return;
    }
    // "Deixar na CLI" does not press Enter, so a busy CLI only gets text on
    // its command line — no risk of answering someone else's question. Being
    // alive is enough.
    if (!running) {
      showToast(t("{name} não está rodando — inicie antes.", { name: baseName(target) }), "error");
      return;
    }
    setSending(true);
    try {
      await injectPrompt(target.id, text, { submit: false });
      setDraft(slot, "");
      setMenu(null);
      setOpen(false);
      // Back to the CLI with its tab in front: the next key belongs to the
      // prompt line that just filled up.
      useProjects.getState().setActiveTab(target.groupId, target.slot, target.id);
      useUI.getState().focusTerminal(target.id, target.slot);
    } catch (e) {
      showToast(t("Não consegui escrever na CLI: {e}", { e: String(e) }), "error");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && suggestions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.shiftKey)) {
        e.preventDefault();
        applyMention(suggestions[highlight].name);
        return;
      }
      // `Escape` with the menu up closes only the menu — handled on the window
      // (the effect above), which is the one place that decides.
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // The same pair of keys that opens the window decides which door it
      // leaves by: Ctrl+Enter sends, Ctrl+Shift+Enter hands the text over.
      if (e.shiftKey) void deliver();
      else void send();
    }
    // `Escape` is the window's (see the effect above), so the mention menu and
    // the dialog do not both answer the same key.
  };

  return (
    <div className="composer-backdrop" onMouseDown={() => setOpen(false)}>
    <div
      ref={dialogRef}
      className="composer"
      role="dialog"
      aria-modal="true"
      aria-label={t("Compositor de prompts")}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="composer-head">
        <strong>{t("Compositor")}</strong>
        {destinations.length > 0 ? (
          <>
            <Select
              className="composer-target"
              value={target?.id ?? ""}
              options={destinations}
              placeholder={t("Escolher destino…")}
              label={t("Destino do prompt")}
              tip={t("Para onde este prompt vai")}
              onChange={(id) => setComposerTarget(id)}
            />
            {target && <span className={`dot dot--${runtimeState ?? "idle"}`} />}
          </>
        ) : (
          <span className="composer-nodest">{t("nenhum terminal ainda")}</span>
        )}
        {mentioned.length > 0 && (
          <span className="composer-chip" data-tip-side="top" data-tip={t("Também recebe este prompt")}>
            +{mentioned.join(", +")}
          </span>
        )}
        <button
          className="icon-btn"
          aria-label={t("Fechar compositor")}
          data-tip-side="top" data-tip={t("Fechar (Esc)")}
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
          rows={12}
          spellCheck={false}
          aria-label={t("Texto do prompt")}
          placeholder={
            ctx?.agents.length
              ? t("Prompt de várias linhas… use @ para mencionar um agente conectado.")
              : target
                ? t("Prompt de várias linhas. Enter quebra linha; nada sai daqui sozinho.")
                : t("Escreva o prompt à vontade — escolha o destino lá em cima quando for entregar.")
          }
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={pasteImage}
        />
        {menu && suggestions.length > 0 && (
          <ul className="composer-mentions" role="listbox">
            {suggestions.map((a, i) => (
              <li key={a.id}>
                <button
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? "is-active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(a.name);
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
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t("envia")} · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+
          <kbd>Enter</kbd> {t("deixa na CLI")} · <kbd>Esc</kbd> {t("fecha")}
        </span>
        <button
          className="icon-btn composer-save"
          data-tip-side="top"
          data-tip={t("Guardar na biblioteca de prompts")}
          aria-label={t("Guardar este texto na biblioteca de prompts")}
          disabled={!draft.trim()}
          onClick={() => {
            const text = draft.trim();
            if (!text) return;
            const theTitle = text.split("\n")[0].slice(0, 60);
            useBench.getState().addPrompt({ title: theTitle, body: text });
            showToast(t("Guardado na biblioteca: “{title}”.", { title: theTitle }));
          }}
        >
          <BookmarkPlus size={13} />
        </button>
        {/* The quiet door, and the one to use when the agent is mid-question:
            the text goes to the command line and waits there for the user. */}
        <button
          className="btn"
          data-tip-side="top"
          data-tip-wrap=""
          data-tip={t("Escreve o texto na linha da CLI e fecha — o Enter fica com você")}
          disabled={!draft.trim() || sending}
          onClick={() => void deliver()}
        >
          <TerminalSquare size={13} /> {t("Deixar na CLI")}
        </button>
        {/* Stays clickable with no destination on purpose: a dead button
            explains nothing, and the click answers what is missing. */}
        <button
          className="btn btn--primary"
          data-tip-side="top"
          data-tip-wrap={willQueue ? "" : undefined}
          data-tip={
            target
              ? willQueue
                ? t("A CLI está ocupada: o texto fica na fila e entra sozinho quando ela liberar")
                : undefined
              : t("Escolha primeiro o destino, lá em cima")
          }
          disabled={!draft.trim() || sending}
          onClick={() => void send()}
        >
          {sending ? (
            <CornerDownLeft size={13} />
          ) : willQueue ? (
            <ListPlus size={13} />
          ) : (
            <Send size={13} />
          )}{" "}
          {sending ? t("Enviando…") : willQueue ? t("Enfileirar") : t("Enviar")}
        </button>
      </div>
    </div>
    </div>
  );
}
