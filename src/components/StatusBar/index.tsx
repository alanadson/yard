/**
 * Status bar — the window's footer.
 *
 * The title bar is about *where* you are (project › group, the surface, the
 * panels); nothing in the chrome said *how things are going*. The product's
 * central signal — an agent stopped to ask you something — lived only as a
 * yellow dot in the tree, three scrolls down and gone with `Ctrl+B`; the
 * project's branch existed only inside the Controle tab; a pipeline walking in
 * another group was invisible; and the composer and the shortcut map were
 * keyboard-only. This bar is the one place the whole workspace is read at a
 * glance, and the mouse's way into the surfaces that had no button. (The
 * Busca left this row: an anonymous magnifier here, it is a named door at the
 * top of the sidebar now, see `ProjectSidebar/actions.ts`.)
 *
 * Every reading is a pure reduction in `statusBar.ts` / `lib/ramPressure.ts`;
 * this file only paints and routes clicks. Readouts are chips, actions are
 * buttons, and each one is a subscription of its own so a resources tick
 * repaints the meter and not the branch.
 *
 * Right-click opens the same map the title bar offers — with the bar's own
 * entry on it, which is how it comes back once hidden from Settings.
 */
import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bot,
  GitBranch,
  GitPullRequest,
  Keyboard,
  MemoryStick,
  SquarePen,
  Wallet,
  Workflow,
} from "lucide-react";

