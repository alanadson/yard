/**
 * "Ao Vivo" — mission control for an agent session.
 *
 * Glass overlay above the workspace (holds no xterm — vibrancy allowed)
 * with three regions: the timeline of what the agent is doing right now,
 * the aggregate of touched files (click opens the real diff) and the board
 * with the agent's plan + sub-agents as a kanban.
 *
 * The source of everything is the tap on the `.jsonl` in the backend
 * (`agents/tail.rs`); this component only draws what `liveStore` has
 * already reduced.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import "./live.css";

import { NO_REPO, fileRow } from "./fileRow";
import {
  AlertCircle,
  BellRing,
  Bot,
  Check,
  ChevronDown,
  Eye,
  FileClock,
  ListChecks,
  Loader2,
  MessageSquare,
  Puzzle,
  RotateCw,
  Search,
  Sparkles,
  SquareTerminal,
  User,
  Wand2,
  X,
} from "lucide-react";

import { BrandIcon } from "../BrandIcon";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { brandById } from "../../lib/brands";
import { clock as fmtClock, elapsed as fmtElapsed } from "../../lib/format";
import { splitPath } from "../../lib/paths";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useNow } from "../../hooks/useNow";
import { useChanges } from "../../stores/changesStore";
import {
  useLive,
  type AgentCard,
  type LiveEntry,
  type PlanCard,
} from "../../stores/liveStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";
import { locale } from "../../lib/i18n";

/** One compact formatter per interface language — the overlay renders every second. */
const compactByLocale = new Map<string, Intl.NumberFormat>();
function compact(): Intl.NumberFormat {
  const l = locale();
  let f = compactByLocale.get(l);
  if (!f) {
    f = new Intl.NumberFormat(l, { notation: "compact", maximumFractionDigits: 1 });
    compactByLocale.set(l, f);
  }
  return f;
}

// i18n-scan: tables
const LANES: { id: PlanCard["status"]; label: string }[] = [
  { id: "pending", label: "A fazer" },
  { id: "in_progress", label: "Fazendo" },
  { id: "completed", label: "Feito" },
];

/** Left-side icon/badge of a timeline row. */
function RowMark({ e }: { e: LiveEntry }) {
  if (e.kind === "prompt") return <User size={12} aria-hidden="true" />;
  if (e.kind === "say") return <MessageSquare size={12} aria-hidden="true" />;
  if (e.kind === "think") return <Sparkles size={12} aria-hidden="true" />;
  if (e.kind === "notify") return <BellRing size={12} aria-hidden="true" />;
  switch (e.op) {
    case "edit":
      return <span className="live-mark-badge live-mark-badge--m">M</span>;
    case "write":
      return <span className="live-mark-badge live-mark-badge--a">A</span>;
    case "read":
      return <Eye size={12} aria-hidden="true" />;
    case "run":
      return <SquareTerminal size={12} aria-hidden="true" />;
    case "search":
      return <Search size={12} aria-hidden="true" />;
    case "agent":
      return <Bot size={12} aria-hidden="true" />;
    case "plan":
    case "todo":
      return <ListChecks size={12} aria-hidden="true" />;
    case "skill":
      return <Wand2 size={12} aria-hidden="true" />;
    default:
      return <Puzzle size={12} aria-hidden="true" />;
  }
}

function RowBody({ e }: { e: LiveEntry }) {
  const t = useT();
  if (e.kind !== "tool") {
    return <span className="live-row-text">{e.text}</span>;
  }
  const path = e.path ? splitPath(e.path) : null;
  return (
    <span className="live-row-main">
      {path && (
        <span className="live-path" data-tip-wrap="" data-tip={e.path}>
          <span className="live-path-dir">{path.dir}</span>
          <span className="live-path-base">{path.base}</span>
        </span>
      )}
      {(e.added ?? 0) > 0 && <em className="live-add">+{e.added}</em>}
      {(e.removed ?? 0) > 0 && <em className="live-del">−{e.removed}</em>}
      {e.op === "agent" && (
        <>
          {e.agentType && <span className="live-chip">{e.agentType}</span>}
          {e.detail && <span className="live-row-text">{e.detail}</span>}
        </>
      )}
      {e.op !== "agent" && !path && e.detail && (
        <span className={`live-row-text ${e.op === "run" || e.op === "search" ? "live-row-text--mono" : ""}`}>
          {e.detail}
        </span>
      )}
      {e.side && <span className="live-side" data-tip={t("Feito por um sub-agent")}>sub</span>}
    </span>
  );
}

