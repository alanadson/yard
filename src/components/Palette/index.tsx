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
 * "onde está o codex que ficou no andar da api" is the question worth
 * answering. Prefixes narrow it when you already know the kind:
 * `>` actions, `@` agents, `#` canvas, `/` files.
 *
 * Nothing here owns state. Every row ends in a call that some store already
 * exposes — the Busca is a **way in**, never a second way to do things.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Boxes,
  CircleDot,
  FileText,
  Folder,
  Globe,
  Layers,
  ListTodo,
  NotebookPen,
  Radio,
  Search,
  SquareTerminal,
  StickyNote,
  Zap,
} from "lucide-react";

import {
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
import { isTopLayer } from "../../lib/layers";
import { goToCanvasItem, goToTerminal } from "../../lib/navigate";
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
import { baseName } from "../../lib/terminals";
import { useAdvertised } from "../../stores/advertisedStore";
import { hasSessions } from "../../stores/agentsStore";
import { dueLabel, useBench } from "../../stores/benchStore";
import { useBrowsers } from "../../stores/browsersStore";
import { useChanges } from "../../stores/changesStore";
import { useEditor } from "../../stores/editorStore";
import { useLive } from "../../stores/liveStore";
import { useNotes } from "../../stores/notesStore";
import { useProjects, type LayoutMode } from "../../stores/projectsStore";
import { isLive, useTerminals } from "../../stores/terminalsStore";
import { useUI } from "../../stores/uiStore";
import type { TerminalRow } from "../../lib/ipc";

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
    ],
  );

  const { scope, text } = parseQuery(query);

  const results = useMemo(() => {
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
  }, [entries, scope, text]);

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
  let painted = -1;

  return (
    // Only the primary button closes: with the right one the gesture is "open the menu".
    <div className="busca-backdrop" onMouseDown={(e) => e.button === 0 && close()}>
      <div
        ref={dialogRef}
        className="busca"
        role="dialog"
        aria-modal="true"
        aria-label="Busca"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="busca-field">
          <Search size={15} className="busca-glass" aria-hidden="true" />
          {scope && <span className="busca-scope">{scope.label}</span>}
          <input
            ref={inputRef}
            className="busca-input"
            value={query}
            spellCheck={false}
            placeholder="Buscar agentes, arquivos, notas, ações…"
            aria-label="Buscar no workspace"
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
              {text
                ? `Nada encontrado para “${text}”.`
                : "Nada por aqui ainda — adicione um projeto para começar."}
              {/* The file rows come from the project index (every file under
                  the root, minus dependencies and build output) — "Nada
                  encontrado" is still not proof of absence: the file may live
                  in a skipped folder, or the index may have just been born. */}
              {scope?.prefix === "/" && text && (
                <span className="busca-empty-hint">
                  A busca cobre todos os arquivos do projeto, menos dependências
                  e saída de build (node_modules, target, dist…). Para procurar
                  por conteúdo, use a lupa da aba Arquivos (Ctrl+Shift+F).
                </span>
              )}
            </p>
          ) : (
            sections.map((section) => (
              <div className="busca-section" key={section.kind}>
                <div className="busca-section-head">{section.label}</div>
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
                <kbd>{s.prefix}</kbd> {s.label}
              </span>
            ))}
          </span>
          <span className="busca-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navega · <kbd>Enter</kbd> abre · <kbd>Esc</kbd> fecha
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
  portal: <Globe size={14} />,
  url: <Radio size={14} />,
  file: <FileText size={14} />,
  prompt: <Bookmark size={14} />,
  task: <ListTodo size={14} />,
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
    const project = group ? projectById.get(group.projectId) : undefined;
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
  for (const t of world.terminals) {
    const local = localOf(t.groupId);
    const runtime = world.runtimes[t.id];
    const waiting = runtime?.finished || runtime?.unread;
    const role = layoutOf(t.groupId).canvas?.roles?.[t.id];
    out.push({
      id: `terminal:${t.id}`,
      kind: "terminal",
      title: baseName(t),
      subtitle: [local.label, role?.name].filter(Boolean).join(" — "),
      // The role is searchable: "revisora" is how someone looks for the agent
      // whose name they never bothered to change.
      keywords: [t.program, t.agentId ?? "", t.cwd, role?.name ?? "", ...t.args],
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
      run: () => goToTerminal(t),
    });
  }

  // --- groups and floors ---------------------------------------------------
  for (const g of world.groups) {
    const project = projectById.get(g.projectId);
    const floor = floorOf(g.id);
    const isFloor = floor.kind !== "ground";
    out.push({
      id: `group:${g.id}`,
      kind: "group",
      title: g.name,
      subtitle: [
        project?.name,
        isFloor ? `andar${floor.branch ? ` · ${floor.branch}` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [isFloor ? "andar floor worktree" : "grupo", floor.branch ?? ""],
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
      keywords: ["projeto", p.path],
      weight: p.id === world.activeProjectId ? W_PROJECT : 0,
      run: () => useProjects.getState().setActiveProject(p.id),
    });
  }

  // --- addresses the terminals announced -----------------------------------
  for (const t of world.terminals) {
    const local = localOf(t.groupId);
    for (const url of world.served[t.id] ?? []) {
      out.push({
        id: `url:${t.id}:${url.origin}`,
        kind: "url",
        title: url.origin,
        subtitle: `servido por ${baseName(t)} — ${local.label}`,
        keywords: ["porta", String(url.port), "localhost", "servidor", "portal"],
        hint: "abrir portal",
        weight: local.weight + W_RUNNING,
        run: () => {
          void spawnPortalNear({
            groupId: t.groupId,
            url: url.origin,
            nearTerminalId: t.id,
          }).catch((e) =>
            useUI.getState().showToast(`Não consegui abrir o portal: ${e}`, "error"),
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
          keywords: [item.text.slice(0, 600), item.locked ? "travada" : ""],
          weight: local.weight,
          run: () => goToCanvasItem(g.id, item.id),
        });
      } else if (item.type === "portal") {
        out.push({
          id: `portal:${item.id}`,
          kind: "portal",
          title: portalName(item),
          subtitle: `${item.url} — ${local.label}`,
          keywords: [item.url, item.engine ?? "", "portal navegador"],
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
        keywords: [file.status, "alterado git"],
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
        keywords: ["tocado recente feed"],
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
      hint: "compositor",
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
      keywords: ["tarefa bancada", owner?.name ?? "global"],
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
        theNotebook || "sem caderno",
        memo.status !== "none" ? STATUS_META[memo.status].label.toLowerCase() : null,
      ]
        .filter(Boolean)
        .join(" · "),
      // The body is searchable but not shown — same rule as the canvas notes.
      keywords: [memo.body.slice(0, 600), "anotacao caderno"],
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
    .catch((e) => useUI.getState().showToast(`Não consegui abrir: ${e}`, "error"));
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
      title: "Nova aba",
      subtitle: "CLI, shell ou navegador no grupo ativo",
      keywords: ["criar", "cli", "claude", "codex", "shell", "terminal", "navegador"],
      hint: "Ctrl+T",
      weight: 40,
      run: () => ui().openModal("new-terminal"),
    },
    {
      id: "action:new-portal",
      kind: "action",
      title: "Novo portal",
      subtitle: "navegador no canvas",
      keywords: ["criar", "browser", "site", "url"],
      weight: 20,
      run: () => ui().openModal("new-portal"),
    },
    ...(hasGroup
      ? [
          {
            id: "action:new-browser-tab",
            kind: "action" as const,
            title: "Novo navegador no painel",
            subtitle: "aba de browser ao lado das CLIs",
            keywords: ["criar", "browser", "navegador", "aba", "site", "url"],
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
      title: "Adicionar projeto",
      subtitle: "abrir uma pasta como projeto",
      keywords: ["criar", "pasta", "repositorio"],
      run: () => ui().openModal("new-project"),
    },
    {
      id: "action:new-floor",
      kind: "action",
      title: "Novo andar",
      subtitle: "worktree isolado para uma tarefa",
      keywords: ["criar", "floor", "worktree", "branch", "git"],
      weight: 20,
      run: () => ui().openModal("new-floor", { projectId: world.activeProjectId }),
    },
    {
      id: "action:new-task",
      kind: "action",
      title: "Nova tarefa",
      subtitle: "mesmo pedido para N agentes, cada um no seu andar",
      keywords: ["fanout", "fan-out", "frota", "paralelo", "worktree", "tarefa"],
      weight: 25,
      run: () => ui().openModal("new-task", { projectId: world.activeProjectId }),
    },
    {
      id: "action:compare-floors",
      kind: "action",
      title: "Comparar andares",
      subtitle: "diffstat lado a lado e aterrissar o vencedor",
      keywords: ["merge", "aterrissar", "land", "vencedor", "diff"],
      weight: 24,
      run: () =>
        ui().openModal("compare-floors", { projectId: world.activeProjectId }),
    },
    {
      id: "action:composer",
      kind: "action",
      title: "Compositor de prompts",
      subtitle: "escrever um prompt longo fora do terminal",
      keywords: ["prompt", "escrever", "enviar"],
      hint: "Ctrl+Enter",
      weight: 30,
      run: () => ui().setComposerOpen(true),
    },
    {
      id: "action:bench",
      kind: "action",
      title: "Bancada",
      subtitle: "tarefas e biblioteca de prompts",
      keywords: ["painel", "prompts", "tarefas"],
      hint: "Ctrl+Shift+B",
      run: () => useBench.getState().toggle(),
    },
    {
      id: "action:files",
      kind: "action",
      title: "Árvore de arquivos",
      subtitle: "explorador do projeto",
      keywords: ["explorer", "pastas", "editor"],
      hint: "Ctrl+Shift+E",
      run: () => useBench.getState().openTab("files"),
    },
    {
      id: "action:search",
      kind: "action",
      title: "Buscar no projeto",
      subtitle: "texto em todos os arquivos",
      keywords: ["grep", "find", "procurar", "conteudo", "search"],
      hint: "Ctrl+Shift+F",
      run: () => useBench.getState().openTab("search"),
    },
    {
      id: "action:changes",
      kind: "action",
      title: "Alterações",
      subtitle: "git status e diff por arquivo",
      keywords: ["git", "diff", "mudancas", "painel"],
      hint: "Ctrl+Shift+D",
      run: () => useChanges.getState().toggle(),
    },
    {
      id: "action:memos",
      kind: "action",
      title: "Anotações",
      subtitle: "o caderno de notas markdown — cadernos, etiquetas e status",
      keywords: ["nota", "caderno", "markdown", "md", "etiqueta", "anotacao", "notebook"],
      hint: "Ctrl+Shift+N",
      weight: 20,
      run: () => useNotes.getState().openView(),
    },
    {
      id: "action:memo-new",
      kind: "action",
      title: "Nova anotação",
      subtitle: "cria uma nota e já abre para escrever",
      keywords: ["nota", "nova", "criar", "anotacao", "markdown"],
      run: () => {
        useNotes.getState().openView();
        useNotes.getState().createNote();
      },
    },
    {
      id: "action:memo-dock",
      kind: "action",
      title: "Anotações em aba",
      subtitle: "o caderno vira uma aba do painel em foco",
      keywords: ["nota", "caderno", "aba", "painel", "dock", "anotacao"],
      run: () => useNotes.getState().dockHere(),
    },
    {
      id: "action:memo-center",
      kind: "action",
      title: "Anotações na área central",
      subtitle: "o caderno ocupa todo o espaço do workspace",
      keywords: ["nota", "caderno", "central", "tela", "expandir", "anotacao"],
      run: () => useNotes.getState().setPlaceKind("center"),
    },
    {
      id: "action:sidebar",
      kind: "action",
      title: "Barra lateral",
      subtitle: "projetos e grupos",
      keywords: ["esconder", "mostrar", "painel"],
      hint: "Ctrl+B",
      run: () => ui().toggleSidebar(),
    },
    {
      id: "action:routines",
      kind: "action",
      title: "Rotinas…",
      subtitle: "prompts agendados do grupo",
      keywords: ["agendar", "lembrete", "repetir"],
      run: () => ui().openModal("routines"),
    },
    {
      id: "action:scores",
      kind: "action",
      title: "Partituras…",
      subtitle: "salvar e reaplicar o arranjo do grupo",
      keywords: ["layout", "arranjo", "template"],
      run: () => ui().openModal("scores"),
    },
    {
      id: "action:extensions",
      kind: "action",
      title: "Extensões",
      subtitle: "a loja — ativar e desativar recursos",
      keywords: ["loja", "plugins", "temas", "icones", "symbols", "store"],
      hint: "Ctrl+Shift+X",
      run: () => ui().openModal("extensions"),
    },
    {
      id: "action:preferences",
      kind: "action",
      title: "Configurações",
      subtitle: "fonte, renderer, scrollback, avisos, atalhos, extensões",
      keywords: ["config", "ajustes", "opcoes", "settings", "preferencias"],
      hint: "Ctrl+Shift+P",
      run: () => ui().openModal("preferences"),
    },
    {
      id: "action:agentes",
      kind: "action",
      title: "Agentes — como cada CLI abre",
      subtitle: "a linha de comando fixa de cada agente, e o “sem pedir permissão”",
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
      title: "Atalhos de teclado",
      keywords: ["teclas", "ajuda", "keybindings"],
      hint: "Ctrl+Shift+H",
      run: () => ui().openModal("shortcuts"),
    },
  ];

  if (project) {
    rows.push({
      id: "action:sessions",
      kind: "action",
      title: "Sessões anteriores",
      subtitle: `retomar uma sessão de agente em ${project.name}`,
      keywords: ["resume", "retomar", "historico", "claude", "codex"],
      run: () => ui().openModal("sessions", { projectPath: project.path }),
    });
  }

  if (hasGroup) {
    const groupId = world.activeGroupId!;
    const current = useProjects.getState().layoutOf(groupId).mode;
    const modes: { mode: LayoutMode; label: string; hint: string }[] = [
      { mode: "canvas", label: "Modo canvas", hint: "cartões num quadro infinito" },
      { mode: "auto", label: "Modo automático", hint: "a grade se ajusta sozinha" },
      { mode: "grid", label: "Modo grade", hint: "número fixo de painéis" },
      { mode: "spotlight", label: "Modo holofote", hint: "um grande, o resto pequeno" },
    ];
    for (const m of modes) {
      if (m.mode === current) continue;
      rows.push({
        id: `action:layout-${m.mode}`,
        kind: "action",
        title: m.label,
        subtitle: m.hint,
        keywords: ["layout", "modo", "grupo"],
        weight: m.mode === "canvas" ? 10 : 0,
        run: () => useProjects.getState().updateLayout(groupId, { mode: m.mode }),
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
      title: "Ao Vivo",
      subtitle: `acompanhar ${baseName(focused)} passo a passo`,
      keywords: ["overlay", "sessao", "mission control", "feed"],
      icon: <Layers size={14} />,
      weight: 25,
      run: () => {
        void useLive
          .getState()
          .openFor(focused)
          .catch((e) =>
            useUI.getState().showToast(`Não consegui abrir o Ao Vivo: ${e}`, "error"),
          );
      },
    });
  }

  return rows;
}