import { ContextMenu, type MenuAnchor } from "../ContextMenu";
import { useT } from "../../hooks/useT";
import { jumpToAttention } from "../../lib/attention";
import { goToCanvasItem } from "../../lib/navigate";
import { ramPressure } from "../../lib/ramPressure";
import { titleBarMenu } from "../../lib/titleBarMenu";
import { useBench } from "../../stores/benchStore";
import { useChanges } from "../../stores/changesStore";
import { useEditor } from "../../stores/editorStore";
import { useForge } from "../../stores/forgeStore";
import { prBadge } from "../../lib/forge";
import { budgetMessage, budgetState } from "../../lib/budget";
import { localDay, totals } from "../../lib/costs";
import { useCosts } from "../../stores/costsStore";
import { useFlows } from "../../stores/flowStore";
import { useNotes } from "../../stores/notesStore";
import { useProjects } from "../../stores/projectsStore";
import { useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import { StatusChip } from "./StatusChip";
import { agentSegments, agentsCaption, flowChip, gitChip } from "./statusBar";

const appWindow = getCurrentWindow();

export function StatusBar() {
  const [menu, setMenu] = useState<(MenuAnchor & { maximized: boolean }) | null>(null);
  const setComposerOpen = useUI((s) => s.setComposerOpen);
  const openModal = useUI((s) => s.openModal);

  return (
    <footer
      className="statusbar"
      aria-label="Barra de status"
      onContextMenu={(e) => {
        e.preventDefault();
        const at = { x: e.clientX, y: e.clientY };
        // "Maximizar" on a maximized window lies about the click: ask first.
        void appWindow
          .isMaximized()
          .then((maximized) => setMenu({ ...at, maximized }))
          .catch(() => setMenu({ ...at, maximized: false }));
      }}
    >
      {menu && <StatusBarMenu anchor={menu} maximized={menu.maximized} onClose={() => setMenu(null)} />}

      <div className="statusbar-left">
        <AgentsChip />
        <GitChipView />
        <FlowChipView />
        <BudgetChip />
      </div>

      <div className="statusbar-right">
        {/* Usage and Energético, one chip and one popover. They were the two
            "read all day, clicked once a week" readings of the title bar, at
            the size of a control; here they stand with the other gauges. */}
        <StatusChip />
        <RamChip />
        <button
          className="sb-btn"
          data-tip="Compositor de prompts (Ctrl+Enter)"
          data-tip-side="top"
          aria-label="Compositor de prompts"
          onClick={() => setComposerOpen(true)}
        >
          <SquarePen size={13} aria-hidden="true" />
        </button>
        <button
          className="sb-btn"
          data-tip="Atalhos de teclado (Ctrl+Shift+H)"
          data-tip-side="top"
          data-tip-at="right"
          aria-label="Atalhos de teclado"
          onClick={() => openModal("shortcuts")}
        >
          <Keyboard size={13} aria-hidden="true" />
        </button>
      </div>
    </footer>
  );
}

/**
 * Who is doing what, across every group — not only the one on screen. The
 * blocked agent is usually on the floor you are *not* looking at; that is
 * the whole point of a global indicator. Click: the same tour as
 * `Ctrl+Shift+A`.
 */
function AgentsChip() {
  const t = useT();
  const rows = useProjects((s) => s.terminals);
  const byId = useTerminals((s) => s.byId);
  const segments = agentSegments(rows, byId);
  const waiting = segments.find((s) => s.tone === "waiting");
  const quiet = segments.length === 0;
  // Quiet, the caption is the chip's name, a word the dictionary carries;
  // counting, it is assembled from the segments, like the chip itself.
  const label = quiet ? t(agentsCaption(segments)) : agentsCaption(segments);

  return (
    <button
      className={`sb-chip sb-chip--agents ${waiting ? "is-waiting" : ""}`}
      data-tip="Ir para o próximo agente esperando você (Ctrl+Shift+A)"
      data-tip-side="top"
      data-tip-at="left"
      aria-label={label}
      onClick={jumpToAttention}
    >
      <Bot size={12} aria-hidden="true" />
      {quiet ? (
        <span className="sb-muted">{label}</span>
      ) : (
        segments.map((s) => (
          <span className="sb-seg" key={s.tone}>
            <span className={`sb-dot sb-dot--${s.tone}`} aria-hidden="true" />
            {s.label}
          </span>
        ))
      )}
    </button>
  );
}

/**
 * The active project's branch and how dirty its tree is. On a floor the
 * summary already follows the worktree (`App` watches `activeRoot`), so the
 * chip reads the floor's branch without knowing about floors. Click: the
 * Controle tab of the bench.
 */
function GitChipView() {
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const summary = useChanges((s) =>
    activeProjectId ? s.gitByProject[activeProjectId] : undefined,
  );
  const git = gitChip(summary);
  if (!git) return null;

  const tip = git.detached
    ? "HEAD solto: não há branch para publicar nem para sincronizar — Controle de versão (Ctrl+Shift+R)"
    : "Controle de versão — preparar, commitar, branches (Ctrl+Shift+R)";

  return (
    <button
      className="sb-chip"
      data-tip={tip}
      data-tip-side="top"
      data-tip-wrap=""
      aria-label={`Branch ${git.branch}, ${git.label}`}
      onClick={() => useBench.getState().openTab("scm")}
    >
      <GitBranch size={12} aria-hidden="true" />
      <span className="sb-branch">{git.branch}</span>
      <span className="sb-muted">{git.label}</span>
      {git.changed > 0 && (
        <span className="sb-diff" aria-hidden="true">
          {/* The changes panel's mark for a floor: new files past the count cap. */}
          <span className="sb-add">
            +{git.additions}
            {git.partial ? "…" : ""}
          </span>
          <span className="sb-del">−{git.deletions}</span>
        </span>
      )}
      <PrMark />
    </button>
  );
}

/**
 * The day's spend against the ceiling, when there is one
 * (`lib/budget.ts`). Only from "warn" up: a footer chip saying "12% do
 * orçamento" every day of the week is a number nobody reads, and the panel
 * (Ctrl+Alt+U) is where the whole picture lives.
 */
function BudgetChip() {
  const limit = useUI((s) => s.prefs.budgetDaily);
  const rows = useCosts((s) => s.rows);
  const t = useT();
  const today = localDay(new Date());
  const state = budgetState(
    totals(rows.filter((row) => row.day === today)).costUsd ?? 0,
    limit,
  );
  if (state.level !== "warn" && state.level !== "over") return null;
  return (
    <button
      className={`sb-chip sb-budget is-${state.level}`}
      data-tip={budgetMessage(state)}
      data-tip-side="top"
      data-tip-wrap=""
      aria-label={budgetMessage(state)}
      onClick={() => void useCosts.getState().open()}
    >
      <Wallet size={12} aria-hidden="true" />
      <span>{t("{pct}% do orçamento", { pct: state.pct })}</span>
    </button>
  );
}

/**
 * The pull request of whatever branch the footer is showing, when there is
 * one. It reads the forge store and nothing else: the request itself is made
 * by the Controle tab, which is the surface that can do something about the
 * answer. If nobody has opened that tab, this shows nothing, the footer is
 * not a place to start a network call from.
 */
function PrMark() {
  const root = useEditor((s) => s.root);
  const entry = useForge((s) => (root ? s.byRoot[root] : undefined));
  if (!entry?.pr) return null;
  const badge = prBadge(entry.pr);
  return (
    <span className={`sb-pr is-${badge.tone}`}>
      <GitPullRequest size={11} aria-hidden="true" />
      #{entry.pr.number} {badge.label}
    </span>
  );
}

/** A pipeline walking somewhere in the workspace. Click: its card on the canvas. */
function FlowChipView() {
  const runs = useFlows((s) => s.runs);
  const flow = flowChip(Object.values(runs));
  if (!flow) return null;
  return (
    <button
      className="sb-chip sb-chip--flow"
      data-tip="Fluxo em andamento — ir até o cartão no canvas"
      data-tip-side="top"
      aria-label={`Fluxo: ${flow.label}`}
      onClick={() => goToCanvasItem(flow.groupId, flow.flowId)}
    >
      <Workflow size={12} aria-hidden="true" />
      {flow.label}
    </button>
  );
}

/**
 * Memory pressure, compact. Same numbers and thresholds as the sidebar HUD
 * (`lib/ramPressure.ts`) — this one survives `Ctrl+B`.
 */
function RamChip() {
  const totalRssMb = useTerminals((s) => s.totalRssMb);
  const availableMb = useTerminals((s) => s.systemAvailableMb);
  const totalMb = useTerminals((s) => s.systemTotalMb);
  const ram = ramPressure(availableMb, totalMb);
  if (!ram) return null;

  const free = `${(availableMb / 1024).toFixed(1)} / ${(totalMb / 1024).toFixed(0)} GB livres`;
  const clis = totalRssMb > 0 ? ` · as CLIs somam ${totalRssMb.toFixed(0)} MB` : "";
  const advice =
    ram.level === "ok" ? "" : " — suspenda grupos ociosos para liberar RAM";
  const level = ram.level === "ok" ? "" : `is-${ram.level}`;

  return (
    <span
      className={`sb-chip sb-chip--ram ${level}`}
      data-tip={`${ram.pct}% da memória em uso: ${free}${clis}${advice}`}
      data-tip-side="top"
      data-tip-wrap=""
      role="img"
      aria-label={`Memória: ${ram.pct}% em uso, ${free}`}
    >
      <MemoryStick size={12} aria-hidden="true" />
      <span className="sb-meter" aria-hidden="true">
        <span className="sb-meter-fill" style={{ transform: `scaleX(${ram.usage})` }} />
      </span>
      <span className="sb-pct">{ram.pct}%</span>
    </span>
  );
}

function StatusBarMenu({
  anchor,
  maximized,
  onClose,
}: {
  anchor: MenuAnchor;
  maximized: boolean;
  onClose: () => void;
}) {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const statusBarOpen = useUI((s) => s.prefs.statusBar);
  const setPref = useUI((s) => s.setPref);
  const openModal = useUI((s) => s.openModal);
  const changesOpen = useChanges((s) => s.open);
  const toggleChanges = useChanges((s) => s.toggle);
  const benchOpen = useBench((s) => s.open);
  const toggleBench = useBench((s) => s.toggle);
  const notesOpen = useNotes((s) => s.open);
  const toggleNotes = useNotes((s) => s.toggleView);

  return (
    <ContextMenu
      anchor={anchor}
      onClose={onClose}
      items={titleBarMenu(
        {
          sidebar: sidebarOpen,
          changes: changesOpen,
          bench: benchOpen,
          notes: notesOpen,
          statusBar: statusBarOpen,
          maximized,
        },
        {
          toggleSidebar,
          toggleChanges,
          toggleBench,
          toggleNotes,
          toggleStatusBar: () => setPref("statusBar", !statusBarOpen),
          openModal,
          toggleMaximize: () => void appWindow.toggleMaximize(),
          minimize: () => void appWindow.minimize(),
        },
      )}
    />
  );
}