/**
 * The timeline, memoized and deliberately blind to the clock.
 *
 * It is the tallest list on screen (up to 400 rows) and the one that changes
 * least: an entry is written once and then only its `pending` flag flips. The
 * overlay's 1 s tick used to re-render all of it to move a "4s ago" elsewhere.
 */
const Timeline = memo(function Timeline({ entries }: { entries: LiveEntry[] }) {
  const t = useT();
  return (
    <>
      {entries.length === 0 && (
        <div className="live-feed-empty">{t("ainda nada por aqui…")}</div>
      )}
      {entries.map((e) => (
        <TimelineRow key={e.id} e={e} />
      ))}
    </>
  );
});

const TimelineRow = memo(function TimelineRow({ e }: { e: LiveEntry }) {
  return (
    <div
      className={`live-row live-row--${e.kind === "tool" ? (e.op ?? "other") : e.kind} ${e.failed ? "live-row--failed" : ""}`}
    >
      <span className="live-row-mark">
        <RowMark e={e} />
      </span>
      <RowBody e={e} />
      <span className="live-row-end">
        {e.pending ? (
          <Loader2 size={11} className="spin" aria-hidden="true" />
        ) : e.failed ? (
          <AlertCircle size={11} aria-hidden="true" />
        ) : (
          <time>{fmtClock(e.at)}</time>
        )}
      </span>
    </div>
  );
});

