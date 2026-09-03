/**
 * "Nova aba": a grid of marks, and one click opens the thing.
 *
 * This dialog has been both shapes. It started as a list where clicking a row
 * created the terminal, with the flags crammed into a footer strip; that made
 * the fast path fast and everything else awkward, so it grew a form — name,
 * destination, folder, arguments, role — and a "Criar" button. Which then made
 * the fast path slow: opening the same CLI in the same project, twenty times a
 * day, meant walking a form whose every field already held the right answer.
 *
 * What broke the tie was Configurações › Agentes. Once each CLI says **once**
 * how it opens — its command line, where it runs, the name and the role it is
 * born with — the form had nothing left to ask that was not already answered,
 * and the dialog could go back to being a single gesture. The two fields that
 * did not move are the two that are per-invocation, and both have a right
 * answer with nobody to ask: the tab is born in the pane that asked for it,
 * and in the project's own folder.
 *
 * On a **board** the folder is the one question that has no answer to infer:
 * a board belongs to no project (the canvas is the boards, `lib/surface.ts`),
 * so the dialog asks for a folder, offers the last card's, and never a
 * project.
 *
 * The grid is "what this tab can be", not "which CLI": the embedded browser
 * and the notebook live here too, and whatever other kinds of tab the pane
 * learns later should land in this same grid instead of growing dialogs of
 * their own.
 *
 * Everything a click creates happens **after** every check passes. The order
 * matters: creating the group first and validating afterwards left a stray
 * empty group behind on each failed attempt.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  FolderOpen,
  FolderPlus,
  Frame,
  Globe,
  NotebookPen,
  RefreshCw,
  Settings2,
  Terminal as TerminalIcon,
} from "lucide-react";

import { Modal } from "./Modal";
import { Select } from "../Select";
import { BrandIcon } from "../BrandIcon";
import { useT } from "../../hooks/useT";
import { defaultRoleOf, pickableAgents, titleFor } from "../../lib/agentDefaults";
import { suggestBoardFolder } from "../../lib/boardFolder";
import { brandById } from "../../lib/brands";
import { commitCanvasExternal, placeCard } from "../../lib/canvasWrite";
import {
  cwdFor,
  defaultDestination,
  destinationAt,
  destinationsOf,
  groundBranchOf,
  NEW_FRONT,
} from "../../lib/destination";
import { createFloor } from "../../lib/floorCreate";
import { ipc, type AgentInfo, type ShellOption } from "../../lib/ipc";
import { deliverBriefing } from "../../lib/roleBrief";
import { roleLaunch } from "../../lib/roles";
import { useAgentDefaults } from "../../stores/agentDefaultsStore";
import { useBrowsers } from "../../stores/browsersStore";
import { useNotes } from "../../stores/notesStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { NO_WORKTREES, useWorktrees } from "../../stores/worktreesStore";

interface Payload {
  groupId?: string;
  slot?: number;
  /** Top-left of the card, when the gesture that opened this had a point. */
  x?: number;
  y?: number;
}

/**
 * One mark in the grid: a CLI detected on the machine, a shell — or the
 * embedded browser. The grid is "what this tab can be", not "which CLI":
 * that is what lets other kinds land here later without another dialog.
 *
 * `label` and `detail` are kept in Portuguese and translated where the tile
 * is drawn, so the list is built once and still follows the language.
 */
interface Choice {
  kind: "shell" | "agent" | "browser" | "notes";
  /** Catalog id — what `brandById` and the agent's settings are keyed by. */
  id: string;
  label: string;
  program: string;
  /** Second line of the tooltip: version, path, or why it cannot be used. */
  detail: string;
  available: boolean;
}

/** The non-process tiles — always present, nothing to detect. */
const BROWSER: Choice = {
  kind: "browser",
  id: "browser",
  label: "Navegador", // i18n-ok — translated where drawn
  program: "",
  detail: "página embutida na barra de abas — o mesmo motor dos portais", // i18n-ok — translated where drawn
  available: true,
};

const NOTES: Choice = {
  kind: "notes",
  id: "notes",
  label: "Anotações", // i18n-ok — translated where drawn
  program: "",
  detail: "o caderno de notas markdown vira uma aba deste painel", // i18n-ok — translated where drawn
  available: true,
};

