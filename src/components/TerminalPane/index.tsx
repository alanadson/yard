/**
 * Frame of a pane: tabs, title, state and actions.
 *
 * In normal use there is a single pane filling the screen and each CLI is a
 * tab on the top bar — creating a terminal never splits the screen (§F2).
 *
 * All terminals in the slot stay mounted; only the active one is visible.
 * That keeps `XTermView` (and therefore the attach) stable when switching
 * tabs, and the backend drops emission of the hidden ones to 450 ms.
 *
 * The action bar shows only three fixed buttons (find, start/suspend and the
 * kebab): with 4 or 6 panes open, a row of six icons per pane becomes
 * noise and eats the tabs.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Eraser,
  Play,
  PauseCircle,
  Pencil,
  Search,
  Terminal as TerminalIcon,
  MoreVertical,
  Plus,
  X,
  Bot,
} from "lucide-react";

import { ExitBanner } from "../ExitBanner";
import { XTermView, type XTermHandle } from "../XTermView";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import { terminalActionEntries } from "../../lib/terminalMenu";
import { ipc, type TerminalRow } from "../../lib/ipc";
import { confirmCloseTerminal } from "../../lib/lifecycle";
import { baseName } from "../../lib/terminals";
import { useAction } from "../../hooks/useAction";
import { useLive } from "../../stores/liveStore";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";

interface Props {
  groupId: string;
  slot: number;
  terminals: TerminalRow[];
  activeId: string | null;
  onDropTerminal?: (terminalId: string) => void;
}

export function TerminalPane({
  groupId,
  slot,
  terminals,
  activeId,
  onDropTerminal,
}: Props) {
  const setActiveTab = useProjects((s) => s.setActiveTab);
  const updateTerminal = useProjects((s) => s.updateTerminal);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const openModal = useUI((s) => s.openModal);
  const runtimes = useTerminals((s) => s.byId);
  const act = useAction();

  const handles = useRef<Record<string, XTermHandle | null>>({});
  const tabsRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [tabMenu, setTabMenu] = useState<{
    id: string;
    anchor: MenuAnchor;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const active = useMemo(
    () => terminals.find((t) => t.id === activeId) ?? terminals[0] ?? null,
    [terminals, activeId],
  );
  const focused = active?.id === focusedTerminalId;

  // Marks as read when it gains focus. When focus arrives from the keyboard
  // (Ctrl+1..9, Ctrl+Tab) the cursor also needs to enter the tab's xterm —
  // without that typing would keep going to the previous tab.
  useEffect(() => {
    if (active && focusedTerminalId === active.id) {
      useTerminals.getState().markRead(active.id);
      handles.current[active.id]?.focus();
    }
  }, [active, focusedTerminalId]);

  // Ctrl+Shift+F arrives as a window event: only the pane that has focus
  // opens find (with 4 panes, opening all four would be absurd).
  useEffect(() => {
    if (!focused) return;
    const abrir = () => setSearchOpen(true);
    window.addEventListener("yard:find", abrir);
    return () => window.removeEventListener("yard:find", abrir);
  }, [focused]);

  // The tab bar scrolls with no visible scrollbar; without this measurement
  // nothing would warn that there are tabs off-screen.
  useLayoutEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const medir = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [terminals.length]);

  const novaCli = () => openModal("new-terminal", { groupId, slot });

  if (terminals.length === 0) {
    return (
      <div
        className={`pane pane--empty ${dragOver ? "pane--dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const id = e.dataTransfer.getData("text/yard-terminal");
          if (id) onDropTerminal?.(id);
        }}
      >
        <div className="pane-empty-inner">
          <TerminalIcon size={22} aria-hidden="true" />
          <span>Painel {slot + 1} vazio</span>
          <small>Arraste a aba de outro painel para cá, ou abra uma CLI nova.</small>
          <button className="btn btn--sm" onClick={novaCli}>
            <Plus size={12} /> Nova CLI aqui
          </button>
        </div>
      </div>
    );
  }

  const rt = active ? (runtimes[active.id] ?? null) : null;
  const isRunning = isLive(rt);

  const tabMenuItems = (id: string): MenuEntry[] => {
    if (!terminals.some((x) => x.id === id)) return [];
    return [
      {
        id: "rename",
        label: "Renomear",
        icon: <Pencil size={13} />,
        onSelect: () => setRenamingId(id),
      },
      {
        id: "clear",
        label: "Limpar terminal",
        icon: <Eraser size={13} />,
        onSelect: () => handles.current[id]?.clear(),
      },
      { kind: "sep" },
      ...terminalActionEntries({ id, running: isLive(runtimes[id]), run: act }),
    ];
  };

  return (
    <div
      className={`pane ${focused ? "pane--focused" : ""} ${dragOver ? "pane--dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const id = e.dataTransfer.getData("text/yard-terminal");
        if (id) onDropTerminal?.(id);
      }}
    >
      <div className="pane-header">
        <div
          className="pane-tabs"
          ref={tabsRef}
          role="tablist"
          aria-label={`Abas do painel ${slot + 1}`}
          data-overflow={overflow}
        >
          {terminals.map((t) => {
            const r = runtimes[t.id];
            const label = baseName(t);
            const selecionar = () => {
              setActiveTab(groupId, slot, t.id);
              focusTerminal(t.id, slot);
              handles.current[t.id]?.focus();
            };
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === active?.id}
                tabIndex={t.id === active?.id ? 0 : -1}
                draggable={renamingId !== t.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/yard-terminal", t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                className={`pane-tab ${t.id === active?.id ? "is-active" : ""}`}
                onClick={selecionar}
                // Middle button closes the tab — same as every browser and
                // every tabbed terminal.
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  void confirmCloseTerminal(t.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selecionar();
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setActiveTab(groupId, slot, t.id);
                  focusTerminal(t.id, slot);
                  setTabMenu({ id: t.id, anchor: { x: e.clientX, y: e.clientY } });
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRenamingId(t.id);
                }}
                data-tip-wrap="" data-tip={`${t.program} ${t.args.join(" ")}\n${t.cwd}`}
              >
                <span className={`dot dot--${r?.state ?? "idle"}`} />
                {t.kind === "agent" ? <Bot size={12} /> : <TerminalIcon size={12} />}
                {renamingId === t.id ? (
                  <InlineRename
                    value={label}
                    onCommit={(next) => {
                      updateTerminal(t.id, { title: next });
                      setRenamingId(null);
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  <span className="pane-tab-label">{label}</span>
                )}
                {r?.finished && (
                  <span className="badge-finished" data-tip="Terminou de trabalhar" />
                )}
                {r?.unread && !r.finished && (
                  <span className="badge-unread" data-tip="Saída nova" />
                )}
                <span
                  className="pane-tab-close"
                  role="button"
                  tabIndex={-1}
                  aria-label={`Fechar ${label}`}
                  data-tip="Fechar"
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirmCloseTerminal(t.id);
                  }}
                >
                  <X size={11} />
                </span>
              </div>
            );
          })}
        </div>

        <button
          className="pane-tab-add"
          data-tip="Nova CLI nesta barra (Ctrl+T)"
          aria-label="Nova CLI nesta barra"
          onClick={novaCli}
        >
          <Plus size={12} />
        </button>

        <div className="pane-actions">
          {rt && rt.rssMb > 0 && (
            <span className="pane-stat" data-tip="RAM da árvore de processos">
              {rt.rssMb.toFixed(0)} MB
            </span>
          )}
          {active?.kind === "agent" && (
            <button
              className="icon-btn live-launch"
              data-tip-wrap=""
              data-tip="Ao Vivo — arquivos, plano e sub-agents em tempo real"
              aria-label="Abrir o Ao Vivo deste agente"
              data-working={isRunning || undefined}
              onClick={() => active && void useLive.getState().openFor(active)}
            >
              <Activity size={13} />
            </button>
          )}
          <button
            className={`icon-btn ${searchOpen ? "is-active" : ""}`}
            data-tip="Buscar no histórico (Ctrl+Shift+F)"
            aria-label="Buscar no histórico"
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search size={13} />
          </button>
          {isRunning ? (
            <button
              className="icon-btn"
              data-tip-wrap="" data-tip="Suspender — encerra o processo e guarda o histórico"
              aria-label="Suspender"
              onClick={() =>
                active && act(() => ipc.suspendPty(active.id), "falha ao suspender")
              }
            >
              <PauseCircle size={13} />
            </button>
          ) : (
            <button
              className="icon-btn icon-btn--go"
              data-tip="Iniciar ou retomar"
              aria-label="Iniciar ou retomar"
              onClick={() => active && handles.current[active.id]?.start()}
            >
              <Play size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip-at="right" data-tip="Mais ações"
            aria-label="Mais ações deste terminal"
            aria-haspopup="menu"
            onClick={(e) => {
              if (!active) return;
              const r = e.currentTarget.getBoundingClientRect();
              setTabMenu({
                id: active.id,
                anchor: { x: r.right - 200, y: r.bottom + 4 },
              });
            }}
          >
            <MoreVertical size={13} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="pane-search">
          <input
            autoFocus
            value={query}
            aria-label="Buscar no histórico do terminal"
            placeholder="Buscar no histórico…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && active) {
                if (e.shiftKey) handles.current[active.id]?.findPrevious(query);
                else handles.current[active.id]?.findNext(query);
              }
              if (e.key === "Escape") {
                setSearchOpen(false);
                if (active) handles.current[active.id]?.focus();
              }
            }}
          />
          <span className="pane-search-hint">Enter ↓ · Shift+Enter ↑</span>
          <button
            className="icon-btn"
            aria-label="Fechar busca"
            data-tip="Fechar busca (Esc)"
            onClick={() => setSearchOpen(false)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="pane-body">
        {terminals.map((t) => {
          const visible = t.id === active?.id;
          const r = runtimes[t.id];
          return (
            <div
              key={t.id}
              className="pane-term"
              // `visibility` (and not `display: none`): the host keeps its
              // real size even when hidden, so the back-tab xterm can
              // measure font/cell and fit works. With display none the
              // renderer opens in a 0x0 host and explodes from the inside
              // ("reading 'dimensions'") on the first write.
              style={{ visibility: visible ? "visible" : "hidden" }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setActiveTab(groupId, slot, t.id);
                focusTerminal(t.id, slot);
                setTabMenu({ id: t.id, anchor: { x: e.clientX, y: e.clientY } });
              }}
            >
              <ExitBanner rt={r} onStart={() => void handles.current[t.id]?.start()} />
              <XTermView
                ref={(h) => {
                  handles.current[t.id] = h;
                }}
                id={t.id}
                program={t.program}
                args={t.args}
                cwd={t.cwd}
                kind={t.kind}
                title={t.title || t.program}
                autoStart={t.alive}
                visible={visible}
                onFocus={() => focusTerminal(t.id, slot)}
              />
            </div>
          );
        })}
      </div>

      {tabMenu && (
        <ContextMenu
          anchor={tabMenu.anchor}
          items={tabMenuItems(tabMenu.id)}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  );
}
