/**
 * "Nova aba": pick what the tab will be, then say the little that has to be
 * said. Mostly that is a CLI — but the grid is "what this tab can be", not
 * "which terminal": the embedded browser lives here too, and whatever other
 * kinds of tab the pane learns later should land in this same grid instead
 * of growing dialogs of their own.
 *
 * The dialog used to be a list of CLIs where **clicking a row created the
 * terminal**, with everything configurable crammed into a footer strip. That
 * made the fast path fast and everything else awkward: the row was both the
 * choice and the commit, so there was no moment in between to name the thing,
 * give it a role, or read the flags you had just typed.
 *
 * So the two halves separated. On top, a grid of marks — every CLI this
 * machine has, plus the shells — where one click only *chooses*. Below, the
 * few fields that matter, split in two tabs so the dialog stays one screen
 * tall. Creating is the button in the footer (or `Enter`, or a double click on
 * the mark, for whoever just wants the same one as always).
 *
 * Opening from a pane's "+" sends `groupId`/`slot` in the payload: the CLI is
 * born where the user clicked, not always in pane 0.
 *
 * Everything the dialog creates happens **after** every check passes. The
 * order matters: creating the group first and validating afterwards left a
 * stray empty group behind on each failed attempt.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  FolderOpen,
  FolderPlus,
  Globe,
  NotebookPen,
  RefreshCw,
  Terminal as TerminalIcon,
} from "lucide-react";

import { ArgsField } from "./ArgsField";
import { Modal } from "./Modal";
import { RoleField } from "./RoleField";
import { BrandIcon } from "../BrandIcon";
import { Select } from "../Select";
import { hasFlag, skipFlagOf, tokenizeArgs, withFlag } from "../../lib/termArgs";
import { brandById } from "../../lib/brands";
import { commitCanvasExternal, placeCard } from "../../lib/canvasWrite";
import { ipc, type AgentInfo, type ShellOption } from "../../lib/ipc";
import { isSupportedPortalUrl } from "../../lib/portals";
import { deliverBriefing } from "../../lib/roleBrief";
import { LAUNCH_HINT_ANY, roleLaunch, type RolePick } from "../../lib/roles";
import { useBrowsers } from "../../stores/browsersStore";
import { useNotes } from "../../stores/notesStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

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
 */
interface Choice {
  kind: "shell" | "agent" | "browser" | "notes";
  /** Catalog id — what `brandById` and the skip-permissions flag are keyed by. */
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
  label: "Navegador",
  program: "",
  detail: "página embutida na barra de abas — o mesmo motor dos portais",
  available: true,
};

const NOTES: Choice = {
  kind: "notes",
  id: "notes",
  label: "Anotações",
  program: "",
  detail: "o caderno de notas markdown vira uma aba deste painel",
  available: true,
};

function ChoiceMark({ choice }: { choice: Choice }) {
  if (choice.kind === "browser") return <Globe size={19} />;
  if (choice.kind === "notes") return <NotebookPen size={19} />;
  const brand = brandById(choice.id);
  if (brand) return <BrandIcon brand={brand} size={19} />;
  return choice.kind === "agent" ? <Bot size={19} /> : <TerminalIcon size={19} />;
}

/** Sentinel of the "Onde abrir" selector: create a group instead of reusing one. */
const NEW_GROUP = "__novo-grupo__";

