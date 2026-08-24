/**
 * Tree of projects -> groups -> terminals, plus the resource HUD in the footer.
 *
 * Right-click (or the kebab on hover) opens each row's menu: rename,
 * delete, suspend, new CLI, etc. Rename is in-place — no modal.
 *
 * The tree is also the state map: process-state dot, white unread-output
 * dot, green agent-finished dot, and a highlight on the CLI that is
 * receiving keystrokes.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Frame,
  History,
  Layers,
  MoreVertical,
  Palette,
  PauseCircle,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  Music,
  Trash2,
} from "lucide-react";

import { TerminalMark } from "../BrandIcon";
import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { InlineRename } from "../ContextMenu/InlineRename";
import { Resizer } from "../Resizer";
import { ipc, type TerminalRow } from "../../lib/ipc";
import { closeGroup, closeProject } from "../../lib/lifecycle";
import { goToTerminal } from "../../lib/navigate";
import { projectIcon } from "../../lib/projectStyle";
import { cardOrigin, sectionsFor, treeRows, type TreeKind } from "./rows";
import { terminalActionEntries } from "../../lib/terminalMenu";
import { baseName } from "../../lib/terminals";
import { useAction } from "../../hooks/useAction";
import { unsavedWarning } from "../../stores/editorStore";
import { useProjects } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import {
  useUI,
  DEFAULT_PREFS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "../../stores/uiStore";

interface MenuState {
  kind: TreeKind;
  id: string;
  anchor: MenuAnchor;
}

interface RenameState {
  kind: TreeKind;
  id: string;
}

export function ProjectSidebar() {
  // One subscription per field. Destructuring the whole store used to
  // re-render this entire tree on *any* write — including `updateCanvas`,
  // which fires on every keystroke inside a canvas note. Zustand's actions
  // are stable references, so subscribing to them costs nothing.
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const addBoard = useProjects((s) => s.addBoard);
  /**
   * Which sections the bar paints. On the canvas the only thing that can be on
   * screen is a board, so the projects tree gives way to the boards.
   *
   * The subscription is a **boolean**, and the object is built in a memo. A
   * selector returning `sectionsFor(...)` directly hands Zustand a fresh
   * object on every call, and since it compares by identity that is
   * "Maximum update depth exceeded" — the render feeding itself. Same rule as
   * every list slice in `WorkspaceGrid`.
   */
  const onCanvas = useProjects(
    (s) => !!s.activeGroupId && s.layoutOf(s.activeGroupId).surface === "canvas",
  );
  const sections = useMemo(
    () => sectionsFor(onCanvas ? "canvas" : "grid"),
    [onCanvas],
  );
  const terminals = useProjects((s) => s.terminals);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const setActiveGroup = useProjects((s) => s.setActiveGroup);
  const addGroup = useProjects((s) => s.addGroup);
  const renameProject = useProjects((s) => s.renameProject);
  const renameGroup = useProjects((s) => s.renameGroup);
  const updateTerminal = useProjects((s) => s.updateTerminal);
  const moveGroup = useProjects((s) => s.moveGroup);
  const moveTerminalBy = useProjects((s) => s.moveTerminalBy);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const width = useUI((s) => s.prefs.sidebarWidth);
  const setPref = useUI((s) => s.setPref);
  const setPrefLocal = useUI((s) => s.setPrefLocal);
  // CPU/RAM changes belong to `ResourceFooter`; the tree itself only paints
  // lifecycle badges. A compact primitive keeps a 2 s resource tick from
  // reconciling hundreds of project/group/terminal nodes.
  const runtimeSignals = useTerminals((s) =>
    terminals
      .map((t) => {
        const r = s.byId[t.id];
        return `${t.id}:${r?.state ?? "idle"}:${r?.unread ? 1 : 0}:${r?.finished ? 1 : 0}:${r?.blocked ? 1 : 0}`;
      })
      .join("|"),
  );
  const runtimes = useMemo(
    () => useTerminals.getState().byId,
    [runtimeSignals, terminals],
  );
  /**
   * The boards: groups that belong to no project. Derived here instead of
   * through the store selector so the memo is keyed on the same `groups`
   * reference the rest of this tree already subscribes to.
   */
  const boards = useMemo(
    () => groups.filter((g) => g.projectId === null).sort((a, b) => a.sort - b.sort),
    [groups],
  );
  const groupsByProject = useMemo(() => {
    const index = new Map<string, typeof groups>();
    for (const group of groups) {
      // A board belongs to no project: it is not in this index at all, it is
      // its own section at the top of the bar.
      if (group.projectId === null) continue;
      const list = index.get(group.projectId) ?? [];
      list.push(group);
      index.set(group.projectId, list);
    }
    for (const list of index.values()) list.sort((a, b) => a.sort - b.sort);
    return index;
  }, [groups]);
  const terminalsByGroup = useMemo(() => {
    const index = new Map<string, typeof terminals>();
    for (const terminal of terminals) {
      const list = index.get(terminal.groupId) ?? [];
      list.push(terminal);
      index.set(terminal.groupId, list);
    }
    for (const list of index.values()) list.sort((a, b) => a.sort - b.sort);
    return index;
  }, [terminals]);
  const act = useAction();

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);

  // Collapsing a project is a decision about the bench, not about the
  // session: stored in `kv` (uiStore), it comes back the same on the next boot.
  const collapsed = useUI((s) => s.treeCollapsed);
  const toggle = useUI((s) => s.toggleTreeNode);

  // --- keyboard ------------------------------------------------------------
  //
  // The rows were `<div onClick>` with no role, no tab stop and no key
  // handler: the app's primary navigation — switch project, group, terminal —
  // simply did not exist without a mouse. This is the same shape `FileTree`
  // already uses: one tab stop for the whole tree (roving tabindex), arrows
  // inside it.

  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const registerRow = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  /**
   * The visible rows, in the order they are painted — boards first, projects
   * after. The arrows walk this one list across both sections, so the focus
   * leaves the last board and lands on the first project instead of stopping
   * at the seam.
   */
  const flatRows = useMemo(
    () =>
      treeRows({
        sections,
        boards,
        projects,
        groupsOf: (id) => groupsByProject.get(id) ?? [],
        cardsOf: (id) => terminalsByGroup.get(id) ?? [],
        collapsed,
      }),
    [sections, boards, projects, groupsByProject, terminalsByGroup, collapsed],
  );

  /** Only one row is reachable by Tab; the arrows move between them. */
  const tabIndexOf = (id: string) =>
    (focusId && flatRows.some((r) => r.id === focusId) ? focusId === id : flatRows[0]?.id === id)
      ? 0
      : -1;

  const moveFocus = (from: string, delta: number) => {
    const i = flatRows.findIndex((r) => r.id === from);
    const target = flatRows[i + delta];
    if (!target) return;
    setFocusId(target.id);
    rowRefs.current.get(target.id)?.focus();
  };

  const openMenuByKeyboard = (kind: TreeKind, id: string) => {
    const el = rowRefs.current.get(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenu({ kind, id, anchor: { x: r.left + 16, y: r.bottom - 4 } });
  };

  /**
   * `expandivel` is null for terminals (leaves), true/false otherwise — it is
   * what makes Right/Left mean "open/close" instead of nothing.
   */
  const onRowKeyDown = (
    e: KeyboardEvent<HTMLDivElement>,
    kind: TreeKind,
    id: string,
    activate: () => void,
    expandable: boolean | null,
  ) => {
    // A key pressed inside the kebab or the rename field belongs to it.
    if (e.target !== e.currentTarget) return;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        activate();
        return;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(id, 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(id, -1);
        return;
      case "ArrowRight":
        if (expandable === false) {
          e.preventDefault();
          toggle(id);
        } else if (expandable === true) {
          e.preventDefault();
          moveFocus(id, 1);
        }
        return;
      case "ArrowLeft":
        if (expandable === true) {
          e.preventDefault();
          toggle(id);
        } else {
          e.preventDefault();
          moveFocus(id, -1);
        }
        return;
      case "Home":
        e.preventDefault();
        if (flatRows[0]) {
          setFocusId(flatRows[0].id);
          rowRefs.current.get(flatRows[0].id)?.focus();
        }
        return;
      case "End": {
        e.preventDefault();
        const last = flatRows[flatRows.length - 1];
        if (last) {
          setFocusId(last.id);
          rowRefs.current.get(last.id)?.focus();
        }
        return;
      }
      case "F2":
        e.preventDefault();
        beginRename(kind, id);
        return;
      case "ContextMenu":
        e.preventDefault();
        openMenuByKeyboard(kind, id);
        return;
      case "F10":
        if (e.shiftKey) {
          e.preventDefault();
          openMenuByKeyboard(kind, id);
        }
        return;
      default:
    }
  };

  const openMenu = (
    e: MouseEvent,
    kind: TreeKind,
    id: string,
    fromButton = false,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (fromButton) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ kind, id, anchor: { x: r.left, y: r.bottom + 4 } });
    } else {
      setMenu({ kind, id, anchor: { x: e.clientX, y: e.clientY } });
    }
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const beginRename = (kind: TreeKind, id: string) => {
    setMenu(null);
    setRenaming({ kind, id });
  };

  const commitRename = (next: string) => {
    if (!renaming) return;
    if (renaming.kind === "project") renameProject(renaming.id, next);
    // A board is a group with no project, so it renames through the same door.
    else if (renaming.kind === "group" || renaming.kind === "board")
      renameGroup(renaming.id, next);
    else updateTerminal(renaming.id, { title: next });
    setRenaming(null);
  };

  /**
   * Live is `isLive` — running **or** starting.
   *
   * This filtered on `state === "running"` alone, so suspending a group right
   * after opening several agents skipped the ones still coming up, while the
   * floors overview (which uses `isLive`) included them. Same button, two
   * answers, and the message claimed to have suspended all of them.
   */
  const liveIds = (groupId: string) =>
    (terminalsByGroup.get(groupId) ?? [])
      .map((t) => t.id)
      .filter((id) => isLive(runtimes[id]));

  const suspendGroup = async (groupId: string) => {
    const ids = liveIds(groupId);
    if (ids.length === 0) {
      showToast("Nenhum terminal vivo neste grupo.");
      return;
    }
    const failures = await ipc.suspendGroup(ids);
    const suspended = ids.length - failures.length;
    showToast(
      failures.length
        ? `${suspended} suspenso(s), ${failures.length} falharam.`
        : `${suspended} terminal(is) suspenso(s) — RAM liberada.`,
      failures.length ? "error" : "info",
    );
  };

  const newCli = (groupId: string) => {
    setActiveGroup(groupId);
    openModal("new-terminal", { groupId });
  };

  /**
   * Deleting a board takes its cards with it — they are processes, and there
   * is no other surface of this board for them to fall back to. Said plainly,
   * because the drawings and the notes go too and none of that is recoverable.
   */
  const confirmDeleteBoard = async (boardId: string) => {
    const board = boards.find((b) => b.id === boardId);
    if (!board) return;
    const cards = terminalsByGroup.get(boardId) ?? [];
    const aliveCount = cards.filter((t) => isLive(runtimes[t.id])).length;
    const detail =
      aliveCount > 0
        ? `${aliveCount} CLI(s) ainda rodando. Excluir encerra os processos.`
        : cards.length > 0
          ? `O quadro tem ${cards.length} CLI(s).`
          : "O quadro está vazio.";
    const ok = await ask(
      `Excluir o quadro “${board.name}”? ${detail} Os desenhos e as notas dele ` +
        `também vão.${unsavedWarning({ groupId: boardId })}`,
      { title: "Excluir quadro", kind: "warning" },
    );
    if (ok) await act(() => closeGroup(boardId), "Não consegui excluir o quadro");
  };

  const confirmDeleteGroup = async (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const clis = terminalsByGroup.get(groupId) ?? [];
    const aliveCount = clis.filter((t) => isLive(runtimes[t.id])).length;
    const detail =
      aliveCount > 0
        ? `${aliveCount} CLI(s) ainda rodando. Excluir encerra os processos.`
        : clis.length > 0
          ? `O grupo tem ${clis.length} CLI(s).`
          : "O grupo está vazio.";
    const ok = await ask(
      `Excluir o grupo “${group.name}”? ${detail}${unsavedWarning({ groupId })}`,
      { title: "Excluir grupo", kind: "warning" },
    );
    if (!ok) return;
    await closeGroup(groupId);
  };

  const confirmDeleteProject = async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const clis = (groupsByProject.get(projectId) ?? []).flatMap(
      (group) => terminalsByGroup.get(group.id) ?? [],
    );
    const aliveCount = clis.filter((t) => isLive(runtimes[t.id])).length;
    const ok = await ask(
      (aliveCount > 0
        ? `Remover “${project.name}”? ${aliveCount} CLI(s) ainda rodando serão encerradas.`
        : `Remover o projeto “${project.name}” da barra? A pasta no disco permanece.`) +
        unsavedWarning({ projectId }),
      { title: "Remover projeto", kind: "warning" },
    );
    if (!ok) return;
    await closeProject(projectId);
  };

  const menuItems = (): MenuEntry[] => {
    if (!menu) return [];

    if (menu.kind === "sidebar") {
      const ids = projects.map((p) => p.id);
      const allClosed = ids.length > 0 && ids.every((id) => collapsed[id]);
      return [
        {
          id: "add-project",
          label: "Adicionar projeto",
          icon: <FolderPlus size={13} />,
          onSelect: () => openModal("new-project"),
        },
        { kind: "sep" },
        {
          id: "fold",
          label: allClosed ? "Expandir todos" : "Recolher todos",
          icon: allClosed ? <ChevronDown size={13} /> : <ChevronRight size={13} />,
          disabled: ids.length === 0,
          onSelect: () => useUI.getState().setTreeCollapsed(ids, !allClosed),
        },
        { kind: "sep" },
        {
          id: "hide",
          label: "Esconder a barra",
          shortcut: "Ctrl+B",
          onSelect: () => useUI.getState().toggleSidebar(),
        },
      ];
    }

    if (menu.kind === "board") {
      const board = boards.find((b) => b.id === menu.id);
      if (!board) return [];
      return [
        {
          id: "new-cli",
          label: "Nova CLI neste quadro",
          icon: <TerminalIcon size={13} />,
          onSelect: () => newCli(board.id),
        },
        {
          id: "rename",
          label: "Renomear",
          icon: <Pencil size={13} />,
          onSelect: () => beginRename("board", board.id),
        },
        { kind: "sep" },
        {
          id: "new-board",
          label: "Novo quadro",
          icon: <Plus size={13} />,
          onSelect: () => beginRename("board", addBoard("")),
        },
        { kind: "sep" },
        {
          id: "delete",
          label: "Excluir quadro",
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => void confirmDeleteBoard(board.id),
        },
      ];
    }

    if (menu.kind === "project") {
      const project = projects.find((p) => p.id === menu.id);
      if (!project) return [];
      return [
        {
          id: "rename",
          label: "Renomear",
          icon: <Pencil size={13} />,
          onSelect: () => beginRename("project", project.id),
        },
        {
          id: "style",
          label: "Personalizar…",
          icon: <Palette size={13} />,
          onSelect: () => openModal("project-style", { projectId: project.id }),
        },
        {
          id: "new-group",
          label: "Novo grupo",
          icon: <Plus size={13} />,
          onSelect: () => addGroup(project.id),
        },
        { kind: "sep" },
        {
          id: "explorer",
          label: "Abrir no Explorer",
          icon: <FolderOpen size={13} />,
          onSelect: () =>
            void ipc
              .revealPath(project.path)
              .catch((e) => showToast(String(e), "error")),
        },
        {
          id: "sessions",
          label: "Sessões de agentes…",
          icon: <History size={13} />,
          onSelect: () => openModal("sessions", { projectPath: project.path }),
        },
        {
          id: "scores",
          label: "Partituras…",
          icon: <Music size={13} />,
          onSelect: () => openModal("scores", { projectId: project.id }),
        },
        { kind: "sep" },
        {
          id: "delete",
          label: "Remover projeto",
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => void confirmDeleteProject(project.id),
        },
      ];
    }

    if (menu.kind === "group") {
      const group = groups.find((g) => g.id === menu.id);
      if (!group) return [];
      const siblings = groups
        .filter((g) => g.projectId === group.projectId)
        .sort((a, b) => a.sort - b.sort);
      const idx = siblings.findIndex((g) => g.id === group.id);
      const aliveCount = liveIds(group.id).length;
      return [
        {
          id: "rename",
          label: "Renomear",
          icon: <Pencil size={13} />,
          onSelect: () => beginRename("group", group.id),
        },
        {
          id: "new-cli",
          label: "Nova aba…",
          icon: <TerminalIcon size={13} />,
          shortcut: "Ctrl+T",
          onSelect: () => newCli(group.id),
        },
        {
          id: "new-group",
          label: "Novo grupo",
          icon: <Plus size={13} />,
          onSelect: () => group.projectId && addGroup(group.projectId),
        },
        {
          id: "scores",
          label: "Partituras…",
          icon: <Music size={13} />,
          onSelect: () =>
            openModal("scores", { groupId: group.id, projectId: group.projectId }),
        },
        { kind: "sep" },
        {
          id: "up",
          label: "Mover para cima",
          icon: <ArrowUp size={13} />,
          disabled: idx <= 0,
          onSelect: () => moveGroup(group.id, -1),
        },
        {
          id: "down",
          label: "Mover para baixo",
          icon: <ArrowDown size={13} />,
          disabled: idx < 0 || idx >= siblings.length - 1,
          onSelect: () => moveGroup(group.id, 1),
        },
        { kind: "sep" },
        {
          id: "suspend",
          label: aliveCount > 0 ? `Suspender grupo (${aliveCount})` : "Suspender grupo",
          icon: <PauseCircle size={13} />,
          disabled: aliveCount === 0,
          onSelect: () => void suspendGroup(group.id),
        },
        {
          id: "delete",
          label: "Excluir grupo",
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: () => void confirmDeleteGroup(group.id),
        },
      ];
    }

    const t = terminals.find((x) => x.id === menu.id);
    if (!t) return [];
    // The order the tree draws is the same as the pane's tab bar — which is
    // why the neighbour above is the previous sibling in the same slot.
    const siblings = (terminalsByGroup.get(t.groupId) ?? []).filter(
      (x) => x.slot === t.slot,
    );
    const idx = siblings.findIndex((x) => x.id === t.id);
    return terminalActionEntries({
      id: t.id,
      running: isLive(runtimes[t.id]),
      run: act,
      onRename: () => beginRename("terminal", t.id),
      reorder: {
        canUp: idx > 0,
        canDown: idx >= 0 && idx < siblings.length - 1,
        run: (delta) => moveTerminalBy(t.id, delta),
      },
    });
  };

  /**
   * One CLI row — used by the boards on top and by the groups below, which is
   * why it is a function and not two copies of ninety lines of markup.
   * `level` is the ARIA depth: a card hangs straight off its board (2), a tab
   * hangs off a group inside a project (3).
   */
  const renderTerminal = (t: TerminalRow, level: number, origin?: string | null) => {
    const rt = runtimes[t.id];
    const termMenuOpen = menu?.kind === "terminal" && menu.id === t.id;
    const label = baseName(t);
    // The tree is the primary navigation: clicking has to bring the CLI to
    // the front, not just light up the row. On a board that means taking the
    // camera to the card — both routes live in `lib/navigate`.
    const openIt = () => goToTerminal(t);
    return (
                            <div
                              key={t.id}
                              className={`tree-row tree-row--terminal ${
                                termMenuOpen ? "is-menu-open" : ""
                              } ${t.id === focusedTerminalId ? "is-focused" : ""}`}
                              role="treeitem"
                              aria-level={level}
                              // The dot and the badges are colour only; both
                              // states have to reach a screen reader through
                              // the name — "blocked" is the one signal the
                              // whole product exists to deliver.
                              aria-label={`${label}${origin ? ` em ${origin}` : ""} — ${readableState(rt?.state)}${
                                rt?.blocked
                                  ? ", esperando uma resposta sua"
                                  : rt?.finished
                                    ? ", terminou de trabalhar"
                                    : rt?.unread
                                      ? ", saída nova ainda não vista"
                                      : ""
                              }`}
                              aria-selected={t.id === focusedTerminalId}
                              aria-current={
                                t.id === focusedTerminalId ? "true" : undefined
                              }
                              ref={(el) => registerRow(t.id, el)}
                              tabIndex={tabIndexOf(t.id)}
                              onFocus={() => setFocusId(t.id)}
                              onKeyDown={(e) =>
                                onRowKeyDown(e, "terminal", t.id, openIt, null)
                              }
                              onClick={openIt}
                              onContextMenu={(e) => {
                                openIt();
                                openMenu(e, "terminal", t.id);
                              }}
                              data-tip-at="left" data-tip-wrap="" data-tip={`${t.program} ${t.args.join(" ")}`.trim()}
                            >
                              <span
                                className={`dot dot--${rt?.state ?? "idle"}`}
                                data-tip={readableState(rt?.state)}
                                // The row's own name already says the state.
                                aria-hidden="true"
                              />
                              <TerminalMark term={t} size={11} className="tree-icon" />
                              {renaming?.kind === "terminal" &&
                              renaming.id === t.id ? (
                                <InlineRename
                                  value={label}
                                  onCommit={commitRename}
                                  onCancel={() => setRenaming(null)}
                                />
                              ) : (
                                <span
                                  className="tree-label"
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    beginRename("terminal", t.id);
                                  }}
                                >
                                  {label}
                                  {origin && (
                                    <span className="tree-origin"> · {origin}</span>
                                  )}
                                </span>
                              )}
                              {rt?.blocked ? (
                                <span
                                  className="badge-blocked"
                                  data-tip-wrap=""
                                  data-tip={rt.blockedAsk ?? "Esperando uma resposta sua"}
                                />
                              ) : rt?.finished ? (
                                <span
                                  className="badge-finished"
                                  data-tip="Terminou de trabalhar"
                                />
                              ) : rt?.unread ? (
                                <span
                                  className="badge-unread"
                                  data-tip="Saída nova ainda não vista"
                                />
                              ) : null}
                              <button
                                className="icon-btn"
                                data-tip-at="right" data-tip="Mais ações"
                                aria-label={`Mais ações de ${label}`}
                                onClick={(e) => {
                                  openIt();
                                  openMenu(e, "terminal", t.id, true);
                                }}
                              >
                                <MoreVertical size={13} />
                              </button>
                            </div>
    );
  };

  return (
    <aside
      className="sidebar"
      style={{ width }}
      // The bar's background (header, empty space, footer) had a bare
      // `preventDefault`: it swallowed the right click and gave nothing back.
      // Now it answers for what the whole bar does.
      onContextMenu={(e) => openMenu(e, "sidebar", "")}
    >
      {/* A board is not inside any project — it is the canvas as its own
          container, mixing cards from several. The two sections are
          surface-exclusive: boards on Canvas, projects on the pane grid. */}
      {sections.boards && (
        <div className="sidebar-header">
          <span>Quadros</span>
          <button
            className="icon-btn"
            data-tip="Novo quadro"
            aria-label="Novo quadro"
            onClick={() => beginRename("board", addBoard(""))}
          >
            <Plus size={14} />
          </button>
        </div>
      )}

      <div
        className={`sidebar-boards ${sections.projects ? "" : "is-alone"}`}
        role="tree"
        aria-label="Quadros do canvas"
        hidden={!sections.boards}
      >
        {boards.length === 0 && (
          <div className="tree-empty">
            Nenhum quadro —{" "}
            <button onClick={() => beginRename("board", addBoard(""))}>criar um</button>
          </div>
        )}
        {boards.map((board) => {
          const cards = terminalsByGroup.get(board.id) ?? [];
          const boardMenuOpen = menu?.kind === "board" && menu.id === board.id;
          const boardCollapsed = collapsed[board.id];
          return (
            <div key={board.id} className="tree-project" role="none">
              <div
                className={`tree-row tree-row--board ${
                  board.id === activeGroupId ? "is-active" : ""
                } ${boardMenuOpen ? "is-menu-open" : ""}`}
                role="treeitem"
                aria-level={1}
                aria-label={board.name}
                aria-selected={board.id === activeGroupId}
                aria-current={board.id === activeGroupId ? "true" : undefined}
                aria-expanded={cards.length > 0 ? !boardCollapsed : undefined}
                ref={(el) => registerRow(board.id, el)}
                tabIndex={tabIndexOf(board.id)}
                onFocus={() => setFocusId(board.id)}
                onKeyDown={(e) =>
                  onRowKeyDown(
                    e,
                    "board",
                    board.id,
                    () => setActiveGroup(board.id),
                    cards.length > 0 ? !boardCollapsed : null,
                  )
                }
                onClick={() => setActiveGroup(board.id)}
                onContextMenu={(e) => {
                  setActiveGroup(board.id);
                  openMenu(e, "board", board.id);
                }}
                data-tip-wrap="" data-tip="Botão direito para ações"
              >
                {cards.length > 0 ? (
                  <button
                    className="tree-toggle"
                    aria-expanded={!boardCollapsed}
                    aria-label={
                      boardCollapsed ? `Expandir ${board.name}` : `Recolher ${board.name}`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(board.id);
                    }}
                  >
                    {boardCollapsed ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                  </button>
                ) : (
                  <Frame size={13} className="tree-icon tree-icon--board" />
                )}
                {renaming?.kind === "board" && renaming.id === board.id ? (
                  <InlineRename
                    value={board.name}
                    onCommit={commitRename}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span
                    className="tree-label"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      beginRename("board", board.id);
                    }}
                  >
                    {board.name}
                  </span>
                )}
                <button
                  className="icon-btn"
                  data-tip-at="right" data-tip="Nova CLI neste quadro"
                  aria-label={`Nova CLI em ${board.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    newCli(board.id);
                  }}
                >
                  <Plus size={13} />
                </button>
                <button
                  className="icon-btn"
                  data-tip-at="right" data-tip="Mais ações"
                  aria-label={`Mais ações de ${board.name}`}
                  onClick={(e) => openMenu(e, "board", board.id, true)}
                >
                  <MoreVertical size={13} />
                </button>
              </div>

              {cards.length === 0 && (
                <div className="tree-empty">
                  Quadro vazio —{" "}
                  <button onClick={() => newCli(board.id)}>abrir uma CLI</button>
                </div>
              )}

              {/* The folder each card runs in: on a board two CLIs with the
                  same name are told apart only by the project behind them. */}
              {!boardCollapsed &&
                cards.map((t) => renderTerminal(t, 2, cardOrigin(projects, t.cwd)))}
            </div>
          );
        })}
      </div>

      {sections.projects && (
        <div className="sidebar-header">
          <span>Projetos</span>
          <button
            className="icon-btn"
            data-tip="Adicionar projeto"
            aria-label="Adicionar projeto"
            onClick={() => openModal("new-project")}
          >
            <FolderPlus size={14} />
          </button>
        </div>
      )}

      <div
        className="sidebar-tree"
        role="tree"
        aria-label="Projetos, grupos e terminais"
        hidden={!sections.projects}
      >
        {projects.length === 0 && (
          <div className="sidebar-empty">
            <p>
              Um projeto é uma pasta do disco. É dela que saem o diretório de
              trabalho das CLIs e as sessões que os agentes já gravaram.
            </p>
            <button
              className="btn btn--primary"
              onClick={() => openModal("new-project")}
            >
              <FolderPlus size={13} /> Adicionar pasta
            </button>
          </div>
        )}

        {projects.map((project) => {
          const projectGroups = groupsByProject.get(project.id) ?? [];
          const isCollapsed = collapsed[project.id];
          const projectMenuOpen =
            menu?.kind === "project" && menu.id === project.id;
          const ProjectIcon = projectIcon(project.icon);
          return (
            <div key={project.id} className="tree-project" role="none">
              <div
                className={`tree-row tree-row--project ${projectMenuOpen ? "is-menu-open" : ""}`}
                role="treeitem"
                aria-level={1}
                aria-expanded={!isCollapsed}
                aria-label={project.name}
                ref={(el) => registerRow(project.id, el)}
                tabIndex={tabIndexOf(project.id)}
                onFocus={() => setFocusId(project.id)}
                onKeyDown={(e) =>
                  onRowKeyDown(
                    e,
                    "project",
                    project.id,
                    () => toggle(project.id),
                    !isCollapsed,
                  )
                }
                onContextMenu={(e) => openMenu(e, "project", project.id)}
              >
                <button
                  className="tree-toggle"
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed
                      ? `Expandir ${project.name}`
                      : `Recolher ${project.name}`
                  }
                  onClick={() => toggle(project.id)}
                >
                  {isCollapsed ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
                <ProjectIcon
                  size={13}
                  className="tree-icon tree-icon--project"
                  style={project.color ? { color: project.color } : undefined}
                  aria-hidden="true"
                />
                {renaming?.kind === "project" && renaming.id === project.id ? (
                  <InlineRename
                    value={project.name}
                    onCommit={commitRename}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span
                    className="tree-label"
                    data-tip-at="left" data-tip-wrap="" data-tip={project.path}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      beginRename("project", project.id);
                    }}
                  >
                    {project.name}
                  </span>
                )}
                <button
                  className="icon-btn"
                  data-tip-at="right" data-tip="Novo grupo"
                  aria-label={`Novo grupo em ${project.name}`}
                  onClick={() => addGroup(project.id)}
                >
                  <Plus size={13} />
                </button>
                <button
                  className="icon-btn"
                  data-tip-at="right" data-tip="Mais ações"
                  aria-label={`Mais ações de ${project.name}`}
                  onClick={(e) => openMenu(e, "project", project.id, true)}
                >
                  <MoreVertical size={13} />
                </button>
              </div>

              {!isCollapsed &&
                projectGroups.map((group) => {
                  const groupTerminals = terminalsByGroup.get(group.id) ?? [];
                  const running = groupTerminals.filter(
                    (t) => runtimes[t.id]?.state === "running",
                  ).length;
                  const groupMenuOpen =
                    menu?.kind === "group" && menu.id === group.id;
                  const groupCollapsed = collapsed[group.id];
                  return (
                    <div key={group.id} className="tree-group" role="none">
                      <div
                        className={`tree-row tree-row--group ${
                          group.id === activeGroupId ? "is-active" : ""
                        } ${groupMenuOpen ? "is-menu-open" : ""}`}
                        role="treeitem"
                        aria-level={2}
                        aria-label={group.name}
                        aria-selected={group.id === activeGroupId}
                        aria-current={group.id === activeGroupId ? "true" : undefined}
                        aria-expanded={
                          groupTerminals.length > 0 ? !groupCollapsed : undefined
                        }
                        ref={(el) => registerRow(group.id, el)}
                        tabIndex={tabIndexOf(group.id)}
                        onFocus={() => setFocusId(group.id)}
                        onKeyDown={(e) =>
                          onRowKeyDown(
                            e,
                            "group",
                            group.id,
                            () => setActiveGroup(group.id),
                            groupTerminals.length > 0 ? !groupCollapsed : null,
                          )
                        }
                        onClick={() => setActiveGroup(group.id)}
                        onContextMenu={(e) => {
                          setActiveGroup(group.id);
                          openMenu(e, "group", group.id);
                        }}
                        data-tip-wrap="" data-tip="Botão direito para ações"
                      >
                        {groupTerminals.length > 0 ? (
                          <button
                            className="tree-toggle"
                            aria-expanded={!groupCollapsed}
                            aria-label={
                              groupCollapsed
                                ? `Expandir ${group.name}`
                                : `Recolher ${group.name}`
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(group.id);
                            }}
                          >
                            {groupCollapsed ? (
                              <ChevronRight size={12} />
                            ) : (
                              <ChevronDown size={12} />
                            )}
                          </button>
                        ) : (
                          <Layers size={12} className="tree-icon" />
                        )}
                        {renaming?.kind === "group" && renaming.id === group.id ? (
                          <InlineRename
                            value={group.name}
                            onCommit={commitRename}
                            onCancel={() => setRenaming(null)}
                          />
                        ) : (
                          <span
                            className="tree-label"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              beginRename("group", group.id);
                            }}
                          >
                            {group.name}
                          </span>
                        )}
                        {running > 0 && (
                          <span
                            className="pill"
                            data-tip-wrap="" data-tip={`${running} rodando neste grupo`}
                          >
                            {running}
                          </span>
                        )}
                        <button
                          className="icon-btn"
                          data-tip-at="right" data-tip="Nova aba neste grupo"
                          aria-label={`Nova aba em ${group.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            newCli(group.id);
                          }}
                        >
                          <Plus size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          data-tip-at="right" data-tip="Mais ações"
                          aria-label={`Mais ações de ${group.name}`}
                          onClick={(e) => {
                            setActiveGroup(group.id);
                            openMenu(e, "group", group.id, true);
                          }}
                        >
                          <MoreVertical size={13} />
                        </button>
                      </div>

                      {groupTerminals.length === 0 && (
                        <div className="tree-empty">
                          Sem CLIs —{" "}
                          <button onClick={() => newCli(group.id)}>
                            abrir uma
                          </button>
                        </div>
                      )}

                      {!groupCollapsed &&
                        groupTerminals.map((t) => renderTerminal(t, 3))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      <ResourceHud />

      <Resizer
        side="right"
        width={width}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        defaultWidth={DEFAULT_PREFS.sidebarWidth}
        label="Largura da barra lateral"
        onResize={(w) => setPrefLocal("sidebarWidth", w)}
        onCommit={(w) => setPref("sidebarWidth", w)}
      />

      {menu && (
        <ContextMenu anchor={menu.anchor} items={menuItems()} onClose={closeMenu} />
      )}
    </aside>
  );
}

/**
 * Resource footer, in its own component on purpose: the numbers refresh on
 * every `resources://tick`, and inlined in the sidebar that tick re-rendered
 * the whole project tree just to move a progress bar.
 */
function ResourceHud() {
  const totalRssMb = useTerminals((s) => s.totalRssMb);
  const systemAvailableMb = useTerminals((s) => s.systemAvailableMb);
  const systemTotalMb = useTerminals((s) => s.systemTotalMb);

  const ramUsage =
    systemTotalMb > 0
      ? Math.min(1, Math.max(0, 1 - systemAvailableMb / systemTotalMb))
      : 0;
  const ramLevel = ramUsage > 0.92 ? "crit" : ramUsage > 0.82 ? "warn" : "ok";

  return (
    <div className="sidebar-hud">
      <div className="hud-row">
        <span>Terminais</span>
        <strong data-tip-side="top" data-tip-wrap="" data-tip="RAM somada das árvores de processo das CLIs">
          {totalRssMb > 0 ? `${totalRssMb.toFixed(0)} MB` : "—"}
        </strong>
      </div>
      <div className="hud-row">
        <span>RAM livre</span>
        <strong>
          {systemAvailableMb > 0
            ? `${(systemAvailableMb / 1024).toFixed(1)} / ${(systemTotalMb / 1024).toFixed(0)} GB`
            : "—"}
        </strong>
      </div>
      {systemAvailableMb > 0 && (
        <div
          className="hud-bar"
          data-tip-side="top" data-tip-wrap="" data-tip={
            ramLevel === "ok"
              ? `${Math.round(ramUsage * 100)}% da memória em uso`
              : `${Math.round(ramUsage * 100)}% da memória em uso — suspenda grupos ociosos para liberar RAM`
          }
        >
          <div
            className={`hud-bar-fill ${ramLevel !== "ok" ? `hud-bar-fill--${ramLevel}` : ""}`}
            style={{ transform: `scaleX(${ramUsage})` }}
          />
        </div>
      )}
    </div>
  );
}

function readableState(state?: string): string {
  switch (state) {
    case "running":
      return "Rodando";
    case "starting":
      return "Iniciando";
    case "exited":
      return "Encerrado";
    case "error":
      return "Falhou ao iniciar";
    default:
      return "Parado";
  }
}
