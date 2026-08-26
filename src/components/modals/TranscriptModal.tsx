/**
 * The transcript — a session read from the start, as a document.
 *
 * Prompts as cards, the assistant's text as text, the tools between them as
 * compact rows with their result folded, thinking folded by default; a
 * search field at the top that counts and steps (Enter) like the editor's.
 * The blocks come from `lib/transcript.ts`; the file from `session_events`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "./transcript.css";
import { Check, ChevronDown, ChevronUp, Copy, Search, X } from "lucide-react";

import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { copyText } from "../../lib/clipboard";
import { locale } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";
import {
  searchTranscript,
  transcriptBlocks,
  transcriptMarkdown,
  type Block,
  type ToolItem,
} from "../../lib/transcript";
import { useUI } from "../../stores/uiStore";

interface Payload {
  file: string;
  title: string;
}

export function TranscriptModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const file = payload?.file ?? "";
  const title = payload?.title ?? t("Transcrição");

  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setBlocks(null);
    setError(null);
    if (!file) return;
    ipc
      .sessionEvents(file)
      .then((events) => {
        if (alive) setBlocks(transcriptBlocks(events));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [file]);

  const hits = useMemo(() => (blocks ? searchTranscript(blocks, query) : []), [blocks, query]);
  const current = hits.length ? hits[((step % hits.length) + hits.length) % hits.length] : -1;

  // The current hit scrolls into view; the others only light up.
  useEffect(() => {
    if (current < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-block="${current}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [current]);

  const copy = async () => {
    if (!blocks) return;
    const ok = await copyText(transcriptMarkdown(blocks, title));
    showToast(
      ok ? t("Transcrição copiada como markdown.") : t("Não consegui copiar."),
      ok ? "info" : "error",
    );
  };

  const counter = !query.trim()
    ? null
    : hits.length === 0
      ? t("sem ocorrências")
      : t("{i} de {n}", {
          i: (((step % hits.length) + hits.length) % hits.length) + 1,
          n: hits.length,
        });

  return (
    <Modal
      title={title}
      onClose={closeModal}
      wide
      initialFocus=".tr-search input"
      toolbar={
        <div className="tr-toolbar">
          <div role="search" className={`tr-search ${query && hits.length === 0 ? "is-empty" : ""}`}>
            <Search size={13} aria-hidden="true" />
            <input
              type="text"
              placeholder={t("Buscar na transcrição")}
              aria-label={t("Buscar na transcrição")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setStep(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setStep((s) => s + (e.shiftKey ? -1 : 1));
                } else if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
            {counter && <span className="tr-count">{counter}</span>}
            {query && (
              <button
                className="icon-btn"
                aria-label={t("Limpar a busca")}
                onClick={() => setQuery("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            className="icon-btn"
            data-tip={t("Ocorrência anterior (Shift+Enter)")}
            aria-label={t("Ocorrência anterior")}
            disabled={hits.length === 0}
            onClick={() => setStep((s) => s - 1)}
          >
            <ChevronUp size={13} />
          </button>
          <button
            className="icon-btn"
            data-tip={t("Próxima ocorrência (Enter)")}
            aria-label={t("Próxima ocorrência")}
            disabled={hits.length === 0}
            onClick={() => setStep((s) => s + 1)}
          >
            <ChevronDown size={13} />
          </button>
          <span className="tr-spacer" />
          <button className="btn" disabled={!blocks} onClick={() => void copy()}>
            <Copy size={12} /> {t("Copiar como markdown")}
          </button>
        </div>
      }
    >
      {error && (
        <p className="hint hint--error" role="alert">
          {t("Não consegui ler a sessão: {error}", { error })}
        </p>
      )}
      {!error && !blocks && <p className="hint">{t("Lendo a sessão…")}</p>}
      {blocks && blocks.length === 0 && (
        <p className="hint">{t("Esta sessão ainda não tem turnos.")}</p>
      )}
      {blocks && (
        <div className="tr-list" ref={listRef}>
          {blocks.map((b, i) => (
            <BlockView
              key={i}
              index={i}
              block={b}
              hit={hits.includes(i)}
              current={i === current}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

function BlockView({
  index,
  block,
  hit,
  current,
}: {
  index: number;
  block: Block;
  hit: boolean;
  current: boolean;
}) {
  const t = useT();
  const cls = `tr-block tr-${block.kind}${hit ? " is-hit" : ""}${current ? " is-current" : ""}`;
  const stamp = block.at > 0 ? new Date(block.at).toLocaleTimeString(locale()) : "";
  switch (block.kind) {
    case "prompt":
      return (
        <section className={cls} data-block={index}>
          <header>
            <span className="tr-who">
              {block.side ? t("você → sub-agente") : t("você")}
            </span>
            <time>{stamp}</time>
          </header>
          <p>{block.text}</p>
        </section>
      );
    case "say":
      return (
        <section className={cls} data-block={index}>
          <header>
            <span className="tr-who">{block.side ? t("sub-agente") : t("agente")}</span>
            <time>{stamp}</time>
          </header>
          <p>{block.text}</p>
        </section>
      );
    case "think":
      return (
        <details className={cls} data-block={index}>
          <summary>
            {t("pensando…")} <time>{stamp}</time>
          </summary>
          <p>{block.text}</p>
        </details>
      );
    case "notify":
      return (
        <p className={cls} data-block={index}>
          <em>{block.text}</em> <time>{stamp}</time>
        </p>
      );
    case "tools":
      return (
        <ul className={cls} data-block={index}>
          {block.items.map((item, j) => (
            <ToolRow key={j} item={item} />
          ))}
        </ul>
      );
  }
}

function ToolRow({ item }: { item: ToolItem }) {
  const t = useT();
  const mark =
    item.ok === null ? (
      <span className="tr-mark tr-mark--open" data-tip={t("Sem resultado gravado")}>…</span>
    ) : item.ok ? (
      <span className="tr-mark tr-mark--ok"><Check size={11} /></span>
    ) : (
      <span className="tr-mark tr-mark--fail"><X size={11} /></span>
    );
  const label = item.op && item.op !== "other" ? item.op : item.tool;
  const body = (
    <>
      {mark}
      <span className="tr-op">{label}</span>
      {item.path && <code className="tr-path">{item.path}</code>}
      {item.detail && <span className="tr-detail">{item.detail}</span>}
      {(item.added ?? 0) > 0 && <em className="tr-add">+{item.added}</em>}
      {(item.removed ?? 0) > 0 && <em className="tr-del">−{item.removed}</em>}
    </>
  );
  if (!item.result) return <li className="tr-tool">{body}</li>;
  return (
    <li className="tr-tool">
      <details>
        <summary>{body}</summary>
        <pre>{item.result}</pre>
      </details>
    </li>
  );
}
