import "./palette.css";

/**
 * Busca (`Ctrl+P`) — one box over everything that finds anything.
 *
 * Yard grew a lot of places to be: agents in several groups, floors with their
 * own canvas, notes, portals, changed files, saved prompts, a dozen panels
 * behind shortcuts. Past a certain size, *knowing where a thing is* becomes
 * the actual work — and that is what this replaces.
 *
 * What it searches is deliberately the whole workspace, not the active group:
 * "onde está o codex que ficou na frente da api" is the question worth
 * answering. Prefixes narrow it when you already know the kind:
 * `>` actions, `@` agents, `#` canvas, `/` files, `$` what the terminals
 * printed. The last one is the only source that is not in memory: it sweeps
 * the scrollbacks on the disk through `search_scrollback`, which is why it
 * lives behind a prefix and never joins the unprefixed hunt.
 *
 * Nothing here owns state. Every row ends in a call that some store already
 * exposes — the Busca is a **way in**, never a second way to do things.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Boxes,
  CircleDot,
  Eye,
  FileText,
  Folder,
  FolderTree,
  Globe,
  Group,
  Image as ImageIcon,
  NotebookTabs,
  Layers,
  ListTodo,
  NotebookPen,
  Radio,
  Braces,
  ScrollText,
  Search,
  SquareTerminal,
  StickyNote,
  Zap,
} from "lucide-react";

import {
  emptyReason,
  fieldsOf,
  parseQuery,
  restingOrder,
  sectionsOf,
  SCOPES,
  type EntryKind,
  type PaletteEntry,
} from "./model";
import { FileGlyph } from "../FileGlyph";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { noteName, portalName } from "../../lib/canvas";
import { mediaNodeName } from "../../lib/mediaNode";
import { treeNodeName } from "../../lib/treeNode";
import { isTopLayer } from "../../lib/layers";
import { toggleBroadcast } from "../../lib/broadcastToggle";
import { goToCanvasItem, goToTerminal, show, toggleCanvas } from "../../lib/navigate";
import { requestQuit } from "../../lib/quit";
import { checkForUpdates } from "../../lib/updateFlow";
import { useBroadcast } from "../../stores/broadcastStore";
import {
  fallbackTitle,
  notebookPath,
  STATUS_META,
  type Note,
  type Notebook,
} from "../../lib/notes";
import { fileName } from "../../lib/paths";
import { spawnPortalNear } from "../../lib/portalSpawn";
import { rank } from "../../lib/search";
import {
  hitRows,
  searchOrder,
  worthSearching,
  PER_TERMINAL,
  TOTAL_HITS,
} from "../../lib/outputSearch";
import {
  MAX_WORKSPACE_SYMBOLS,
  readWorkspaceSymbols,
  type WorkspaceSymbolRow,
} from "../../lib/lsp/workspaceSymbols";
import { sameRoot } from "../../lib/roots";
import { useLsp } from "../../stores/lspStore";
import { openOutputHit } from "../../lib/outputOpen";
import { writeTodaysJournal } from "../../lib/journalFlow";
import { ipc, type TerminalHits, type TerminalRow } from "../../lib/ipc";
import { baseName } from "../../lib/terminals";
import { exportTerminalOutput } from "../../lib/termExportFlow";
import { useAdvertised } from "../../stores/advertisedStore";
import { openTranscriptFor } from "../../lib/transcriptOpen";
import { hasSessions } from "../../stores/agentsStore";
import { dueLabel, useBench } from "../../stores/benchStore";
import { useBrowsers } from "../../stores/browsersStore";
import { useChanges } from "../../stores/changesStore";
import { useEditor } from "../../stores/editorStore";
import { useLive } from "../../stores/liveStore";
import { useNotes } from "../../stores/notesStore";
import { useProjects, type LayoutMode } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useAutoBackup } from "../../stores/autoBackupStore";
import { useCosts } from "../../stores/costsStore";
import { useUI } from "../../stores/uiStore";
import { toggledTheme } from "../../lib/theme";
import { resolvedTheme } from "../../stores/themeStore";
import { useT } from "../../hooks/useT";
import { locale, t } from "../../lib/i18n";

/** Rows painted at once. Past this nobody is reading, they are re-typing. */
const CAP = 40;
/** Per kind, so one noisy source cannot flood the list. */
const CAP_BY_KIND = 12;
/** Quick-open candidates fed to the ranking — see where the index is added. */
const INDEX_CAP = 6000;