export function NewTerminalModal() {
  const closeModal = useUI((s) => s.closeModal);
  const openModal = useUI((s) => s.openModal);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const addTerminal = useProjects((s) => s.addTerminal);
  const addGroup = useProjects((s) => s.addGroup);
  const projectOfGroup = useProjects((s) => s.projectOfGroup);

  const [shells, setShells] = useState<ShellOption[] | null>(null);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);

  const [choice, setChoice] = useState<Choice | null>(null);
  const [tab, setTab] = useState<"detalhes" | "papel">("detalhes");
  const [itemName, setName] = useState("");
  const [groupId, setGroupId] = useState(
    payload?.groupId ?? activeGroupId ?? NEW_GROUP,
  );
  const [extraArgs, setExtraArgs] = useState("");
  const [cwdOverride, setCwdOverride] = useState("");
  /** Address of a browser tab. Empty = blank page with the URL bar focused. */
  const [urlNav, setUrlNav] = useState("");
  /** The responsibility this CLI is born with. Agents only — a shell has none. */
  const [role, setRole] = useState<RolePick | null>(null);
  /** Locks the dialog while `is_directory` and the spawn resolve. */
  const [busy, setBusy] = useState(false);
  /**
   * Field errors under the field, not in a toast: whoever is typing looks at
   * the input, and the notice at the window's foot died unread.
   */
  const [err, setError] = useState<{
    field: "cwd" | "url" | "destino";
    msg: string;
  } | null>(null);
  const cwdRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // `NOVO_GRUPO` is a choice, not an id: the group only exists once the dialog
  // commits, and creating it up front left an empty group behind on every
  // attempt that failed a check.
  const group = groupId === NEW_GROUP ? undefined : groups.find((g) => g.id === groupId);
  /**
   * Where the CLI will be born. With a group selected it is that group's
   * project; without one (the project lost its last group) it falls back to
   * the project the user is looking at — `projects[0]` used to be the
   * fallback, which could open the terminal in a project nobody was in.
   */
  const targetProject =
    (group ? projectOfGroup(group.id) : undefined) ??
    projects.find((p) => p.id === activeProjectId) ??
    projects[0];
  const cwd = cwdOverride || targetProject?.path || "";

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

  // Detection runs on open, not on a tab switch: the agents *are* the grid
  // now, and a dialog that shows the shells first and the CLIs a beat later
  // would move under the pointer.
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
      detail: a.installed
        ? (a.version ?? a.bin ?? "")
        : "não instalado — instale a CLI e detecte de novo",
      available: a.installed,
    });
    const fromShell = (s: ShellOption): Choice => ({
      kind: "shell",
      id: s.id,
      label: s.label,
      program: s.program,
      detail: s.available ? s.program : "não encontrado nesta máquina",
      available: s.available,
    });
    // Agents first, and within each family what can actually run comes first:
    // the grid is read left to right, and a dead tile in the first slot is a
    // dead first impression.
    const sortBy = (list: Choice[]) =>
      [...list].sort((a, b) => Number(b.available) - Number(a.available));
    return [
      ...sortBy((agents ?? []).map(byAgent)),
      ...sortBy((shells ?? []).map(fromShell)),
      // Last, after everything that runs: these are the tiles that are not
      // processes, and the grid reads left to right as "agents, shells, the rest".
      BROWSER,
      NOTES,
    ];
  }, [agents, shells]);

  // First usable mark, once both lists have landed. Preselecting is what keeps
  // the old one-gesture speed: open, `Enter`, done.
  useEffect(() => {
    if (choice || agents === null || shells === null) return;
    setChoice(choices.find((c) => c.available) ?? null);
  }, [choices, choice, agents, shells]);

  /**
   * Where the CLI can be born.
   *
   * The list used to be every group of every project, flat — so picking one
   * could move the terminal (and its working directory) to a project the user
   * was not in, with nothing but a prefix in the label saying so. Now the
   * project in view comes first, under its own heading, and the rest sits
   * below it as an explicit choice. "(criar novo grupo)" is always there:
   * before, it only appeared when the workspace had no group at all.
   */
  const destinations = useMemo(() => {
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "—";
    const ofProject = groups.filter((g) => g.projectId === activeProjectId);
    const others = groups.filter((g) => g.projectId !== activeProjectId);
    return [
      ...ofProject.map((g) => ({
        value: g.id,
        label: g.name,
        group: projectName(g.projectId),
      })),
      { value: NEW_GROUP, label: "Criar um grupo novo", group: ofProject.length ? projectName(activeProjectId ?? "") : "Novo" },
      ...others.map((g) => ({
        value: g.id,
        label: `${projectName(g.projectId)} › ${g.name}`,
        group: "Outros projetos",
      })),
    ];
  }, [groups, projects, activeProjectId]);

  /**
   * The field is a command line, so quotes group:
   * `--append-system-prompt "seja breve"` is two arguments, not three. A plain
   * split on whitespace handed the CLI `"seja` and `breve"`, and it died in
   * the PTY with a usage error nothing on screen connected to this field.
   */
  const parsedArgs = useMemo(() => tokenizeArgs(extraArgs), [extraArgs]);

  // The "skip the prompts" flag of the CLI that was chosen, and of no other:
  // it is what the checkbox in the arguments field ticks. Null for a shell,
  // and for an agent with no such flag — the checkbox simply does not appear.
  const skipFlag = useMemo(
    () =>
      choice && (choice.kind === "shell" || choice.kind === "agent")
        ? skipFlagOf(choice.kind, choice.id)
        : null,
    [choice],
  );

  const choose = (c: Choice) => {
    // That checkbox lives inside the arguments text, and each CLI spells the
    // flag differently. Switching mark with the box ticked has to swap the
    // spelling, or Codex would be born carrying Claude's flag and die on an
    // unknown option before printing a thing.
    const after =
      c.kind === "shell" || c.kind === "agent" ? skipFlagOf(c.kind, c.id) : null;
    if (skipFlag && skipFlag !== after && hasFlag(extraArgs, skipFlag.args)) {
      const stripped = withFlag(extraArgs, skipFlag.args, false);
      setExtraArgs(after ? withFlag(stripped, after.args, true) : stripped);
    }
    setChoice(c);
    // A shell has nobody to give a role to; staying on that tab would leave
    // the dialog showing a control that does not apply to what is selected.
    if (c.kind !== "agent") setTab("detalhes");
  };

  /**
   * Takes the screen to where the tab was born.
   *
   * "Onde abrir" may point at another group — and without this the dialog
   * closed leaving the user exactly where they were, with nothing on screen
   * showing that something had been created. Creating a new group already
   * activated the group; picking an existing one did not.
   */
  const goToTarget = (targetId: string) => {
    if (useProjects.getState().activeGroupId !== targetId) {
      useProjects.getState().setActiveGroup(targetId);
    }
  };

  const pickFolder = async () => {
    const chosen = await open({ directory: true, multiple: false });
    if (typeof chosen === "string") {
      setCwdOverride(chosen);
      if (err?.field === "cwd") setError(null);
    }
  };

  /**
   * `alvo` defaults to what is selected, but the double click passes its own
   * tile: `setEscolha` has not reached this closure yet at that point, and
   * without it a double click created whatever was selected *before*.
   */
  const createIt = async (recipient: Choice | null = choice) => {
    if (busy || !recipient) return;
    // The notebook needs no project (it is global) — the other tiles do, and
    // for them the way forward is the other dialog, which answers the click
    // instead of scolding it.
    if (!targetProject && recipient.kind !== "notes") {
      openModal("new-project");
      return;
    }

    // The notebook is not created — it already exists, globally. This tile
    // only *docks* it: the tab lands in the chosen pane, moving from
    // wherever it was. A canvas-mode group has no tab bar to receive it.
    if (recipient.kind === "notes") {
      const projectsState = useProjects.getState();
      // The notebook is global and already exists: with no project at all
      // there is no pane to dock it in, but there is the notebook — opening
      // it as an overlay answers the click instead of demanding a folder be
      // registered that it does not even use.
      if (!targetProject) {
        useNotes.getState().setPlaceKind("overlay");
        useNotes.getState().openView();
        closeModal();
        return;
      }
      if (group && projectsState.layoutOf(group.id).mode === "canvas") {
        setError({
          field: "destino",
          msg: "Esse grupo está no modo canvas, que não tem barra de abas — troque o layout ou escolha outro grupo em “Onde abrir”.",
        });
        return;
      }
      const target = group?.id ?? addGroup(targetProject.id);
      useNotes
        .getState()
        .dockTo(target, (target === payload?.groupId ? payload?.slot : undefined) ?? 0);
      goToTarget(target);
      closeModal();
      return;
    }

    // A browser has no process, no cwd and no flags: its whole commit is a
    // row in `browsersStore` — which also opens the engine when the pane
    // mounts the tab. Checked before anything is created, same rule as below.
    if (recipient.kind === "browser") {
      if (urlNav.trim() && !isSupportedPortalUrl(urlNav)) {
        setError({
          field: "url",
          msg: "Um navegador abre páginas http/https. Endereços como file: não são suportados.",
        });
        urlRef.current?.focus();
        return;
      }
      const target = group?.id ?? addGroup(targetProject.id);
      const browsers = useBrowsers.getState();
      const id = browsers.open({
        groupId: target,
        // Same rule as the CLI: the requested slot only counts in the pane
        // that asked; another group goes to its first pane.
        slot: (target === payload?.groupId ? payload?.slot : undefined) ?? 0,
        url: urlNav.trim() || undefined,
      });
      if (itemName.trim()) browsers.patch(id, { name: itemName.trim() });
      goToTarget(target);
      closeModal();
      return;
    }

    const folder = (cwdOverride.trim() || targetProject.path).trim();
    if (!folder) {
      setError({ field: "cwd", msg: "Sem pasta de trabalho: cadastre o caminho do projeto." });
      cwdRef.current?.focus();
      return;
    }

    setBusy(true);
    try {
      // The backend silently falls back to the home directory for a cwd that
      // does not exist, so the agent would end up editing files outside the
      // project while the UI kept showing the path that was typed.
      if (!(await ipc.isDirectory(folder))) {
        setError({ field: "cwd", msg: `A pasta "${folder}" não existe — confira o caminho.` });
        cwdRef.current?.focus();
        return;
      }

      // The role only exists for an agent, and reaches it either as a flag on
      // this command line or as a message typed in once the CLI is up.
      const pick = recipient.kind === "agent" ? role : null;
      const launch = roleLaunch(recipient.kind === "agent" ? recipient.id : null, pick?.role);
      const title = itemName.trim() || recipient.label;

      // Only now, with everything checked, does anything get created.
      // `group`, not `groupId`: the selected id can be stale (the group was
      // deleted while the dialog sat open), and adding a terminal to a group
      // that no longer exists makes it invisible everywhere.
      const target = group?.id ?? addGroup(targetProject.id);
      const id = addTerminal({
        groupId: target,
        // Only honors the requested slot when the CLI is born in the same group
        // as the pane that asked; switching group in the selector goes to the full pane.
        slot: target === payload?.groupId ? payload?.slot : undefined,
        program: recipient.program,
        // The role's flag goes before what was typed by hand, so a repeated
        // flag in the free field is the one the CLI reads last.
        args: [...launch.args, ...parsedArgs],
        cwd: folder,
        kind: recipient.kind,
        title,
        agentId: recipient.kind === "agent" ? recipient.id : null,
      });
      // The point travels in the payload only when the canvas context menu
      // opened this: the menu sits *inside* the canvas, so walking down to
      // "Terminal" already moved the pointer off the spot being pointed at.
      // Every other opener (Ctrl+T, the title bar, the palette) has no point
      // of its own and lets the canvas answer with the live cursor.
      placeCard(
        target,
        id,
        payload?.x !== undefined && payload.y !== undefined && target === payload.groupId
          ? { x: payload.x, y: payload.y }
          : null,
      );
      // After `placeCard`, which is what put the card in `nodes` for the tint
      // to land on. A card with no entry there is in an automatic slot and
      // keeps the default frame.
      // Through the external commit, like `placeCard` just above: the two
      // writes are one gesture, and a `Ctrl+Z` that undid half of it would
      // leave a role attached to a card back in an automatic slot.
      if (pick) {
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
    { title: "Agentes", items: choices.filter((c) => c.kind === "agent") },
    { title: "Shells", items: choices.filter((c) => c.kind === "shell") },
    {
      title: "Outros",
      items: choices.filter((c) => c.kind === "browser" || c.kind === "notes"),
    },
  ].filter((f) => f.items.length > 0);

  /**
   * Arrows walk every tile — the unavailable ones included, because their
   * tooltip is where "not installed" is explained — and select the ones that
   * can run, as `role="radio"` promises. Tab enters the grid once (roving
   * tabindex) instead of stopping on each of the 16 tiles.
   */
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const tiles = [
      ...(gridRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []),
    ];
    if (tiles.length === 0) return;
    const currentValue = tiles.indexOf(document.activeElement as HTMLElement);
    const base =
      currentValue >= 0
        ? currentValue
        : Math.max(0, tiles.findIndex((t) => t.getAttribute("aria-checked") === "true"));
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const target = tiles[(base + delta + tiles.length) % tiles.length];
    target.focus();
    const chosen = choices.find(
      (c) => `${c.kind}:${c.id}` === target.dataset.choice,
    );
    if (chosen?.available) choose(chosen);
  };

  return (
    <Modal
      title="Nova aba"
      onClose={closeModal}
      wide
      dirty={
        !!itemName.trim() ||
        !!extraArgs.trim() ||
        !!cwdOverride.trim() ||
        !!urlNav.trim() ||
        role !== null
      }
      // Typing names the terminal and `Enter` opens it, which is the whole
      // dialog for whoever already knows what they want.
      initialFocus="#novo-term-nome"
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <span className="new-term-summary">
            {choice
              ? `${choice.label} em ${targetProject?.name ?? "—"}`
              : "Escolha o que vai rodar"}
          </span>
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !choice}
            onClick={() => void createIt()}
          >
            {busy ? "Abrindo…" : "Criar"}
          </button>
        </div>
      }
    >
      {projects.length === 0 && (
        <div className="hint new-term-noproject">
          <span>
            Tudo aqui nasce dentro de um projeto (uma pasta do disco) — e ainda
            não há nenhum.
          </span>
          <button className="btn btn--sm" onClick={() => openModal("new-project")}>
            <FolderPlus size={12} /> Adicionar projeto…
          </button>
        </div>
      )}

      <div className="option-list-head">
        <span>{loadingAgents ? "Procurando CLIs…" : "Início rápido"}</span>
        <button
          className={`icon-btn ${loadingAgents ? "is-busy" : ""}`}
          data-tip="Detectar de novo"
          aria-label="Detectar CLIs de novo"
          onClick={() => detect(true)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div
        ref={gridRef}
        className="quick-grid"
        role="radiogroup"
        aria-label="O que vai rodar"
        onKeyDown={onGridKey}
      >
        {loading
          ? [0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="quick-tile quick-tile--skeleton" />
            ))
          : familias.map((f) => (
              <div className="quick-grid-familia" key={f.title} role="presentation">
                <div className="quick-grid-sect">{f.title}</div>
                {f.items.map((c) => {
                  const isActive = choice?.id === c.id && choice.kind === c.kind;
                  return (
                    <button
                      key={`${c.kind}:${c.id}`}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      data-choice={`${c.kind}:${c.id}`}
                      // One Tab stop for the whole grid; the arrows do the rest.
                      tabIndex={
                        isActive || (!choice && c === choices[0]) ? 0 : -1
                      }
                      // `aria-disabled`, not `disabled`: a CLI that is not
                      // installed still has something to say (it says why), and a
                      // truly disabled button answers no hover and no focus.
                      aria-disabled={!c.available}
                      className={`quick-tile ${isActive ? "is-active" : ""} ${
                        c.available ? "" : "is-off"
                      }`}
                      data-tip-wrap=""
                      data-tip={`${c.detail}${c.available ? "\nDuplo clique abre direto" : ""}`}
                      onClick={() => c.available && choose(c)}
                      onDoubleClick={() => {
                        if (!c.available) return;
                        choose(c);
                        void createIt(c);
                      }}
                    >
                      <ChoiceMark choice={c} />
                      <span className="quick-tile-label">{c.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
      </div>

      {shellsError && (
        <p className="hint hint--error">
          Não consegui listar os shells desta máquina: {shellsError}
        </p>
      )}
      {agentsError && (
        <p className="hint hint--error">
          A detecção falhou: {agentsError}. Clique em detectar de novo.
        </p>
      )}
      {noAgent && (
        <p className="hint">
          Nenhuma CLI de agente encontrada no PATH nem nas pastas do npm. Instale
          uma (ex.: <code>npm i -g @anthropic-ai/claude-code</code>) e clique em
          detectar de novo.
        </p>
      )}

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "detalhes"}
          className={tab === "detalhes" ? "is-active" : ""}
          onClick={() => setTab("detalhes")}
        >
          Detalhes
        </button>
        <button
          role="tab"
          aria-selected={tab === "papel"}
          className={tab === "papel" ? "is-active" : ""}
          // A shell takes no role. The tab stays in place instead of
          // disappearing: a strip that loses a segment when you pick pwsh
          // reflows everything under it.
          disabled={choice?.kind !== "agent"}
          onClick={() => setTab("papel")}
        >
          Papel {role && <span className="tab-dot" aria-hidden="true" />}
        </button>
      </div>

      {tab === "detalhes" ? (
        <div
          className="form"
          onKeyDown={(e) => {
            // Enter submits from any field of the form — the checkbox
            // included, which answers to Space, not to Enter.
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              void createIt();
            }
          }}
        >
          <label htmlFor="novo-term-nome">
            {choice?.kind === "browser" || choice?.kind === "notes"
              ? "Nome da aba"
              : "Nome do terminal"}
            <input
              id="novo-term-nome"
              value={choice?.kind === "notes" ? "" : itemName}
              // There is one notebook and it already has a name — the field
              // stays (no reflow when switching tiles) but has nothing to say.
              disabled={choice?.kind === "notes"}
              placeholder={
                choice?.kind === "notes"
                  ? "a aba se chama Anotações"
                  : choice?.kind === "browser"
                    ? "título da página (padrão)"
                    : choice
                      ? `${choice.label} (padrão)`
                      : "opcional"
              }
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="form-row">
            <label>
              Onde abrir
              <Select
                value={groupId}
                options={destinations}
                onChange={(v) => {
                  setGroupId(v);
                  if (err?.field === "destino") setError(null);
                }}
              />
            </label>
            {choice?.kind === "notes" ? (
              // The notebook is global — no address, no folder. The spot in
              // the form says what the tile does instead of sitting empty.
              <label className="grow">
                O que acontece
                <input
                  value=""
                  disabled
                  placeholder="o caderno (e o que já está escrito nele) vira uma aba do painel"
                  readOnly
                />
              </label>
            ) : choice?.kind === "browser" ? (
              // A page has an address where a process has a folder — the
              // same spot in the form, so switching tiles does not reflow.
              <label className="grow">
                Endereço
                <input
                  ref={urlRef}
                  value={urlNav}
                  spellCheck={false}
                  placeholder="http://localhost:5173, exemplo.com… — vazio abre em branco"
                  aria-invalid={err?.field === "url" ? true : undefined}
                  aria-describedby={err?.field === "url" ? "nova-aba-erro" : undefined}
                  onChange={(e) => {
                    setUrlNav(e.target.value);
                    if (err?.field === "url") setError(null);
                  }}
                />
              </label>
            ) : (
              <label className="grow">
                Diretório de trabalho
                <div className="input-row">
                  <input
                    ref={cwdRef}
                    value={cwd}
                    placeholder="pasta do projeto"
                    aria-invalid={err?.field === "cwd" ? true : undefined}
                    aria-describedby={err?.field === "cwd" ? "nova-aba-erro" : undefined}
                    onChange={(e) => {
                      setCwdOverride(e.target.value);
                      if (err?.field === "cwd") setError(null);
                    }}
                  />
                  <button className="btn" onClick={() => void pickFolder()}>
                    <FolderOpen size={13} /> Procurar
                  </button>
                </div>
              </label>
            )}
          </div>
          {err && (
            <p className="hint hint--error" id="nova-aba-erro" role="alert">
              {err.msg}
            </p>
          )}

          {choice?.kind !== "browser" && choice?.kind !== "notes" && (
            <ArgsField value={extraArgs} onChange={setExtraArgs} skip={skipFlag} />
          )}
        </div>
      ) : (
        <RoleField
          groupId={group?.id ?? null}
          hint={LAUNCH_HINT_ANY}
          value={role}
          onChange={setRole}
        />
      )}
    </Modal>
  );
}