export function LiveView() {
  const phase = useLive((s) => s.phase);
  const terminalTitle = useLive((s) => s.terminalTitle);
  const brand = useLive((s) => brandById(s.agentId));
  const session = useLive((s) => s.session);
  const sessions = useLive((s) => s.sessions);
  const timeline = useLive((s) => s.timeline);
  const files = useLive((s) => s.files);
  const plan = useLive((s) => s.plan);
  const all = useLive((s) => s.todos);
  const agents = useLive((s) => s.agents);
  const usage = useLive((s) => s.usage);
  const pendingTools = useLive((s) => s.pendingTools);
  const lastEventAt = useLive((s) => s.lastEventAt);
  const lastNote = useLive((s) => s.lastNote);
  const lastNoteKind = useLive((s) => s.lastNoteKind);
  const counts = useLive((s) => s.counts);
  const close = useLive((s) => s.close);
  const switchSession = useLive((s) => s.switchSession);
  const error = useLive((s) => s.error);
  const retry = useLive((s) => s.retry);
  const t = useT();

  const activeProjectId = useProjects((s) => s.activeProjectId);
  const openViewer = useChanges((s) => s.openViewer);
  // Without a git repo there is no diff to open — file clicks are disabled.
  const isRepo = useChanges((s) =>
    activeProjectId ? (s.gitByProject[activeProjectId]?.isRepo ?? false) : false,
  );

  const [sessMenu, setSessMenu] = useState<MenuAnchor | null>(null);
  const [stuck, setStuck] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Full-window dialog: without the trap, Tab wandered through the workspace
  // hidden behind the glass (see `useDialogFocus`).
  const dialogRef = useRef<HTMLDivElement>(null);
  /** The click that closes must have started on the background (see the backdrop). */
  const pressOnBackdrop = useRef(false);
  useDialogFocus(dialogRef, phase !== "closed", "live");

  const open = phase !== "closed";

  // Shared 1 s clock: status decay, elapsed times.
  // The timeline does not depend on it (see `<Timeline>` above).
  const now = useNow(1_000);

  // Esc closes — but if the diff viewer is open on top, Esc belongs to it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (useChanges.getState().viewer) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Auto-follow: stick to the end until the user scrolls up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [timeline, stuck, phase]);

  const working = pendingTools > 0 || (lastEventAt > 0 && now - lastEventAt < 4000);

  const fileList = useMemo(
    () => Object.values(files).sort((a, b) => b.lastAt - a.lastAt),
    [files],
  );

  const planCards: PlanCard[] = useMemo(() => {
    const cards = Object.values(plan);
    if (cards.length > 0) {
      return cards.sort((a, b) => {
        const na = Number(a.key);
        const nb = Number(b.key);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return a.at - b.at;
      });
    }
    return all.map((t, i) => ({
      key: String(i),
      subject: t.content,
      status: (t.status === "in_progress" || t.status === "completed"
        ? t.status
        : "pending") as PlanCard["status"],
      at: i,
    }));
  }, [plan, all]);

  // Grouped once instead of a `filter` per lane plus one for the counter —
  // this whole block re-ran four times per render, every second.
  const byLane = useMemo(() => {
    const m: Record<PlanCard["status"], PlanCard[]> = {
      pending: [],
      in_progress: [],
      completed: [],
    };
    for (const c of planCards) m[c.status].push(c);
    return m;
  }, [planCards]);

  const { runningAgents, doneAgents } = useMemo(() => {
    const running: AgentCard[] = [];
    const done: AgentCard[] = [];
    for (const a of agents) (a.done ? done : running).push(a);
    return { runningAgents: running, doneAgents: done };
  }, [agents]);
  const doneShown = doneAgents.slice(-30).reverse();

  if (!open) return null;

  const sessionItems: MenuEntry[] = sessions.slice(0, 12).map((s) => ({
    id: s.externalId,
    label: `${s.title ?? s.externalId.slice(0, 8)} · ${fmtClock(s.updatedAt)}`,
    icon: <FileClock size={13} />,
    disabled: s.externalId === session?.externalId,
    onSelect: () => void switchSession(s),
  }));

  const openFileDiff = (path: string) => {
    // The row is never `disabled`: greying it out took the whole list away
    // from the keyboard and never said why. Without a repository, the click
    // answers with the reason.
    if (activeProjectId && isRepo) openViewer(activeProjectId, path);
    else useUI.getState().showToast(t(NO_REPO), "info");
  };

  const statusLabel = !working
    ? t("ocioso")
    : lastNoteKind === "think" && pendingTools === 0
      ? t("pensando")
      : t("trabalhando");

  return (
    <div
      className="live-backdrop"
      // Closes only when the *whole* gesture happened on the background: a
      // text selection that starts inside and ends outside is not a request
      // to close, and this is a screen meant to be read at leisure (long
      // timeline, kanban) — losing your place to a glancing click is costly.
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressOnBackdrop.current) close();
        pressOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className="live"
        role="dialog"
        aria-modal="true"
        aria-label={t("Ao vivo: {title}", { title: terminalTitle })}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="live-head">
          <span className={`live-eq ${working ? "is-on" : ""}`} aria-hidden="true">
            <i /><i /><i />
          </span>
          <div className="live-titles">
            <strong>
              {brand && <BrandIcon brand={brand} size={13} />}
              {terminalTitle}
            </strong>
            <span className="live-sub">
              {phase === "finding"
                ? t("procurando a sessão…")
                : phase === "none"
                  ? t("esperando a primeira sessão…")
                  : (session?.title ?? session?.externalId ?? "")}
            </span>
          </div>
          <span className={`live-status ${working ? "live-status--on" : ""}`}>
            {phase === "backfill" ? (
              <>
                <Loader2 size={11} className="spin" aria-hidden="true" />{" "}
                {t("carregando histórico…")}
              </>
            ) : (
              statusLabel
            )}
          </span>

          <div className="live-stats">
            {usage.model && (
              <span className="live-stat" data-tip={t("Modelo da sessão")}>
                {usage.model.replace(/^claude-/, "")}
              </span>
            )}
            {usage.outTokens > 0 && (
              <span
                className="live-stat"
                data-tip-wrap=""
                data-tip={t("Tokens — entrada {input} · saída {output} · cache {cache}", {
                  input: usage.inTokens.toLocaleString(locale()),
                  output: usage.outTokens.toLocaleString(locale()),
                  cache: usage.cacheRead.toLocaleString(locale()),
                })}
              >
                ↑{compact().format(usage.inTokens + usage.cacheWrite)} ↓
                {compact().format(usage.outTokens)}
              </span>
            )}
            {usage.costUsd != null && (
              <span className="live-stat" data-tip={t("Custo estimado (tabela pública)")}>
                US$ {usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}
              </span>
            )}
          </div>

          {sessions.length > 1 && (
            <button
              className="icon-btn"
              aria-label={t("Trocar de sessão")}
              aria-haspopup="menu"
              data-tip={t("Trocar de sessão")}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSessMenu({ x: r.right - 260, y: r.bottom + 4 });
              }}
            >
              <ChevronDown size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            aria-label={t("Fechar o Ao Vivo (Esc)")}
            data-tip-at="left"
            data-tip={t("Fechar (Esc)")}
            onClick={close}
          >
            <X size={13} />
          </button>
        </header>

        {lastNote && phase !== "none" && (
          <div className="live-note" key={lastNote}>
            {lastNoteKind === "think" ? (
              <Sparkles size={11} aria-hidden="true" />
            ) : (
              <MessageSquare size={11} aria-hidden="true" />
            )}
            <span className={lastNoteKind === "think" ? "live-note--think" : ""}>
              {lastNote}
            </span>
          </div>
        )}

        {phase === "finding" && (
          <div className="live-empty" role="status" aria-live="polite">
            <Loader2 size={20} className="spin" aria-hidden="true" />
            <span>{t("procurando a sessão do agente…")}</span>
          </div>
        )}

        {/* Without this the failure looked exactly like the search above, and
            the search never ended. */}
        {phase === "error" && (
          <div className="live-empty live-empty--error" role="alert">
            <AlertCircle size={22} aria-hidden="true" />
            <span>{t("Não consegui ler as sessões deste agente.")}</span>
            <small>
              {error ??
                t("O Yard lê os rastros que a CLI grava em disco; algo impediu essa leitura.")}
            </small>
            <button className="btn btn--sm" onClick={() => void retry()}>
              <RotateCw size={11} aria-hidden="true" /> {t("Tentar de novo")}
            </button>
          </div>
        )}

        {phase === "none" && (
          <div className="live-empty">
            <Bot size={22} aria-hidden="true" />
            <span>{t("Esperando o primeiro turno do agente…")}</span>
            <small>
              {t("O rastro nasce quando a conversa começa. Assim que a CLI escrever qualquer coisa, ele aparece aqui sozinho.")}
            </small>
            <Loader2 size={14} className="spin" aria-hidden="true" />
          </div>
        )}

        {(phase === "backfill" || phase === "live") && (
          <div className="live-body">
            {/* ---- timeline ---- */}
            <section className="live-col live-col--feed" aria-label={t("Linha do tempo")}>
              <header className="live-col-head">
                <span>{t("Linha do tempo")}</span>
                <span className="live-col-meta">
                  {counts.edits > 0 && t("{n} ed", { n: counts.edits })}
                  {counts.runs > 0 && ` · ${t("{n} cmd", { n: counts.runs })}`}
                  {counts.reads > 0 && ` · ${t("{n} leit", { n: counts.reads })}`}
                </span>
              </header>
              <div
                className="live-feed"
                ref={scrollerRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
                }}
              >
                <Timeline entries={timeline} />
              </div>
              {!stuck && (
                <button
                  className="live-follow"
                  onClick={() => {
                    setStuck(true);
                    const el = scrollerRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                  }}
                >
                  {t("seguir ao vivo ↓")}
                </button>
              )}
            </section>

            {/* ---- touched files ---- */}
            <section className="live-col live-col--files" aria-label={t("Arquivos tocados")}>
              <header className="live-col-head">
                <span>{t("Arquivos tocados")}</span>
                <span className="live-col-meta">{fileList.length}</span>
              </header>
              <div className="live-files">
                {fileList.length === 0 && (
                  <div className="live-feed-empty">{t("nenhum arquivo tocado ainda")}</div>
                )}
                {fileList.map((f) => {
                  const p = splitPath(f.path);
                  const fresh = now - f.lastAt < 2500;
                  return (
                    <button
                      key={f.path}
                      className="live-file"
                      data-fresh={fresh || undefined}
                      onClick={() => openFileDiff(f.path)}
                      data-tip-wrap=""
                      data-tip={fileRow(f.path, isRepo).tip}
                    >
                      <span
                        className={`live-mark-badge ${
                          f.lastOp === "write"
                            ? "live-mark-badge--a"
                            : f.lastOp === "edit"
                              ? "live-mark-badge--m"
                              : "live-mark-badge--r"
                        }`}
                      >
                        {f.lastOp === "write" ? "A" : f.lastOp === "edit" ? "M" : "L"}
                      </span>
                      <span className="live-path">
                        <span className="live-path-dir">{p.dir}</span>
                        <span className="live-path-base">{p.base}</span>
                      </span>
                      <span className="live-file-stats">
                        {f.added > 0 && <em className="live-add">+{f.added}</em>}
                        {f.removed > 0 && <em className="live-del">−{f.removed}</em>}
                        {f.edits + f.writes > 1 && (
                          <span className="live-file-count">
                            {f.edits + f.writes}×
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ---- board: plan + sub-agents ---- */}
            <section className="live-col live-col--board" aria-label={t("Plano e sub-agents")}>
              <header className="live-col-head">
                <span>{t("Plano do agente")}</span>
                <span className="live-col-meta">
                  {byLane.completed.length}/{planCards.length}
                </span>
              </header>
              {planCards.length === 0 ? (
                <div className="live-feed-empty">{t("o agente ainda não montou um plano")}</div>
              ) : (
                <div className="live-kanban">
                  {LANES.map((lane) => (
                    <div className="live-lane" key={lane.id}>
                      <span className="live-lane-head">
                        {t(lane.label)}
                        <em>{byLane[lane.id].length}</em>
                      </span>
                      {byLane[lane.id].map((c) => (
                          <div
                            className={`live-card live-card--${c.status}`}
                            key={c.key}
                          >
                            {c.status === "in_progress" && (
                              <span className="live-card-pulse" aria-hidden="true" />
                            )}
                            {c.status === "completed" && (
                              <Check size={11} aria-hidden="true" />
                            )}
                            <span>{c.subject}</span>
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              )}

              <header className="live-col-head live-col-head--gap">
                <span>Sub-agents</span>
                <span className="live-col-meta">
                  {runningAgents.length > 0 && t("{n} rodando", { n: runningAgents.length })}
                </span>
              </header>
              {agents.length === 0 ? (
                <div className="live-feed-empty">{t("nenhum sub-agent nesta sessão")}</div>
              ) : (
                <div className="live-kanban live-kanban--two">
                  <div className="live-lane">
                    <span className="live-lane-head">
                      {t("Rodando")} <em>{runningAgents.length}</em>
                    </span>
                    {runningAgents.map((a: AgentCard) => (
                      <div className="live-card live-card--agent" key={a.toolId}>
                        <span className="live-agent-top">
                          <Bot size={11} aria-hidden="true" />
                          {a.agentType && <span className="live-chip">{a.agentType}</span>}
                          {a.bg && <span className="live-chip live-chip--dim">{t("fundo")}</span>}
                          <Loader2 size={11} className="spin" aria-hidden="true" />
                        </span>
                        {a.detail && <span>{a.detail}</span>}
                        <time>{fmtElapsed(now - a.startedAt)}</time>
                      </div>
                    ))}
                  </div>
                  <div className="live-lane">
                    <span className="live-lane-head">
                      {t("Concluídos")} <em>{doneAgents.length}</em>
                    </span>
                    {doneShown.map((a) => (
                      <div
                        className={`live-card live-card--agent live-card--completed ${a.ok === false ? "live-card--failed" : ""}`}
                        key={a.toolId}
                      >
                        <span className="live-agent-top">
                          {a.ok === false ? (
                            <AlertCircle size={11} aria-hidden="true" />
                          ) : (
                            <Check size={11} aria-hidden="true" />
                          )}
                          {a.agentType && <span className="live-chip">{a.agentType}</span>}
                        </span>
                        {a.detail && <span>{a.detail}</span>}
                        {a.endedAt && (
                          <time>{fmtElapsed(a.endedAt - a.startedAt)}</time>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {sessMenu && (
          <ContextMenu
            anchor={sessMenu}
            items={sessionItems}
            onClose={() => setSessMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
