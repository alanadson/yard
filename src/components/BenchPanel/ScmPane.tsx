// i18n-scan: tables
/**
 * The **Source control** tab — version control for the open project, inside
 * the bench.
 *
 * The "Files" panel (below) *reads* the repository: what changed and each
 * file's diff. This tab **acts** on it: stage, discard, commit, switch
 * branches, stash, fetch and push. Both look at the same `git status` (the
 * one in `changesStore`, fed by the watcher) — running a second `git status`
 * here would double the cost of the work of an agent that is saving a file
 * every second.
 *
 * The root is the **active floor's**, when there is one: in a group with a
 * worktree, the commit belongs to the worktree, not to the ground. It is the
 * same root the watcher, the file tree and the `git status` already use
 * (`editorStore.root`).
 *
 * Four sections, one segmented bar:
 * - **Changes**: the commit box and the three groups (conflicts, staged,
 *   changes). A row expands into the diff, and the diff carries a button per
 *   *hunk* — that is what makes the commit say what the person meant, rather
 *   than whatever state the file happened to be in;
 * - **History**: the commits, paginated, each opening the files it touched;
 * - **Branches**: local and remote, with each one's tracking, plus the tags;
 * - **Stash**: the `git stash` pile.
 *
 * Nothing here holds process state: the store is the source, this file is
 * the projection (the golden rule of §4.3).
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  FileDiff as FileDiffIcon,
  FolderGit2,
  GitBranch,
  GitCompare,
  GitCommitVertical,
  History,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCw,
  Tag,
  Undo2,
  X,
} from "lucide-react";

// The status badges and the diff colours live in the files panel's stylesheet,
// which is where they were born; both surfaces draw the same file with the
// same marks, and duplicating the rules here was how they started to diverge.
import "../ChangesPanel/changes.css";
import "./scm.css";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { GitStatusBadge, PathLabel } from "../FileMarks";
import { copyText } from "../../lib/clipboard";
import { commitAction, messageHint } from "../../lib/commitBox";
import { diffLineClass } from "../../lib/diff";
import {
  ipc,
  type FileDiff,
  type ScmBranch,
  type ScmCommit,
  type ScmInfo,
} from "../../lib/ipc";
import { since } from "../../lib/format";
import {
  SCM_DIFF_LINES,
  capHunks,
  patchForHunks,
  patchForLines,
  splitPatch,
  type PatchHunk,
} from "../../lib/scmPatch";
import {
  branchDeleteSpec,
  discardAllSpec,
  discardSpec,
  remoteDeleteSpec,
  resetSpec,
  stashDropSpec,
  type ScmConfirmSpec,
} from "../../lib/scmConfirm";
import { branchLabel, stashTitle, stateBanner, syncState } from "../../lib/scmHeader";
import {
  SCM_ROWS_PAGE,
  conflictKind,
  groupChanges,
  pageRows,
  scmCounts,
  type ScmRow,
} from "../../lib/scmGroups";
import {
  scmBranchMenu,
  scmCommitMenu,
  scmGroupMenu,
  scmRowMenu,
  scmStashMenu,
} from "../../lib/scmMenu";
import { useChanges } from "../../stores/changesStore";
import { useEditor } from "../../stores/editorStore";
import { useScm, type ScmSection } from "../../stores/scmStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";
import { tn } from "../../lib/i18n";

/** Read context, built once and handed down to the sections. */
interface Ctx {
  root: string;
  projectId: string | null;
}

/**
 * The four sections. Icon-only, like the bench's own tab strip: in a 268px
 * column the four labels ("Alterações", "Histórico", "Branches", "Guardado")
 * come out cut mid-word, and a truncated label says less than an icon with a
 * tooltip.
 */
const SECTIONS: {
  id: ScmSection;
  label: string;
  tip: string;
  Icon: typeof GitCompare;
}[] = [
  { id: "changes", label: "Alterações", tip: "O que mudou e o commit", Icon: FileDiffIcon },
  { id: "history", label: "Histórico", tip: "Os commits desta branch", Icon: History },
  { id: "branches", label: "Branches", tip: "Branches e etiquetas", Icon: GitCompare },
  { id: "stash", label: "Guardado", tip: "A pilha do stash", Icon: Archive },
];

