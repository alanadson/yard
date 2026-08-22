/**
 * Bench — the right-edge utility panel (Ctrl+Shift+B), mirror of the left
 * sidebar: it disappears entirely when closed and comes back at the width it
 * was left at. Three tabs:
 *
 * - **Files**: the active project's tree (the active floor's, when there is
 *   one), in the usual shape — a click opens the file in the editor, right
 *   click creates, renames and deletes. The data lives in `editorStore`.
 * - **Tasks**: the *user's* list (not the agents') — jotting down the next
 *   step without stepping away from the terminals. Reorders by dragging,
 *   edits inline, priority flag, completed ones stay within reach to uncheck.
 * - **Prompts**: the library of reusable prompts — title, tags,
 *   `{{like this}}` variables filled in at use time; each card copies, edits
 *   in place (the pencil) or injects straight into the focused terminal (the
 *   same injection as `yard ask`, via bracketed paste). Opening in the
 *   composer — which needs no terminal: the destination is chosen there —
 *   lives in the ⋯ menu, wearing the same icon the panes use for it.
 *
 * The panel is a *floating* pane of glass: it sits inset
 * from the window's edges on a 24px radius, with the terminals visible around
 * and behind it, instead of the flush side wall it used to be. Everything
 * inside speaks the same two shapes — capsules for controls, inset rounded
 * cards for lists (`heading.ts` owns the one rule the header carries).
 *
 * The tab strip is icon-only, like an IDE navigator bar: folder,
 * checklist and book, each naming itself via tooltip. Project-wide search is
 * not a fourth tab anymore — it is the magnifier inside Files (still the
 * `search` tab in `benchStore`, so Ctrl+Shift+F and the palette keep working).
 *
 * The panel owns only the gesture; the data lives in `benchStore` (kv/SQLite).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./bench.css";
import "../CodeEditor/editor.css";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  BookMarked,
  CalendarClock,
  CalendarX,
  Check,
  ChevronDown,
  Copy,
  CopyPlus,
  Flag,
  Folder,
  GitBranch,
  Globe,
  GripVertical,
  ListTodo,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Send,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import {
  benchPromptsPaneMenu,
  benchTasksPaneMenu,
} from "../../lib/benchMenu";
import { captureTextTarget } from "../../lib/textMenu";
import { benchHeading, type BenchTab as BenchTabId } from "./heading";
import { FilesPane } from "./FilesPane";
import { ScmPane } from "./ScmPane";
import { SearchPane } from "./SearchPane";
import { Resizer } from "../Resizer";
import { injectPrompt } from "../../lib/inject";
import { sendability } from "../../lib/sendable";
import { copyText } from "../../lib/clipboard";
import {
  dueLabel,
  fillVars,
  promptVars,
  relevantTasks,
  startOfDay,
  taskInScope,
  useBench,
  type BenchPrompt,
  type BenchTask,
  type TaskFilter,
} from "../../stores/benchStore";
import { useChanges } from "../../stores/changesStore";
import { useEditor } from "../../stores/editorStore";
import { projectIcon } from "../../lib/projectStyle";
import { useProjects } from "../../stores/projectsStore";
import {
  useUI,
  BENCH_MAX,
  BENCH_MIN,
  DEFAULT_PREFS,
} from "../../stores/uiStore";

export function BenchPanel() {
  const tab = useBench((s) => s.tab);
  const setTab = useBench((s) => s.setTab);
  const toggle = useBench((s) => s.toggle);
  const wantsFocus = useBench((s) => s.wantsFocus);
  const clearFocus = useBench((s) => s.clearFocus);
  // Only what concerns the project on screen (plus the global ones): a badge
  // counting another project's list is a nag about work that is not here.
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const tasks = useBench((s) => s.tasks);
  const taskFilter = useBench((s) => s.taskFilter);
  const pendingCount = useMemo(
    () =>
      relevantTasks(tasks, activeProjectId).reduce((n, t) => n + (t.done ? 0 : 1), 0),
    [tasks, activeProjectId],
  );
  const promptCount = useBench((s) => s.prompts.length);
  // How many open files have unsaved changes — the same warning the tab
  // shows, visible even when it is not the active one.
  const unsavedCount = useEditor(
    (s) => s.docs.filter((d) => d.text !== d.saved && !d.binary && !d.truncated).length,
  );

  const width = useUI((s) => s.prefs.benchWidth);
  const setPref = useUI((s) => s.setPref);
  const setPrefLocal = useUI((s) => s.setPrefLocal);

  // Each increment tells the active tab to focus its input field — fired by a
  // deliberate open (shortcut/button) and by clicking the tabs.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (wantsFocus) {
      setFocusTick((t) => t + 1);
      clearFocus();
    }
  }, [wantsFocus, clearFocus]);

  const pickTab = (next: BenchTabId) => {
    setTab(next);
    setFocusTick((t) => t + 1);
  };

  // The header states what the open tab is looking at. The scope it names has
  // to be the one `TasksPane` actually shows — which is not always the one
  // stored, since "Projeto" falls back to "Globais" when nothing is open.
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const scope: TaskFilter = taskFilter === "project" && !project ? "global" : taskFilter;
  // What the Source control tab has to say in the subtitle: the branch and
  // how many files are modified. It comes from the same `git status` the
  // files panel uses — the header cannot count differently from the list.
  const scmSummary = useChanges((st) =>
    activeProjectId ? st.gitByProject[activeProjectId] : undefined,
  );
  const changedCount = scmSummary?.isRepo ? scmSummary.files.length : 0;
  const heading = benchHeading(tab, {
    pending: tasks.reduce(
      (n, t) => n + (!t.done && taskInScope(t, scope, activeProjectId) ? 1 : 0),
      0,
    ),
    scopeName:
      scope === "project" ? (project?.name ?? "") : scope === "global" ? "Globais" : "Todas",
    unsaved: unsavedCount,
    promptCount,
    projectName: project?.name ?? null,
    scm: scmSummary
      ? {
          isRepo: scmSummary.isRepo,
          branch: scmSummary.branch ?? "sem branch",
          changes: scmSummary.files.length,
        }
      : null,
  });

  return (
    <aside
      className="bench"
      style={{ width }}
      aria-label="Bancada — arquivos, controle de versão, tarefas e prompts"
    >
      <Resizer
        side="left"
        width={width}
        min={BENCH_MIN}
        max={BENCH_MAX}
        defaultWidth={DEFAULT_PREFS.benchWidth}
        label="Largura da bancada"
        onResize={(w) => setPrefLocal("benchWidth", w)}
        onCommit={(w) => setPref("benchWidth", w)}
      />

      <div className="bench-glass">
        <div className="bench-header">
          <div className="bench-heading">
            <h2 className="bench-title">{heading.title}</h2>
            <p className="bench-subtitle">{heading.subtitle}</p>
          </div>
          <button
            className="bench-close"
            data-tip-at="right"
            data-tip="Fechar (Ctrl+Shift+B)"
            aria-label="Fechar a bancada"
            onClick={toggle}
          >
            <X size={12} />
          </button>
        </div>

        {/* Icon-only tabs, each named by tooltip + aria-label; the badge detail
            (unsaved, pending) rides in both so the number is never mute. Search
            lives *inside* Files, so the folder stays lit while searching. The
            strip is a capsule segmented control — the same instrument as the
            scope filter below it, one shape language down the whole panel. */}
        <div className="bench-tabs" role="tablist" aria-label="Seções da bancada">
          <button
            role="tab"
            aria-selected={tab === "files" || tab === "search"}
            className={tab === "files" || tab === "search" ? "is-active" : ""}
            data-tip={
              unsavedCount > 0
                ? `Arquivos — ${unsavedCount} não salvo(s) (Ctrl+Shift+E)`
                : "Arquivos (Ctrl+Shift+E)"
            }
            aria-label={
              unsavedCount > 0
                ? `Arquivos, ${unsavedCount} com alteração não salva`
                : "Arquivos"
            }
            onClick={() => pickTab("files")}
          >
            <Folder size={14} aria-hidden="true" />
            {unsavedCount > 0 && (
              <span className="bench-count bench-count--warn" aria-hidden="true">
                {unsavedCount}
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={tab === "scm"}
            className={tab === "scm" ? "is-active" : ""}
            data-tip={
              changedCount > 0
                ? `Controle — ${changedCount} arquivo(s) mexido(s) (Ctrl+Shift+R)`
                : "Controle de versão (Ctrl+Shift+R)"
            }
            aria-label={
              changedCount > 0
                ? `Controle de versão, ${changedCount} arquivo(s) mexido(s)`
                : "Controle de versão"
            }
            onClick={() => pickTab("scm")}
          >
            <GitBranch size={14} aria-hidden="true" />
            {changedCount > 0 && (
              <span className="bench-count" aria-hidden="true">
                {changedCount}
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={tab === "tasks"}
            className={tab === "tasks" ? "is-active" : ""}
            data-tip={pendingCount > 0 ? `Tarefas — ${pendingCount} pendente(s)` : "Tarefas"}
            aria-label={
              pendingCount > 0 ? `Tarefas, ${pendingCount} pendente(s)` : "Tarefas"
            }
            onClick={() => pickTab("tasks")}
          >
            <ListTodo size={14} aria-hidden="true" />
            {pendingCount > 0 && (
              <span className="bench-count" aria-hidden="true">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={tab === "prompts"}
            className={tab === "prompts" ? "is-active" : ""}
            data-tip={promptCount > 0 ? `Prompts — ${promptCount} na biblioteca` : "Prompts"}
            aria-label={
              promptCount > 0 ? `Prompts, ${promptCount} na biblioteca` : "Prompts"
            }
            onClick={() => pickTab("prompts")}
          >
            <BookMarked size={14} aria-hidden="true" />
          </button>
        </div>

        {tab === "files" ? (
          <FilesPane focusTick={focusTick} onSearch={() => pickTab("search")} />
        ) : tab === "search" ? (
          <SearchPane focusTick={focusTick} onClose={() => pickTab("files")} />
        ) : tab === "scm" ? (
          <ScmPane focusTick={focusTick} />
        ) : tab === "tasks" ? (
          <TasksPane focusTick={focusTick} />
        ) : (
          <PromptsPane focusTick={focusTick} />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Tasks tab
// ---------------------------------------------------------------------------

const PRIO_LABEL = ["Sem prioridade", "Prioridade baixa", "Prioridade média", "Prioridade alta"];

/** Deadlines worth a single click; anything else goes through the date field. */
const DUE_QUICK: { id: string; label: string; days: number }[] = [
  { id: "today", label: "Hoje", days: 0 },
  { id: "tomorrow", label: "Amanhã", days: 1 },
  { id: "week", label: "Em uma semana", days: 7 },
];

/** Local midnight `days` from today — what the quick deadlines resolve to. */
function inDays(days: number): number {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return startOfDay(d.getTime());
}

/** `dueAt` as the `yyyy-mm-dd` the date field speaks, in local time. */
function toDateField(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * The date field back into an instant. Built from the parts on purpose:
 * `Date.parse("2026-08-20")` reads UTC, which lands on the day before for
 * anyone west of Greenwich — including here.
 */
function fromDateField(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Sends text to the terminal the user last clicked, complaining precisely
 * when it cannot. Shared by the prompt cards and the task menu — both mean
 * the same thing by "enviar": the focused terminal, via bracketed paste.
 */
async function injectIntoFocused(text: string): Promise<boolean> {
  const showToast = useUI.getState().showToast;
  const targetId = useUI.getState().focusedTerminalId;
  const target = useProjects.getState().terminals.find((t) => t.id === targetId);
  if (!targetId || !target) {
    showToast(
      "Clique num terminal primeiro — o texto vai para o que estiver em foco.",
      "error",
    );
    return false;
  }
  // Alive is not the question — ready is. A prompt pushed into a CLI that is
  // mid-task arrives split, and one pushed into a CLI frozen on a question
  // becomes the answer to it (`injectPrompt` ends with Enter). The text is
  // still in the card either way, so refusing costs the user nothing.
  const ready = sendability(targetId);
  if (!ready.ok) {
    showToast(ready.message ?? "O terminal em foco não pode receber agora.", "error");
    return false;
  }
  try {
    await injectPrompt(targetId, text);
  } catch (e) {
    showToast(`Falha ao enviar: ${e}`, "error");
    return false;
  }
  showToast(`Enviado para ${target.title ?? target.program}.`);
  return true;
}

function TasksPane({ focusTick }: { focusTick: number }) {
  const tasks = useBench((s) => s.tasks);
  const filter = useBench((s) => s.taskFilter);
  const setFilter = useBench((s) => s.setTaskFilter);
  const addTask = useBench((s) => s.addTask);
  const clearDone = useBench((s) => s.clearDone);
  const projects = useProjects((s) => s.projects);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const hasTarget = useUI((s) => !!s.focusedTerminalId);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  // Nothing is open: "Projeto" has nothing to show, and the global list is
  // the honest fallback — an empty screen would look like data loss.
  const scope: TaskFilter = filter === "project" && !project ? "global" : filter;

  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [showDone, setShowDone] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    { task: BenchTask; anchor: MenuAnchor } | { entries: MenuEntry[]; anchor: MenuAnchor } | null
  >(null);
  /**
   * Where the next task lands. `null` = follow what is on screen, which is
   * what you mean nine times out of ten; picking the other scope sticks until
   * the view itself changes.
   */
  const [wantGlobal, setWantGlobal] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Order at the start of the drag — Esc mid-gesture returns to it. */
  const dragSnapshot = useRef<BenchTask[] | null>(null);

  const newGlobal = !project ? true : (wantGlobal ?? scope === "global");
  useEffect(() => setWantGlobal(null), [scope, activeProjectId]);

  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);

  const beginDrag = (id: string) => {
    dragSnapshot.current = useBench.getState().tasks;
    setDragId(id);
  };

  const finishDrag = (cancelled: boolean) => {
    if (cancelled && dragSnapshot.current) {
      useBench.getState().restoreTasks(dragSnapshot.current);
    } else {
      useBench.getState().commitTasks();
    }
    dragSnapshot.current = null;
    setDragId(null);
  };

  const inScope = useMemo(
    () => tasks.filter((t) => taskInScope(t, scope, activeProjectId)),
    [tasks, scope, activeProjectId],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? inScope.filter((t) => t.text.toLowerCase().includes(needle)) : inScope;
  }, [inScope, q]);

  const pending = shown.filter((t) => !t.done);
  const done = useMemo(
    () =>
      shown.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
    [shown],
  );

  /** Alt+↑/↓ — the same drag reorder, from the keyboard. */
  const keyMove = (id: string, dir: -1 | 1) => {
    const idx = pending.findIndex((t) => t.id === id);
    const target = pending[idx + dir];
    if (idx < 0 || !target) return;
    useBench.getState().moveTask(id, target.id, dir === -1);
    useBench.getState().commitTasks();
  };

  /** Pending counts per scope — what the segments carry. */
  const counts = useMemo(() => {
    let mine = 0;
    let global = 0;
    let all = 0;
    for (const t of tasks) {
      if (t.done) continue;
      all += 1;
      if (t.projectId === null) global += 1;
      else if (t.projectId === activeProjectId) mine += 1;
    }
    return { project: mine, global, all };
  }, [tasks, activeProjectId]);

  // The search only appears once the list is long enough to need it: two text
  // fields stacked over three tasks is a form, not a to-do list.
  const searchable = inScope.length >= 8 || q.trim().length > 0;

  const submit = () => {
    const clean = text.trim();
    if (!clean) return;
    const projectId = newGlobal ? null : (project?.id ?? null);
    const id = addTask(clean, { projectId });
    setText("");
    // Adding something the current view hides would read as a task that never
    // got written. Widen the filter (and drop the search) instead.
    if (scope !== "all" && (scope === "global") !== (projectId === null)) {
      setFilter("all");
    }
    if (q.trim() && !clean.toLowerCase().includes(q.trim().toLowerCase())) setQ("");
    setFreshId(id);
  };

  const chips: { id: TaskFilter; label: string; count: number; tip: string }[] = [
    ...(project
      ? [
          {
            id: "project" as TaskFilter,
            label: project.name,
            count: counts.project,
            tip: `Só as tarefas de ${project.name}`,
          },
        ]
      : []),
    {
      id: "global",
      label: "Globais",
      count: counts.global,
      tip: "Tarefas que seguem você em todos os projetos",
    },
    { id: "all", label: "Todas", count: counts.all, tip: "Tudo, de todos os projetos" },
  ];

  const ScopeIcon = projectIcon(project?.icon);

  /** Right-click on the panel's background speaks of the *list*, not of a task. */
  const openPaneMenu = (e: React.MouseEvent) => {
    // In a text field the right menu is cut/paste: let it bubble up to the
    // global net instead of answering with the panel's menu.
    if (captureTextTarget(e.nativeEvent).info.editable) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      entries: benchTasksPaneMenu(
        { scope, doneCount: done.length, showDone, hasProject: !!project },
        {
          newTask: () => inputRef.current?.focus(),
          setScope: setFilter,
          setShowDone,
          clearDone: () => {
            if (done.length === 1) {
              clearDone(done.map((t) => t.id));
              return;
            }
            void ask(
              `Apagar ${done.length} tarefas concluídas desta lista? Não dá para desfazer.`,
              { title: "Limpar concluídas", kind: "warning" },
            ).then((ok) => {
              if (ok) clearDone(done.map((t) => t.id));
            });
          },
        },
      ),
    });
  };

  return (
    <div
      className="bench-body bench-body--tasks"
      role="tabpanel"
      aria-label="Tarefas"
      onContextMenu={openPaneMenu}
    >
      <form
        className="task-add"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Plus size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          value={text}
          placeholder={
            newGlobal
              ? "Nova tarefa global… Enter adiciona"
              : `Nova tarefa em ${project?.name ?? ""}… Enter adiciona`
          }
          aria-label={newGlobal ? "Nova tarefa global" : `Nova tarefa em ${project?.name}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (text) setText("");
              else e.currentTarget.blur();
            }
          }}
        />
        {project && (
          <button
            type="button"
            className={`task-scope ${newGlobal ? "is-global" : ""}`}
            data-tip={
              newGlobal
                ? `Global — clique para guardar em ${project.name}`
                : `${project.name} — clique para guardar como global`
            }
            aria-label={`Destino da nova tarefa: ${newGlobal ? "global" : project.name}`}
            onClick={() => setWantGlobal(!newGlobal)}
          >
            {newGlobal ? <Globe size={14} /> : <ScopeIcon size={14} />}
          </button>
        )}
      </form>

      {projects.length > 0 && (
        <div className="task-seg" role="group" aria-label="Escopo das tarefas">
          {chips.map((c) => (
            <button
              key={c.id}
              className={scope === c.id ? "is-active" : ""}
              data-tip={c.tip}
              aria-pressed={scope === c.id}
              onClick={() => setFilter(c.id)}
            >
              {/* No icon: on a capsule this narrow the three labels are
                  already the whole distinction, and the glyph only ate the
                  room a project's name needs. */}
              <span className="task-seg-label">{c.label}</span>
              {c.count > 0 && <span className="task-seg-count">{c.count}</span>}
            </button>
          ))}
        </div>
      )}

      {searchable && (
        <div className="bench-search task-search">
          <Search size={12} aria-hidden="true" />
          <input
            ref={searchRef}
            value={q}
            placeholder="Filtrar tarefas"
            aria-label="Filtrar tarefas"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (q) setQ("");
                else e.currentTarget.blur();
              }
            }}
          />
          {q && (
            <button
              className="icon-btn"
              aria-label="Limpar o filtro"
              onClick={() => {
                setQ("");
                searchRef.current?.focus();
              }}
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="bench-empty">
          <ListTodo size={20} aria-hidden="true" />
          {q.trim() ? (
            <>Nada encontrado para “{q.trim()}”.</>
          ) : scope === "project" ? (
            <>
              Nada por fazer em {project?.name}.
              <small>
                O que você anotar aqui só aparece com este projeto aberto — use
                o botão ao lado do campo para guardar uma tarefa global.
              </small>
            </>
          ) : scope === "global" ? (
            <>
              Nenhuma tarefa global.
              <small>
                Globais seguem você em todos os projetos — bom para o que não é
                de um código só.
              </small>
            </>
          ) : (
            <>
              Nada por fazer.
              <small>
                Anote aqui os próximos passos enquanto os agentes trabalham — a
                lista sobrevive ao fechar o Yard.
              </small>
            </>
          )}
        </div>
      ) : (
        <>
          {/* The list is an inset rounded card, grouped-list style: the
              rows share one surface and are separated by hairlines instead of
              each floating on its own. "Tudo concluído." belongs inside it —
              an empty card with a note under it would read as two things. */}
          <ul className="task-list">
            {pending.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                project={projects.find((p) => p.id === t.projectId)}
                showScope={scope === "all"}
                fresh={t.id === freshId}
                onFreshEnd={() => setFreshId(null)}
                dragId={dragId}
                onDragBegin={beginDrag}
                onDragFinish={finishDrag}
                onKeyMove={keyMove}
                onMenu={(anchor) => setMenu({ task: t, anchor })}
              />
            ))}
            {pending.length === 0 && (
              <li className="task-list-note">Tudo concluído.</li>
            )}
          </ul>

          {done.length > 0 && (
            <section className="task-done">
              <div className="task-done-head">
                <button
                  className="bench-subhead"
                  aria-expanded={showDone}
                  onClick={() => setShowDone((v) => !v)}
                >
                  {/* One chevron that turns, not two that swap: the rotation
                      is the animation the collapse never had. */}
                  <span
                    className={`task-done-chev ${showDone ? "" : "is-closed"}`}
                    aria-hidden="true"
                  >
                    <ChevronDown size={11} strokeWidth={2.5} />
                  </span>
                  Concluídas
                  <span className="task-done-count">{done.length}</span>
                </button>
                <button
                  className="task-done-clear"
                  data-tip={`Apagar ${done.length} tarefa(s) concluída(s) desta lista`}
                  // Only what is on screen: the button sits under a filtered
                  // section and must not reach another project's history.
                  //
                  // And it asks: deleting one task is a click you can undo
                  // from memory (you retype it), deleting twenty at once is
                  // not — the done list is the record of what got done, and
                  // it vanishes through a tidy-up button.
                  onClick={() => {
                    if (done.length === 1) {
                      clearDone(done.map((t) => t.id));
                      return;
                    }
                    void ask(
                      `Apagar ${done.length} tarefas concluídas desta lista? Não dá para desfazer.`,
                      { title: "Limpar concluídas", kind: "warning" },
                    ).then((ok) => {
                      if (ok) clearDone(done.map((t) => t.id));
                    });
                  }}
                >
                  Limpar
                </button>
              </div>
              {showDone && (
                <ul className="task-list task-list--done">
                  {done.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      project={projects.find((p) => p.id === t.projectId)}
                      showScope={scope === "all"}
                      fresh={false}
                      onFreshEnd={() => {}}
                      dragId={null}
                      onDragBegin={() => {}}
                      onDragFinish={() => {}}
                      onKeyMove={() => {}}
                      onMenu={(anchor) => setMenu({ task: t, anchor })}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={"task" in menu ? taskMenu(menu.task, projects, hasTarget) : menu.entries}
        />
      )}
    </div>
  );
}

/** The row's kebab: everything that does not fit as a button on 248px. */
function taskMenu(
  t: BenchTask,
  projects: { id: string; name: string }[],
  hasTarget: boolean,
): MenuEntry[] {
  const bench = () => useBench.getState();
  return [
    {
      id: "due",
      label: t.dueAt ? `Prazo: ${dueLabel(t.dueAt).text}` : "Definir prazo",
      icon: <CalendarClock size={13} />,
      submenu: [
        ...DUE_QUICK.map((o) => ({
          id: `due-${o.id}`,
          label: o.label,
          icon:
            t.dueAt === inDays(o.days) ? <Check size={13} /> : <span aria-hidden />,
          onSelect: () => bench().setTaskDue(t.id, inDays(o.days)),
        })),
        { kind: "sep" as const },
        {
          id: "due-none",
          label: "Sem prazo",
          icon: <CalendarX size={13} />,
          disabled: t.dueAt === null,
          onSelect: () => bench().setTaskDue(t.id, null),
        },
      ],
    },
    {
      id: "prio",
      label: PRIO_LABEL[t.priority],
      icon: <Flag size={13} />,
      submenu: ([0, 1, 2, 3] as const).map((p) => ({
        id: `prio-${p}`,
        label: PRIO_LABEL[p],
        icon: t.priority === p ? <Check size={13} /> : <span aria-hidden />,
        onSelect: () => bench().setPriority(t.id, p),
      })),
    },
    {
      id: "scope",
      label: "Mover para",
      icon: <Globe size={13} />,
      submenu: [
        {
          id: "scope-global",
          label: "Global (todos os projetos)",
          icon: t.projectId === null ? <Check size={13} /> : <Globe size={13} />,
          onSelect: () => bench().setTaskProject(t.id, null),
        },
        ...(projects.length > 0 ? [{ kind: "sep" as const }] : []),
        ...projects.map((p) => ({
          id: `scope-${p.id}`,
          label: p.name,
          icon: t.projectId === p.id ? <Check size={13} /> : <span aria-hidden />,
          onSelect: () => bench().setTaskProject(t.id, p.id),
        })),
      ],
    },
    { kind: "sep" },
    {
      id: "send",
      label: "Enviar ao terminal em foco",
      icon: <Send size={13} />,
      disabled: !hasTarget,
      onSelect: () => void injectIntoFocused(t.text),
    },
    {
      id: "composer",
      label: "Abrir no compositor",
      icon: <MessageSquarePlus size={13} />,
      onSelect: () => useUI.getState().sendToComposer(t.text),
    },
    {
      id: "dup",
      label: "Duplicar",
      icon: <CopyPlus size={13} />,
      onSelect: () => bench().duplicateTask(t.id),
    },
    { kind: "sep" },
    {
      id: "del",
      label: "Excluir",
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: () => bench().removeTask(t.id),
    },
  ];
}

function TaskRow({
  task: t,
  project,
  showScope,
  fresh,
  onFreshEnd,
  dragId,
  onDragBegin,
  onDragFinish,
  onKeyMove,
  onMenu,
}: {
  task: BenchTask;
  project: { name: string; icon?: string | null; color?: string | null } | undefined;
  showScope: boolean;
  fresh: boolean;
  onFreshEnd: () => void;
  dragId: string | null;
  onDragBegin: (id: string) => void;
  onDragFinish: (cancelled: boolean) => void;
  onKeyMove: (id: string, dir: -1 | 1) => void;
  onMenu: (anchor: MenuAnchor) => void;
}) {
  const toggleTask = useBench((s) => s.toggleTask);
  const renameTask = useBench((s) => s.renameTask);
  const cyclePriority = useBench((s) => s.cyclePriority);
  const setTaskDue = useBench((s) => s.setTaskDue);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.text);
  // Only the handle arms the drag: the rest of the row stays clickable to edit.
  const [armed, setArmed] = useState(false);

  // Releasing outside the handle also disarms — otherwise the next drag on
  // the text would turn into an accidental reorder.
  useEffect(() => {
    if (!armed) return;
    const off = () => setArmed(false);
    window.addEventListener("pointerup", off, true);
    return () => window.removeEventListener("pointerup", off, true);
  }, [armed]);

  // A live edit does not die with the panel: if the row unmounts midway (tab
  // switch, Ctrl+Shift+B), the typed text is saved. Empty does not save —
  // erasing because of a close would be a surprise, not an intention.
  const editRef = useRef({ editing: false, draft: "", original: t.text, id: t.id });
  editRef.current = { editing, draft, original: t.text, id: t.id };
  useEffect(
    () => () => {
      const e = editRef.current;
      if (e.editing && e.draft.trim() && e.draft.trim() !== e.original) {
        useBench.getState().renameTask(e.id, e.draft);
      }
    },
    [],
  );

  const startEdit = () => {
    setDraft(t.text);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (draft.trim() !== t.text) renameTask(t.id, draft);
  };

  const onDragOver = (e: DragEvent<HTMLLIElement>) => {
    if (!dragId || dragId === t.id || t.done) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    useBench.getState().moveTask(dragId, t.id, before);
  };

  return (
    <li
      className={[
        "task-row",
        t.done ? "task-row--done" : "",
        dragId === t.id ? "is-drag" : "",
        fresh ? "is-fresh" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={armed}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
        onDragBegin(t.id);
      }}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={(e) => {
        setArmed(false);
        // Esc (or releasing outside the list) arrives here as dropEffect
        // "none": the gesture was a give-up, the order goes back to what it was.
        onDragFinish(e.dataTransfer.dropEffect === "none");
      }}
      onKeyDown={
        t.done || editing
          ? undefined
          : (e) => {
              if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                e.preventDefault();
                onKeyMove(t.id, e.key === "ArrowUp" ? -1 : 1);
              }
            }
      }
      onAnimationEnd={fresh ? onFreshEnd : undefined}
      // The same menu as the kebab, on the gesture the hand tries first.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* The handle lives *in* the row's left padding, absolutely, and only
          shows on hover: the grouped card wants a clean left edge at rest,
          and reserving a column for a control that is invisible most of the
          time was what pushed every task 14px to the right. Done rows have no
          handle — and now no gap to hide either. */}
      {!t.done && (
        <span
          className="task-grip"
          data-tip="Arrastar para reordenar"
          aria-hidden="true"
          onPointerDown={() => setArmed(true)}
        >
          <GripVertical size={12} />
        </span>
      )}
      <button
        className={`task-check ${t.done ? "is-done" : ""}`}
        role="checkbox"
        aria-checked={t.done}
        aria-label={t.done ? `Reabrir “${t.text}”` : `Concluir “${t.text}”`}
        onClick={() => toggleTask(t.id)}
      >
        {t.done && <Check size={12} strokeWidth={3} aria-hidden="true" />}
      </button>

      {editing ? (
        // Text and deadline are one field: `blur` between the two would close
        // the editor the moment the user reached for the date.
        <div
          className="task-editing"
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            commitEdit();
          }}
        >
          <input
            className="task-edit"
            value={draft}
            autoFocus
            aria-label="Editar tarefa"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") {
                setDraft(t.text);
                setEditing(false);
              }
            }}
          />
          <input
            type="date"
            className="task-date"
            value={t.dueAt ? toDateField(t.dueAt) : ""}
            data-tip="Prazo"
            aria-label={`Prazo de “${t.text}”`}
            // Applies on the spot: the date is its own decision, and losing it
            // to an Esc meant for the text would be a trap.
            onChange={(e) => setTaskDue(t.id, fromDateField(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") commitEdit();
            }}
          />
        </div>
      ) : (
        <button
          className={`task-text ${t.done ? "task-text--done" : ""}`}
          data-tip={t.done ? undefined : "Clique para editar · Alt+↑/↓ reordena"}
          aria-keyshortcuts={t.done ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
          onClick={t.done ? () => toggleTask(t.id) : startEdit}
        >
          <span className="task-text-line">
            {t.priority > 0 && (
              <span
                className="task-prio"
                data-tip={PRIO_LABEL[t.priority]}
                aria-label={PRIO_LABEL[t.priority]}
              >
                {"!".repeat(t.priority)}
              </span>
            )}
            {t.text}
          </span>
          {/* Deadline and scope get a quiet line of their own: on 248px, two
              short lines scan better than one crowded one. */}
          {((t.dueAt !== null && !t.done) || showScope) && (
            <span className="task-meta">
              {t.dueAt !== null && !t.done && <DueBadge dueAt={t.dueAt} />}
              {showScope && (
                <span
                  className="task-scope-tag"
                  data-tip={project ? `Tarefa de ${project.name}` : "Tarefa global"}
                  style={project?.color ? { color: project.color } : undefined}
                >
                  {project?.name ?? "global"}
                </span>
              )}
            </span>
          )}
        </button>
      )}

      {!t.done && !editing && (
        <button
          className={`icon-btn ${t.priority > 0 ? "is-flagged" : ""}`}
          data-tip={`${PRIO_LABEL[t.priority]} — clique alterna`}
          aria-label={`Alternar prioridade (atual: ${PRIO_LABEL[t.priority].toLowerCase()})`}
          onClick={() => cyclePriority(t.id)}
        >
          <Flag size={12} />
        </button>
      )}
      <button
        className="icon-btn"
        data-tip="Prazo, prioridade, escopo…"
        aria-label={`Mais ações de “${t.text}”`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu({ x: r.right, y: r.bottom + 4 });
        }}
      >
        <MoreHorizontal size={12} />
      </button>
    </li>
  );
}

/**
 * The deadline as a word — "hoje", "amanhã", "sex", "22/ago"; red once late.
 * A capsule with no glyph: at 9px the little clock was a smudge, and the word
 * it sat next to already said "date".
 */
function DueBadge({ dueAt }: { dueAt: number }) {
  const label = dueLabel(dueAt);
  return (
    <span
      className={`task-due task-due--${label.state}`}
      data-tip={label.full}
      aria-label={label.full}
    >
      {label.text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Prompts tab
// ---------------------------------------------------------------------------

type PromptAction = "copy" | "composer" | "send";

const ACTION_LABEL: Record<PromptAction, string> = {
  copy: "Copiar",
  composer: "Abrir no compositor",
  send: "Enviar agora",
};

function PromptsPane({ focusTick }: { focusTick: number }) {
  const prompts = useBench((s) => s.prompts);
  const markUsed = useBench((s) => s.markUsed);
  const showToast = useUI((s) => s.showToast);
  const hasTarget = useUI((s) => !!s.focusedTerminalId);

  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  /** `"new"` = new prompt editor at the top; otherwise the id being edited. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    | { prompt: BenchPrompt; anchor: MenuAnchor }
    | { entries: MenuEntry[]; anchor: MenuAnchor }
    | null
  >(null);
  const [fill, setFill] = useState<{ id: string; action: PromptAction } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (focusTick > 0) searchRef.current?.focus();
  }, [focusTick]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const allTags = useMemo(
    () =>
      [...new Set(prompts.flatMap((p) => p.tags))].sort((a, b) =>
        a.localeCompare(b, "pt-BR"),
      ),
    [prompts],
  );

  // The filtered tag may stop existing (its last prompt edited/deleted).
  useEffect(() => {
    if (tag && !allTags.includes(tag)) setTag(null);
  }, [tag, allTags]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return prompts
      .filter((p) => !tag || p.tags.includes(tag))
      .filter(
        (p) =>
          !needle ||
          `${p.title}\n${p.body}\n${p.tags.join(" ")}`.toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt,
      );
  }, [prompts, q, tag]);

  const runAction = async (
    p: BenchPrompt,
    action: PromptAction,
    values?: Record<string, string>,
  ) => {
    const text = values ? fillVars(p.body, values) : p.body;

    if (action === "copy") {
      const ok = await copyText(text);
      if (!ok) {
        showToast("Não consegui copiar para a área de transferência.", "error");
        return;
      }
      setCopiedId(p.id);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1400);
    } else if (action === "composer") {
      // No terminal needed: the composer takes the text into its scratch and
      // the destination is chosen there, whenever the user is done editing.
      useUI.getState().sendToComposer(text);
    } else if (!(await injectIntoFocused(text))) {
      return;
    }
    markUsed(p.id);
    setFill(null);
  };

  const requestAction = (p: BenchPrompt, action: PromptAction) => {
    if (promptVars(p.body).length > 0) {
      setFill((f) =>
        f?.id === p.id && f.action === action ? null : { id: p.id, action },
      );
      return;
    }
    void runAction(p, action);
  };

  const confirmDelete = async (p: BenchPrompt) => {
    const sure = await ask(`Excluir o prompt “${p.title}”? Não dá para desfazer.`, {
      title: "Excluir prompt",
      kind: "warning",
    });
    if (sure) useBench.getState().removePrompt(p.id);
  };

  const openPaneMenu = (e: React.MouseEvent) => {
    // In a text field the right menu is cut/paste: let it bubble up to the
    // global net instead of answering with the panel's menu.
    if (captureTextTarget(e.nativeEvent).info.editable) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      entries: benchPromptsPaneMenu(
        { tag, tags: allTags, query: q },
        {
          newPrompt: () => {
            setFill(null);
            setEditingId("new");
          },
          setTag,
          clearQuery: () => setQ(""),
        },
      ),
    });
  };

  return (
    <div
      className="bench-body"
      role="tabpanel"
      aria-label="Prompts"
      onContextMenu={openPaneMenu}
    >
      <div className="prompt-bar">
        <div className="bench-search">
          <Search size={12} aria-hidden="true" />
          <input
            ref={searchRef}
            value={q}
            placeholder="Buscar por título, texto ou tag"
            aria-label="Buscar prompts"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (q) setQ("");
                else e.currentTarget.blur();
              }
            }}
          />
          {q && (
            <button
              className="icon-btn"
              aria-label="Limpar a busca"
              onClick={() => {
                setQ("");
                searchRef.current?.focus();
              }}
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          className="btn btn--ghost btn--sm"
          data-tip="Guardar um prompt novo"
          onClick={() => setEditingId((id) => (id === "new" ? null : "new"))}
        >
          <Plus size={12} aria-hidden="true" /> Novo
        </button>
      </div>

      {allTags.length > 0 && (
        <div className="bench-chips" role="group" aria-label="Filtrar por tag">
          {allTags.map((name) => (
            <button
              key={name}
              className={`bench-chip ${tag === name ? "is-active" : ""}`}
              aria-pressed={tag === name}
              onClick={() => setTag((cur) => (cur === name ? null : name))}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {editingId === "new" && (
        <PromptEditor prompt={null} onClose={() => setEditingId(null)} />
      )}

      {prompts.length === 0 && editingId !== "new" ? (
        <div className="bench-empty">
          <BookMarked size={20} aria-hidden="true" />
          Nenhum prompt guardado.
          <small>
            Guarde aqui os prompts que você reutiliza — com título, tags e
            variáveis <code>{"{{assim}}"}</code> para preencher na hora de usar.
          </small>
          <button className="btn btn--sm" onClick={() => setEditingId("new")}>
            <Plus size={12} aria-hidden="true" /> Guardar o primeiro
          </button>
        </div>
      ) : visible.length === 0 && editingId !== "new" ? (
        <div className="bench-empty">
          Nada encontrado
          {q.trim() && <> para “{q.trim()}”</>}
          {tag && <> na tag “{tag}”</>}.
        </div>
      ) : (
        <ul className="prompt-list">
          {visible.map((p) =>
            editingId === p.id ? (
              <li key={p.id}>
                <PromptEditor
                  prompt={p}
                  onClose={() => setEditingId(null)}
                  onDelete={() => {
                    setEditingId(null);
                    void confirmDelete(p);
                  }}
                />
              </li>
            ) : (
              <PromptCard
                key={p.id}
                prompt={p}
                copied={copiedId === p.id}
                hasTarget={hasTarget}
                fill={fill?.id === p.id ? fill.action : null}
                onOpen={() => {
                  setFill(null);
                  setEditingId(p.id);
                }}
                onAction={(action) => requestAction(p, action)}
                onRun={(action, values) => void runAction(p, action, values)}
                onCancelFill={() => setFill(null)}
                onMenu={(anchor) => setMenu({ prompt: p, anchor })}
              />
            ),
          )}
        </ul>
      )}

      {menu && "entries" in menu && (
        <ContextMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={menu.entries}
        />
      )}
      {menu && "prompt" in menu && (
        <ContextMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            {
              id: "edit",
              label: "Editar",
              icon: <SquarePen size={13} />,
              onSelect: () => {
                setFill(null);
                setEditingId(menu.prompt.id);
              },
            },
            {
              id: "composer",
              label: "Abrir no compositor",
              icon: <MessageSquarePlus size={13} />,
              onSelect: () => requestAction(menu.prompt, "composer"),
            },
            { kind: "sep" },
            {
              id: "pin",
              label: menu.prompt.pinned ? "Desafixar" : "Fixar no topo",
              icon: <Pin size={13} />,
              onSelect: () => useBench.getState().togglePin(menu.prompt.id),
            },
            {
              id: "dup",
              label: "Duplicar",
              icon: <CopyPlus size={13} />,
              onSelect: () => {
                const id = useBench.getState().duplicatePrompt(menu.prompt.id);
                if (id) setEditingId(id);
              },
            },
            { kind: "sep" },
            {
              id: "del",
              label: "Excluir…",
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => void confirmDelete(menu.prompt),
            },
          ]}
        />
      )}
    </div>
  );
}

function PromptCard({
  prompt: p,
  copied,
  hasTarget,
  fill,
  onOpen,
  onAction,
  onRun,
  onCancelFill,
  onMenu,
}: {
  prompt: BenchPrompt;
  copied: boolean;
  hasTarget: boolean;
  fill: PromptAction | null;
  onOpen: () => void;
  onAction: (action: PromptAction) => void;
  onRun: (action: PromptAction, values: Record<string, string>) => void;
  onCancelFill: () => void;
  onMenu: (anchor: MenuAnchor) => void;
}) {
  const vars = promptVars(p.body);
  const noTargetTip = "Clique num terminal primeiro";

  return (
    <li
      className={`prompt-card ${p.pinned ? "is-pinned" : ""}`}
      // The same menu as the "⋯", on the gesture the hand tries first.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="prompt-card-head">
        <button
          className="prompt-card-open"
          data-tip-wrap=""
          data-tip={`“${p.title}” — clique para ver e editar`}
          onClick={onOpen}
        >
          {p.pinned && (
            <Pin size={10} className="prompt-pin" aria-label="Fixado" />
          )}
          <strong>{p.title}</strong>
        </button>
        <div className="prompt-card-actions">
          <button
            className={`icon-btn ${copied ? "is-copied" : ""}`}
            data-tip={copied ? "Copiado!" : "Copiar"}
            aria-label={`Copiar “${p.title}”`}
            onClick={() => onAction("copy")}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button
            className="icon-btn"
            data-tip="Editar"
            aria-label={`Editar “${p.title}”`}
            onClick={onOpen}
          >
            <SquarePen size={12} />
          </button>
          <button
            className="icon-btn icon-btn--go"
            data-tip={hasTarget ? "Enviar para o terminal em foco" : noTargetTip}
            aria-label={`Enviar “${p.title}” para o terminal em foco`}
            disabled={!hasTarget}
            onClick={() => onAction("send")}
          >
            <Send size={12} />
          </button>
          <button
            className="icon-btn"
            data-tip="Mais ações"
            aria-label={`Mais ações de “${p.title}”`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu({ x: r.right, y: r.bottom + 4 });
            }}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>

      {fill ? (
        <VarFill
          vars={vars}
          action={fill}
          onCancel={onCancelFill}
          onRun={(values) => onRun(fill, values)}
        />
      ) : (
        <>
          <p className="prompt-preview">{p.body}</p>
          {(p.tags.length > 0 || vars.length > 0 || p.uses > 0) && (
            <div className="prompt-meta">
              {p.tags.map((name) => (
                <span key={name} className="prompt-tag">
                  {name}
                </span>
              ))}
              {vars.map((v) => (
                <span
                  key={v}
                  className="prompt-var"
                  data-tip="Variável — preenchida na hora de usar"
                >
                  {"{{"}
                  {v}
                  {"}}"}
                </span>
              ))}
              {p.uses > 0 && (
                <span
                  className="prompt-uses"
                  data-tip={`Usado ${p.uses} vez(es)`}
                  role="img"
                  aria-label={`Usado ${p.uses} vez(es)`}
                >
                  {p.uses}×
                </span>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** Inline variable form: appears on the card when the action requires filling in. */
function VarFill({
  vars,
  action,
  onCancel,
  onRun,
}: {
  vars: string[];
  action: PromptAction;
  onCancel: () => void;
  onRun: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onRun(values);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="prompt-fill">
      <span className="prompt-fill-title">Preencha as variáveis</span>
      {vars.map((v, i) => (
        <label key={v} className="prompt-fill-row">
          <span>{v}</span>
          <input
            ref={i === 0 ? firstRef : undefined}
            value={values[v] ?? ""}
            placeholder={`{{${v}}}`}
            onChange={(e) => setValues((cur) => ({ ...cur, [v]: e.target.value }))}
            onKeyDown={onKeyDown}
          />
        </label>
      ))}
      <div className="prompt-fill-foot">
        <button className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn btn--primary btn--sm" onClick={() => onRun(values)}>
          {ACTION_LABEL[action]}
        </button>
      </div>
    </div>
  );
}

/**
 * Inline editor (new or existing). Saving is explicit — the Salvar button or
 * Ctrl+Enter — and Esc/Cancelar reverts, like every inline edit in the app.
 * The one exception: an unmount that bypasses both (tab switch, Ctrl+Shift+B,
 * a filter hiding the card) still saves a changed draft, because losing typed
 * text to an accident would be worse than saving too much.
 */
function PromptEditor({
  prompt,
  onClose,
  onDelete,
}: {
  prompt: BenchPrompt | null;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const [title, setTitle] = useState(prompt?.title ?? "");
  const [body, setBody] = useState(prompt?.body ?? "");
  const [tagsText, setTagsText] = useState(prompt?.tags.join(", ") ?? "");
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const stateRef = useRef({ title, body, tagsText });
  stateRef.current = { title, body, tagsText };
  /** Closed through Salvar/Cancelar — the unmount safety net must not write. */
  const doneRef = useRef(false);
  const initialRef = useRef({
    title: prompt?.title ?? "",
    body: prompt?.body ?? "",
    tagsText: prompt?.tags.join(", ") ?? "",
  });

  const dirty = () => {
    const cur = stateRef.current;
    const init = initialRef.current;
    return (
      cur.title !== init.title ||
      cur.body !== init.body ||
      cur.tagsText !== init.tagsText
    );
  };

  /** Writes the draft to the store; `false` = nothing worth keeping (all blank). */
  const commit = (values: { title: string; body: string; tagsText: string }) => {
    const tags = [
      ...new Set(
        values.tagsText
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    // An empty title inherits the body's first line — naming is optional.
    const fallback = values.body.trim().split("\n")[0]?.slice(0, 60) ?? "";
    const finalTitle = values.title.trim() || fallback || "Sem título";

    if (prompt) {
      useBench
        .getState()
        .updatePrompt(prompt.id, { title: finalTitle, body: values.body, tags });
      return true;
    }
    if (values.title.trim() || values.body.trim()) {
      useBench.getState().addPrompt({ title: finalTitle, body: values.body, tags });
      return true;
    }
    return false;
  };

  const save = () => {
    doneRef.current = true;
    // Saving an untouched editor is just a close — no write, no toast.
    if ((dirty() || !prompt) && commit(stateRef.current)) {
      useUI.getState().showToast("Prompt salvo.");
    }
    onClose();
  };

  const cancel = () => {
    doneRef.current = true;
    onClose();
  };

  // The safety net for closes that go through neither button: only an
  // actually changed draft writes — which also absorbs StrictMode's
  // simulated unmount in dev.
  useEffect(
    () => () => {
      if (doneRef.current || !dirty()) return;
      commit(stateRef.current);
    },
    // `commit` closes over `prompt`, which is stable for the editor's lifetime (key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const vars = promptVars(body);

  return (
    <div
      className="prompt-editor"
      role="group"
      aria-label={prompt ? `Editar “${prompt.title}”` : "Novo prompt"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="prompt-editor-head">
        <span className="prompt-editor-title">
          {prompt ? "Editar prompt" : "Novo prompt"}
        </span>
        <span className="bench-hint">Ctrl+Enter salva</span>
      </div>
      <input
        ref={titleRef}
        value={title}
        placeholder="Título do prompt"
        aria-label="Título do prompt"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          // Enter in the title means "next": down into the text, not submit.
          if (e.key === "Enter") {
            e.preventDefault();
            bodyRef.current?.focus();
          }
        }}
      />
      <textarea
        ref={bodyRef}
        value={body}
        rows={6}
        spellCheck={false}
        placeholder={"O texto do prompt…\nUse {{variável}} para campos a preencher na hora de usar."}
        aria-label="Texto do prompt"
        onChange={(e) => setBody(e.target.value)}
      />
      {/* Live echo of the variables the body defines — proof the syntax took. */}
      {vars.length > 0 && (
        <div className="prompt-editor-vars" aria-label="Variáveis detectadas">
          <span className="prompt-editor-vars-label">Variáveis</span>
          {vars.map((v) => (
            <span
              key={v}
              className="prompt-var"
              data-tip="Vira um campo a preencher na hora de usar"
            >
              {"{{"}
              {v}
              {"}}"}
            </span>
          ))}
        </div>
      )}
      <input
        value={tagsText}
        placeholder="tags separadas por vírgula (git, revisão, deploy…)"
        aria-label="Tags, separadas por vírgula"
        onChange={(e) => setTagsText(e.target.value)}
        onKeyDown={(e) => {
          // Tags are the last field — here Enter does mean "done".
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="prompt-editor-foot">
        {onDelete && (
          <button
            className="icon-btn icon-btn--danger"
            data-tip="Excluir este prompt"
            aria-label="Excluir este prompt"
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </button>
        )}
        <button className="btn btn--ghost btn--sm prompt-editor-cancel" onClick={cancel}>
          Cancelar
        </button>
        <button className="btn btn--primary btn--sm" onClick={save}>
          Salvar
        </button>
      </div>
    </div>
  );
}