export function Palette() {
  const open = useUI((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const seed = useUI((s) => s.paletteSeed);
  const close = useUI((s) => s.closePalette);
  const [query, setQuery] = useState(seed);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogFocus(dialogRef, true, "busca");

  // Subscriptions, not `getState()`: a card that starts running while the box
  // is open has to change its dot without a keystroke.
  //
  // `runtimes` also carries the RAM/CPU tick, so the rows are rebuilt every
  // couple of seconds while the box is open. Left as is on purpose: the list
  // is a few hundred plain objects, and filtering the subscription down to
  // "state only" would buy microseconds at the price of a staleness bug.
  const projects = useProjects((s) => s.projects);
  const groups = useProjects((s) => s.groups);
  const terminals = useProjects((s) => s.terminals);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const runtimes = useTerminals((s) => s.byId);
  const gitByProject = useChanges((s) => s.gitByProject);
  const liveByProject = useChanges((s) => s.liveByProject);
  const dirs = useEditor((s) => s.dirs);
  const fileIndex = useEditor((s) => s.fileIndex);
  const prompts = useBench((s) => s.prompts);
  const tasks = useBench((s) => s.tasks);
  const served = useAdvertised((s) => s.byTerminal);
  const focusedTerminalId = useUI((s) => s.focusedTerminalId);
  const memos = useNotes((s) => s.notes);
  const memoBooks = useNotes((s) => s.notebooks);
  const t = useT();
  // The rows carry translated titles, so the language is one of their inputs.
  const lang = locale();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // The quick-open index is built (or refreshed) when the box opens — not
    // on the watcher's schedule. By the second keystroke it is usually in.
    void useEditor.getState().ensureFileIndex();
  }, []);

  const entries = useMemo(
    () =>
      buildEntries({
        projects,
        groups,
        terminals,
        activeGroupId,
        activeProjectId,
        runtimes,
        gitByProject,
        liveByProject,
        dirs,
        fileIndex,
        prompts,
        tasks,
        served,
        focusedTerminalId,
        memos,
        memoBooks,
      }),
    [
      projects,
      groups,
      terminals,
      activeGroupId,
      activeProjectId,
      runtimes,
      gitByProject,
      liveByProject,
      dirs,
      fileIndex,
      prompts,
      tasks,
      served,
      focusedTerminalId,
      memos,
      memoBooks,
      lang,
    ],
  );

  const { scope, text } = parseQuery(query);
  const wantsOutput = scope?.kinds.includes("output") ?? false;
  const wantsSymbols = scope?.kinds.includes("symbol") ?? false;

  // --- what the terminals said ($) -----------------------------------------
  // Asynchronous, debounced, and only under the prefix: every keystroke here
  // reads up to 8 MB per terminal off the disk.
  const [outputHits, setOutputHits] = useState<TerminalHits[]>([]);
  const [sweeping, setSweeping] = useState(false);

  useEffect(() => {
    if (!wantsOutput || !worthSearching(text)) {
      setOutputHits([]);
      setSweeping(false);
      return;
    }
    setSweeping(true);
    let alive = true;
    const timer = window.setTimeout(() => {
      const ids = searchOrder(terminals, activeGroupId, focusedTerminalId);
      void ipc
        .searchScrollback(ids, text.trim(), PER_TERMINAL, TOTAL_HITS)
        .then((answer) => {
          if (!alive) return;
          setOutputHits(answer);
          setSweeping(false);
        })
        .catch(() => {
          if (!alive) return;
          setOutputHits([]);
          setSweeping(false);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // `terminals` on purpose and nothing else from the workspace: the sweep is
    // driven by what was typed, not by a card changing colour mid-search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsOutput, text]);

  // --- declarations anywhere in the project (:) ----------------------------
  // Asked of the servers that are **already running** for this root. Typing a
  // colon must not start a `rust-analyzer`: the point of the prefix is to
  // reach what is there, not to make the palette expensive.
  const [symbolRows, setSymbolRows] = useState<WorkspaceSymbolRow[]>([]);
  const [askingServers, setAskingServers] = useState(false);

  useEffect(() => {
    const query = text.trim();
    if (!wantsSymbols || query.length < 2) {
      setSymbolRows([]);
      setAskingServers(false);
      return;
    }
    setAskingServers(true);
    let alive = true;
    const timer = window.setTimeout(() => {
      const root = useEditor.getState().root;
      const clients = Object.values(useLsp.getState().clients).filter(
        (entry) => root && sameRoot(entry.root, root),
      );
      if (!root || clients.length === 0) {
        setSymbolRows([]);
        setAskingServers(false);
        return;
      }
      void Promise.all(
        clients.map((entry) =>
          entry.client
            .request<{ query: string }, unknown>("workspace/symbol", { query })
            .catch(() => null),
        ),
      ).then((replies) => {
        if (!alive) return;
        // Two servers can both answer for one root (a TS and a CSS server in
        // the same project); their lists are simply appended.
        const rows = replies.flatMap((reply) => readWorkspaceSymbols(reply, root));
        setSymbolRows(rows.slice(0, MAX_WORKSPACE_SYMBOLS));
        setAskingServers(false);
      });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [wantsSymbols, text]);

  const symbolEntries = useMemo(
    () =>
      symbolRows.map<PaletteEntry>((row, i) => ({
        id: `symbol:${row.path}:${row.line}:${row.name}:${i}`,
        kind: "symbol",
        title: row.container ? `${row.container}.${row.name}` : row.name,
        subtitle: t("{path} · linha {line}", { path: row.path, line: row.line }),
        icon: <Braces size={14} />,
        run: () => void useEditor.getState().openFileAt(row.path, row.line),
      })),
    [symbolRows, t],
  );

  const outputEntries = useMemo(() => {
    const nameOf = (id: string) => {
      const row = terminals.find((term) => term.id === id);
      return row ? baseName(row) : undefined;
    };
    return hitRows(outputHits, nameOf).map<PaletteEntry>((row) => ({
      id: `output:${row.id}`,
      kind: "output",
      title: row.title,
      subtitle: t("{name} · linha {line}", { name: row.name, line: row.line }),
      icon: <ScrollText size={14} />,
      run: () => openOutputHit(row),
    }));
  }, [outputHits, terminals]);

  const results = useMemo(() => {
    // The backend already matched these rows and answered in priority order;
    // ranking a raw terminal line against the query a second time only buries
    // the long lines. See RANKED_SCOPES in `model.ts`.
    if (wantsOutput) return outputEntries;
    // Same reasoning: the servers matched and ordered these already.
    if (wantsSymbols) return symbolEntries;
    const pool = scope
      ? entries.filter((e) => scope.kinds.includes(e.kind))
      : entries;
    const ranked = text
      ? rank(text, pool, fieldsOf, { weightOf: (e) => e.weight ?? 0 })
      : restingOrder(pool);

    // One source must not eat the whole list: with nothing typed a project of
    // 200 changed files buried every action under "Arquivos".
    const seen = new Map<EntryKind, number>();
    const out: PaletteEntry[] = [];
    for (const entry of ranked) {
      const used = seen.get(entry.kind) ?? 0;
      if (used >= CAP_BY_KIND) continue;
      seen.set(entry.kind, used + 1);
      out.push(entry);
      if (out.length >= CAP) break;
    }
    return out;
  }, [entries, scope, text, wantsOutput, outputEntries, wantsSymbols, symbolEntries]);

  // The cursor is an index into a list that changes on every keystroke.
  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-cursor="1"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor, results]);

  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    // Closing first: the row may open a modal, and two surfaces stacked on
    // top of each other would fight over `Esc`.
    close();
    entry.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
      return;
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setCursor((c) =>
        results.length ? (c - 1 + results.length) % results.length : 0,
      );
      return;
    }
    if (e.key === "Home" && results.length) {
      e.preventDefault();
      setCursor(0);
      return;
    }
    if (e.key === "End" && results.length) {
      e.preventDefault();
      setCursor(results.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(results[cursor]);
    }
  };

  // Esc on the window too: the input may have lost focus to a stray click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!isTopLayer("busca")) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const sections = useMemo(() => sectionsOf(results), [results]);
  // `fileIndex === null` means the walk has not finished, not that the
  // project has no files.
  const vazio = emptyReason({
    text,
    scope,
    indexed: fileIndex !== null,
    searching: sweeping || askingServers,
  });
  let painted = -1;

  return (
    // Only the primary button closes: with the right one the gesture is "open the menu".
    <div className="busca-backdrop" onMouseDown={(e) => e.button === 0 && close()}>
      <div
        ref={dialogRef}
        className="busca"
        role="dialog"
        aria-modal="true"
        aria-label={t("Busca")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="busca-field">
          <Search size={15} className="busca-glass" aria-hidden="true" />
          {scope && <span className="busca-scope">{t(scope.label)}</span>}
          <input
            ref={inputRef}
            className="busca-input"
            value={query}
            spellCheck={false}
            placeholder={t("Buscar agentes, arquivos, notas, ações…")}
            aria-label={t("Buscar no workspace")}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="busca-lista"
            aria-activedescendant={
              results[cursor] ? `busca-row-${results[cursor].id}` : undefined
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="busca-list" id="busca-lista" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <p className="busca-empty">
              {/* Three different sentences, because the three states are
                  different news. Denying a file while the index is still
                  being walked is the worst of them (`model.ts`,
                  `emptyReason`). */}
              {vazio === "sem-busca" &&
                t("Nada por aqui ainda — adicione um projeto para começar.")}
              {vazio === "indexando" &&
                t("Indexando os arquivos do projeto… os que já entraram aparecem aqui.")}
              {vazio === "buscando" &&
                t("Procurando “{text}” na saída dos terminais…", { text })}
              {vazio === "curto" &&
                t("Escreva ao menos duas letras: esta busca lê o histórico de todos os terminais.")}
              {vazio === "nada-encontrado" &&
                t("Nada encontrado para “{text}”.", { text })}
              {/* The sweep covers what is on disk, which is the last 4 MB of
                  each terminal, older output was compacted away long ago. */}
              {vazio === "nada-encontrado" && scope?.prefix === "$" && text && (
                <span className="busca-empty-hint">
                  {t("A busca cobre o histórico guardado de cada terminal (os últimos 4 MB); o que passou disso já foi descartado.")}
                </span>
              )}
              {/* The file rows come from the project index (every file under
                  the root, minus dependencies and build output) — "Nada
                  encontrado" is still not proof of absence: the file may live
                  in a skipped folder. */}
              {vazio === "nada-encontrado" && scope?.prefix === "/" && text && (
                <span className="busca-empty-hint">
                  {t("A busca cobre todos os arquivos do projeto, menos dependências e saída de build (node_modules, target, dist…). Para procurar por conteúdo, use a lupa da aba Arquivos (Ctrl+Shift+F).")}
                </span>
              )}
            </p>
          ) : (
            sections.map((section) => (
              <div className="busca-section" key={section.kind}>
                <div className="busca-section-head">{t(section.label)}</div>
                {section.entries.map((entry) => {
                  painted += 1;
                  const index = painted;
                  return (
                    <button
                      key={entry.id}
                      id={`busca-row-${entry.id}`}
                      role="option"
                      aria-selected={index === cursor}
                      data-cursor={index === cursor ? "1" : "0"}
                      className={`busca-row ${index === cursor ? "is-active" : ""}`}
                      onMouseMove={() => setCursor(index)}
                      onClick={() => choose(entry)}
                    >
                      <span className="busca-icon" aria-hidden="true">
                        {entry.icon ?? ICON[entry.kind]}
                      </span>
                      <span className="busca-text">
                        <span className="busca-title">{entry.title}</span>
                        {entry.subtitle && (
                          <span className="busca-sub">{entry.subtitle}</span>
                        )}
                      </span>
                      {entry.hint && <kbd className="busca-hint">{entry.hint}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="busca-foot">
          <span className="busca-legend">
            {SCOPES.map((s) => (
              <span key={s.prefix}>
                <kbd>{s.prefix}</kbd> {t(s.label)}
              </span>
            ))}
          </span>
          <span className="busca-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("navega")} · <kbd>Enter</kbd> {t("abre")} · <kbd>Esc</kbd> {t("fecha")}
          </span>
        </div>
      </div>
    </div>
  );
}

const ICON: Record<EntryKind, JSX.Element> = {
  action: <Zap size={14} />,
  terminal: <SquareTerminal size={14} />,
  group: <Boxes size={14} />,
  project: <Folder size={14} />,
  note: <StickyNote size={14} />,
  memo: <NotebookPen size={14} />,
  frame: <Group size={14} />,
  media: <ImageIcon size={14} />,
  binder: <NotebookTabs size={14} />,
  tree: <FolderTree size={14} />,
  portal: <Globe size={14} />,
  url: <Radio size={14} />,
  file: <FileText size={14} />,
  prompt: <Bookmark size={14} />,
  task: <ListTodo size={14} />,
  output: <ScrollText size={14} />,
  symbol: <Braces size={14} />,
};

// ---------------------------------------------------------------------------
// entries
// ---------------------------------------------------------------------------

interface World {
  projects: ReturnType<typeof useProjects.getState>["projects"];
  groups: ReturnType<typeof useProjects.getState>["groups"];
  terminals: TerminalRow[];
  activeGroupId: string | null;
  activeProjectId: string | null;
  runtimes: ReturnType<typeof useTerminals.getState>["byId"];
  gitByProject: ReturnType<typeof useChanges.getState>["gitByProject"];
  liveByProject: ReturnType<typeof useChanges.getState>["liveByProject"];
  dirs: ReturnType<typeof useEditor.getState>["dirs"];
  fileIndex: string[] | null;
  prompts: ReturnType<typeof useBench.getState>["prompts"];
  tasks: ReturnType<typeof useBench.getState>["tasks"];
  served: ReturnType<typeof useAdvertised.getState>["byTerminal"];
  focusedTerminalId: string | null;
  /** The markdown notebook (Anotações), not the canvas stickies. */
  memos: Note[];
  memoBooks: Notebook[];
}

/** Weight steps. Same group beats same project beats anywhere else. */
const W_GROUP = 600;
const W_PROJECT = 300;
const W_WAITING = 120;
/** On top of `W_WAITING`: stopped at a question outranks stopped with an answer. */
const W_BLOCKED = 90;
const W_RUNNING = 60;

function buildEntries(world: World): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const projectById = new Map(world.projects.map((p) => [p.id, p]));
  const groupById = new Map(world.groups.map((g) => [g.id, g]));
  const { layoutOf, floorOf } = useProjects.getState();

  const localOf = (groupId: string) => {
    const group = groupById.get(groupId);
    // A board has no project — `label` then reads as just the board's name.
    const project = group?.projectId ? projectById.get(group.projectId) : undefined;
    return {
      group,
      project,
      label: [project?.name, group?.name].filter(Boolean).join(" · "),
      weight:
        groupId === world.activeGroupId
          ? W_GROUP
          : group?.projectId === world.activeProjectId
            ? W_PROJECT
            : 0,
    };
  };

  // --- terminals -----------------------------------------------------------
  for (const term of world.terminals) {
    const local = localOf(term.groupId);
    const runtime = world.runtimes[term.id];
    const waiting = runtime?.finished || runtime?.unread;
    const role = layoutOf(term.groupId).canvas?.roles?.[term.id];
    out.push({
      id: `terminal:${term.id}`,
      kind: "terminal",
      title: baseName(term),
      subtitle: [local.label, role?.name].filter(Boolean).join(" — "),
      // The role is searchable: "revisora" is how someone looks for the agent
      // whose name they never bothered to change.
      keywords: [term.program, term.agentId ?? "", term.cwd, role?.name ?? "", ...term.args],
      icon: (
        <CircleDot
          size={14}
          className={
            isLive(runtime)
              ? waiting
                ? "busca-dot busca-dot--waiting"
                : "busca-dot busca-dot--live"
              : "busca-dot"
          }
        />
      ),
      weight:
        local.weight +
        (waiting ? W_WAITING : 0) +
        (runtime?.blocked ? W_BLOCKED : 0) +
        (isLive(runtime) ? W_RUNNING : 0),
      run: () => goToTerminal(term),
    });
  }

  // --- groups and floors ---------------------------------------------------
  for (const g of world.groups) {
    const project = g.projectId ? projectById.get(g.projectId) : undefined;
    const floor = floorOf(g.id);
    const isFloor = floor.kind !== "ground";
    out.push({
      id: `group:${g.id}`,
      kind: "group",
      title: g.name,
      subtitle: [
        project?.name,
        isFloor ? `${t("frente")}${floor.branch ? ` · ${floor.branch}` : ""}` : null, // i18n-ok
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [isFloor ? "frente front floor worktree" : "grupo group", floor.branch ?? ""], // i18n-ok
      weight:
        g.id === world.activeGroupId
          ? W_GROUP
          : g.projectId === world.activeProjectId
            ? W_PROJECT
            : 0,
      run: () => useProjects.getState().setActiveGroup(g.id),
    });
  }

  // --- projects ------------------------------------------------------------
  for (const p of world.projects) {
    out.push({
      id: `project:${p.id}`,
      kind: "project",
      title: p.name,
      subtitle: p.path,
      keywords: ["projeto project", p.path], // i18n-ok
      weight: p.id === world.activeProjectId ? W_PROJECT : 0,
      run: () => useProjects.getState().setActiveProject(p.id),
    });
  }

  // --- addresses the terminals announced -----------------------------------
  for (const term of world.terminals) {
    const local = localOf(term.groupId);
    for (const url of world.served[term.id] ?? []) {
      out.push({
        id: `url:${term.id}:${url.origin}`,
        kind: "url",
        title: url.origin,
        subtitle: t("servido por {name} — {local}", { name: baseName(term), local: local.label }),
        keywords: ["porta", "port", String(url.port), "localhost", "servidor", "server", "portal"],
        hint: t("abrir portal"),
        weight: local.weight + W_RUNNING,
        run: () => {
          void spawnPortalNear({
            groupId: term.groupId,
            url: url.origin,
            nearTerminalId: term.id,
          }).catch((e) =>
            useUI.getState().showToast(t("Não consegui abrir o portal: {e}", { e: String(e) }), "error"),
          );
        },
      });
    }
  }

  // --- canvas: notes and portals ------------------------------------------
  for (const g of world.groups) {
    const items = layoutOf(g.id).canvas?.items;
    if (!items) continue;
    const local = localOf(g.id);
    for (const item of items) {
      if (item.type === "note") {
        out.push({
          id: `note:${item.id}`,
          kind: "note",
          title: noteName(item),
          subtitle: local.label,
          // The body is searchable but not shown: a note is memory, and
          // remembering *what was written* is the whole reason to look for it.
          keywords: [item.text.slice(0, 600), item.locked ? "travada locked" : ""], // i18n-ok
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      } else if (item.type === "binder") {
        // Its notes are indexed on their own (they are still notes), and
        // picking one opens its tab — see the reveal in `CanvasView`. This
        // row is the fichário itself, for whoever named it.
        out.push({
          id: `binder:${item.id}`,
          kind: "binder",
          title: item.name || t("Fichário"),
          subtitle: t("{n} nota(s) — {local}", { n: item.notes.length, local: local.label }),
          keywords: ["fichario abas notas binder tabs notes"], // i18n-ok
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      } else if (item.type === "tree") {
        out.push({
          id: `tree:${item.id}`,
          kind: "tree",
          title: treeNodeName(item),
          subtitle: `${item.path || t("raiz")} — ${local.label}`,
          keywords: [item.path, "arvore arquivos explorador tree files explorer"], // i18n-ok
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      } else if (item.type === "media") {
        // A file pinned to the board is findable by its own name *and* by its
        // path — the two ways anybody refers to a file.
        out.push({
          id: `media:${item.id}`,
          kind: "media",
          title: mediaNodeName(item),
          subtitle: `${item.path} — ${local.label}`,
          icon: <FileGlyph name={mediaNodeName(item)} size={14} />,
          keywords: [item.path, item.root ?? "", "arquivo canvas midia file media"], // i18n-ok
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      } else if (item.type === "group") {
        // A frame is the only name the user ever gives to a *region* of the
        // board. Finding "Frontend" and landing on the frame is how you get
        // back to a corner of a big canvas you have not visited in a week.
        out.push({
          id: `frame:${item.id}`,
          kind: "frame",
          title: item.name,
          subtitle: local.label,
          keywords: ["grupo moldura canvas group frame"], // i18n-ok
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      } else if (item.type === "portal") {
        out.push({
          id: `portal:${item.id}`,
          kind: "portal",
          title: portalName(item),
          subtitle: `${item.url} — ${local.label}`,
          keywords: [item.url, item.engine ?? "", "portal navegador browser"], // i18n-ok
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      }
    }
  }

  // --- files ---------------------------------------------------------------
  const projectId = world.activeProjectId;
  if (projectId) {
    const changed = new Set<string>();
    for (const file of world.gitByProject[projectId]?.files ?? []) {
      changed.add(file.path);
      out.push({
        id: `file:${file.path}`,
        kind: "file",
        title: fileName(file.path),
        subtitle: file.path,
        icon: <FileGlyph name={fileName(file.path)} size={14} />,
        keywords: [file.status, "alterado git changed"], // i18n-ok
        weight: W_GROUP,
        run: () => openFile(projectId, file.path, true),
      });
    }
    // What the agent touched in this session but git does not list (ignored
    // files, generated output): the feed is the only place they exist.
    for (const entry of (world.liveByProject[projectId] ?? []).slice(0, 60)) {
      if (changed.has(entry.path)) continue;
      changed.add(entry.path);
      out.push({
        id: `file:${entry.path}`,
        kind: "file",
        title: fileName(entry.path),
        subtitle: entry.path,
        icon: <FileGlyph name={fileName(entry.path)} size={14} />,
        keywords: ["tocado recente feed touched recent"], // i18n-ok
        weight: W_PROJECT,
        run: () => openFile(projectId, entry.path, false),
      });
    }
    // Whatever the tree already read from disk. It is lazy, so this is "what
    // you have browsed" — slightly warmer than the raw index below.
    for (const listing of Object.values(world.dirs)) {
      for (const info of listing) {
        if (info.dir || changed.has(info.path)) continue;
        changed.add(info.path);
        out.push({
          id: `file:${info.path}`,
          kind: "file",
          title: info.name,
          subtitle: info.path,
          icon: <FileGlyph name={info.name} size={14} />,
          weight: 0,
          run: () => openFile(projectId, info.path, false),
        });
      }
    }
    // The whole project, from the quick-open index (`fs_index_files`): what
    // makes `/qualquer/arquivo.ts` open before anyone browsed anywhere.
    // Capped because the ranking runs per keystroke — and past a few thousand
    // candidates a monorepo's tail buys latency, not better hits.
    if (world.fileIndex) {
      let remaining = INDEX_CAP;
      for (const path of world.fileIndex) {
        if (remaining <= 0) break;
        if (changed.has(path)) continue;
        changed.add(path);
        remaining -= 1;
        out.push({
          id: `file:${path}`,
          kind: "file",
          title: fileName(path),
          subtitle: path,
          icon: <FileGlyph name={fileName(path)} size={14} />,
          weight: 0,
          run: () => openFile(projectId, path, false),
        });
      }
    }
  }

  // --- bench ---------------------------------------------------------------
  for (const p of world.prompts) {
    out.push({
      id: `prompt:${p.id}`,
      kind: "prompt",
      title: p.title,
      subtitle: p.body.split("\n")[0]?.slice(0, 90),
      keywords: [...p.tags, p.body.slice(0, 400)],
      hint: t("compositor"),
      weight: p.pinned ? W_PROJECT : 0,
      run: () => usePromptInComposer(p.id),
    });
  }
  for (const t of world.tasks) {
    if (t.done) continue;
    const owner = t.projectId ? projectById.get(t.projectId) : null;
    // Another project's tasks are findable but never on top: the ones that
    // belong here — and the global ones — come first.
    const mine = t.projectId === null || t.projectId === world.activeProjectId;
    out.push({
      id: `task:${t.id}`,
      kind: "task",
      title: t.text,
      subtitle: [
        t.priority > 0 ? "!".repeat(t.priority) : null,
        t.dueAt !== null ? dueLabel(t.dueAt).text : null,
        owner ? owner.name : "global",
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: ["tarefa bancada task bench", owner?.name ?? "global"], // i18n-ok
      weight: mine ? W_PROJECT : 0,
      run: () =>
        useBench.getState().revealTask(t.id, useProjects.getState().activeProjectId),
    });
  }

  // --- the notebook (Anotações) --------------------------------------------
  for (const memo of world.memos) {
    if (memo.deletedAt !== null) continue;
    const theNotebook = notebookPath(world.memoBooks, memo.notebookId);
    out.push({
      id: `memo:${memo.id}`,
      kind: "memo",
      title: memo.title.trim() || fallbackTitle(memo.body),
      subtitle: [
        theNotebook || t("sem caderno"),
        memo.status !== "none" ? t(STATUS_META[memo.status].label).toLowerCase() : null,
      ]
        .filter(Boolean)
        .join(" · "),
      // The body is searchable but not shown — same rule as the canvas notes.
      keywords: [memo.body.slice(0, 600), "anotacao caderno note notebook"], // i18n-ok
      weight: memo.pinned ? W_PROJECT : 0,
      run: () => useNotes.getState().openView(memo.id),
    });
  }

  out.push(...actions(world));
  return out;
}

// ---------------------------------------------------------------------------
// what a row does
// ---------------------------------------------------------------------------

/** Changed file goes to the diff; anything else goes to the editor. */
function openFile(projectId: string, path: string, diff: boolean) {
  if (diff) {
    useChanges.getState().openViewer(projectId, path);
    return;
  }
  void useEditor
    .getState()
    .openFile(path)
    .catch((e) => useUI.getState().showToast(t("Não consegui abrir: {e}", { e: String(e) }), "error"));
}

function usePromptInComposer(promptId: string) {
  const bench = useBench.getState();
  const prompt = bench.prompts.find((p) => p.id === promptId);
  if (!prompt) return;
  // No terminal required: the composer holds the text and asks where it goes
  // only at send time.
  useUI.getState().sendToComposer(prompt.body);
  bench.markUsed(prompt.id);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function actions(world: World): PaletteEntry[] {
  const ui = () => useUI.getState();
  const hasGroup = !!world.activeGroupId;
  const project = world.projects.find((p) => p.id === world.activeProjectId);
  const rows: PaletteEntry[] = [
    {
      id: "action:new-terminal",
      kind: "action",
      title: t("Nova aba"),
      subtitle: t("CLI, shell ou navegador no grupo ativo"),
      keywords: ["criar", "cli", "claude", "codex", "shell", "terminal", "navegador", "new tab", "browser"],
      hint: "Ctrl+T",
      weight: 40,
      run: () => ui().openModal("new-terminal"),
    },
    {
      id: "action:new-portal",
      kind: "action",
      title: t("Novo portal"),
      subtitle: t("navegador no canvas"),
      keywords: ["criar", "browser", "site", "url", "new portal", "web"],
      weight: 20,
      run: () => ui().openModal("new-portal"),
    },
    ...(hasGroup
      ? [
          {
            id: "action:new-browser-tab",
            kind: "action" as const,
            title: t("Novo navegador no painel"),
            subtitle: t("aba de browser ao lado das CLIs"),
            keywords: ["criar", "browser", "navegador", "aba", "site", "url", "new browser tab"],
            weight: 20,
            run: () =>
              useBrowsers.getState().open({
                groupId: world.activeGroupId!,
                slot: useUI.getState().focusedSlot,
              }),
          },
        ]
      : []),
    {
      id: "action:new-project",
      kind: "action",
      title: t("Adicionar projeto"),
      subtitle: t("abrir uma pasta como projeto"),
      keywords: ["criar", "pasta", "repositorio", "add project", "folder", "repository"],
      run: () => ui().openModal("new-project"),
    },
    {
      id: "action:new-floor",
      kind: "action",
      title: t("Nova frente"),
      subtitle: t("worktree isolado para uma tarefa"),
      keywords: ["criar", "floor", "worktree", "branch", "git", "new floor"],
      weight: 20,
      run: () => ui().openModal("new-floor", { projectId: world.activeProjectId }),
    },
    {
      id: "action:new-task",
      kind: "action",
      title: t("Nova tarefa"),
      subtitle: t("mesmo pedido para N agentes, cada um na sua frente"),
      keywords: ["fanout", "fan-out", "frota", "paralelo", "worktree", "tarefa", "new task", "fleet", "parallel"],
      weight: 25,
      run: () => ui().openModal("new-task", { projectId: world.activeProjectId }),
    },
    {
      id: "action:compare-floors",
      kind: "action",
      title: t("Comparar frentes"),
      subtitle: t("diffstat lado a lado e aterrissar o vencedor"),
      keywords: ["merge", "aterrissar", "land", "vencedor", "diff", "compare floors", "winner"],
      weight: 24,
      run: () =>
        ui().openModal("compare-floors", { projectId: world.activeProjectId }),
    },
    {
      id: "action:journal",
      kind: "action",
      title: t("Diário de hoje"),
      subtitle: t("commits, agentes e custo do dia numa nota nova"),
      keywords: ["journal", "diario", "diário", "resumo", "dia", "today", "log"], // i18n-ok
      weight: 12,
      run: () => void writeTodaysJournal(),
    },
    {
      id: "action:composer",
      kind: "action",
      title: t("Compositor de prompts"),
      subtitle: t("escrever um prompt longo fora do terminal"),
      keywords: ["prompt", "escrever", "enviar", "composer", "write", "send"],
      hint: "Ctrl+Enter",
      weight: 30,
      run: () => ui().setComposerOpen(true),
    },
    {
      id: "action:bench",
      kind: "action",
      title: t("Bancada"),
      subtitle: t("tarefas e biblioteca de prompts"),
      keywords: ["painel", "prompts", "tarefas", "bench", "tasks", "panel"],
      hint: "Ctrl+Shift+B",
      run: () => useBench.getState().toggle(),
    },
    {
      id: "action:files",
      kind: "action",
      title: t("Árvore de arquivos"),
      subtitle: t("explorador do projeto"),
      keywords: ["explorer", "pastas", "editor", "file tree", "folders"],
      hint: "Ctrl+Shift+E",
      run: () => useBench.getState().openTab("files"),
    },
    {
      id: "action:search",
      kind: "action",
      title: t("Buscar no projeto"),
      subtitle: t("texto em todos os arquivos"),
      keywords: ["grep", "find", "procurar", "conteudo", "search", "search project", "content"],
      hint: "Ctrl+Shift+F",
      run: () => useBench.getState().openTab("search"),
    },
    {
      id: "action:changes",
      kind: "action",
      title: t("Alterações"),
      subtitle: t("git status e diff por arquivo"),
      keywords: ["git", "diff", "mudancas", "painel", "changes", "status"],
      hint: "Ctrl+Shift+D",
      run: () => useChanges.getState().toggle(),
    },
    {
      id: "action:memos",
      kind: "action",
      title: t("Anotações"),
      subtitle: t("o caderno de notas markdown — cadernos, etiquetas e status"),
      keywords: ["nota", "caderno", "markdown", "md", "etiqueta", "anotacao", "notebook", "notes", "tags"],
      hint: "Ctrl+Shift+N",
      weight: 20,
      run: () => useNotes.getState().openView(),
    },
    {
      id: "action:memo-new",
      kind: "action",
      title: t("Nova anotação"),
      subtitle: t("cria uma nota e já abre para escrever"),
      keywords: ["nota", "nova", "criar", "anotacao", "markdown", "new note"],
      run: () => {
        useNotes.getState().openView();
        useNotes.getState().createNote();
      },
    },
    {
      id: "action:memo-dock",
      kind: "action",
      title: t("Anotações em aba"),
      subtitle: t("o caderno vira uma aba do painel em foco"),
      keywords: ["nota", "caderno", "aba", "painel", "dock", "anotacao", "notes tab"],
      run: () => useNotes.getState().dockHere(),
    },
    {
      id: "action:memo-center",
      kind: "action",
      title: t("Anotações na área central"),
      subtitle: t("o caderno ocupa todo o espaço do workspace"),
      keywords: ["nota", "caderno", "central", "tela", "expandir", "anotacao", "notes center", "expand"],
      run: () => useNotes.getState().setPlaceKind("center"),
    },
    {
      id: "action:sidebar",
      kind: "action",
      title: t("Barra lateral"),
      subtitle: t("projetos e grupos"),
      keywords: ["esconder", "mostrar", "painel", "sidebar", "show", "hide"],
      hint: "Ctrl+B",
      run: () => ui().toggleSidebar(),
    },
    {
      id: "action:statusbar",
      kind: "action",
      title: t("Barra de status"),
      subtitle: t("agentes, branch, fluxos e memória no rodapé"),
      keywords: ["esconder", "mostrar", "rodape", "rodapé", "footer"], // i18n-ok
      run: () => ui().setPref("statusBar", !ui().prefs.statusBar),
    },
    {
      id: "action:routines",
      kind: "action",
      title: t("Rotinas…"),
      subtitle: t("prompts agendados do grupo"),
      keywords: ["agendar", "lembrete", "repetir", "routines", "schedule", "reminder", "repeat"],
      run: () => ui().openModal("routines"),
    },
    {
      id: "action:scores",
      kind: "action",
      title: t("Partituras…"),
      subtitle: t("salvar e reaplicar o arranjo do grupo"),
      keywords: ["layout", "arranjo", "template", "scores", "arrangement"],
      run: () => ui().openModal("scores"),
    },
    {
      // The store shelf is gone; what people searched it for is here. The old
      // words keep working — whoever learned "extensões" types it.
      id: "action:editor-features",
      kind: "action",
      title: t("Tema, ícones e recursos do editor…"),
      subtitle: t("tema de cor, tema de ícones, minimapa, Prettier, Mermaid"),
      keywords: ["extensoes", "extensions", "loja", "store", "plugins", "temas", "themes", "icones", "icons", "symbols", "minimapa", "minimap", "prettier"],
      run: () => ui().openModal("preferences", "editor"),
    },
    {
      id: "action:preferences",
      kind: "action",
      title: t("Configurações"),
      subtitle: t("fonte, renderer, scrollback, avisos, atalhos, recursos"),
      keywords: ["config", "ajustes", "opcoes", "settings", "preferencias", "preferences", "options"],
      hint: "Ctrl+Shift+P",
      run: () => ui().openModal("preferences"),
    },
    {
      id: "action:agentes",
      kind: "action",
      title: t("Agentes — como cada CLI abre"),
      subtitle: t("a linha de comando fixa de cada agente, e o “sem pedir permissão”"),
      keywords: [
        "permissao",
        "dangerously",
        "skip",
        "yolo",
        "flags",
        "argumentos",
        "claude",
        "codex",
      ],
      run: () => ui().openModal("preferences", "agentes"),
    },
    {
      id: "action:shortcuts",
      kind: "action",
      title: t("Atalhos de teclado"),
      keywords: ["teclas", "ajuda", "keybindings", "shortcuts", "keys", "help"],
      hint: "Ctrl+Shift+H",
      run: () => ui().openModal("shortcuts"),
    },
    ...(hasGroup
      ? [
          {
            id: "action:broadcast",
            kind: "action" as const,
            title: useBroadcast.getState().isOn(world.activeGroupId ?? "")
              ? t("Parar de transmitir o teclado")
              : t("Transmitir teclado para o grupo"),
            subtitle: t("o que você digita numa CLI vai para todas as CLIs vivas do grupo"),
            keywords: ["broadcast", "uníssono", "todos", "transmitir", "teclado", "keyboard", "all"], // i18n-ok
            hint: "Ctrl+Shift+U",
            run: () => toggleBroadcast(),
          },
        ]
      : []),
    ...(world.focusedTerminalId
      ? [
          {
            id: "action:export-output",
            kind: "action" as const,
            title: t("Salvar saída do terminal em foco…"),
            subtitle: t("Um .txt legível, ou .ansi com as cores — vale para uma CLI que já morreu"),
            keywords: ["exportar", "salvar", "saída", "scrollback", "log", "histórico", "export", "save output", "history"], // i18n-ok
            run: () => void exportTerminalOutput(world.focusedTerminalId as string),
          },
        ]
      : []),
    {
      id: "action:theme-toggle",
      kind: "action",
      title: t("Alternar tema claro/escuro"),
      subtitle: t("Aparência do Yard — Escuro, Claro ou Sistema em Configurações"),
      keywords: ["tema", "aparência", "claro", "escuro", "light", "dark", "theme", "appearance"], // i18n-ok
      run: () => ui().setPref("theme", toggledTheme(resolvedTheme())),
    },
    {
      id: "action:language",
      kind: "action",
      title: t("Idioma da interface…"),
      subtitle: t("Português (Brasil), English ou o do sistema — em Configurações → Interface"),
      keywords: ["idioma", "language", "inglês", "english", "português", "portuguese"], // i18n-ok
      run: () => ui().openModal("preferences", "interface"),
    },
    {
      id: "action:quit",
      kind: "action",
      title: t("Sair do Yard"),
      subtitle: t("Salva o workspace e fecha — mesmo com \"fechar para a bandeja\" ligado"),
      keywords: ["quit", "exit", "fechar", "encerrar", "close"],
      run: () => {
        if (!requestQuit()) ui().showToast(t("O Yard ainda está abrindo."), "error");
      },
    },
    {
      id: "action:onboarding",
      kind: "action",
      title: t("Boas-vindas — o tour do primeiro uso"),
      subtitle: t("As CLIs encontradas, o primeiro projeto e os seis atalhos"),
      keywords: ["onboarding", "tour", "início", "primeiro uso", "ajuda", "welcome", "first run", "help"], // i18n-ok
      run: () => ui().openModal("onboarding"),
    },
    {
      id: "action:support",
      kind: "action",
      title: t("Relatar um problema…"),
      subtitle: t("Pacote de suporte com os logs — em Configurações → Dados e backup"),
      keywords: ["bug", "suporte", "issue", "log", "erro", "support", "report", "problem", "error"],
      run: () => ui().openModal("preferences", "dados"),
    },
    {
      id: "action:check-updates",
      kind: "action",
      title: t("Verificar atualizações"),
      subtitle: t("Procura uma versão nova do Yard no GitHub"),
      keywords: ["update", "atualizar", "versão", "release", "novidades", "check updates", "version"], // i18n-ok
      run: () => void checkForUpdates(),
    },
    {
      id: "action:autobackup-now",
      kind: "action",
      title: t("Fazer backup automático agora"),
      subtitle: t("Grava uma cópia .zip na pasta de backups e aplica a retenção"),
      keywords: ["backup", "cópia", "zip", "segurança", "automático", "backup now", "copy", "automatic"], // i18n-ok
      run: () => void useAutoBackup.getState().runNow(),
    },
    {
      id: "action:costs",
      kind: "action",
      title: t("Custos e uso"),
      subtitle: t("tokens e gasto estimado por dia, projeto, agente e modelo"),
      keywords: ["custo", "tokens", "gasto", "uso", "dinheiro", "preço", "cost", "usage", "spend", "money", "price"], // i18n-ok
      hint: "Ctrl+Alt+U",
      run: () => void useCosts.getState().open(),
    },
    ...(hasGroup
      ? [
          {
            id: "action:shoulder",
            kind: "action" as const,
            title: t("Ombro"),
            subtitle: t("o que cada agente do grupo fez, lido das sessões em disco"),
            keywords: ["shoulder", "resumo", "digest", "sessão", "agentes", "summary", "session", "agents"], // i18n-ok
            icon: <Eye size={14} />,
            hint: "Ctrl+Shift+O",
            run: () => ui().openModal("shoulder", { groupId: world.activeGroupId }),
          },
        ]
      : []),
    ...(() => {
      // "Rotinas…" above opens the modal with no payload; this one opens it
      // for the CLI in focus, with the counts of what is already armed on it.
      const focusedId = world.focusedTerminalId;
      const term = focusedId ? useProjects.getState().terminal(focusedId) : undefined;
      if (!term) return [];
      const canvas = useProjects.getState().layoutOf(term.groupId).canvas;
      const routines = (canvas?.routines ?? []).filter(
        (r) => r.enabled && r.terminalId === term.id,
      ).length;
      const triggers = (canvas?.triggers ?? []).filter(
        (t) => t.enabled && (t.sourceId === "*" || t.sourceId === term.id),
      ).length;
      return [
        {
          id: "action:triggers-focused",
          kind: "action" as const,
          title: t("Rotinas e gatilhos da CLI em foco…"),
          subtitle:
            routines + triggers > 0
              ? t("{r} rotina(s) · {g} gatilho(s) armados", { r: routines, g: triggers })
              : t("quando terminar, travar ou sair → mandar prompt, notificar ou rodar fluxo"),
          keywords: ["gatilho", "trigger", "quando", "evento", "automação", "routines", "when", "event", "automation"], // i18n-ok
          run: () => ui().openModal("routines", { groupId: term.groupId, terminalId: term.id }),
        },
      ];
    })(),
    {
      id: "action:mcp",
      kind: "action",
      title: t("Servidores MCP…"),
      subtitle: t("os servidores de ferramentas de cada CLI, num lugar só"),
      keywords: ["mcp", "model context protocol", "servidor", "ferramentas", "tools", "server"],
      run: () => ui().openModal("preferences", "mcp"),
    },
    {
      id: "action:lsp",
      kind: "action",
      title: t("Servidores de linguagem…"),
      subtitle: t("quais o editor encontrou nesta máquina, e o interruptor do LSP"),
      keywords: ["lsp", "language server", "autocomplete", "definição", "diagnóstico", "definition", "diagnostics"], // i18n-ok
      run: () => ui().openModal("preferences", "editor"),
    },
  ];

  if (project) {
    rows.push({
      id: "action:sessions",
      kind: "action",
      title: t("Sessões anteriores"),
      subtitle: t("retomar uma sessão de agente em {name}", { name: project.name }),
      keywords: ["resume", "retomar", "historico", "claude", "codex", "sessions", "history"],
      run: () => ui().openModal("sessions", { projectPath: project.path }),
    });
  }

  // The canvas is the group's other surface, not a fourth mode: one row that
  // flips between the two, and it carries the weight because it is the only
  // one that changes *what* is on screen rather than its shape. It sits
  // **outside** the block below on purpose — the shapes of the grid need a
  // group, the canvas does not: with every tab closed it is still reachable,
  // through a board (`toggleCanvas`).
  const onBoard =
    hasGroup && useProjects.getState().layoutOf(world.activeGroupId!).surface === "canvas";
  rows.push({
    id: "action:surface-canvas",
    kind: "action",
    title: onBoard ? t("Voltar aos painéis") : t("Ir para o canvas"),
    subtitle: onBoard
      ? t("as abas e a grade do grupo")
      : t("cartões num quadro infinito, com as CLIs de lá"),
    keywords: ["canvas", "quadro", "paineis", "abas", "superficie", "board", "panes", "tabs", "surface"],
    weight: 10,
    run: () => toggleCanvas(),
  });

  if (hasGroup) {
    const groupId = world.activeGroupId!;
    const layout = useProjects.getState().layoutOf(groupId);
    const modes: { mode: LayoutMode; label: string; hint: string }[] = [
      { mode: "auto", label: t("Modo automático"), hint: t("a grade se ajusta sozinha") },
      { mode: "grid", label: t("Modo grade"), hint: t("número fixo de painéis") },
      { mode: "spotlight", label: t("Modo holofote"), hint: t("um grande, o resto pequeno") },
    ];
    for (const m of modes) {
      if (m.mode === layout.mode && !onBoard) continue;
      rows.push({
        id: `action:layout-${m.mode}`,
        kind: "action",
        title: m.label,
        subtitle: m.hint,
        keywords: ["layout", "modo", "grupo", "paineis", "mode", "group", "panes", "auto", "grid", "spotlight"],
        run: () => {
          useProjects.getState().updateLayout(groupId, { mode: m.mode });
          show(groupId, "grid");
        },
      });
    }
  }

  const focused = world.terminals.find((t) => t.id === world.focusedTerminalId);
  // Same rule as the other doors into the Live view: with no session recorded
  // on disk there is nothing to follow, and the row would only lead to an
  // endless wait.
  if (focused && hasSessions(focused.agentId)) {
    rows.push({
      id: "action:live",
      kind: "action",
      title: t("Ao Vivo"),
      subtitle: t("acompanhar {name} passo a passo", { name: baseName(focused) }),
      keywords: ["overlay", "sessao", "mission control", "feed", "live", "session"],
      icon: <Layers size={14} />,
      weight: 25,
      run: () => {
        void useLive
          .getState()
          .openFor(focused)
          .catch((e) =>
            useUI.getState().showToast(t("Não consegui abrir o Ao Vivo: {e}", { e: String(e) }), "error"),
          );
      },
    });
    rows.push({
      id: "action:transcript",
      kind: "action",
      title: t("Transcrição da sessão"),
      subtitle: t("ler a conversa de {name} do começo", { name: baseName(focused) }),
      keywords: ["transcript", "sessão", "histórico", "conversa", "session", "history", "conversation"], // i18n-ok
      icon: <ScrollText size={14} />,
      run: () => void openTranscriptFor(focused),
    });
  }

  return rows;
}