export function ScmPane({ focusTick }: { focusTick: number }) {
  const root = useEditor((s) => s.root);
  const projectId = useEditor((s) => s.projectId);
  const showToast = useUI((s) => s.showToast);
  const t = useT();

  const section = useScm((s) => s.section);
  const setSection = useScm((s) => s.setSection);
  const repo = useScm((s) => s.repoOf(root));
  const setRepo = useScm((s) => s.setRepo);

  const summary = useChanges((s) => (projectId ? s.gitByProject[projectId] : undefined));
  const files = summary?.files;
  const counts = useMemo(() => scmCounts(files ?? []), [files]);

  const info = repo.info;

  // The store needs to know whose root this is to be able to reload the other
  // store's `git status` after every write.
  useEffect(() => {
    setRepo(projectId, root);
  }, [projectId, root, setRepo]);

  // One read on entry and another every time the `git status` moves: the
  // header (branch, ahead/behind, what is in progress) comes from nowhere else.
  const fingerprint = `${summary?.branch ?? ""}|${summary?.files.length ?? 0}`;
  useEffect(() => {
    if (root) void useScm.getState().refresh(root);
  }, [root, fingerprint]);

  useEffect(() => {
    if (root && section === "history" && repo.commits.length === 0) {
      void useScm.getState().loadLog(root, false);
    }
  }, [root, section, repo.commits.length]);

  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuEntry[] } | null>(null);
  const openMenu = useCallback((e: ReactMouseEvent, items: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, items });
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (!root) return;
      const err = await useScm.getState().run(root, label, fn);
      if (err) showToast(err, "error");
    },
    [root, showToast],
  );

  const confirmAction = useCallback(
    (spec: ScmConfirmSpec, onConfirm: () => void) => {
      useUI.getState().openModal("scm-confirm", { ...spec, onConfirm });
    },
    [],
  );

  /**
   * The read context goes down to every row as a prop, and it is by identity
   * that the row's `memo` decides not to re-render. Built in the render body
   * it was born different every time — and since this component re-renders on
   * every `busy`, `version`, `error` and fresh `git status` summary, that
   * meant re-rendering **every** row four times per click. In a repository of
   * two thousand files that was the whole freeze.
   */
  const ctx = useMemo<Ctx>(() => ({ root: root ?? "", projectId }), [root, projectId]);

  if (!root) {
    return (
      <div className="bench-body" role="tabpanel" aria-label={t("Controle")}>
        <div className="bench-empty">
          <FolderGit2 size={22} aria-hidden="true" />
          {t("Nenhum projeto aberto")}
          <small>{t("Abra um projeto para ver o controle de versão dele.")}</small>
        </div>
      </div>
    );
  }

  // The other store's `git status` usually lands before our `scm_info` —
  // using both avoids the flash where a folder without git draws the commit
  // box for one frame before turning into "not a repository".
  const isRepo = info ? info.isRepo : summary?.isRepo;

  if (isRepo === false) {
    return (
      <div className="bench-body" role="tabpanel" aria-label={t("Controle")}>
        <div className="bench-empty">
          <FolderGit2 size={22} aria-hidden="true" />
          {t("Esta pasta não é um repositório git")}
          <small>
            {t(
              "Sem repositório não há o que preparar nem o que commitar. Dá para criar um agora — nada do que está no disco é alterado.",
            )}
          </small>
          <button
            className="btn btn--primary"
            onClick={() => void run(t("iniciando"), () => ipc.scmInit(root))}
          >
            {t("Iniciar um repositório")}
          </button>
        </div>
      </div>
    );
  }

  const banner = stateBanner(info);
  const sync = syncState(info);

  return (
    <div className="bench-body bench-body--scm" role="tabpanel" aria-label={t("Controle")}>
      <ScmToolbar
        ctx={ctx}
        run={run}
        confirmAction={confirmAction}
        onMenu={openMenu}
        counts={counts}
      />

      {banner && (
        <div className={`scm-banner scm-banner--${banner.tone}`} role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          <div className="scm-banner-text">
            <strong>{banner.title}</strong>
            <span>{banner.detail}</span>
          </div>
          <div className="scm-banner-acts">
            {banner.canContinue && (
              <button className="btn btn--sm" onClick={() => void run(t("continuando"), () => ipc.scmContinue(root))}>
                {t("Continuar")}
              </button>
            )}
            {banner.canAbort && (
              <button
                className="btn btn--sm btn--danger"
                onClick={() => void run(t("abortando"), () => ipc.scmAbort(root))}
              >
                {t("Abortar")}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="task-seg scm-seg" role="tablist" aria-label={t("Seções do controle")}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={section === s.id}
            className={section === s.id ? "is-active" : ""}
            data-tip={t("{label} — {tip}", { label: t(s.label), tip: t(s.tip) })}
            aria-label={t(s.label)}
            onClick={() => setSection(s.id)}
          >
            <s.Icon size={13} aria-hidden="true" />
            {s.id === "changes" && counts.total > 0 && (
              <span className="task-seg-count">{counts.total}</span>
            )}
            {s.id === "stash" && (info?.stashes ?? 0) > 0 && (
              <span className="task-seg-count">{info?.stashes}</span>
            )}
          </button>
        ))}
      </div>

      {repo.error && (
        <p className="scm-error" role="alert">
          {repo.error}
        </p>
      )}

      {section === "changes" && (
        <ChangesSection
          ctx={ctx}
          run={run}
          confirmAction={confirmAction}
          onMenu={openMenu}
          focusTick={focusTick}
        />
      )}
      {section === "history" && (
        <HistorySection ctx={ctx} run={run} confirmAction={confirmAction} onMenu={openMenu} />
      )}
      {section === "branches" && (
        <BranchesSection ctx={ctx} run={run} confirmAction={confirmAction} onMenu={openMenu} />
      )}
      {section === "stash" && (
        <StashSection ctx={ctx} run={run} confirmAction={confirmAction} onMenu={openMenu} />
      )}

      {sync.kind !== "none" && section === "changes" && (
        <p className="scm-foot" aria-hidden="true">
          {info?.upstream
            ? t("Rastreando {upstream}", { upstream: info.upstream })
            : t("Branch ainda não publicada")}
        </p>
      )}

      {menu && (
        <ContextMenu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// top bar: branch, remote, refresh, ⋯
// ---------------------------------------------------------------------------

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>;
type ConfirmAction = (spec: ScmConfirmSpec, onConfirm: () => void) => void;
type OnMenu = (e: ReactMouseEvent, items: MenuEntry[]) => void;

function ScmToolbar({
  ctx,
  run,
  confirmAction,
  onMenu,
  counts,
}: {
  ctx: Ctx;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
  counts: ReturnType<typeof scmCounts>;
}) {
  const repo = useScm((s) => s.repoOf(ctx.root));
  const setSection = useScm((s) => s.setSection);
  const info = repo.info;
  const sync = syncState(info);
  const t = useT();
  const [ask, setAsk] = useState<AskSpec | null>(null);

  const remote = info?.remotes[0]?.name ?? "origin";

  const synchronize = () => {
    if (sync.kind === "publish") {
      void run(t("publicando"), () =>
        ipc.scmPush(ctx.root, remote, info?.branch ?? null, true, false),
      );
      return;
    }
    if (sync.kind === "fetch") {
      void run(t("buscando"), () => ipc.scmFetch(ctx.root, null, false));
      return;
    }
    // Syncing is pull and then push, in that order: pushing first is what
    // produces the "updates were rejected" refusal nobody knows how to read.
    void run(t("sincronizando"), async () => {
      if ((info?.behind ?? 0) > 0) await ipc.scmPull(ctx.root, false);
      if ((info?.ahead ?? 0) > 0) await ipc.scmPush(ctx.root, remote, null, false, false);
    });
  };

  const generalMenu = (): MenuEntry[] => {
    const noRemote = (info?.remotes.length ?? 0) === 0;
    const nothing = counts.total === 0;
    return [
      {
        id: "fetch",
        label: t("Buscar do servidor"),
        disabled: noRemote,
        onSelect: () => void run(t("buscando"), () => ipc.scmFetch(ctx.root, null, false)),
      },
      {
        id: "fetch-prune",
        label: t("Buscar e limpar branches que sumiram"),
        disabled: noRemote,
        onSelect: () => void run(t("buscando"), () => ipc.scmFetch(ctx.root, null, true)),
      },
      {
        id: "pull",
        label: t("Trazer (pull)"),
        disabled: noRemote || !info?.upstream,
        onSelect: () => void run(t("trazendo"), () => ipc.scmPull(ctx.root, false)),
      },
      {
        id: "pull-rebase",
        label: t("Trazer reaplicando o meu por cima (pull --rebase)"),
        disabled: noRemote || !info?.upstream,
        onSelect: () => void run(t("trazendo"), () => ipc.scmPull(ctx.root, true)),
      },
      {
        id: "push",
        label: t("Enviar (push)"),
        disabled: noRemote,
        onSelect: () =>
          void run(t("enviando"), () =>
            ipc.scmPush(ctx.root, remote, info?.upstream ? null : (info?.branch ?? null), !info?.upstream, false),
          ),
      },
      {
        id: "push-force",
        // Always `--force-with-lease` in the backend: it refuses if the server
        // moved since the last fetch, which is the difference between
        // rewriting my own work and erasing somebody else's.
        label: t("Enviar forçando (com verificação)"),
        disabled: noRemote || !info?.upstream,
        danger: true,
        onSelect: () =>
          void run(t("enviando"), () => ipc.scmPush(ctx.root, remote, null, false, true)),
      },
      { kind: "sep" },
      {
        id: "stash",
        label: t("Guardar tudo (stash)"),
        disabled: nothing,
        onSelect: () =>
          setAsk({
            title: t("Guardar o quê?"),
            placeholder: t("Uma descrição (opcional)"),
            confirm: t("Guardar"),
            onConfirm: (theText) =>
              void run(t("guardando"), () => ipc.scmStashPush(ctx.root, theText || null, true, false)),
          }),
      },
      {
        id: "stash-keep",
        label: t("Guardar, mantendo o que está preparado"),
        disabled: counts.changes === 0,
        onSelect: () =>
          void run(t("guardando"), () => ipc.scmStashPush(ctx.root, null, true, true)),
      },
      { kind: "sep" },
      {
        id: "branch",
        label: t("Criar uma branch…"),
        onSelect: () =>
          setAsk({
            title: t("Nome da nova branch"),
            placeholder: t("feature/algo"),
            confirm: t("Criar e trocar"),
            onConfirm: (itemName) =>
              itemName && void run(t("criando"), () => ipc.scmBranchCreate(ctx.root, itemName, null, true)),
          }),
      },
      {
        id: "tag",
        label: t("Criar uma etiqueta aqui…"),
        disabled: !info?.hasHead,
        onSelect: () =>
          setAsk({
            title: t("Nome da etiqueta"),
            placeholder: t("v1.0.0"),
            confirm: t("Criar"),
            onConfirm: (name) =>
              name && void run(t("etiquetando"), () => ipc.scmTagCreate(ctx.root, name, null, null)),
          }),
      },
      { kind: "sep" },
      {
        id: "discard-all",
        label: t("Descartar todas as alterações"),
        disabled: nothing,
        danger: true,
        onSelect: () =>
          confirmAction(
            // `total - untracked` and not `staged`: what "goes back to the
            // commit" is every file git already knows, staged or not.
            discardAllSpec({
              tracked: counts.total - counts.untracked,
              untracked: counts.untracked,
            }),
            () => void run(t("descartando"), () => ipc.scmDiscardAll(ctx.root, true)),
          ),
      },
    ];
  };

  return (
    <>
      <div className="scm-bar">
        <button
          className="scm-branch"
          data-tip={
            info?.upstream
              ? t("Branch atual — rastreia {upstream}", { upstream: info.upstream })
              : t("Branch atual — clique para ver todas")
          }
          aria-label={t("Branch atual: {branch}. Abrir a lista de branches", { branch: branchLabel(info) })}
          onClick={() => setSection("branches")}
        >
          <GitBranch size={12} aria-hidden="true" />
          <span className="scm-branch-name">{branchLabel(info) || "—"}</span>
        </button>

        {sync.kind !== "none" && (
          <button
            className={`scm-sync${sync.kind === "sync" ? " is-behind" : ""}`}
            data-tip={sync.tip}
            aria-label={sync.tip}
            disabled={sync.disabled || repo.busy !== null}
            onClick={synchronize}
          >
            {sync.kind === "publish" ? (
              <CloudUpload size={12} aria-hidden="true" />
            ) : (
              <CloudDownload size={12} aria-hidden="true" />
            )}
            <span>{sync.label}</span>
          </button>
        )}

        <div className="scm-bar-tools">
          <button
            className={`icon-btn${repo.busy ? " is-busy" : ""}`}
            data-tip={repo.busy ? `${repo.busy}…` : t("Atualizar")}
            aria-label={repo.busy ? `${repo.busy}…` : t("Atualizar o estado do repositório")}
            disabled={repo.busy !== null}
            onClick={() => void useScm.getState().refresh(ctx.root)}
          >
            {repo.busy ? <Loader2 size={13} /> : <RotateCw size={13} />}
          </button>
          <button
            className="icon-btn"
            data-tip={t("Mais ações")}
            aria-label={t("Mais ações do repositório")}
            onClick={(e) => onMenu(e, generalMenu())}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
      </div>

      {ask && <AskLine spec={ask} onClose={() => setAsk(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// one-line question (branch name, tag name, stash text)
// ---------------------------------------------------------------------------

interface AskSpec {
  title: string;
  placeholder: string;
  confirm: string;
  initial?: string;
  onConfirm: (value: string) => void;
}

/**
 * A text field that appears inside the panel instead of opening a dialog.
 * The difference matters: "create a branch" is one word, and covering the
 * branch list with a modal sheet to ask for a word removes from the screen
 * precisely what helps pick the name.
 */
function AskLine({ spec, onClose }: { spec: AskSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.initial ?? "");
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  // The top bar and the branches section can each have one open at the same
  // time; a fixed `id` would make the second label point at the first field.
  const id = useId();
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const confirmAction = () => {
    spec.onConfirm(value.trim());
    onClose();
  };

  return (
    <div className="scm-ask">
      <label className="scm-ask-label" htmlFor={id}>
        {spec.title}
      </label>
      <div className="scm-ask-row">
        <input
          id={id}
          ref={ref}
          value={value}
          placeholder={spec.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmAction();
            if (e.key === "Escape") onClose();
          }}
        />
        <button className="btn btn--sm btn--primary" onClick={confirmAction}>
          {spec.confirm}
        </button>
        <button className="icon-btn" aria-label={t("Cancelar")} onClick={onClose}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// section: changes
// ---------------------------------------------------------------------------

function ChangesSection({
  ctx,
  run,
  confirmAction,
  onMenu,
  focusTick,
}: {
  ctx: Ctx;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
  focusTick: number;
}) {
  const summary = useChanges((s) => (ctx.projectId ? s.gitByProject[ctx.projectId] : undefined));
  const files = useMemo(() => summary?.files ?? [], [summary]);
  const groups = useMemo(() => groupChanges(files), [files]);
  const counts = useMemo(() => scmCounts(files), [files]);
  const t = useT();

  return (
    <>
      <CommitBox ctx={ctx} counts={counts} run={run} focusTick={focusTick} />
      {groups.length === 0 ? (
        <div className="bench-empty">
          <Check size={20} aria-hidden="true" />
          {t("Nada mexido")}
          <small>{t("A árvore está igual ao último commit.")}</small>
        </div>
      ) : (
        groups.map((g) => (
          <GroupBlock
            key={g.id}
            ctx={ctx}
            group={g}
            run={run}
            confirmAction={confirmAction}
            onMenu={onMenu}
          />
        ))
      )}
    </>
  );
}

function CommitBox({
  ctx,
  counts,
  run,
  focusTick,
}: {
  ctx: Ctx;
  counts: ReturnType<typeof scmCounts>;
  run: Run;
  focusTick: number;
}) {
  const info = useScm((s) => s.repoOf(ctx.root).info);
  const busy = useScm((s) => s.repoOf(ctx.root).busy);
  const amend = useScm((s) => s.amend);
  const setAmend = useScm((s) => s.setAmend);
  const draft = useScm((s) => s.draftOf(ctx.root));
  const setDraft = useScm((s) => s.setDraft);
  const showToast = useUI((s) => s.showToast);
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = useT();

  useEffect(() => {
    if (focusTick > 0) ref.current?.focus();
  }, [focusTick]);

  // Turning "amend" on brings in the message about to be rewritten: without
  // it, fixing a typo in the subject silently erased the whole body.
  useEffect(() => {
    if (!amend) return;
    let alive = true;
    void ipc
      .scmLastMessage(ctx.root)
      .then((msg) => {
        if (alive && msg && !useScm.getState().draftOf(ctx.root)) {
          useScm.getState().setDraft(ctx.root, msg);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [amend, ctx.root]);

  const action = commitAction(info, counts, draft, amend);
  const hint = messageHint(draft);

  const doCommit = async () => {
    const error = await useScm.getState().commit(ctx.root, {
      amend,
      stageAll: action.stageAll,
    });
    if (error) showToast(error, "error");
  };

  return (
    <div className="scm-commit">
      <textarea
        ref={ref}
        className="scm-message"
        rows={3}
        value={draft}
        placeholder={
          amend ? t("Nova mensagem do último commit") : t("Mensagem do commit (Ctrl+Enter grava)")
        }
        aria-label={t("Mensagem do commit")}
        onChange={(e) => setDraft(ctx.root, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !action.disabled) {
            e.preventDefault();
            void doCommit();
          }
        }}
      />
      {hint && <p className="scm-hint">{hint}</p>}
      {action.warning && (
        <p className="scm-hint scm-hint--warn">
          <AlertTriangle size={11} aria-hidden="true" /> {action.warning}
        </p>
      )}
      <div className="scm-commit-row">
        <button
          className="btn btn--primary scm-commit-btn"
          disabled={action.disabled || busy !== null}
          data-tip={action.tip}
          aria-label={action.disabled ? (action.reason ?? action.tip) : action.tip}
          onClick={() => void doCommit()}
        >
          <Check size={13} aria-hidden="true" />
          {busy === "commitando" ? t("Gravando…") : action.label}
        </button>
        <button
          className={`btn btn--sm${amend ? " is-active" : ""}`}
          aria-pressed={amend}
          data-tip={t("Reescrever o último commit em vez de criar outro")}
          aria-label={t("Emendar o último commit")}
          disabled={!info?.hasHead}
          onClick={() => setAmend(!amend)}
        >
          <Undo2 size={12} aria-hidden="true" />
          {t("Emendar")}
        </button>
      </div>
      {action.disabled && action.reason && <p className="scm-hint">{action.reason}</p>}
      {counts.total > 0 && (
        <div className="scm-quick">
          <button
            className="btn btn--sm"
            disabled={counts.changes === 0}
            onClick={() => void run(t("preparando"), () => ipc.scmStageAll(ctx.root))}
          >
            <Plus size={12} aria-hidden="true" /> {t("Preparar tudo")}
          </button>
          <button
            className="btn btn--sm"
            disabled={counts.staged === 0}
            onClick={() => void run(t("despreparando"), () => ipc.scmUnstageAll(ctx.root))}
          >
            <Minus size={12} aria-hidden="true" /> {t("Despreparar tudo")}
          </button>
        </div>
      )}
    </div>
  );
}

const GroupBlock = memo(function GroupBlock({
  ctx,
  group,
  run,
  confirmAction,
  onMenu,
}: {
  ctx: Ctx;
  group: ReturnType<typeof groupChanges>[number];
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const t = useT();
  const [shown, setShown] = useState(SCM_ROWS_PAGE);
  const page = useMemo(() => pageRows(group.rows, shown), [group.rows, shown]);

  const groupActions = {
    stageAll: () =>
      void run(t("preparando"), () =>
        ipc.scmStage(ctx.root, group.rows.map((r) => r.path)),
      ),
    unstageAll: () =>
      void run(t("despreparando"), () =>
        ipc.scmUnstage(ctx.root, group.rows.map((r) => r.path)),
      ),
    discardAll: () => {
      const paths = group.rows.map((r) => r.path);
      const added = group.rows.filter((r) => r.untracked).length;
      confirmAction(
        discardAllSpec({ tracked: paths.length - added, untracked: added }),
        () => void run(t("descartando"), () => ipc.scmDiscard(ctx.root, paths)),
      );
    },
  };

  return (
    <section className="scm-group">
      <div
        className="scm-group-head"
        onContextMenu={(e) =>
          onMenu(e, scmGroupMenu(group.id, { count: group.rows.length }, groupActions))
        }
      >
        <button
          className="bench-subhead"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((v) => !v)}
        >
          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {group.label}
          <span className="scm-group-count">{group.rows.length}</span>
        </button>
        <div className="scm-group-tools">
          {group.id === "staged" ? (
            <button
              className="icon-btn"
              data-tip={t("Despreparar tudo deste grupo")}
              aria-label={t("Despreparar todos os arquivos deste grupo")}
              onClick={groupActions.unstageAll}
            >
              <Minus size={12} />
            </button>
          ) : (
            <>
              {group.id === "changes" && (
                <button
                  className="icon-btn icon-btn--danger"
                  data-tip={t("Descartar tudo deste grupo")}
                  aria-label={t("Descartar todas as alterações deste grupo")}
                  onClick={groupActions.discardAll}
                >
                  <Undo2 size={12} />
                </button>
              )}
              <button
                className="icon-btn"
                data-tip={
                  group.id === "conflicts" ? t("Marcar todos como resolvidos") : t("Preparar tudo deste grupo")
                }
                aria-label={
                  group.id === "conflicts"
                    ? t("Marcar todos os conflitos como resolvidos")
                    : t("Preparar todos os arquivos deste grupo")
                }
                onClick={groupActions.stageAll}
              >
                <Plus size={12} />
              </button>
            </>
          )}
        </div>
      </div>
      {isOpen && (
        <div className="scm-rows">
          {page.rows.map((row) => (
            <FileRow
              key={row.key}
              ctx={ctx}
              row={row}
              run={run}
              confirmAction={confirmAction}
              onMenu={onMenu}
            />
          ))}
          {page.hidden > 0 && (
            <button
              className="list-more"
              onClick={() => setShown((n) => n + SCM_ROWS_PAGE)}
            >
              {t("Mostrar mais {n}", { n: Math.min(page.hidden, SCM_ROWS_PAGE) })}
              <span className="list-more-rest">
                {tn(page.hidden, "{n} arquivo sem desenhar", "{n} arquivos sem desenhar")}
              </span>
            </button>
          )}
        </div>
      )}
    </section>
  );
});

// ---------------------------------------------------------------------------
// the file row, with the diff and the per-hunk buttons
// ---------------------------------------------------------------------------

const FileRow = memo(function FileRow({
  ctx,
  row,
  run,
  confirmAction,
  onMenu,
}: {
  ctx: Ctx;
  row: ScmRow;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
}) {
  const [opened, setOpened] = useState(false);
  const t = useT();
  const info = useScm((s) => s.repoOf(ctx.root).info);
  const showToast = useUI((s) => s.showToast);

  const actions = useMemo(
    () => ({
      openDiff: () => {
        if (ctx.projectId) useChanges.getState().openViewer(ctx.projectId, row.path);
      },
      openInEditor: (path: string) => {
        void useEditor
          .getState()
          .openFile(path)
          .catch((e) => showToast(t("Não consegui abrir: {e}", { e: String(e) }), "error"));
      },
      stage: (path: string) => void run(t("preparando"), () => ipc.scmStage(ctx.root, [path])),
      unstage: (path: string) =>
        void run(t("despreparando"), () => ipc.scmUnstage(ctx.root, [path])),
      discard: (path: string) =>
        confirmAction(discardSpec([path], row.untracked), () =>
          void run(t("descartando"), () => ipc.scmDiscard(ctx.root, [path])),
        ),
      resolve: (path: string, side: "ours" | "theirs") =>
        void run(t("resolvendo"), () => ipc.scmResolveConflict(ctx.root, [path], side)),
      fileHistory: (path: string) => {
        useScm.getState().setSection("history");
        void useScm.getState().loadFileLog(ctx.root, path);
      },
      copyText: (text: string) => void copyText(text),
      reveal: (osPath: string) => {
        void ipc.revealPath(osPath).catch((e) => showToast(String(e), "error"));
      },
    }),
    [ctx.root, ctx.projectId, row.path, row.untracked, run, confirmAction, showToast, t],
  );

  return (
    <div className="scm-row-wrap">
      <div
        className={`scm-row${opened ? " is-open" : ""}`}
        onContextMenu={(e) => onMenu(e, scmRowMenu(row, { root: ctx.root, info }, actions))}
      >
        <button
          className="scm-row-main"
          aria-expanded={opened}
          data-tip={row.conflict ? conflictKind(row.conflict) : row.path}
          onClick={() => setOpened((v) => !v)}
        >
          {opened ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <GitStatusBadge status={row.status} />
          <PathLabel path={row.path} deleted={row.status === "deleted"} />
          {row.additions !== null && (row.additions > 0 || (row.deletions ?? 0) > 0) && (
            <span className="scm-row-stat">
              {row.additions > 0 && <em className="scm-add">+{row.additions}</em>}
              {(row.deletions ?? 0) > 0 && <em className="scm-del">−{row.deletions}</em>}
            </span>
          )}
        </button>
        <div className="scm-row-acts">
          {row.canDiscard && (
            <button
              className="icon-btn icon-btn--danger"
              data-tip={row.untracked ? t("Excluir o arquivo") : t("Descartar as alterações")}
              aria-label={
                row.untracked
                  ? t("Excluir {path}", { path: row.path })
                  : t("Descartar as alterações de {path}", { path: row.path })
              }
              onClick={() => actions.discard(row.path)}
            >
              <Undo2 size={12} />
            </button>
          )}
          {row.canUnstage ? (
            <button
              className="icon-btn"
              data-tip={t("Despreparar")}
              aria-label={t("Despreparar {path}", { path: row.path })}
              onClick={() => actions.unstage(row.path)}
            >
              <Minus size={12} />
            </button>
          ) : (
            <button
              className="icon-btn"
              data-tip={row.group === "conflicts" ? t("Marcar como resolvido") : t("Preparar")}
              aria-label={
                row.group === "conflicts"
                  ? t("Marcar {path} como resolvido", { path: row.path })
                  : t("Preparar {path}", { path: row.path })
              }
              onClick={() => actions.stage(row.path)}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
      </div>
      {opened && <RowDiff ctx={ctx} row={row} run={run} confirmAction={confirmAction} />}
    </div>
  );
});

/**
 * The row's diff, with one button per hunk.
 *
 * The `side` comes from the row and is no detail: the "Staged" group compares
 * `HEAD` with the index and the "Changes" group compares the index with the
 * disk. Building the patch from the wrong comparison produces a patch that
 * `git apply` refuses — and the click does nothing, without saying why.
 */
function RowDiff({
  ctx,
  row,
  run,
  confirmAction,
}: {
  ctx: Ctx;
  row: ScmRow;
  run: Run;
  confirmAction: ConfirmAction;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<number, Set<number>>>({});
  const t = useT();
  // Re-read on every write: staging a hunk changes the very diff on screen.
  // And it is the store's counter, not the `git status` fingerprint — staging
  // the second hunk of a file that is already `MM` changes nothing the
  // summary knows how to say, and still changes the text here.
  const version = useScm((s) => s.repoOf(ctx.root).version);

  useEffect(() => {
    let alive = true;
    setError(null);
    void ipc
      .scmDiff(ctx.root, row.path, row.side, row.origPath, null)
      .then((d) => {
        if (!alive) return;
        setDiff(d);
        setSelection({});
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [ctx.root, row.path, row.side, row.origPath, version]);

  const parsed = useMemo(() => (diff ? splitPatch(diff.text) : null), [diff]);
  // The backend's 1 MB cut still lets ~20 thousand lines through, and each
  // one becomes a clickable `<span>` (that is how line-by-line picking works).
  // Opening a regenerated lockfile in here froze the window for seconds.
  const drawn = useMemo(
    () => capHunks(parsed?.hunks ?? EMPTY_HUNKS, SCM_DIFF_LINES),
    [parsed],
  );

  if (error) return <p className="diff-note">{error}</p>;
  if (!diff) return <p className="diff-note">{t("Lendo o diff…")}</p>;
  if (diff.isBinary) return <p className="diff-note">{t("Arquivo binário — sem diff de texto.")}</p>;
  if (!parsed || parsed.hunks.length === 0)
    return <p className="diff-note">{t("Sem diferenças neste lado.")}</p>;

  const staged = row.group === "staged";

  const applyIt = (patch: string, label: string) => {
    if (!patch) return;
    void run(label, () => ipc.scmApplyPatch(ctx.root, patch, true, staged));
  };

  const discard = (patch: string, spec: ScmConfirmSpec) => {
    if (!patch) return;
    confirmAction(spec, () =>
      void run(t("descartando"), () => ipc.scmApplyPatch(ctx.root, patch, false, true)),
    );
  };

  const toggleLine = (hunk: number, line: number) => {
    setSelection((prev) => {
      const currentValue = new Set(prev[hunk] ?? []);
      if (currentValue.has(line)) currentValue.delete(line);
      else currentValue.add(line);
      return { ...prev, [hunk]: currentValue };
    });
  };

  return (
    <div className="scm-diff">
      {drawn.hunks.map((h) => (
        <HunkBlock
          key={h.index}
          hunk={h}
          selectedLines={selection[h.index] ?? EMPTY_SET}
          staged={staged}
          onToggleLine={(line) => toggleLine(h.index, line)}
          onApplyHunk={() =>
            applyIt(
              patchForHunks(diff.text, [h.index]),
              staged ? "despreparando" : "preparando",
            )
          }
          onApplyLines={() =>
            applyIt(
              patchForLines(diff.text, h.index, selection[h.index] ?? EMPTY_SET),
              staged ? "despreparando" : "preparando",
            )
          }
          onDiscardHunk={() =>
            discard(patchForHunks(diff.text, [h.index]), {
              title: t("Descartar este pedaço?"),
              detail: t("As linhas deste trecho de “{path}” voltam ao que estavam. Isso não dá para desfazer.", {
                path: row.path,
              }),
              confirmLabel: t("Descartar o pedaço"),
            })
          }
        />
      ))}
      {drawn.hiddenLines > 0 && (
        <p className="diff-note">
          {t("Diff grande: {lines}{hunks}. Abra no visor para ver o arquivo inteiro.", {
            lines: tn(drawn.hiddenLines, "{n} linha não desenhada", "{n} linhas não desenhadas"),
            hunks:
              drawn.hiddenHunks > 0
                ? ` (${tn(drawn.hiddenHunks, "{n} pedaço inteiro", "{n} pedaços inteiros")})`
                : "",
          })}
        </p>
      )}
    </div>
  );
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();
const EMPTY_HUNKS: PatchHunk[] = [];

function HunkBlock({
  hunk,
  selectedLines,
  staged,
  onToggleLine,
  onApplyHunk,
  onApplyLines,
  onDiscardHunk,
}: {
  hunk: PatchHunk;
  selectedLines: ReadonlySet<number>;
  staged: boolean;
  onToggleLine: (line: number) => void;
  onApplyHunk: () => void;
  onApplyLines: () => void;
  onDiscardHunk: () => void;
}) {
  const t = useT();
  const hasSelection = selectedLines.size > 0;
  const verb = staged ? t("Despreparar") : t("Preparar");
  return (
    <div className="scm-hunk">
      <div className="scm-hunk-head">
        <code>{hunk.header}</code>
        <span className="scm-hunk-stat">
          {hunk.additions > 0 && <em className="scm-add">+{hunk.additions}</em>}
          {hunk.deletions > 0 && <em className="scm-del">−{hunk.deletions}</em>}
        </span>
        {/* Always visible, not only on hover: staging by hunk is the reason
            the row opens. Hiding them behind the cursor hides the one thing
            this panel does that the one below does not. */}
        <div className="scm-hunk-acts">
          {hasSelection && (
            <button
              className="btn btn--sm"
              data-tip={t("{verb} só as {n} linha(s) marcadas", { verb, n: selectedLines.size })}
              onClick={onApplyLines}
            >
              {tn(selectedLines.size, "{n} linha", "{n} linhas")}
            </button>
          )}
          <button
            className="icon-btn"
            data-tip={t("{verb} este pedaço", { verb })}
            aria-label={t("{verb} este pedaço", { verb })}
            onClick={onApplyHunk}
          >
            {staged ? <Minus size={11} /> : <Plus size={11} />}
          </button>
          {!staged && (
            <button
              className="icon-btn icon-btn--danger"
              data-tip={t("Descartar este pedaço")}
              aria-label={t("Descartar este pedaço")}
              onClick={onDiscardHunk}
            >
              <Undo2 size={11} />
            </button>
          )}
        </div>
      </div>
      <pre>
        {hunk.lines.map((line, i) => {
          const isChange = line.startsWith("+") || line.startsWith("-");
          const checked = selectedLines.has(i);
          return (
            <span
              key={i}
              className={`${diffLineClass(line)}${isChange ? " is-pickable" : ""}${checked ? " is-picked" : ""}`}
              onClick={isChange ? () => onToggleLine(i) : undefined}
              role={isChange ? "button" : undefined}
              tabIndex={isChange ? 0 : undefined}
              aria-pressed={isChange ? checked : undefined}
              onKeyDown={
                isChange
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggleLine(i);
                      }
                    }
                  : undefined
              }
            >
              {line || " "}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// section: history
// ---------------------------------------------------------------------------

function HistorySection({
  ctx,
  run,
  confirmAction,
  onMenu,
}: {
  ctx: Ctx;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
}) {
  const t = useT();
  const repo = useScm((s) => s.repoOf(ctx.root));
  const info = repo.info;

  if (!info?.hasHead) {
    return (
      <div className="bench-empty">
        <GitCommitVertical size={20} aria-hidden="true" />
        {t("Ainda não há commits")}
        <small>{t("O histórico começa no primeiro commit desta branch.")}</small>
      </div>
    );
  }

  return (
    <>
      <div className="scm-rows">
        {repo.commits.map((c) => (
          <CommitRow
            key={c.hash}
            ctx={ctx}
            commit={c}
            run={run}
            confirmAction={confirmAction}
            onMenu={onMenu}
          />
        ))}
      </div>
      {repo.commits.length === 0 && <p className="bench-note">{t("Lendo o histórico…")}</p>}
      {!repo.logDone && repo.commits.length > 0 && (
        <button
          className="btn btn--sm scm-more"
          onClick={() => void useScm.getState().loadLog(ctx.root, true)}
        >
          <History size={12} aria-hidden="true" /> {t("Carregar mais")}
        </button>
      )}
    </>
  );
}

function CommitRow({
  ctx,
  commit,
  run,
  confirmAction,
  onMenu,
}: {
  ctx: Ctx;
  commit: ScmCommit;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
}) {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof ipc.scmCommitDetail>> | null>(
    null,
  );
  const info = useScm((s) => s.repoOf(ctx.root).info);
  const showToast = useUI((s) => s.showToast);
  const [ask, setAsk] = useState<AskSpec | null>(null);

  useEffect(() => {
    if (!isOpen || detail) return;
    let alive = true;
    void ipc
      .scmCommitDetail(ctx.root, commit.hash)
      .then((d) => alive && setDetail(d))
      .catch((e) => showToast(String(e), "error"));
    return () => {
      alive = false;
    };
  }, [isOpen, detail, ctx.root, commit.hash, showToast]);

  const actions = {
    checkout: (rev: string) => void run(t("trocando"), () => ipc.scmCheckout(ctx.root, rev)),
    createFrom: (start: string) =>
      setAsk({
        title: t("Nome da nova branch"),
        placeholder: t("feature/algo"),
        confirm: t("Criar e trocar"),
        onConfirm: (name) =>
          name && void run(t("criando"), () => ipc.scmBranchCreate(ctx.root, name, start, true)),
      }),
    revert: (hash: string) =>
      void run(t("revertendo"), async () => {
        const res = await ipc.scmRevert(ctx.root, hash);
        if (res.conflicted) showToast(t("O revert parou em conflitos — resolva-os na aba Alterações."));
      }),
    reset: (hash: string, mode: "soft" | "mixed" | "hard") =>
      confirmAction(resetSpec(commit.short, mode), () =>
        void run(t("voltando"), () => ipc.scmReset(ctx.root, hash, mode)),
      ),
    tag: (hash: string) =>
      setAsk({
        title: t("Nome da etiqueta"),
        placeholder: t("v1.0.0"),
        confirm: t("Criar"),
        onConfirm: (name) =>
          name && void run(t("etiquetando"), () => ipc.scmTagCreate(ctx.root, name, null, hash)),
      }),
    copyText: (text: string) => void copyText(text),
  };

  return (
    <div className="scm-row-wrap">
      <div
        className="scm-row scm-row--commit"
        onContextMenu={(e) => onMenu(e, scmCommitMenu(commit, { info }, actions))}
      >
        <button
          className="scm-row-main"
          aria-expanded={isOpen}
          // The author lives here and not on the line below: in a narrow
          // column it is the field that pushes the date — the "when" — out.
          data-tip={`${commit.author} <${commit.email}>`}
          onClick={() => setIsOpen((v) => !v)}
        >
          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <div className="scm-commit-text">
            <span className="scm-commit-subject">{commit.subject}</span>
            <span className="scm-commit-meta">
              {/* The refs go on the line below, not beside the subject:
                  beside it, a branch with a long name ate the text that says
                  what the commit did — which is what is being read. */}
              {commit.refs.slice(0, 2).map((r) => (
                <span key={r} className="scm-ref">
                  {r.replace("HEAD -> ", "")}
                </span>
              ))}
              <code>{commit.short}</code> · {since(commit.date, Date.now())}
            </span>
          </div>
        </button>
      </div>
      {ask && <AskLine spec={ask} onClose={() => setAsk(null)} />}
      {isOpen && (
        <div className="scm-commit-detail">
          {commit.body && <pre className="scm-commit-body">{commit.body}</pre>}
          {!detail ? (
            <p className="diff-note">{t("Lendo o commit…")}</p>
          ) : (
            <>
              <p className="diff-note">
                {tn(detail.files.length, "{n} arquivo", "{n} arquivos")} ·{" "}
                <em className="scm-add">+{detail.additions}</em>{" "}
                <em className="scm-del">−{detail.deletions}</em>
              </p>
              {detail.files.map((f) => (
                <CommitFile key={f.path} ctx={ctx} hash={commit.hash} file={f} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CommitFile({
  ctx,
  hash,
  file,
}: {
  ctx: Ctx;
  hash: string;
  file: { path: string; status: string; additions: number | null; deletions: number | null };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const showToast = useUI((s) => s.showToast);

  useEffect(() => {
    if (!isOpen || diff) return;
    let alive = true;
    void ipc
      .scmCommitFileDiff(ctx.root, hash, file.path)
      .then((d) => alive && setDiff(d))
      .catch((e) => showToast(String(e), "error"));
    return () => {
      alive = false;
    };
  }, [isOpen, diff, ctx.root, hash, file.path, showToast]);

  return (
    <div className="scm-row-wrap">
      <div className="scm-row scm-row--sub">
        <button className="scm-row-main" aria-expanded={isOpen} onClick={() => setIsOpen((v) => !v)}>
          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <GitStatusBadge status={file.status} />
          <PathLabel path={file.path} deleted={file.status === "deleted"} />
        </button>
      </div>
      {isOpen && diff && (
        <div className="scm-diff">
          <pre>
            {diff.text.split("\n").map((line, i) => (
              <span key={i} className={diffLineClass(line)}>
                {line || " "}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// section: branches (and tags)
// ---------------------------------------------------------------------------

function BranchesSection({
  ctx,
  run,
  confirmAction,
  onMenu,
}: {
  ctx: Ctx;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
}) {
  const tr = useT();
  const repo = useScm((s) => s.repoOf(ctx.root));
  const info = repo.info;
  const [filter, setFilter] = useState("");
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const showToast = useUI((s) => s.showToast);

  const target = filter.trim().toLowerCase();
  const matches = (b: ScmBranch) => !target || b.name.toLowerCase().includes(target);
  const locals = repo.branches.filter((b) => !b.remote && matches(b));
  const remoteBranches = repo.branches.filter((b) => b.remote && matches(b));
  const tags = repo.tags.filter((t) => !target || t.name.toLowerCase().includes(target));

  const actions = {
    checkout: (name: string) => void run(tr("trocando"), () => ipc.scmCheckout(ctx.root, name)),
    createFrom: (start: string) =>
      setAsk({
        title: tr("Nova branch a partir de {start}", { start }),
        placeholder: tr("feature/algo"),
        confirm: tr("Criar e trocar"),
        initial: start.includes("/") ? start.split("/").slice(1).join("/") : "",
        onConfirm: (name) =>
          name && void run(tr("criando"), () => ipc.scmBranchCreate(ctx.root, name, start, true)),
      }),
    merge: (name: string) =>
      void run(tr("mesclando"), async () => {
        const res = await ipc.scmMerge(ctx.root, name, false);
        if (res.conflicted) {
          useScm.getState().setSection("changes");
          showToast(tr("O merge parou em conflitos — resolva-os na aba Alterações."));
        }
      }),
    rebase: (name: string) =>
      void run(tr("reaplicando"), async () => {
        const res = await ipc.scmRebase(ctx.root, name);
        if (res.conflicted) {
          useScm.getState().setSection("changes");
          showToast(tr("O rebase parou em conflitos — resolva-os na aba Alterações."));
        }
      }),
    rename: (name: string) =>
      setAsk({
        title: tr("Renomear “{name}”", { name }),
        placeholder: tr("novo-nome"),
        confirm: tr("Renomear"),
        initial: name,
        onConfirm: (next) =>
          next && void run(tr("renomeando"), () => ipc.scmBranchRename(ctx.root, name, next)),
      }),
    deleteBranch: (name: string, force: boolean) =>
      confirmAction(branchDeleteSpec(name, force), () =>
        void run(tr("apagando"), () => ipc.scmBranchDelete(ctx.root, name, force)),
      ),
    deleteRemote: (name: string) => {
      const remote = info?.remotes[0]?.name ?? "origin";
      const shortOne = name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name;
      confirmAction(remoteDeleteSpec(shortOne, remote), () =>
        void run(tr("apagando no servidor"), () => ipc.scmPushDelete(ctx.root, remote, shortOne)),
      );
    },
    copyText: (text: string) => void copyText(text),
  };

  return (
    <>
      <div className="bench-search scm-filter">
        <GitBranch size={12} aria-hidden="true" />
        <input
          value={filter}
          placeholder={tr("Filtrar branches e etiquetas")}
          aria-label={tr("Filtrar branches e etiquetas pelo nome")}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
        />
        <button
          className="icon-btn"
          data-tip={tr("Criar uma branch a partir da atual")}
          aria-label={tr("Criar uma branch")}
          onClick={() =>
            setAsk({
              title: tr("Nome da nova branch"),
              placeholder: tr("feature/algo"),
              confirm: tr("Criar e trocar"),
              onConfirm: (name) =>
                name && void run(tr("criando"), () => ipc.scmBranchCreate(ctx.root, name, null, true)),
            })
          }
        >
          <Plus size={12} />
        </button>
      </div>
      {ask && <AskLine spec={ask} onClose={() => setAsk(null)} />}

      <BranchList title={tr("Locais")} branches={locals} info={info} actions={actions} onMenu={onMenu} />
      {remoteBranches.length > 0 && (
        <BranchList title={tr("Remotas")} branches={remoteBranches} info={info} actions={actions} onMenu={onMenu} />
      )}

      {tags.length > 0 && (
        <section className="scm-group">
          <div className="scm-group-head">
            <span className="bench-subhead">
              {tr("Etiquetas")}<span className="scm-group-count">{tags.length}</span>
            </span>
          </div>
          <div className="scm-rows">
            {tags.map((t) => (
              <div key={t.name} className="scm-row scm-row--sub">
                <span className="scm-row-main scm-row-static">
                  <Tag size={11} aria-hidden="true" />
                  <span className="scm-branch-name">{t.name}</span>
                  <span className="scm-commit-meta">{t.subject}</span>
                </span>
                <button
                  className="icon-btn icon-btn--danger"
                  data-tip={tr("Apagar a etiqueta")}
                  aria-label={tr("Apagar a etiqueta {name}", { name: t.name })}
                  onClick={() =>
                    confirmAction(
                      {
                        title: tr("Apagar a etiqueta “{name}”?", { name: t.name }),
                        detail: tr("Ela some daqui; no servidor, só sai com um push próprio."),
                        confirmLabel: tr("Apagar"),
                      },
                      () => void run(tr("apagando"), () => ipc.scmTagDelete(ctx.root, t.name)),
                    )
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function BranchList({
  title: theTitle,
  branches,
  info,
  actions: actions,
  onMenu,
}: {
  title: string;
  branches: ScmBranch[];
  info: ScmInfo | null;
  actions: Parameters<typeof scmBranchMenu>[2];
  onMenu: OnMenu;
}) {
  const t = useT();
  if (branches.length === 0) {
    return (
      <section className="scm-group">
        <div className="scm-group-head">
          <span className="bench-subhead">{theTitle}</span>
        </div>
        <p className="bench-note">{t("Nenhuma por aqui.")}</p>
      </section>
    );
  }
  return (
    <section className="scm-group">
      <div className="scm-group-head">
        <span className="bench-subhead">
          {theTitle}
          <span className="scm-group-count">{branches.length}</span>
        </span>
      </div>
      <div className="scm-rows">
        {branches.map((b) => (
          <div
            key={b.name}
            className={`scm-row${b.current ? " is-current" : ""}`}
            onContextMenu={(e) => onMenu(e, scmBranchMenu(b, { info }, actions))}
          >
            <button
              className="scm-row-main"
              data-tip={b.subject}
              aria-label={b.current ? t("{name} (atual)", { name: b.name }) : b.name}
              disabled={b.current}
              onClick={() => (b.remote ? actions.createFrom(b.name) : actions.checkout(b.name))}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span className="scm-branch-name">{b.name}</span>
              {b.current && <span className="scm-tagline">{t("atual")}</span>}
              {b.gone && (
                <span className="scm-tagline scm-tagline--warn">{t("sumiu no servidor")}</span>
              )}
              {(b.ahead > 0 || b.behind > 0) && (
                <span className="scm-row-stat">
                  {b.behind > 0 && <em className="scm-del">{b.behind}↓</em>}
                  {b.ahead > 0 && <em className="scm-add">{b.ahead}↑</em>}
                </span>
              )}
            </button>
            <button
              className="icon-btn"
              data-tip={t("Mais ações")}
              aria-label={t("Mais ações de {name}", { name: b.name })}
              onClick={(e) => onMenu(e, scmBranchMenu(b, { info }, actions))}
            >
              <MoreHorizontal size={12} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// section: stash
// ---------------------------------------------------------------------------

function StashSection({
  ctx,
  run,
  confirmAction,
  onMenu,
}: {
  ctx: Ctx;
  run: Run;
  confirmAction: ConfirmAction;
  onMenu: OnMenu;
}) {
  const t = useT();
  const repo = useScm((s) => s.repoOf(ctx.root));
  const [showing, setShowing] = useState<{ index: number; text: string } | null>(null);
  const showToast = useUI((s) => s.showToast);

  const actions = {
    stashApply: (index: number, pop: boolean) =>
      void run(t("aplicando"), () => ipc.scmStashApply(ctx.root, index, pop)),
    stashDrop: (index: number) => {
      const target = repo.stashes.find((s) => s.index === index);
      confirmAction(stashDropSpec(target?.message ?? `stash@{${index}}`), () =>
        void run(t("descartando"), () => ipc.scmStashDrop(ctx.root, index)),
      );
    },
    stashShow: (index: number) => {
      void ipc
        .scmStashShow(ctx.root, index)
        .then((text) => setShowing({ index, text }))
        .catch((e) => showToast(String(e), "error"));
    },
  };

  if (repo.stashes.length === 0) {
    return (
      <div className="bench-empty">
        <Archive size={20} aria-hidden="true" />
        {t("Nada guardado")}
        <small>
          {t(
            "Guardar tira as alterações do caminho sem commitar — útil para trocar de branch no meio de uma coisa. Fica no menu ⋯ lá em cima.",
          )}
        </small>
      </div>
    );
  }

  return (
    <div className="scm-rows">
      {repo.stashes.map((s) => (
        <div key={s.index} className="scm-row-wrap">
          <div
            className="scm-row"
            onContextMenu={(e) => onMenu(e, scmStashMenu(s, actions))}
          >
            <button
              className="scm-row-main"
              data-tip={t("Ver o que tem dentro")}
              onClick={() =>
                showing?.index === s.index ? setShowing(null) : actions.stashShow(s.index)
              }
            >
              <Archive size={11} aria-hidden="true" />
              <div className="scm-commit-text">
                <span className="scm-commit-subject">{stashTitle(s.message, s.branch)}</span>
                <span className="scm-commit-meta">
                  {s.branch ? `${s.branch} · ` : ""}
                  {since(s.date, Date.now())}
                </span>
              </div>
            </button>
            <div className="scm-row-acts">
              <button
                className="icon-btn"
                data-tip={t("Aplicar e remover da pilha")}
                aria-label={t("Aplicar e remover {name}", { name: s.message })}
                onClick={() => actions.stashApply(s.index, true)}
              >
                <Check size={12} />
              </button>
              <button
                className="icon-btn"
                data-tip={t("Mais ações")}
                aria-label={t("Mais ações de {name}", { name: s.message })}
                onClick={(e) => onMenu(e, scmStashMenu(s, actions))}
              >
                <MoreHorizontal size={12} />
              </button>
            </div>
          </div>
          {showing?.index === s.index && (
            <div className="scm-diff">
              <pre>
                {showing.text.split("\n").map((line, i) => (
                  <span key={i} className={diffLineClass(line)}>
                    {line || " "}
                  </span>
                ))}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