/** Reasons a tile cannot open — Portuguese keys, translated where drawn. */
const NOT_INSTALLED = "não instalado — instale a CLI e detecte de novo"; // i18n-ok — translated where drawn
const NOT_FOUND = "não encontrado nesta máquina"; // i18n-ok — translated where drawn

function ChoiceMark({ choice }: { choice: Choice }) {
  if (choice.kind === "browser") return <Globe size={19} />;
  if (choice.kind === "notes") return <NotebookPen size={19} />;
  const brand = brandById(choice.id);
  if (brand) return <BrandIcon brand={brand} size={19} />;
  return choice.kind === "agent" ? <Bot size={19} /> : <TerminalIcon size={19} />;
}

export function NewTerminalModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const openModal = useUI((s) => s.openModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const addTerminal = useProjects((s) => s.addTerminal);
  const addGroup = useProjects((s) => s.addGroup);
  const addBoard = useProjects((s) => s.addBoard);
  const canvasSide = useProjects((s) => s.canvasSide);
  const projectOfGroup = useProjects((s) => s.projectOfGroup);
  const agentDefaults = useAgentDefaults((s) => s.defaults);

  const [shells, setShells] = useState<ShellOption[] | null>(null);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  /** Locks the grid while `is_directory` and the spawn resolve. */
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  /**
   * Where the tab is born: the group of the pane that asked, else the one in
   * view. This is the field that used to be "Onde abrir" — it had the right
   * answer every time, and reading it was work done for nothing.
   */
  const groupId = payload?.groupId ?? activeGroupId ?? null;
  const group = groupId ? groups.find((g) => g.id === groupId) : undefined;
  /**
   * A board belongs to no project, and that is the point of it: the folder the
   * CLI runs in is a **question** instead of something to infer, and the
   * answer is never a project. Everywhere else the dialog stopped asking,
   * because it always had the right answer.
   */
  const onBoard = group?.projectId === null;
  /**
   * The canvas side with no board to be born on (the last one was deleted):
   * a CLI here is a card, and a card needs a board first. The dialog asks
   * for one instead of quietly opening the CLI in a project, which would
   * carry the user off the canvas side.
   */
  const needsBoard = canvasSide && !group;
  /**
   * `projects[0]` used to be the fallback, which could open the terminal in a
   * project nobody was in. On a board there is no project at all.
   */
  const targetProject = onBoard
    ? undefined
    : ((group ? projectOfGroup(group.id) : undefined) ??
      projects.find((p) => p.id === activeProjectId) ??
      projects[0]);
  /**
   * The folder of a board card: offered from the board's last card, else the
   * home folder (`lib/boardFolder.ts`), then typed or picked from the disk.
   * The offer only fills an empty field, so what the user typed survives it.
   */
  const [boardFolder, setBoardFolder] = useState("");
  useEffect(() => {
    if (!onBoard || !groupId) return;
    const known = suggestBoardFolder(useProjects.getState().terminalsOf(groupId), "");
    if (known) {
      setBoardFolder((current) => current || known);
      return;
    }
    let alive = true;
    void homeDir()
      .then((home) => {
        if (alive) setBoardFolder((current) => current || home);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [onBoard, groupId]);
  const pickFolder = async () => {
    const chosen = await openFolderDialog({
      directory: true,
      multiple: false,
      defaultPath: boardFolder || undefined,
    });
    if (typeof chosen === "string") setBoardFolder(chosen);
  };

  /**
   * Where inside the project the tab runs: the ground (the project's own root,
   * on whatever branch is checked out there) or one of the fronts, a `git
   * worktree` each, with a branch of its own. A project stopped growing
   * folders, so this is the whole of the answer.
   *
   * With nothing chosen the ground wins, which is the promise the dialog used
   * to break: a CLI opened inside a front was spawned in the *project's* root,
   * so the tab said "fix-login" and the agent edited the files of `main`.
   */
  // `s.of(...)`, never `s.byProject[id] ?? []`: a selector that mints a fresh
  // array on every call hands Zustand a new snapshot each time it checks, and
  // that is the "Maximum update depth exceeded" loop, not a re-render.
  const worktrees = useWorktrees((s) =>
    targetProject ? s.of(targetProject.id) : NO_WORKTREES,
  );
  const destinations = useMemo(() => {
    if (!targetProject) return [];
    const s = useProjects.getState();
    return destinationsOf({
      projectPath: targetProject.path,
      groups: groups.filter((g) => g.projectId === targetProject.id),
      floorOf: (id) => s.floorOf(id),
      worktrees,
      groundBranch: groundBranchOf(worktrees, targetProject.path),
    });
  }, [targetProject, groups, worktrees]);
  /** `null` = the dialog has not been touched: follow the group in view. */
  const [destPicked, setDestPicked] = useState<string | null>(null);
  const destValue =
    destPicked && destinations.some((d) => d.value === destPicked)
      ? destPicked
      : defaultDestination(destinations, onBoard ? null : groupId);
  const dest = destinationAt(destinations, destValue);

  // `git worktree list` is what names the branches here; it is read once per
  // project the dialog points at.
  useEffect(() => {
    if (!targetProject) return;
    void useWorktrees.getState().refresh(targetProject.id, targetProject.path);
  }, [targetProject]);

  useEffect(() => {
    void ipc
      .listShells()
      .then(setShells)
      // Without this the grid sat on its skeletons forever, looking like a
      // slow load rather than a failure.
      .catch((e) => {
        setShells([]);
        setShellsError(String(e));
      });
  }, []);

  const detect = (refresh: boolean) => {
    setLoadingAgents(true);
    setAgentsError(null);
    void ipc
      .detectAgents(refresh)
      .then(setAgents)
      .catch((e) => {
        setAgents([]);
        setAgentsError(String(e));
      })
      .finally(() => setLoadingAgents(false));
  };

  // Detection runs on open: the agents *are* the grid, and a dialog that shows
  // the shells first and the CLIs a beat later would move under the pointer.
  useEffect(() => {
    detect(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choices = useMemo<Choice[]>(() => {
    const byAgent = (a: AgentInfo): Choice => ({
      kind: "agent",
      id: a.id,
      label: a.name,
      program: a.bin ?? a.id,
      detail: a.installed ? (a.version ?? a.bin ?? "") : NOT_INSTALLED,
      available: a.installed,
    });
    const fromShell = (s: ShellOption): Choice => ({
      kind: "shell",
      id: s.id,
      label: s.label,
      program: s.program,
      detail: s.available ? s.program : NOT_FOUND,
      available: s.available,
    });
    // Agents first, and within each family what can actually run comes first:
    // the grid is read left to right, and a dead tile in the first slot is a
    // dead first impression.
    const sortBy = (list: Choice[]) =>
      [...list].sort((a, b) => Number(b.available) - Number(a.available));
    return [
      // An agent turned off in Settings is not offered here — it is still
      // installed, still configurable, still reachable by name from
      // `yard recruit`. This grid is the one place the choice narrows.
      ...sortBy(pickableAgents(agents ?? [], agentDefaults).map(byAgent)),
      ...sortBy((shells ?? []).map(fromShell)),
      // Last, after everything that runs: these are the tiles that are not
      // processes, and the grid reads left to right as "agents, shells, the rest".
      BROWSER,
      NOTES,
    ];
  }, [agents, shells, agentDefaults]);

  /**
   * Takes the screen to where the tab was born.
   *
   * The pane that asked is usually already in view, but `Ctrl+T` with another
   * group active is not — and the dialog closing with nothing on screen
   * showing what was created is the worst possible answer to a click.
   */
  /**
   * Puts the screen where the new thing landed: a tab in its group, a card
   * on its board. The group says which (the canvas is the boards), so this is
   * only ever a change of group.
   */
  const goToTarget = (targetId: string) => {
    if (useProjects.getState().activeGroupId !== targetId) {
      useProjects.getState().setActiveGroup(targetId);
    }
  };

  /**
   * One click, one tab. Everything it needs was decided somewhere else: the
   * CLI's own settings (name, role, command line, where it runs) and the pane
   * that asked (group, slot, folder).
   */
  /**
   * The group the tab lands in. A board is not a project child, so a front
   * chosen in the picker there only says which folder the card runs in: the
   * card still belongs to the board.
   */
  const destGroupId = onBoard ? null : (dest?.groupId ?? null);
  const groupFor = () => destGroupId ?? group?.id ?? addGroup(targetProject!.id);

  const createIt = async (recipient: Choice) => {
    if (busy || !recipient.available) return;
    if (needsBoard) {
      showToast(t("Crie um quadro primeiro: no canvas, a CLI é um cartão de um quadro."), "error");
      return;
    }
    // "Nova frente…" is a door, not a destination: it hands the click to the
    // dialog that knows about branches and worktrees.
    if (destValue === NEW_FRONT && targetProject) {
      closeModal();
      openModal("new-floor", { projectId: targetProject.id });
      return;
    }
    // The notebook needs no project (it is global) and a board has none by
    // definition; the other tiles, inside a project, do, and for them the way
    // forward is the other dialog, which answers the click instead of
    // scolding it.
    if (!onBoard && !targetProject && recipient.kind !== "notes") {
      openModal("new-project");
      return;
    }

    // The notebook is not created — it already exists, globally. This tile
    // only *docks* it: the tab lands in the chosen pane, moving from wherever
    // it was. A board has no tab bar to receive it, so there the notebook
    // takes the centre instead, which is its other place.
    if (recipient.kind === "notes") {
      if (onBoard || !targetProject) {
        useNotes.getState().placeCenter();
        closeModal();
        return;
      }
      const target = groupFor();
      useNotes
        .getState()
        .dockTo(target, (target === payload?.groupId ? payload?.slot : undefined) ?? 0);
      goToTarget(target);
      closeModal();
      return;
    }

    // A browser has no process, no cwd and no flags: its whole commit is a row
    // in `browsersStore` — which also opens the engine when the pane mounts
    // the tab. With no address it opens blank, with the URL bar focused, which
    // is where an address was going to be typed anyway.
    if (recipient.kind === "browser") {
      // A browser tab belongs to a pane, and a board has none. Its browser is
      // the portal — a card on the board — and that is drawn from the board's
      // own toolbar, so the dialog points there instead of opening a tab
      // nobody would ever see.
      if (onBoard) {
        showToast(
          t("Num quadro o navegador é um portal: use a ferramenta de portal na barra do quadro."),
          "error",
        );
        return;
      }
      const target = groupFor();
      useBrowsers.getState().open({
        groupId: target,
        // Same rule as the CLI: the requested slot only counts in the pane
        // that asked; another group goes to its first pane.
        slot: (target === payload?.groupId ? payload?.slot : undefined) ?? 0,
      });
      // A browser tab is a tab: it belongs to a pane, not to the board (the
      // board's browser is a portal, which is another thing entirely).
      goToTarget(target);
      closeModal();
      return;
    }

    // On a board, the folder the user gave; inside a project, the chosen
    // destination's own folder: the front's worktree when a front is chosen,
    // the project's root otherwise.
    const folder = (onBoard ? boardFolder : cwdFor(dest, targetProject!.path)).trim();
    if (!folder) {
      showToast(
        onBoard
          ? t("Informe a pasta em que a CLI vai rodar.")
          : t(
              'O projeto "{name}" não tem pasta cadastrada — informe o caminho nas configurações do projeto.',
              { name: targetProject!.name },
            ),
        "error",
      );
      return;
    }

    setBusy(true);
    try {
      // The backend silently falls back to the home directory for a cwd that
      // does not exist, so the agent would end up editing files outside the
      // project while the UI kept showing the path that was configured.
      if (!(await ipc.isDirectory(folder))) {
        showToast(
          onBoard
            ? t('A pasta "{folder}" não existe.', { folder })
            : t('A pasta "{folder}" não existe — confira o caminho do projeto.', { folder }),
          "error",
        );
        return;
      }

      const agentId = recipient.kind === "agent" ? recipient.id : null;
      // The role only exists for an agent, and reaches it either as a flag on
      // this command line or as a message typed in once the CLI is up.
      const pick = defaultRoleOf(agentDefaults, agentId);
      const launch = roleLaunch(agentId, pick?.role);
      const title = titleFor(agentDefaults, agentId, recipient.label);

      // Only now, with everything checked, does anything get created.
      //
      // A worktree that git knows about and no front has opened yet becomes a
      // front on the spot: the folder is already there, so nothing is created
      // on the disk: the Yard only adopts it and the group is born pointing
      // at it. Without this the CLI would run in a worktree with no front,
      // and `rootOfGroup` would keep answering the project's root for it.
      const target =
        dest?.kind === "worktree" && dest.path && !onBoard
          ? (
              await createFloor({
                projectId: targetProject!.id,
                name: dest.branch ?? dest.label,
                adopt: { path: dest.path, branch: dest.branch ?? null },
                activate: false,
              })
            ).groupId
          : groupFor();
      const born = useAgentDefaults.getState().launchOf(agentId, {
        program: recipient.program,
        args: launch.args,
        cwd: folder,
      });
      // Born on the surface of the target group, which the store decides: a
      // card on a board, a tab in a project's group. Read back here only to
      // know whether there is a card to place.
      const surface = useProjects.getState().layoutOf(target).surface;
      const id = addTerminal({
        groupId: target,
        // Only honors the requested slot when the CLI is born in the same group
        // as the pane that asked.
        slot: target === payload?.groupId ? payload?.slot : undefined,
        program: born.program,
        args: born.args,
        cwd: folder,
        kind: recipient.kind,
        title,
        agentId,
      });
      // The point travels in the payload only when the canvas context menu
      // opened this: the menu sits *inside* the canvas, so walking down to
      // "Terminal" already moved the pointer off the spot being pointed at.
      if (surface === "canvas") {
        placeCard(
          target,
          id,
          payload?.x !== undefined && payload.y !== undefined && target === payload.groupId
            ? { x: payload.x, y: payload.y }
            : null,
        );
      }
      // After `placeCard`, which is what put the card in `nodes` for the tint
      // to land on. Through the external commit, like `placeCard` itself: the
      // two writes are one gesture, and a `Ctrl+Z` that undid half of it would
      // leave a role attached to a card back in an automatic slot.
      if (pick && surface === "canvas") {
        commitCanvasExternal(target, (c) => ({
          ...c,
          roles: { ...(c.roles ?? {}), [id]: pick.role },
          nodes:
            pick.color && c.nodes[id]
              ? { ...c.nodes, [id]: { ...c.nodes[id], color: pick.color } }
              : c.nodes,
        }));
      }
      // `alive: true` makes XTermView spawn as soon as it mounts.
      useProjects.getState().updateTerminal(id, { alive: true });
      // Waits for the CLI to be up and quiet on its own; the dialog must not
      // hang around for the seconds an agent takes to paint its banner.
      if (launch.briefing) void deliverBriefing(id, launch.briefing);
      goToTarget(target);
      closeModal();
    } catch (e) {
      showToast(t("Não consegui abrir: {e}", { e: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const loading = agents === null || shells === null;
  const noAgent =
    agents !== null && !agentsError && agents.every((a) => !a.installed);

  // With 8+ CLIs the flat grid was a wall of 12–16 equal tiles; the three
  // families give the eye (and the screen reader) somewhere to start.
  const familias: { title: string; items: Choice[] }[] = [
    { title: t("Agentes"), items: choices.filter((c) => c.kind === "agent") },
    { title: t("Shells"), items: choices.filter((c) => c.kind === "shell") },
    {
      title: t("Outros"),
      items: choices.filter((c) => c.kind === "browser" || c.kind === "notes"),
    },
  ].filter((f) => f.items.length > 0);

  /**
   * Arrows walk every tile — the unavailable ones included, because their
   * tooltip is where "not installed" is explained. Tab enters the grid once
   * (roving tabindex) instead of stopping on each of the 16 tiles; `Enter` and
   * `Space` are the button's own, and they open.
   */
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const tiles = [
      ...(gridRef.current?.querySelectorAll<HTMLElement>(".quick-tile") ?? []),
    ];
    if (tiles.length === 0) return;
    const at = tiles.indexOf(document.activeElement as HTMLElement);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    tiles[(Math.max(0, at) + delta + tiles.length) % tiles.length]?.focus();
  };

  return (
    <Modal
      title={t("Nova aba")}
      onClose={closeModal}
      wide
      // The first tile, so `Enter` opens what the eye is already on.
      initialFocus=".quick-tile"
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            {busy
              ? t("Abrindo…")
              : t(
                  "Um clique abre. Como cada CLI abre — flags, papel, nome — fica em Configurações › Agentes.",
                )}
          </span>
          <button
            className="btn btn--sm"
            onClick={() => openModal("preferences", "agentes")}
          >
            <Settings2 size={12} aria-hidden="true" /> {t("Configurar agentes")}
          </button>
        </div>
      }
    >
      {needsBoard && (
        <div className="hint new-term-noproject">
          <span>{t("No canvas, a CLI é um cartão de um quadro, e não há nenhum quadro ainda.")}</span>
          <button className="btn btn--sm" onClick={() => addBoard("")}>
            <Frame size={12} /> {t("Novo quadro")}
          </button>
        </div>
      )}
      {!canvasSide && projects.length === 0 && (
        <div className="hint new-term-noproject">
          <span>
            {t("Tudo aqui nasce dentro de um projeto (uma pasta do disco) — e ainda não há nenhum.")}
          </span>
          <button className="btn btn--sm" onClick={() => openModal("new-project")}>
            <FolderPlus size={12} /> {t("Adicionar projeto…")}
          </button>
        </div>
      )}

      <div className="option-list-head">
        {/* Where the tab is going to be born, said out loud. The dialog stopped
            asking everything else, so it owes this answer, and since a project
            grows branches and worktrees instead of folders, the answer is no
            longer inferable from the pane that asked. */}
        {onBoard ? (
          /* A board belongs to no project: the folder is typed or picked, and
             that is what lets one board hold cards from three folders at
             once, none of them a project. */
          <span className="new-term-where">
            {t("Abrir em")}
            <input
              className="new-term-folder"
              value={boardFolder}
              placeholder={t("pasta em que a CLI vai rodar")}
              aria-label={t("Pasta da CLI")}
              spellCheck={false}
              onChange={(e) => setBoardFolder(e.target.value)}
            />
            <button
              className="btn btn--sm"
              data-tip={t("Escolher uma pasta do disco")}
              onClick={() => void pickFolder()}
            >
              <FolderOpen size={12} aria-hidden="true" /> {t("Escolher…")}
            </button>
          </span>
        ) : targetProject ? (
          <span className="new-term-where">
            {t("Abrir em")}
            <Select
              value={destValue}
              label={t("Branch ou worktree")}
              // Only reachable with every group of the project deleted: the
              // ground is gone and there is nothing to be born beside yet.
              placeholder={t("Escolha onde")}
              tip={t("Onde a CLI vai rodar: o chão do projeto, na branch dele, ou uma frente")}
              options={destinations.map((d) => ({
                value: d.value,
                label: d.label,
                group: d.heading,
              }))}
              onChange={setDestPicked}
            />
          </span>
        ) : (
          <span>{loadingAgents ? t("Procurando CLIs…") : t("Início rápido")}</span>
        )}
        <button
          className={`icon-btn ${loadingAgents ? "is-busy" : ""}`}
          data-tip={t("Detectar de novo")}
          aria-label={t("Detectar CLIs de novo")}
          onClick={() => detect(true)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div
        ref={gridRef}
        className="quick-grid"
        aria-label={t("O que vai rodar")}
        aria-busy={busy}
        onKeyDown={onGridKey}
      >
        {loading
          ? [0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="quick-tile quick-tile--skeleton" />
            ))
          : familias.map((f, fi) => (
              <div className="quick-grid-familia" key={f.title} role="presentation">
                <div className="quick-grid-sect">{f.title}</div>
                {f.items.map((c, i) => (
                  <button
                    key={`${c.kind}:${c.id}`}
                    type="button"
                    data-choice={`${c.kind}:${c.id}`}
                    // One Tab stop for the whole grid; the arrows do the rest.
                    tabIndex={fi === 0 && i === 0 ? 0 : -1}
                    // `aria-disabled`, not `disabled`: a CLI that is not
                    // installed still has something to say (it says why), and a
                    // truly disabled button answers no hover and no focus.
                    aria-disabled={!c.available}
                    className={`quick-tile ${c.available ? "" : "is-off"}`}
                    data-tip-wrap=""
                    data-tip={t(c.detail)}
                    onClick={() => void createIt(c)}
                  >
                    <ChoiceMark choice={c} />
                    <span className="quick-tile-label">{t(c.label)}</span>
                  </button>
                ))}
              </div>
            ))}
      </div>

      {shellsError && (
        <p className="hint hint--error">
          {t("Não consegui listar os shells desta máquina: {error}", { error: shellsError })}
        </p>
      )}
      {agentsError && (
        <p className="hint hint--error">
          {t("A detecção falhou: {error}. Clique em detectar de novo.", { error: agentsError })}
        </p>
      )}
      {noAgent && (
        <p className="hint">
          {t("Nenhuma CLI de agente encontrada no PATH nem nas pastas do npm. Instale uma (ex.: ")}
          <code>npm i -g @anthropic-ai/claude-code</code>
          {t(") e clique em detectar de novo.")}
        </p>
      )}
    </Modal>
  );
}
