/**
 * "Abrir frente": the one door through which a project grows a child.
 *
 * It used to be a form and a button. You typed a name, picked one of three
 * shapes, clicked, and then found out what had happened — from git's own
 * stderr, in English, naming paths nobody had typed, sometimes with a folder
 * and a branch already on the disk and no way to tell which of the two had
 * been created. Opening four fronts for four agents meant walking that form
 * four times and discovering on the fourth that all four had asked for the
 * same branch.
 *
 * So the click is split in two, and the halves are the whole design:
 *
 * **The plan.** Nothing is written while the dialog is open. Every keystroke
 * asks the backend what it *would* do (`ipc.worktreePreflight`, which writes
 * nothing) and the rules in `lib/provision/plan.ts` turn that, plus what the
 * app knows about its own fronts and agents, into the block at the bottom of
 * this dialog: the commit each front grows from, the branch, the folder, and
 * every reason it would be refused. Read it and walk away, and the repository
 * is exactly as you found it.
 *
 * **The run.** Confirming hands that plan to `lib/provision/batch.ts`, which
 * writes one row at a time, records every effect before it happens, and — when
 * something fails halfway — undoes only what it recorded, never deleting a
 * branch that has moved. The dialog does not vanish at that point: it becomes
 * the progress screen, and stays until there is something to say.
 *
 * Four destinations, not three: a branch of its own, an existing branch, a
 * worktree already on the disk (adopted, never created, therefore never
 * deleted), and the project's own checkout — which creates nothing at all and
 * says so.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Bot,
  CaseSensitive,
  Check,
  CheckCircle2,
  CircleAlert,
  FolderGit2,
  GitBranch,
  GitFork,
  Home,
  ListChecks,
  Loader2,
  Monitor,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";

import { Modal } from "../modals/Modal";
import { Select } from "../Select";
import { BrandIcon } from "../BrandIcon";
import { brandById } from "../../lib/brands";
import { pickableAgents } from "../../lib/agentDefaults";
import { branchChoices, type BranchChoice, type BranchWhere } from "../../lib/destination";
import { parseHookLines, type FloorHooks } from "../../lib/floors";
import { baseWarningOf, baseWarningText } from "../../lib/floorSync";
import { ipc, type AgentInfo, type Preflight, type ScmBranch } from "../../lib/ipc";
import {
  cleanupItems,
  runBatch,
  type BatchReport,
  type FailurePolicy,
  type ItemReport,
  type SetupPolicy,
} from "../../lib/provision/batch";
import { issueText, type ProvisionIssue } from "../../lib/provision/errors";
import { yardEffects } from "../../lib/provision/effects";
import {
  buildPlan,
  type Plan,
  type PlannedItem,
  type TargetKind,
} from "../../lib/provision/plan";
import { specsToPreflight, worldFrom } from "../../lib/provision/world";
import { useAgentDefaults } from "../../stores/agentDefaultsStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { useWorktrees } from "../../stores/worktreesStore";
import { useT } from "../../hooks/useT";
import {
  adoptableWorktrees,
  applyPattern,
  applyToAll,
  canConfirm,
  chooseBranch,
  duplicate,
  inlineIssue,
  isConfirmGesture,
  materialWarnings,
  newRow,
  nextRowFrom,
  reuseOf,
  progressOf,
  rowsForMode,
  selectBranchMode,
  selectDestination,
  selectMode,
  summaryOf,
  switchProject,
  toSpecs,
  type FrontRow,
  type NameMode,
} from "./frontPlan";

/** What the dialog is doing: filling in, writing, or reporting. */
type Stage = "form" | "running" | "done";

/**
 * The three shapes a person picks, in the order they are offered.
 *
 * The ground is not among them any more: it is not a kind of place, it is
 * where one branch already lives, and it is chosen by name inside the branch
 * picker (`chooseExistingBranch`).
 *
 * `short` is what the tab strip shows: four labels have to fit on one line
 * of a narrow dialog, and the full sentence lives in the balloon and in the
 * matrix, where there is room for it.
 */
const KINDS: { id: TargetKind; label: string; icon: ReactNode }[] = [
  {
    id: "new_worktree_new_branch",
    label: "Branch nova", // i18n-ok — translated where drawn
    icon: <GitBranch size={13} aria-hidden="true" />,
  },
  {
    id: "new_worktree_existing_branch",
    label: "Branch existente", // i18n-ok
    icon: <GitFork size={13} aria-hidden="true" />,
  },
  {
    id: "existing_worktree",
    label: "Worktree existente", // i18n-ok
    icon: <FolderGit2 size={13} aria-hidden="true" />,
  },
  {
    id: "current_workspace",
    label: "Workspace atual", // i18n-ok
    icon: <Home size={13} aria-hidden="true" />,
  },
];

/**
 * The two ways of answering the one question this dialog asks.
 *
 * It used to ask a different one, "which kind of git object do you want", and
 * one of the tabs was called "Worktree": plumbing, on a screen where nothing
 * else was. What a person decides here is what the front is called, or what it
 * is made from. pt-BR keys, translated where they are drawn.
 */
const MODES: { id: NameMode; label: string; icon: ReactNode; tip: string }[] = [
  {
    id: "name",
    label: "Nome", // i18n-ok
    icon: <CaseSensitive size={13} aria-hidden="true" />,
    tip: "Dê um nome e a frente sai da branch do chão", // i18n-ok
  },
  {
    id: "branch",
    label: "Branch", // i18n-ok
    icon: <GitBranch size={13} aria-hidden="true" />,
    tip: "Escolha de onde a frente parte, ou reutilize a branch como ela está", // i18n-ok
  },
];

/** i18n-ok */
const NO_BRANCHES = "Este repositório ainda não tem branch nenhuma: faça o primeiro commit.";

/** The heading each branch sits under, which is where it already lives. */
const WHERE_GROUP: Record<BranchWhere, string> = {
  free: "Livres", // i18n-ok
  ground: "No workspace que você já tem aberto", // i18n-ok
  worktree: "Em um worktree que já está no disco", // i18n-ok
  front: "Em outra frente", // i18n-ok
};

/**
 * What ticking "reutilizar" would do. Four sentences because it is four
 * different things, and the person has to read the one that applies before
 * clicking, not after.
 */
const REUSE_HINT: Record<BranchWhere, string> = {
  // i18n-ok
  free: "Faz checkout de {branch} na frente nova, em vez de criar uma branch a partir dela.",
  // i18n-ok
  ground: "É o workspace que você já tem aberto: nada será criado e a branch não será trocada.",
  // i18n-ok
  worktree: "Adota o worktree que já está em {path}: nada é criado, e fechar a frente não apaga nada.",
  // i18n-ok
  front: "{branch} já está em uso em outra frente, e o git só dá um worktree por branch.",
};

/** Order for the headings above: a run per group, in a fixed order. */
const WHERE_RANK: Record<BranchWhere, number> = { ground: 0, free: 1, worktree: 2, front: 3 };

const sortedBranches = (list: readonly BranchChoice[]): BranchChoice[] =>
  [...list].sort((a, b) => WHERE_RANK[a.where] - WHERE_RANK[b.where]);

/** How long the dialog waits after a keystroke before asking git again. */
const PREFLIGHT_DEBOUNCE_MS = 260;

export function NewFloorModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as { projectId?: string } | null;

  const projects = useProjects((s) => s.projects);
  /**
   * Which project the front is being opened in.
   *
   * It starts wherever the dialog was opened from, and it can be moved. The
   * gesture it replaces is closing this, finding the other project in the
   * sidebar, and opening it again: three steps to answer a question the
   * dialog was already asking.
   */
  const [pickedId, setPickedId] = useState<string>(() => {
    const s = useProjects.getState();
    const asked = s.projects.find((p) => p.id === payload?.projectId);
    return (asked ?? s.projects.find((p) => p.id === s.activeProjectId))?.id ?? "";
  });
  const project = projects.find((p) => p.id === pickedId);

  const groups = useProjects((s) => s.groups);
  const terminals = useProjects((s) => s.terminals);
  const agentDefaults = useAgentDefaults((s) => s.defaults);

  const [rows, setRows] = useState<FrontRow[]>(() => [newRow(nanoid(8))]);
  const [multi, setMulti] = useState(false);
  const [nameMode, setNameMode] = useState<NameMode>("name");
  const [pattern, setPattern] = useState("exp-{agent}-{index}");
  const [copyGround, setCopyGround] = useState(true);
  const [setupTxt, setSetupTxt] = useState("");
  const [runTxt, setRunTxt] = useState("");
  const [teardownTxt, setTeardownTxt] = useState("");
  const [setupPolicy, setSetupPolicy] = useState<SetupPolicy>("wait_for_setup");
  const [failurePolicy, setFailurePolicy] = useState<FailurePolicy>("continue");
  const [addAnother, setAddAnother] = useState(false);
  const [acked, setAcked] = useState<string[]>([]);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(true);

  const [stage, setStage] = useState<Stage>("form");
  const [report, setReport] = useState<BatchReport | null>(null);
  /** Read between rows by the runner; a ref so it is never a stale closure. */
  const cancelling = useRef(false);

  const projectId = project?.id;
  const projectPath = project?.path;

  const installed = useMemo(
    () => pickableAgents(agents.filter((a) => a.installed && a.bin), agentDefaults),
    [agents, agentDefaults],
  );

  useEffect(() => {
    void ipc.detectAgents(false).then(setAgents).catch(() => setAgents([]));
  }, []);

  /**
   * The whole plan, rebuilt on every change. It is a read — the backend
   * command writes nothing — so it can run on a keystroke; the debounce is
   * about not spawning four `git` processes per character, not about safety.
   */
  const replan = useCallback(async (): Promise<Plan | null> => {
    if (!projectId || !projectPath) return null;
    setPlanning(true);
    try {
      const specs = toSpecs(rows);
      const pf = await ipc.worktreePreflight(projectPath, specsToPreflight(specs));
      const s = useProjects.getState();
      setPreflight(pf);
      const built = buildPlan({
        planId: nanoid(10),
        revision: 1,
        now: Date.now(),
        specs,
        preflight: pf,
        world: worldFrom({
          projectId,
          projectPath,
          groups: s.groups,
          floorOf: (id) => s.floorOf(id),
          terminals: s.terminals,
          availableAgents: installed.map((a) => a.id),
        }),
      });
      setPlan(built);
      return built;
    } catch (e) {
      // A preflight that failed must not read as "everything is fine": the
      // plan goes away and the button goes with it.
      setPlan(null);
      showToast(t("Não consegui ler o repositório: {e}", { e: String(e) }), "error");
      return null;
    } finally {
      setPlanning(false);
    }
    // `groups`/`terminals` are in the deps because a front opened in another
    // window changes which names and which folders are already spoken for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectPath, rows, installed, groups, terminals]);

  useEffect(() => {
    if (stage !== "form") return;
    const timer = setTimeout(() => void replan(), PREFLIGHT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [replan, stage]);

  /**
   * The server's copy of the branches, so the dialog can say how old the base
   * of a new front really is.
   *
   * Nothing fetches on its own: the network is slow and a dialog that hangs
   * on open is worse than a base one fetch behind. What the dialog owes is
   * the sentence, and the button that fixes it before the front is born, when
   * fixing it is still free. Afterwards it is a rebase.
   */
  const [sync, setSync] = useState<{ branches: ScmBranch[]; hasRemote: boolean } | null>(null);
  const [fetching, setFetching] = useState(false);

  const readSync = useCallback(async () => {
    if (!projectPath) return;
    try {
      const [info, list] = await Promise.all([
        ipc.scmInfo(projectPath),
        ipc.scmBranches(projectPath),
      ]);
      setSync({ branches: list, hasRemote: info.remotes.length > 0 });
    } catch {
      // A folder with no repository has no base to be behind of.
      setSync(null);
    }
  }, [projectPath]);

  useEffect(() => {
    void readSync();
  }, [readSync]);

  const fetchFromServer = async () => {
    if (!projectPath || fetching) return;
    setFetching(true);
    try {
      await ipc.scmFetch(projectPath, null, false);
      await readSync();
      // The plan froze a commit for each base; after a fetch those commits
      // can be older than what the repository now has, so it is rebuilt.
      await replan();
    } catch (e) {
      showToast(t("Não consegui buscar do servidor: {e}", { e: String(e) }), "error");
    } finally {
      setFetching(false);
    }
  };

  if (!project) return null;

  /** The folders the fronts of this project already work in. */
  const ownedPaths = useProjects
    .getState()
    .groupsOf(project.id)
    .map((g) => useProjects.getState().floorOf(g.id).worktreePath)
    .filter((path): path is string => !!path);
  // Which branch is where. `ownedPaths` is what separates a worktree this
  // dialog may adopt from one a front is already working in, and getting that
  // wrong would offer somebody else's folder under the wrong heading.
  const branches = branchChoices(
    (preflight?.localBranches ?? []).map((name) => ({ name, remote: false })),
    preflight?.worktrees ?? [],
    { groundPath: project.path, ownedPaths },
  );
  /** Worktrees on the disk that no front has opened yet. */
  const freeWorktrees = adoptableWorktrees(preflight?.worktrees ?? [], {
    groundPath: project.path,
    ownedPaths,
  });

  const patch = (id: string, over: Partial<FrontRow>) =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...over } : r)));

  /**
   * Moving the whole dialog to another repository. The plan goes with it:
   * one built over the old project would still be on screen, still look
   * valid, and name folders in a repository nobody is looking at any more.
   */
  const pickProject = (id: string) => {
    if (id === pickedId) return;
    setPickedId(id);
    setRows((cur) => cur.map(switchProject));
    setNameMode("name");
    setAcked([]);
    setPreflight(null);
    setPlan(null);
  };

  const hooks: FloorHooks = {
    setup: parseHookLines(setupTxt),
    run: parseHookLines(runTxt),
    teardown: parseHookLines(teardownTxt),
    autoSetup: setupPolicy !== "skip",
  };

  const effects = () =>
    yardEffects({
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      hooks,
      copyGround,
      agentBin: (id) => installed.find((a) => a.id === id)?.bin ?? null,
      agentName: (id) => installed.find((a) => a.id === id)?.name ?? id,
    });

  const start = async () => {
    if (!plan) return;
    // Built again, here, against a repository read a moment ago. The plan on
    // screen may be two minutes old — long enough for a `git pull` in another
    // window — and everything below is about not creating a front on a base
    // nobody approved. If the fresh plan is refused, the dialog stays where it
    // is, with the refusal under the field that caused it.
    const fresh = await replan();
    if (!fresh || !canConfirm(fresh, acked)) return;
    cancelling.current = false;
    setStage("running");
    setReport(null);
    const done = await runBatch({
      plan: fresh,
      effects: effects(),
      policy: failurePolicy,
      setupPolicy,
      now: () => Date.now(),
      cancelled: () => cancelling.current,
      onProgress: setReport,
    });
    setReport(done);
    setStage("done");
    void useWorktrees.getState().refresh(project.id, project.path);
  };

  /** Runs again only the rows that failed, on a freshly read repository. */
  const retry = async () => {
    const failed = (report?.items ?? [])
      .filter((i) => i.state === "failed" || i.state === "rolled_back")
      .map((i) => i.clientItemId);
    if (!failed.length) return;
    setStage("form");
    setRows((cur) => cur.filter((r) => failed.includes(r.id)));
    setReport(null);
  };

  const cleanUp = async () => {
    if (!report) return;
    const stuck = report.items
      .filter((i) => i.state === "cleanup_required")
      .map((i) => i.clientItemId);
    const after = await cleanupItems(report.journal, stuck, effects());
    setReport({
      ...report,
      journal: after.journal,
      items: report.items.map((i) => {
        const fixed = after.items.find((x) => x.clientItemId === i.clientItemId);
        return fixed ? { ...i, state: fixed.state, issue: fixed.issue } : i;
      }),
    });
    void useWorktrees.getState().refresh(project.id, project.path);
  };

  const openFront = (item: ItemReport) => {
    if (!item.groupId) return;
    useProjects.getState().setActiveGroup(item.groupId);
    closeModal();
  };

  const continueAdding = () => {
    setRows([nextRowFrom(rows[0] ?? newRow(nanoid(8)), nanoid(8))]);
    setMulti(false);
    setAcked([]);
    setReport(null);
    setStage("form");
  };

  const warnings = plan ? materialWarnings(plan) : [];
  const ready = !!plan && !planning && canConfirm(plan, acked);
  const single = rows[0];

  // -- what the footer says and does ---------------------------------------
  /**
   * The shortcut on the button, and the button under the shortcut.
   *
   * `Enter` on its own is what a person presses after typing a name, so the
   * modifier is what turns the gesture into a decision. It listens on the
   * body rather than on the window because the dialog already traps focus:
   * the chord can only arrive from inside it.
   */
  const onKey = (e: ReactKeyboardEvent) => {
    if (!isConfirmGesture(e) || !ready) return;
    e.preventDefault();
    void start();
  };

  const advanced = (
    <AdvancedBlock
      identity={
        multi ? null : (
          <SheetIdentity
            row={single}
            mode={nameMode}
            defaultBase={preflight?.defaultBase ?? null}
            onPatch={(over) => patch(single.id, over)}
          />
        )
      }
      setupTxt={setupTxt}
      onSetup={setSetupTxt}
      runTxt={runTxt}
      onRun={setRunTxt}
      teardownTxt={teardownTxt}
      onTeardown={setTeardownTxt}
      setupPolicy={setupPolicy}
      onSetupPolicy={setSetupPolicy}
      failurePolicy={failurePolicy}
      onFailurePolicy={setFailurePolicy}
      copyGround={copyGround}
      onCopyGround={setCopyGround}
      addAnother={multi ? null : addAnother}
      onAddAnother={setAddAnother}
    />
  );

  /**
   * One line per distinct base that is not as new as the server's copy.
   *
   * By base, not by row: a fan-out of six agents off `main` is one fact about
   * `main`, and six copies of it would bury the plan beside it.
   */
  const baseNotes: string[] = [];
  const seenBases = new Set<string>();
  for (const item of plan?.items ?? []) {
    const ref = item.base?.ref;
    if (!ref || seenBases.has(ref)) continue;
    seenBases.add(ref);
    const line = baseWarningText(baseWarningOf(sync?.branches, ref, sync?.hasRemote ?? false));
    if (line) baseNotes.push(line);
  }

  const baseNote = !baseNotes.length ? null : (
    <div className="front-basenote">
      {baseNotes.map((line) => (
        <p key={line}>
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{line}</span>
        </p>
      ))}
      <button className="btn" disabled={fetching} onClick={() => void fetchFromServer()}>
        <RotateCcw size={12} aria-hidden="true" />
        {fetching ? t("Buscando…") : t("Buscar do servidor")}
      </button>
    </div>
  );

  const acks = !warnings.length ? null : (
    <div className="front-acks" aria-label={t("Confirmações necessárias")}>
      {warnings.map((w) => (
        <label key={w.code} className="front-ack">
          <input
            type="checkbox"
            checked={acked.includes(w.code)}
            onChange={(e) =>
              setAcked((cur) =>
                e.target.checked ? [...cur, w.code] : cur.filter((c) => c !== w.code),
              )
            }
          />
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{issueText(w)}</span>
        </label>
      ))}
    </div>
  );

  // -- what the footer says and does ---------------------------------------
  const footer =
    stage === "form" ? (
      <div className="modal-foot-row front-foot">
        {/* The switch that turns one front into a matrix of them lives here,
            beside the button it changes, and not in the header where the
            change it makes is off screen. */}
        <label className="front-multi">
          <input
            className="switch"
            type="checkbox"
            checked={multi}
            onChange={(e) => {
              const enabled = e.target.checked;
              setMulti(enabled);
              setRows((cur) =>
                enabled && cur.length === 1
                  ? [...cur, newRow(nanoid(8), { kind: cur[0].kind })]
                  : rowsForMode(cur, enabled),
              );
            }}
          />
          <span>{t("Criar vários")}</span>
        </label>
        <span className="grow" />
        <button className="btn" onClick={closeModal}>
          {t("Cancelar")}
        </button>
        <button className="btn btn--primary" disabled={!ready} onClick={() => void start()}>
          {primaryLabel(t, rows, single)}
          <kbd className="front-chord">Ctrl ↵</kbd>
        </button>
      </div>
    ) : (
      <div className="modal-foot-row">
        {/* While rows are still going, the report carries no verdict yet —
            reading one out of it would say "nada foi criado" over a batch
            that is halfway through creating things. */}
        <span className="hint grow">
          {stage === "running" ? t("Trabalhando…") : resultLine(t, report)}
        </span>
        {stage === "running" ? (
          <button
            className="btn"
            onClick={() => {
              cancelling.current = true;
            }}
          >
            <Ban size={12} aria-hidden="true" /> {t("Cancelar o que falta")}
          </button>
        ) : (
          <>
            {report?.items.some((i) => i.state === "cleanup_required") && (
              <button className="btn btn--danger" onClick={() => void cleanUp()}>
                <Trash2 size={12} aria-hidden="true" /> {t("Tentar limpar de novo")}
              </button>
            )}
            {report?.items.some((i) => i.state === "failed" || i.state === "rolled_back") && (
              <button className="btn" onClick={() => void retry()}>
                <RotateCcw size={12} aria-hidden="true" /> {t("Tentar de novo")}
              </button>
            )}
            {addAnother && !multi ? (
              <>
                <button className="btn" onClick={closeModal}>
                  {t("Fechar")}
                </button>
                <button className="btn btn--primary" onClick={continueAdding}>
                  <Plus size={12} aria-hidden="true" /> {t("Adicionar outro")}
                </button>
              </>
            ) : (
              <button className="btn btn--primary" onClick={closeModal}>
                {t("Fechar")}
              </button>
            )}
          </>
        )}
      </div>
    );

  return (
    <Modal
      title={multi ? t("Abrir frentes") : t("Abrir frente")}
      onClose={closeModal}
      wide={multi}
      initialFocus="[data-front-focus]"
      dirty={stage === "form" && rows.some((r) => !!r.name.trim() || !!r.prompt.trim())}
      footer={footer}
    >
      {stage !== "form" ? (
        <div className="front-provisioner front-provisioner--progress">
          <Progress report={report} onOpen={openFront} />
        </div>
      ) : multi ? (
        <div className="front-provisioner is-multi" onKeyDown={onKey}>
          <ContextRail
            projectName={project.name}
            projectPath={project.path}
            row={single}
            rows={rows}
            agents={installed}
            plan={plan}
          />

          <section className="front-config" aria-label={t("Configuração")}>
            <header className="front-config-head">
              <div>
                <h2>{t("Configure os agentes")}</h2>
                <p>
                  {t("Cada linha pode receber um destino próprio. O plano valida o conjunto antes de criar.")}
                </p>
              </div>
            </header>

            <div className="front-config-scroll">
              <MatrixRows
                rows={rows}
                plan={plan}
                agents={installed}
                branches={branches}
                worktrees={freeWorktrees}
                pattern={pattern}
                onPattern={setPattern}
                onPatch={patch}
                onRows={setRows}
              />
              {advanced}
            </div>
          </section>

          <aside className="front-review" aria-label={t("Plano")}>
            <PlanBlock plan={plan} planning={planning} projectName={project.name} />
            {baseNote}
            {acks}
          </aside>
        </div>
      ) : (
        <FrontSheet
          projects={projects}
          project={project}
          onProject={pickProject}
          row={single}
          plan={plan}
          planning={planning}
          agents={installed}
          branches={branches}
          mode={nameMode}
          onMode={(m) => {
            setNameMode(m);
            patch(single.id, selectMode(single, m));
          }}
          onPatch={(over) => patch(single.id, over)}
          onKeyDown={onKey}
          advanced={advanced}
          baseNote={baseNote}
          acks={acks}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// the sheet: one front, one column
// ---------------------------------------------------------------------------

/**
 * One front, as a single column of labelled controls.
 *
 * The old shape was three columns: a rail of context on the left, the form in
 * the middle, the plan on the right. It read as a wizard for a decision that
 * is, most of the time, "a branch called this, with this agent on it", and it
 * pushed the two things nobody can guess (which project, and where it runs)
 * into a strip of grey text in the header.
 *
 * So: every answer is a row, every row is a label and one control, and the
 * order is the order a person decides in. Which project. Where it runs. What
 * it is called, or what it is made from. Which agent. Everything derived (the
 * branch, the base, the folder, the hooks) is behind "Avançado", because a
 * value the app fills in correctly is not a question. The plan stays on
 * screen, condensed into the strip above the button, and it is still the
 * thing that says nothing has been written yet.
 */
function FrontSheet({
  projects,
  project,
  onProject,
  row,
  plan,
  planning,
  agents,
  branches,
  mode,
  onMode,
  onPatch,
  onKeyDown,
  advanced,
  baseNote,
  acks,
}: {
  projects: { id: string; name: string; path: string }[];
  project: { id: string; name: string; path: string };
  onProject: (id: string) => void;
  row: FrontRow;
  plan: Plan | null;
  planning: boolean;
  agents: AgentInfo[];
  branches: BranchChoice[];
  /** Which of the two questions the section is asking right now. */
  mode: NameMode;
  onMode: (mode: NameMode) => void;
  onPatch: (over: Partial<FrontRow>) => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  advanced: ReactNode;
  baseNote: ReactNode;
  acks: ReactNode;
}) {
  const t = useT();
  const mine = plan?.items.find((i) => i.clientItemId === row.id);
  const fieldError = (field: string) => mine?.errors.find((e) => e.field === field) ?? null;
  const brand = row.agentId ? brandById(row.agentId) : null;
  /**
   * The branch that was pointed at, read back off the row: unchecked it is the
   * base the new branch grows from, checked it is the branch itself. Derived
   * rather than held in state, so there is one truth and it is the one the
   * plan is built from.
   */
  const picked = row.kind === "new_worktree_new_branch" ? row.baseRef : row.branch;
  const chosen = branches.find((b) => b.name === picked) ?? null;
  const reuse = row.kind !== "new_worktree_new_branch";
  /** What is written in the control this mode put on screen. */
  const typed = mode === "name" ? row.name : picked;
  const sectionIssue =
    mode === "name"
      ? fieldError("name")
      : (fieldError("branch") ?? fieldError("worktree") ?? fieldError("base"));

  return (
    <div className="front-sheet" onKeyDown={onKeyDown}>
      <SheetField label={t("Projeto")}>
        <Select
          value={project.id}
          label={t("Projeto")}
          icon={<FolderGit2 size={13} aria-hidden="true" />}
          hint={project.path}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={onProject}
        />
      </SheetField>

      {/* Not a picker. There is one machine, and a control that opens onto a
          list of one is a promise of somewhere else to run. */}
      <SheetField label={t("Onde roda")}>
        <div className="front-static">
          <Monitor size={13} aria-hidden="true" />
          <span>{t("Este computador")}</span>
          <i className="front-online" aria-label={t("online")} />
          <span className="front-static-hint" title={project.path}>
            {project.path}
          </span>
        </div>
      </SheetField>

      <SheetField label={t("Nome ou origem")} issue={inlineIssue(sectionIssue, typed)}>
        <div className="front-tabs" role="tablist" aria-label={t("Nome ou origem")}>
          {MODES.map((m) => {
            const on = mode === m.id;
            const off = m.id === "branch" && branches.length === 0;
            return (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={on}
                className={on ? "is-active" : ""}
                disabled={off}
                data-tip={off ? t(NO_BRANCHES) : t(m.tip)}
                {...(on && m.id === "branch" ? { "data-front-focus": "" } : {})}
                onClick={() => onMode(m.id)}
              >
                {m.icon}
                <span>{t(m.label)}</span>
              </button>
            );
          })}
        </div>

        {mode === "name" && (
          <input
            data-front-focus
            value={row.name}
            placeholder={t("ex.: fix-login")}
            aria-label={t("Nome da frente")}
            aria-invalid={sectionIssue ? true : undefined}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        )}

        {mode === "branch" &&
          (branches.length === 0 ? (
            <Empty>{t(NO_BRANCHES)}</Empty>
          ) : (
            <>
              <Select
                value={picked}
                label={t("Branch")}
                icon={<GitBranch size={13} aria-hidden="true" />}
                placeholder={t("Escolha uma branch")}
                options={sortedBranches(branches).map((b) => ({
                  value: b.name,
                  label: b.name,
                  // Grouped by where the branch already is, because that is
                  // what decides what reusing it would mean.
                  group: t(WHERE_GROUP[b.where]),
                }))}
                onChange={(v) => {
                  const choice = branches.find((b) => b.name === v);
                  if (choice) onPatch(chooseBranch(row, choice, reuse));
                }}
              />
              {/* Only once there is a branch to reuse. Unchecked, the branch is
                  where the new one grows from, which is the common case. */}
              {chosen && (
                <label className="front-reuse">
                  <input
                    type="checkbox"
                    checked={reuse}
                    disabled={!reuseOf(chosen.where)}
                    onChange={(e) => onPatch(chooseBranch(row, chosen, e.target.checked))}
                  />
                  <span>
                    <strong>{t("Reutilizar a branch")}</strong>
                    <small>
                      {t(REUSE_HINT[chosen.where], {
                        branch: chosen.name,
                        path: chosen.path ?? "",
                      })}
                    </small>
                  </span>
                </label>
              )}
            </>
          ))}
      </SheetField>

      <SheetField label={t("Agente")} optional issue={fieldError("agent")}>
        <Select
          value={row.agentId ?? ""}
          label={t("Agente")}
          icon={brand ? <BrandIcon brand={brand} size={13} /> : <Bot size={13} aria-hidden="true" />}
          placeholder={t("sem agente — a frente abre vazia")}
          options={[
            { value: "", label: t("sem agente — a frente abre vazia") },
            ...agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
          onChange={(v) => onPatch({ agentId: v || null })}
        />
      </SheetField>

      {/* Asked only once there is somebody to ask it of. */}
      {row.agentId && (
        <SheetField label={t("Pedido")} optional>
          <textarea
            rows={2}
            value={row.prompt}
            placeholder={t("O que o agente deve fazer nesta frente.")}
            onChange={(e) => onPatch({ prompt: e.target.value })}
          />
        </SheetField>
      )}

      {advanced}
      <PlanStrip plan={plan} planning={planning} />
      {baseNote}
      {acks}
    </div>
  );
}

/** Where a control would be, when there is nothing for it to offer. */
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="front-static front-static--note front-static--empty">
      <Ban size={13} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** A label, one control, and the refusal that belongs to it. */
function SheetField({
  label,
  optional,
  issue,
  children,
}: {
  label: string;
  optional?: boolean;
  issue?: ProvisionIssue | null;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="front-sheet-field">
      <span className="front-sheet-label">
        {label}
        {optional && <em>[{t("opcional")}]</em>}
      </span>
      {children}
      {issue && (
        <p className="hint hint--error" role="alert">
          {issueText(issue)}
        </p>
      )}
    </div>
  );
}

/**
 * The fields the app fills in correctly on its own.
 *
 * They are not folded away to save room: they are folded away because a
 * derived value is not a question. The name is here only when the tab asks for
 * something else first, so no screen ever shows two name fields with one of
 * them a copy of the other.
 */
function SheetIdentity({
  row,
  mode,
  defaultBase,
  onPatch,
}: {
  row: FrontRow;
  /** The question the section above is asking. */
  mode: NameMode;
  defaultBase: string | null;
  onPatch: (over: Partial<FrontRow>) => void;
}) {
  const t = useT();
  if (row.kind === "current_workspace") return null;
  return (
    <>
      {mode === "branch" && (
        <label>
          {t("Nome da frente")}
          <input
            value={row.name}
            placeholder={t("padrão: o nome do destino")}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </label>
      )}
      {row.kind === "new_worktree_new_branch" && (
        <>
          <label>
            {t("Base")}
            <input
              value={row.baseRef}
              placeholder={defaultBase ?? t("padrão: a branch do chão")}
              onChange={(e) => onPatch({ baseRef: e.target.value })}
            />
          </label>
          <label>
            Branch
            <input
              value={row.branch}
              placeholder={t("padrão: yard/<nome>")}
              onChange={(e) => onPatch({ branch: e.target.value })}
            />
          </label>
        </>
      )}
      {row.kind !== "existing_worktree" && (
        <label>
          {t("Pasta do worktree")}
          <input
            value={row.worktreeName}
            placeholder={t("padrão: o nome da frente")}
            onChange={(e) => onPatch({ worktreeName: e.target.value })}
          />
        </label>
      )}
    </>
  );
}

/**
 * The plan, condensed into the strip above the button.
 *
 * The narrow sheet has no room for the column the matrix gets, and it does not
 * need one: with a single front there is one line to read (where the branch
 * grows from, what it is called, which folder it lands in) and the refusals
 * underneath it. What must not shrink is the sentence at the end. It is the
 * promise the whole dialog is built on.
 */
function PlanStrip({ plan, planning }: { plan: Plan | null; planning: boolean }) {
  const t = useT();
  const item = plan?.items[0];
  return (
    <section className="front-strip" aria-busy={planning} aria-label={t("Plano")}>
      <header>
        <span className={`front-plan-status ${plan?.valid ? "is-valid" : plan ? "is-invalid" : ""}`}>
          {planning ? (
            <Loader2 size={12} className="spin" aria-hidden="true" />
          ) : plan?.valid ? (
            <CheckCircle2 size={12} aria-hidden="true" />
          ) : (
            <CircleAlert size={12} aria-hidden="true" />
          )}
          {planning ? t("Validando") : plan?.valid ? t("Plano válido") : t("Revise os campos")}
        </span>
        {item && (
          <div className="front-plan-flow" aria-label={t("Origem, branch e caminho")}>
            {item.base && (
              <span title={`${item.base.ref} @ ${item.base.oid}`}>
                {item.base.ref} <code>{item.base.oid.slice(0, 7)}</code>
              </span>
            )}
            {item.base && item.branch && <ArrowRight size={11} aria-hidden="true" />}
            {item.branch && <span title={item.branch}>{item.branch}</span>}
            {(item.base || item.branch) && item.path && <ArrowRight size={11} aria-hidden="true" />}
            {item.path && <span title={item.path}>{folderOf(item.path)}</span>}
          </div>
        )}
      </header>
      <Issues item={item} />
      <p className="front-strip-safety">
        <ShieldCheck size={12} aria-hidden="true" />
        {t("Nada muda no repositório antes da confirmação.")}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// the matrix
// ---------------------------------------------------------------------------

function MatrixRows({
  rows,
  plan,
  agents,
  branches,
  worktrees,
  pattern,
  onPattern,
  onPatch,
  onRows,
}: {
  rows: FrontRow[];
  plan: Plan | null;
  agents: AgentInfo[];
  branches: BranchChoice[];
  worktrees: { path: string; branch: string | null }[];
  pattern: string;
  onPattern: (v: string) => void;
  onPatch: (id: string, over: Partial<FrontRow>) => void;
  onRows: (fn: (cur: FrontRow[]) => FrontRow[]) => void;
}) {
  const t = useT();
  return (
    <div className="front-matrix">
      <div className="front-matrix-head">
        <label className="front-pattern">
          {t("Padrão dos nomes")}
          <input
            value={pattern}
            placeholder="exp-{agent}-{index}"
            onChange={(e) => onPattern(e.target.value)}
          />
        </label>
        <button
          className="btn btn--sm"
          onClick={() =>
            onRows((cur) => applyPattern(cur, pattern, (r) => agentLabelOf(agents, r.agentId)))
          }
        >
          {t("Nomear todas")}
        </button>
        <button
          className="btn btn--sm"
          onClick={() => onRows((cur) => applyToAll(cur, { kind: cur[0]?.kind, prompt: cur[0]?.prompt, baseRef: cur[0]?.baseRef }))}
          data-tip-wrap=""
          data-tip={t("Copia destino, base e pedido da primeira linha para todas")}
        >
          {t("Aplicar a todas")}
        </button>
      </div>

      {rows.map((row, i) => {
        const mine = plan?.items.find((it) => it.clientItemId === row.id);
        return (
          <div className="front-row" key={row.id}>
            <div className="front-row-head">
              <span className="front-row-n">{i + 1}</span>
              <input
                className="front-row-name"
                value={row.name}
                placeholder={t("nome da frente")}
                onChange={(e) => onPatch(row.id, { name: e.target.value })}
              />
              <Select
                className="front-row-kind"
                value={row.kind}
                label={t("Destino")}
                // Same rule as the single row: a destination with nothing
                // behind it is not offered, or the row can only be corrected
                // by changing it back.
                options={KINDS.filter(
                  (k) =>
                    k.id !== "existing_worktree" ||
                    worktrees.length > 0 ||
                    row.kind === "existing_worktree",
                ).map((k) => ({ value: k.id, label: t(k.label) }))}
                onChange={(v) => {
                  const kind = v as TargetKind;
                  onPatch(
                    row.id,
                    kind === "new_worktree_new_branch"
                      ? selectBranchMode(row, "new")
                      : kind === "new_worktree_existing_branch"
                        ? selectBranchMode(row, "existing")
                        : selectDestination(row, kind),
                  );
                }}
              />
              <Select
                className="front-row-agent"
                value={row.agentId ?? ""}
                label={t("Agente")}
                placeholder={t("sem agente")}
                options={[
                  { value: "", label: t("sem agente") },
                  ...agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
                onChange={(v) => onPatch(row.id, { agentId: v || null })}
              />
              <span className={`front-row-state ${mine?.errors.length ? "is-error" : mine?.warnings.length ? "is-warn" : mine ? "is-valid" : ""}`}>
                {!mine ? (
                  <Loader2 size={12} className="spin" aria-hidden="true" />
                ) : mine.errors.length ? (
                  <CircleAlert size={12} aria-hidden="true" />
                ) : mine.warnings.length ? (
                  <AlertTriangle size={12} aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={12} aria-hidden="true" />
                )}
                {!mine ? t("Validando") : mine.errors.length ? t("Corrigir") : mine.warnings.length ? t("Atenção") : t("Válido")}
              </span>
              <button
                className="icon-btn"
                data-tip={t("Duplicar")}
                aria-label={t("Duplicar a linha {n}", { n: i + 1 })}
                onClick={() => onRows((cur) => duplicate(cur, row.id, nanoid(8)))}
              >
                <Plus size={13} />
              </button>
              <button
                className="icon-btn"
                data-tip={t("Remover")}
                aria-label={t("Remover a linha {n}", { n: i + 1 })}
                disabled={rows.length === 1}
                onClick={() => onRows((cur) => cur.filter((r) => r.id !== row.id))}
              >
                <X size={13} />
              </button>
            </div>

            <div className="front-row-body">
              {row.kind === "new_worktree_existing_branch" && (
                <Select
                  value={row.branch}
                  label={t("Branch existente")}
                  placeholder={t("Escolha uma branch")}
                  // Only the ones that can be reused: the rest of the list is
                  // a base, and the base has its own field on the row.
                  options={branches
                    .filter((b) => reuseOf(b.where))
                    .map((b) => ({ value: b.name, label: b.name, group: t(WHERE_GROUP[b.where]) }))}
                  onChange={(v) => {
                    const choice = branches.find((b) => b.name === v);
                    if (choice) onPatch(row.id, chooseBranch(row, choice, true));
                  }}
                />
              )}
              {row.kind === "existing_worktree" && (
                <Select
                  value={row.worktreePath}
                  label={t("Worktree no disco")}
                  placeholder={t("Escolha um worktree")}
                  options={worktrees.map((w) => ({
                    value: w.path,
                    label: w.branch ? `${w.branch} · ${w.path}` : w.path,
                  }))}
                  onChange={(v) => onPatch(row.id, { worktreePath: v })}
                />
              )}
              {row.kind === "new_worktree_new_branch" && (
                <>
                  <input
                    value={row.baseRef}
                    aria-label={t("Base")}
                    placeholder={t("base (padrão: a branch do chão)")}
                    onChange={(e) => onPatch(row.id, { baseRef: e.target.value })}
                  />
                  <input
                    value={row.branch}
                    aria-label={t("Branch")}
                    placeholder={t("branch (padrão: yard/<nome>)")}
                    onChange={(e) => onPatch(row.id, { branch: e.target.value })}
                  />
                </>
              )}
              <input
                value={row.prompt}
                aria-label={t("Pedido")}
                placeholder={t("o que este agente deve fazer")}
                onChange={(e) => onPatch(row.id, { prompt: e.target.value })}
              />
            </div>

            <Issues item={mine} />
          </div>
        );
      })}

      <button
        className="btn btn--sm"
        onClick={() => onRows((cur) => [...cur, newRow(nanoid(8), { kind: cur[0]?.kind })])}
      >
        <Plus size={12} aria-hidden="true" /> {t("Adicionar agente")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the plan, and the progress
// ---------------------------------------------------------------------------

function ContextRail({
  projectName,
  projectPath,
  row,
  rows,
  agents,
  plan,
}: {
  projectName: string;
  projectPath: string;
  row: FrontRow;
  rows: FrontRow[];
  agents: AgentInfo[];
  plan: Plan | null;
}) {
  const t = useT();
  const selectedAgents = rows.filter((item) => !!item.agentId).length;
  const agent = row.agentId ? agents.find((item) => item.id === row.agentId)?.name : null;
  return (
    <aside className="front-context" aria-label={t("Contexto da criação")}>
      <h2>{t("Contexto")}</h2>
      <ol>
        <li className="is-complete">
          <span className="front-context-icon"><FolderGit2 size={14} aria-hidden="true" /></span>
          <div>
            <span>{t("Projeto")}</span>
            <strong>{projectName}</strong>
            <small title={projectPath}>{projectPath}</small>
          </div>
        </li>
        <li className="is-complete">
          <span className="front-context-icon"><Monitor size={14} aria-hidden="true" /></span>
          <div>
            <span>{t("Executar em")}</span>
            <strong>{t("Este computador")}</strong>
            <small>{t("Windows · online")}</small>
          </div>
        </li>
        <li className={plan?.valid ? "is-complete" : plan ? "is-error" : "is-current"}>
          <span className="front-context-icon"><GitBranch size={14} aria-hidden="true" /></span>
          <div>
            <span>{t("Destino Git")}</span>
            <strong>{rows.length > 1 ? t("{n} destinos", { n: rows.length }) : t(destinationLabel(row.kind))}</strong>
            <small>{plan?.valid ? t("Plano validado") : t("Aguardando validação")}</small>
          </div>
        </li>
        <li className={selectedAgents ? "is-complete" : "is-current"}>
          <span className="front-context-icon"><Bot size={14} aria-hidden="true" /></span>
          <div>
            <span>{t("Agente")}</span>
            <strong>
              {rows.length > 1
                ? t("{n} configurado(s)", { n: selectedAgents })
                : agent ?? t("Sem agente")}
            </strong>
            <small>{selectedAgents ? t("Será iniciado depois do setup") : t("A frente pode abrir vazia")}</small>
          </div>
        </li>
      </ol>
      <div className="front-context-safety">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>{t("Nada muda no repositório antes da confirmação.")}</span>
      </div>
    </aside>
  );
}

function PlanBlock({
  plan,
  planning,
  projectName,
}: {
  plan: Plan | null;
  planning: boolean;
  projectName: string;
}) {
  const t = useT();
  const summary = plan ? summaryOf(plan) : null;
  return (
    <section className="front-plan" aria-busy={planning} aria-label={t("Plano")}>
      <header className="front-review-head">
        <div>
          <h2>{t("Plano")}</h2>
          <p>{projectName}</p>
        </div>
        <span className={`front-plan-status ${plan?.valid ? "is-valid" : plan ? "is-invalid" : ""}`}>
          {planning ? (
            <Loader2 size={12} className="spin" aria-hidden="true" />
          ) : plan?.valid ? (
            <CheckCircle2 size={12} aria-hidden="true" />
          ) : (
            <CircleAlert size={12} aria-hidden="true" />
          )}
          {planning ? t("Validando") : plan?.valid ? t("Plano válido") : t("Revise os campos")}
        </span>
      </header>

      {summary && (
        <div className="front-plan-summary" aria-label={t("Resumo do plano")}>
          <span><FolderGit2 size={12} aria-hidden="true" /> {t("{n} worktree(s) nova(s)", { n: summary.worktrees })}</span>
          <span><GitBranch size={12} aria-hidden="true" /> {t("{n} branch(es) nova(s)", { n: summary.branches })}</span>
          <span><Bot size={12} aria-hidden="true" /> {t("{n} agente(s)", { n: summary.agents })}</span>
        </div>
      )}

      <div className="front-plan-items">
        {(plan?.items ?? []).map((item, i) => (
          <article className="front-plan-item" key={item.clientItemId}>
            <header>
              <span className="front-plan-n">{i + 1}</span>
              <div>
                <strong>{item.displayName || t("(sem nome)")}</strong>
                <span className="front-plan-action">{t(actionLabel(item))}</span>
              </div>
            </header>
            <div className="front-plan-flow" aria-label={t("Origem, branch e caminho")}>
              {item.base && <span title={`${item.base.ref} @ ${item.base.oid}`}>{item.base.ref}</span>}
              {item.base && item.branch && <ArrowRight size={11} aria-hidden="true" />}
              {item.branch && <span title={item.branch}>{item.branch}</span>}
              {(item.base || item.branch) && item.path && <ArrowRight size={11} aria-hidden="true" />}
              {item.path && <span title={item.path}>{folderOf(item.path)}</span>}
            </div>
            <dl>
              {item.base && (
                <>
                  <dt>{t("Base resolvida")}</dt>
                  <dd><code>{item.base.oid.slice(0, 7)}</code></dd>
                </>
              )}
              {item.branch && (
                <>
                  <dt>Branch</dt>
                  <dd>{item.branch}</dd>
                </>
              )}
              {item.path && (
                <>
                  <dt>{t("Caminho")}</dt>
                  <dd className="front-plan-path"><span className="front-plan-ltr">{item.path}</span></dd>
                </>
              )}
            </dl>
            <Issues item={item} />
          </article>
        ))}
        {!plan && !planning && <p className="hint">{t("Preencha o destino para montar o plano.")}</p>}
      </div>
    </section>
  );
}

function Issues({ item }: { item: PlannedItem | undefined }) {
  if (!item || (!item.errors.length && !item.warnings.length)) return null;
  return (
    <ul className="front-issues">
      {item.errors.map((e, i) => (
        <li key={`e${i}`} className="is-error" role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          {issueText(e)}
        </li>
      ))}
      {item.warnings.map((w, i) => (
        <li key={`w${i}`} className="is-warn">
          <AlertTriangle size={12} aria-hidden="true" />
          {issueText(w)}
        </li>
      ))}
    </ul>
  );
}

function Progress({
  report,
  onOpen,
}: {
  report: BatchReport | null;
  onOpen: (item: ItemReport) => void;
}) {
  const t = useT();
  if (!report) {
    return (
      <section className="front-run" aria-live="polite">
        <div className="front-run-loading">
          <Loader2 size={18} className="spin" aria-hidden="true" />
          <div>
            <h2>{t("Validando o plano mais uma vez")}</h2>
            <p>{t("O repositório é relido imediatamente antes de qualquer alteração.")}</p>
          </div>
        </div>
      </section>
    );
  }
  const progress = progressOf(report.items);
  const active = report.items.find((item) => item.state === "running");
  const phases = ["validando", "criando", "registrando", "setup", "iniciando", "pronto"] as const;
  const activePhase = active ? phases.indexOf(active.phase as (typeof phases)[number]) : phases.length;
  return (
    <section className="front-run" aria-label={t("Progresso")}>
      <header className="front-run-head">
        <div>
          <span className="front-run-icon"><ListChecks size={17} aria-hidden="true" /></span>
          <div>
            <h2>{active ? t("Preparando {name}", { name: active.displayName }) : t("Provisionamento concluído")}</h2>
            <p aria-live="polite">
              {active ? t(phaseLabel(active)) : resultLine(t, report)}
            </p>
          </div>
        </div>
        <strong>{t("{done} de {total}", { done: progress.settled, total: progress.total })}</strong>
      </header>
      <progress className="front-run-meter" max={100} value={progress.percent}>
        {progress.percent}%
      </progress>

      <ol className="front-phase-track" aria-label={t("Fases do provisionamento")}>
        {phases.map((phase, index) => (
          <li key={phase} className={index < activePhase ? "is-done" : index === activePhase ? "is-active" : ""}>
            <span>{index < activePhase ? <Check size={10} aria-hidden="true" /> : index + 1}</span>
            {t(phase === "criando" ? "Criando worktree" : phaseLabel({ phase, state: "running" } as ItemReport))}
          </li>
        ))}
      </ol>

      <ol className="front-progress" aria-label={t("Itens do lote")}>
        {report.items.map((item) => (
          <li key={item.clientItemId} className={`is-${item.state}`}>
            <span className="front-progress-mark" aria-hidden="true">
              {item.state === "ready" ? (
                <Check size={13} />
              ) : item.state === "running" ? (
                <Loader2 size={13} className="spin" />
              ) : item.state === "cancelled" ? (
                <Ban size={13} />
              ) : item.state === "pending" ? (
                <span className="front-pending-dot" />
              ) : (
                <CircleAlert size={13} />
              )}
            </span>
            <span className="front-progress-main">
              <strong>{item.displayName}</strong>
              <small>{item.path ?? item.branch ?? t("Aguardando destino")}</small>
            </span>
            <span className="front-progress-phase">{t(phaseLabel(item))}</span>
            {item.issue && <span className="front-progress-why">{issueText(item.issue)}</span>}
            {item.state === "ready" && item.groupId && (
              <button className="btn btn--sm" onClick={() => onOpen(item)}>
                {t("Abrir worktree")}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

/**
 * Everything the dialog can answer on its own, folded away.
 *
 * Two callers, one block: the sheet passes the derived identity fields in
 * (`identity`), the matrix passes nothing, because there each row carries its
 * own. What both share is the part that belongs to the whole batch: the
 * commands, what to do when one of them fails, and what to do when a front
 * does.
 */
function AdvancedBlock({
  identity,
  setupTxt,
  onSetup,
  runTxt,
  onRun,
  teardownTxt,
  onTeardown,
  setupPolicy,
  onSetupPolicy,
  failurePolicy,
  onFailurePolicy,
  copyGround,
  onCopyGround,
  addAnother,
  onAddAnother,
}: {
  identity: ReactNode;
  setupTxt: string;
  onSetup: (v: string) => void;
  runTxt: string;
  onRun: (v: string) => void;
  teardownTxt: string;
  onTeardown: (v: string) => void;
  setupPolicy: SetupPolicy;
  onSetupPolicy: (v: SetupPolicy) => void;
  failurePolicy: FailurePolicy;
  onFailurePolicy: (v: FailurePolicy) => void;
  copyGround: boolean;
  onCopyGround: (v: boolean) => void;
  /** `null` in the matrix: "add another" is a one-front idea. */
  addAnother: boolean | null;
  onAddAnother: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <details className="floors-hooks front-advanced">
      <summary>{t("Avançado")}</summary>
      {identity && <div className="front-advanced-identity">{identity}</div>}
      <div className="front-advanced-grid">
        <label>
          {t("Setup (na criação)")}
          <textarea
            rows={2}
            value={setupTxt}
            placeholder={t("ex.: npm ci")}
            onChange={(e) => onSetup(e.target.value)}
          />
        </label>
        <label>
          {t("Quando o setup falhar")}
          <Select
            value={setupPolicy}
            label={t("Quando o setup falhar")}
            options={[
              { value: "wait_for_setup", label: t("Não iniciar o agente") },
              { value: "run_parallel", label: t("Avisar e iniciar mesmo assim") },
              { value: "skip", label: t("Não rodar setup nenhum") },
            ]}
            onChange={(v) => onSetupPolicy(v as SetupPolicy)}
          />
        </label>
        <label>
          {t("Quando uma frente falhar")}
          <Select
            value={failurePolicy}
            label={t("Quando uma frente falhar")}
            options={[
              { value: "continue", label: t("Seguir com as outras") },
              { value: "stop_pending", label: t("Parar as que ainda não começaram") },
              { value: "compensate_created", label: t("Desfazer as que já foram criadas") },
            ]}
            onChange={(v) => onFailurePolicy(v as FailurePolicy)}
          />
        </label>
        <label>
          {t("Run (botão ▶ no overview)")}
          <textarea
            rows={2}
            value={runTxt}
            placeholder={t("ex.: npm run dev")}
            onChange={(e) => onRun(e.target.value)}
          />
        </label>
        <label>
          {t("Teardown (ao encerrar)")}
          <textarea
            rows={2}
            value={teardownTxt}
            placeholder={t("ex.: npm run clean")}
            onChange={(e) => onTeardown(e.target.value)}
          />
        </label>
        <div className="front-advanced-checks">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={copyGround}
              onChange={(e) => onCopyGround(e.target.checked)}
            />
            {t("Clonar o layout do chão")}
          </label>
          {addAnother !== null && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={addAnother}
                onChange={(e) => onAddAnother(e.target.checked)}
              />
              {t("Adicionar outro depois")}
            </label>
          )}
        </div>
      </div>
    </details>
  );
}

/** pt-BR keys, translated where they are drawn. */
function actionLabel(item: PlannedItem): string {
  switch (item.action) {
    case "create_worktree":
      return item.base ? "criar branch e worktree" : "abrir worktree na branch";
    case "adopt_worktree":
      return "adotar worktree do disco";
    case "use_ground":
      return "usar o chão, sem criar nada";
    case "create_folder":
      return "abrir grupo sem git";
  }
}

function destinationLabel(kind: TargetKind): string {
  switch (kind) {
    case "new_worktree_new_branch":
      return "Nova worktree · branch nova";
    case "new_worktree_existing_branch":
      return "Nova worktree · branch existente";
    case "existing_worktree":
      return "Worktree existente";
    case "current_workspace":
      return "Workspace atual";
  }
}

function primaryLabel(
  t: (s: string, v?: Record<string, string | number>) => string,
  rows: readonly FrontRow[],
  row: FrontRow,
): string {
  if (rows.length > 1) return t("Criar {n} frentes", { n: rows.length });
  if (row.kind === "current_workspace") return row.agentId ? t("Iniciar agente") : t("Usar workspace atual");
  if (row.kind === "existing_worktree") return row.agentId ? t("Usar worktree e iniciar") : t("Usar worktree");
  return row.agentId ? t("Criar worktree e iniciar") : t("Criar worktree");
}

function phaseLabel(item: ItemReport): string {
  if (item.state === "cancelled") return "cancelada";
  if (item.state === "rolled_back") return "desfeita";
  if (item.state === "cleanup_required") return "precisa de limpeza";
  switch (item.phase) {
    case "esperando":
      return "esperando";
    case "validando":
      return "validando";
    case "criando":
      return "criando o worktree";
    case "registrando":
      return "registrando a frente";
    case "setup":
      return "rodando o setup";
    case "iniciando":
      return "iniciando o agente";
    case "pronto":
      return "pronta";
  }
}

function resultLine(t: (s: string, v?: Record<string, string | number>) => string, report: BatchReport | null): string {
  if (!report) return t("Trabalhando…");
  const ready = report.items.filter((i) => i.state === "ready").length;
  switch (report.state) {
    case "succeeded":
      return t("{n} frente(s) no ar.", { n: ready });
    case "partially_succeeded":
      return t("{n} de {total} no ar. O resto está explicado acima.", {
        n: ready,
        total: report.items.length,
      });
    case "cleanup_required":
      return t("Sobrou coisa no disco que eu não podia apagar sozinho — veja acima.");
    case "cancelled":
      return t("Cancelado. Nada foi criado.");
    default:
      return t("Nada foi criado.");
  }
}

const agentLabelOf = (agents: AgentInfo[], id: string | null): string =>
  agents.find((a) => a.id === id)?.id ?? "";

const folderOf = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;
