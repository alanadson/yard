import { commands, topics, type EventPayloads_Serialize } from "./bindings";
export { topics } from "./bindings";
import * as refine from "../contracts/refinements";
import type {
  SpawnOptions,
  AttachWants,
  SessionFeed,
  ResourcesTick,
  WindowShown,
  WorkspaceSnapshot,
  FilesActivity,
  ScmCommitOpts,
  ScmLogQuery,
  ScmDiffSide,
  SearchOptions,
  FileStamp,
  PreflightItem,
  UsageSnapshot,
  PortalOpen,
  PortalRect,
  PortalPlace,
  PortalBoundsUpdate,
  PortalNav,
  PortalPopup,
  PortalEscape,
  PortalMenu,
  NoteRecord,
  NotebookRecord,
  NoteTagRecord,
  McpServer,
  LspMessagePayload,
  LspExitPayload,
  BridgeRequest,
  BridgeResponse,
  OutputChunk,
  ExitPayload,
  ActivityPayload,
  IdlePayload,
} from "../contracts/types";
/** Tauri adapter for backend commands, application events and terminal channels. */
// i18n-scan: tables , string-literal unions and backend error names; nothing here is rendered.
import { Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { createPtyStream } from "../lib/ptyStream";

export const ipc = {
  accountsSnapshot: () => commands.accountsSnapshot(),
  accountCreate: (id: string, provider: string, label: string) =>
    commands.accountCreate(id, provider, label),
  accountSelect: (provider: string, accountId: string | null) =>
    commands.accountSelect(provider, accountId ?? null),
  accountAssign: (
    terminalId: string,
    provider: string,
    accountId: string | null,
  ) => commands.accountAssign(terminalId, provider, accountId ?? null),
  accountVerify: (id: string) => commands.accountVerify(id),
  accountRemove: (id: string) => commands.accountRemove(id),
  flowStart: (
    groupId: string,
    flowId: string,
    terminalId: string,
    task: string,
    typed = false,
    callerId?: string,
    work?: { id: string; revision: number },
  ) =>
    commands
      .flowStart({
        groupId,
        flowId,
        terminalId,
        task,
        typed,
        callerId,
        ...(work ? { taskId: work.id, taskRevision: work.revision } : {}),
      })
      .then(refine.legacyJson<import("../stores/flowStore").FlowRun>),
  flowSnapshot: () =>
    commands
      .flowSnapshot()
      .then(refine.legacyJson<import("../stores/flowStore").FlowRun[]>),
  flowCancel: (groupId: string, flowId: string, attempt: number) =>
    commands
      .flowCancel(groupId, flowId, attempt)
      .then(refine.legacyJson<import("../stores/flowStore").FlowRun>),
  flowResume: (
    groupId: string,
    flowId: string,
    attempt: number,
    confirmed: boolean,
  ) =>
    commands
      .flowResume(groupId, flowId, attempt, confirmed)
      .then(refine.legacyJson<import("../stores/flowStore").FlowRun>),
  flowDismiss: (groupId: string, flowId: string, attempt: number) =>
    commands.flowDismiss(groupId, flowId, attempt).then(() => undefined),
  ptyArchives: (id: string | null = null) => commands.ptyArchives(id ?? null),
  ptyArchivePreview: (id: string, name: string) =>
    commands.ptyArchivePreview(id, name, 64 * 1024),
  ptyArchiveExport: (id: string, name: string, dest: string, plain: boolean) =>
    commands.ptyArchiveExport(id, name, dest, plain),
  ptyArchiveDelete: (id: string, name: string) =>
    commands.ptyArchiveDelete(id, name),
  taskCreate: (input: import("../lib/work").NewTask) =>
    commands.taskCreate(input).then(refine.task),
  taskList: (
    cursor: import("../lib/work").TaskCursor | null = null,
    limit = 200,
    attention = false,
  ) =>
    commands
      .taskList(cursor ?? null, limit, attention ?? null)
      .then(refine.taskPage),
  taskGet: (id: string) => commands.taskGet(id).then(refine.task),
  taskLink: (
    id: string,
    revision: number,
    resource: import("../lib/work").TaskResource,
  ) => commands.taskLink(id, revision, resource).then(refine.task),
  checkpointNotices: () =>
    commands
      .checkpointNotices()
      .then(
        refine.legacyJson<
          import("../lib/checkpointNotices").CheckpointNotice[]
        >,
      ),
  checkpointNoticeHistory: () =>
    commands
      .checkpointNoticeHistory()
      .then(
        refine.legacyJson<
          import("../lib/checkpointNotices").CheckpointNotice[]
        >,
      ),
  checkpointAcknowledgeNotices: (
    notices: import("../lib/checkpointNotices").CheckpointNotice[],
  ) =>
    commands
      .checkpointAcknowledgeNotices(notices.map((notice) => ({ ...notice })))
      .then(() => undefined),
  taskEvents: (id: string) => commands.taskEvents(id),
  taskRetryDelivery: (
    id: string,
    revision: number,
    terminalId: string,
    previousQueueId: string,
    queueId: string,
  ) =>
    commands
      .taskRetryDelivery(id, revision, terminalId, previousQueueId, queueId)
      .then(refine.taskQueue),
  taskDeliveries: (id: string) => commands.taskDeliveries(id),
  taskReviews: (id: string) =>
    commands.taskReviews(id).then((items) => items.map(refine.taskReview)),
  taskRequestReview: (input: import("../lib/work").ReviewRequest) =>
    commands.taskRequestReview(input).then(refine.taskQueue),
  taskTransition: (id: string, revision: number, status: string) =>
    commands.taskTransition(id, revision, status).then(refine.task),
  taskSubmit: (
    id: string,
    revision: number,
    submission: import("../lib/work").Submission,
  ) => commands.taskSubmit(id, revision, submission).then(refine.task),
  taskApprove: (id: string, revision: number, note: string) =>
    commands.taskApprove(id, revision, note).then(refine.task),
  taskEnqueue: (
    id: string,
    revision: number,
    terminalId: string,
    queueId: string,
  ) =>
    commands
      .taskEnqueue(id, revision, terminalId, queueId)
      .then(refine.taskQueue),
  taskClaim: (id: string, queueId: string, terminalId: string) =>
    commands.taskClaim(id, queueId, terminalId).then(refine.task),
  // PTY
  spawnPty: (opts: SpawnOptions) =>
    commands.spawnPty(opts).then(refine.terminal),
  writePty: (id: string, data: string, submitPrompt?: boolean) =>
    commands
      .writePty(id, data, submitPrompt ?? null ?? null)
      .then(() => undefined),
  resizePty: (id: string, rows: number, cols: number) =>
    commands.resizePty(id, rows, cols).then(() => undefined),
  attachPty: (id: string, wants?: AttachWants) =>
    commands.attachPty(id, wants ?? null).then(refine.attachment),
  /**
   * Asks the console host to re-emit the frame the CLI has on screen right
   * now , the only way to repaint a full-screen CLI that a view rebuilt from
   * scratch can use.
   */
  repaintPty: (id: string) => commands.repaintPty(id).then(() => undefined),
  ptyProbe: (id: string) => commands.ptyProbe(id),
  /**
   * The `pty://activity` beat the backend would send right now (`null` with
   * no live process). The heartbeat only goes out when it has something new
   * to say, so a listener that registered late asks for this once.
   */
  ptyActivity: (id: string) => commands.ptyActivity(id),
  ptyReadSince: (id: string, after: number, maxBytes: number) =>
    commands.ptyReadSince(id, after, maxBytes),
  ptyExists: (id: string) => commands.ptyExists(id),
  listPtys: () =>
    commands.listPtys().then((items) => items.map(refine.terminal)),
  killPty: (id: string) => commands.killPty(id).then(() => undefined),
  suspendPty: (id: string) => commands.suspendPty(id).then(() => undefined),
  suspendGroup: (ids: string[]) => commands.suspendGroup(ids),
  restartPty: (id: string) => commands.restartPty(id).then(refine.terminal),
  clearPty: (id: string) => commands.clearPty(id).then(() => undefined),
  setPtyVisible: (id: string, visible: boolean) =>
    commands.setPtyVisible(id, visible),
  getPtyTreeInfo: (id: string) => commands.getPtyTreeInfo(id),
  forgetPty: (id: string) => commands.forgetPty(id),
  defaultShell: () => commands.defaultShell(),
  listShells: () => commands.listShells(),
  /** First call scans the font folders (slow); the backend caches the rest. */
  listFonts: () => commands.listFonts(),

  // workspace / prefs
  saveWorkspace: (snapshot: WorkspaceSnapshot) =>
    commands.saveWorkspace(snapshot),
  loadWorkspace: () => commands.loadWorkspace().then(refine.workspace),
  readPrefs: () => commands.readPrefs(),
  writePrefs: (entries: [string, string][]) =>
    commands.writePrefs(entries).then(() => undefined),
  writePref: (key: string, value: string) =>
    commands.writePref(key, value).then(() => undefined),
  deletePref: (key: string) => commands.deletePref(key).then(() => undefined),
  exportBackup: (dest: string) => commands.exportBackup(dest),
  /** Stages the backup for the next boot; the live database is not touched. */
  importBackup: (src: string) =>
    commands.importBackup(src).then(() => undefined),
  backupPending: () => commands.backupPending(),
  /** Discards the staged backup; the next boot keeps the current workspace. */
  cancelBackup: () => commands.cancelBackup().then(() => undefined),
  restartApp: () => commands.restartApp(),
  /** Energy mode: `true` = the PC neither sleeps nor turns off the screen. */
  /** Holds the PC awake; `display` keeps the screen lit as well. */
  setKeepAwake: (on: boolean, display: boolean) =>
    commands.setKeepAwake(on, display ?? null),

  // notebook (markdown notes)
  notesLoad: () => commands.notesLoad(),
  noteSave: (note: NoteRecord) => commands.noteSave(note).then(() => undefined),
  noteDelete: (id: string) => commands.noteDelete(id).then(() => undefined),
  notebookSave: (notebook: NotebookRecord) =>
    commands.notebookSave(notebook).then(() => undefined),
  notebookDelete: (id: string) =>
    commands.notebookDelete(id).then(() => undefined),
  noteTagSave: (tag: NoteTagRecord) =>
    commands.noteTagSave(tag).then(() => undefined),
  noteTagDelete: (id: string) =>
    commands.noteTagDelete(id).then(() => undefined),
  noteExport: (dest: string, text: string) =>
    commands.noteExport(dest, text).then(() => undefined),

  // scores (saved arrangements of a group)
  /**
   * Refuses to replace a score that already exists unless `overwrite` says so
   * , the error then starts with `JA_EXISTE:` and the caller offers to replace.
   */
  scoreSave: (name: string, json: string, overwrite = false) =>
    commands.scoreSave(name, json, overwrite),
  scoreList: () => commands.scoreList(),
  scoreRead: (name: string) => commands.scoreRead(name),
  scoreDelete: (name: string) =>
    commands.scoreDelete(name).then(() => undefined),

  // agents
  detectAgents: (refresh = false) => commands.detectAgents(refresh),
  wslStatus: () => commands.wslStatus(),
  listAgentSessions: (agent: string, projectPath: string) =>
    commands.listAgentSessions(agent, projectPath),
  getSessionUsage: (file: string) => commands.getSessionUsage(file),
  agentResumeArgs: (agent: string, sessionId: string) =>
    commands.agentResumeArgs(agent, sessionId),
  sessionTailStart: (tailId: string, file: string) =>
    commands.sessionTailStart(tailId, file),
  sessionTailStop: (tailId: string) => commands.sessionTailStop(tailId),

  // project files
  watchProject: (projectId: string, root: string) =>
    commands.watchProject(projectId, root).then(() => undefined),
  unwatchProject: (projectId: string) => commands.unwatchProject(projectId),
  gitChanges: (cwd: string) => commands.gitChanges(cwd).then(refine.changes),
  gitFileDiff: (
    cwd: string,
    path: string,
    untracked: boolean,
    origPath?: string | null,
    /** Context lines per hunk (`-U<n>`); omitted = git default (3). */
    context?: number | null,
  ) =>
    commands.gitFileDiff(
      cwd,
      path,
      untracked,
      origPath ?? null ?? null,
      context ?? null ?? null,
    ),

  // file explorer , `root` is the project root (or the active floor's) and
  // every `path` is relative to it; the backend refuses anything outside.
  fsListDir: (root: string, path: string) => commands.fsListDir(root, path),
  /** `encoding` = the one the reader picked; omitted, the file decides. */
  fsReadText: (root: string, path: string, encoding?: string | null) =>
    commands.fsReadText(root, path, encoding ?? null ?? null),
  /**
   * Writes the file and returns its new stamp. Errors with `CONFLITO:` when
   * the disk moved: `expected` is what the editor last saw there, and it
   * carries the **size** as well as the timestamp , the mtime alone has a
   * one-second tolerance (FAT/network shares round it), and an agent rewriting
   * the same file in that same second is an everyday event here.
   * `null` skips the comparison ("Salvar por cima").
   */
  fsWriteText: (
    root: string,
    path: string,
    text: string,
    expected: FileStamp | null,
    crlf: boolean,
    bom: boolean,
    /** The encoding the file was opened with; the write uses the same one. */
    encoding?: string | null,
  ) =>
    commands.fsWriteText(
      root,
      path,
      text,
      expected ?? null,
      crlf,
      bom,
      encoding ?? null ?? null,
    ),
  fsCreateEntry: (root: string, path: string, dir: boolean) =>
    commands.fsCreateEntry(root, path, dir).then(() => undefined),
  fsRenameEntry: (root: string, path: string, newPath: string) =>
    commands.fsRenameEntry(root, path, newPath).then(() => undefined),
  fsDeleteEntry: (root: string, path: string) =>
    commands.fsDeleteEntry(root, path).then(() => undefined),
  /** Text search across the whole project (Ctrl+Shift+F). */
  fsSearchText: (root: string, query: string, options: SearchOptions) =>
    commands.fsSearchText(root, query, options),
  /**
   * Rewrites every match of the same search. Not cancellable: this one
   * writes, and a replace stopped halfway through the walk is a state nobody
   * can reason about afterwards.
   */
  fsReplaceText: (
    root: string,
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => commands.fsReplaceText(root, query, replacement, options),
  fsCancelSearch: (root: string) => commands.fsCancelSearch(root),
  /** All file paths under the root , what Ctrl+P offers before any browsing. */
  fsIndexFiles: (root: string) => commands.fsIndexFiles(root),
  /**
   * The file's content at HEAD (normalized to `\n`), or `null` when there is
   * nothing to compare against: untracked, no commit yet, binary, no git.
   */
  gitHeadText: (root: string, path: string) => commands.gitHeadText(root, path),

  // source control , every call takes the repository's `cwd` (the project
  // root, or the active floor's worktree) as its first argument, exactly like
  // `gitChanges`. Nothing here caches: the store owns freshness.
  scmInfo: (cwd: string) => commands.scmInfo(cwd).then(refine.scm),
  scmInit: (cwd: string) => commands.scmInit(cwd).then(() => undefined),

  scmStage: (cwd: string, paths: string[]) =>
    commands.scmStage(cwd, paths).then(() => undefined),
  scmStageAll: (cwd: string) => commands.scmStageAll(cwd).then(() => undefined),
  scmUnstage: (cwd: string, paths: string[]) =>
    commands.scmUnstage(cwd, paths).then(() => undefined),
  scmUnstageAll: (cwd: string) =>
    commands.scmUnstageAll(cwd).then(() => undefined),
  scmDiscard: (cwd: string, paths: string[]) =>
    commands.scmDiscard(cwd, paths).then(() => undefined),
  scmDiscardAll: (cwd: string, includeUntracked: boolean) =>
    commands.scmDiscardAll(cwd, includeUntracked).then(() => undefined),

  scmCommit: (cwd: string, message: string, opts: ScmCommitOpts = {}) =>
    commands.scmCommit(cwd, message, {
      amend: opts.amend ?? false,
      stageAll: opts.stageAll ?? false,
      signoff: opts.signoff ?? false,
      noVerify: opts.noVerify ?? false,
      allowEmpty: opts.allowEmpty ?? false,
    }),
  /** The full message of the last commit , what the amend box is pre-filled with. */
  scmLastMessage: (cwd: string) => commands.scmLastMessage(cwd),

  scmLog: (cwd: string, query: ScmLogQuery = {}) =>
    commands.scmLog(cwd, {
      limit: query.limit ?? 0,
      skip: query.skip ?? 0,
      path: query.path ?? null,
      rev: query.rev ?? null,
      all: query.all ?? false,
      search: query.search ?? null,
    }),
  scmCommitDetail: (cwd: string, hash: string) =>
    commands.scmCommitDetail(cwd, hash),
  scmCommitFileDiff: (cwd: string, hash: string, path: string) =>
    commands.scmCommitFileDiff(cwd, hash, path),

  scmBranches: (cwd: string) => commands.scmBranches(cwd),
  scmCheckout: (cwd: string, name: string) =>
    commands.scmCheckout(cwd, name).then(() => undefined),
  scmBranchCreate: (
    cwd: string,
    name: string,
    startPoint: string | null,
    switchTo: boolean,
  ) =>
    commands
      .scmBranchCreate(cwd, name, startPoint ?? null, switchTo)
      .then(() => undefined),
  scmBranchDelete: (cwd: string, name: string, force: boolean) =>
    commands.scmBranchDelete(cwd, name, force).then(() => undefined),
  scmBranchRename: (cwd: string, from: string, to: string) =>
    commands.scmBranchRename(cwd, from, to).then(() => undefined),

  scmMerge: (cwd: string, name: string, noFf: boolean) =>
    commands.scmMerge(cwd, name, noFf),
  scmRebase: (cwd: string, onto: string) => commands.scmRebase(cwd, onto),
  scmRevert: (cwd: string, hash: string) => commands.scmRevert(cwd, hash),
  /** `soft` keeps everything prepared, `mixed` keeps the files, `hard` throws it away. */
  scmReset: (cwd: string, rev: string, mode: "soft" | "mixed" | "hard") =>
    commands.scmReset(cwd, rev, mode).then(() => undefined),
  scmResolveConflict: (cwd: string, paths: string[], side: "ours" | "theirs") =>
    commands.scmResolveConflict(cwd, paths, side).then(() => undefined),
  scmAbort: (cwd: string) => commands.scmAbort(cwd).then(() => undefined),
  scmContinue: (cwd: string) => commands.scmContinue(cwd).then(() => undefined),

  scmStashList: (cwd: string) => commands.scmStashList(cwd),
  scmStashPush: (
    cwd: string,
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
  ) =>
    commands
      .scmStashPush(cwd, message ?? null, includeUntracked, keepIndex)
      .then(() => undefined),
  scmStashApply: (cwd: string, index: number, pop: boolean) =>
    commands.scmStashApply(cwd, index, pop).then(() => undefined),
  scmStashDrop: (cwd: string, index: number) =>
    commands.scmStashDrop(cwd, index).then(() => undefined),
  scmStashShow: (cwd: string, index: number) =>
    commands.scmStashShow(cwd, index),

  scmFetch: (cwd: string, remote: string | null, prune: boolean) =>
    commands.scmFetch(cwd, remote ?? null, prune).then(() => undefined),
  scmPull: (cwd: string, rebase: boolean) =>
    commands.scmPull(cwd, rebase).then(() => undefined),
  /** `force` is `--force-with-lease` on the backend, never a plain `--force`. */
  scmPush: (
    cwd: string,
    remote: string,
    branch: string | null,
    setUpstream: boolean,
    force: boolean,
  ) =>
    commands
      .scmPush(cwd, remote, branch ?? null, setUpstream, force)
      .then(() => undefined),
  scmPushDelete: (cwd: string, remote: string, branch: string) =>
    commands.scmPushDelete(cwd, remote, branch).then(() => undefined),

  scmTags: (cwd: string) => commands.scmTags(cwd),
  scmTagCreate: (
    cwd: string,
    name: string,
    message: string | null,
    target: string | null,
  ) =>
    commands
      .scmTagCreate(cwd, name, message ?? null, target ?? null)
      .then(() => undefined),
  scmTagDelete: (cwd: string, name: string) =>
    commands.scmTagDelete(cwd, name).then(() => undefined),

  /**
   * Applies a patch the panel built from selected hunks (or selected lines).
   * `cached` writes to the index, `reverse` undoes instead of applying , the
   * four combinations are prepare, unprepare, discard and re-apply.
   */
  scmApplyPatch: (
    cwd: string,
    patch: string,
    cached: boolean,
    reverse: boolean,
  ) =>
    commands.scmApplyPatch(cwd, patch, cached, reverse).then(() => undefined),
  scmDiff: (
    cwd: string,
    path: string,
    side: ScmDiffSide,
    origPath: string | null = null,
    context: number | null = null,
  ) => commands.scmDiff(cwd, path, side, origPath ?? null, context ?? null),

  // floors (git worktree)
  worktreeProvision: (opts: {
    projectPath: string;
    name: string;
    branch?: string | null;
    existingBranch: boolean;
    noGit: boolean;
    /** The commit the plan froze , without it the branch grows from HEAD. */
    base?: string | null;
    /** The folder the plan chose, so the disk gets what the screen promised. */
    worktreeName?: string | null;
  }) =>
    commands.worktreeProvision(opts.projectPath, {
      name: opts.name,
      branch: opts.branch ?? null,
      existingBranch: opts.existingBranch,
      noGit: opts.noGit,
      base: opts.base ?? null,
      worktreeName: opts.worktreeName ?? null,
    }),
  /** Reads the repository and answers what each row would do. Writes nothing. */
  worktreePreflight: (projectPath: string, items: PreflightItem[]) =>
    commands.worktreePreflight(projectPath, items),
  /**
   * Deletes a branch only while it still points at `expectedOid`. `false`
   * means it moved , there is work on it, and it was kept.
   */
  branchDeleteIfUnchanged: (
    projectPath: string,
    branch: string,
    expectedOid: string,
  ) => commands.branchDeleteIfUnchanged(projectPath, branch, expectedOid),
  worktreeList: (projectPath: string) => commands.worktreeList(projectPath),
  worktreeDirty: (path: string) => commands.worktreeDirty(path),
  /**
   * Removes the worktree and, when a branch is named, deletes it with
   * `git branch -d`. A branch holding commits the ground does not have is
   * kept, and comes back in `branchKept` for the caller to say out loud.
   */
  worktreeRemove: (
    projectPath: string,
    path: string,
    deleteBranch?: string | null,
  ) => commands.worktreeRemove(projectPath, path, deleteBranch ?? null ?? null),
  worktreePreview: (
    projectPath: string,
    floorBranch: string,
    floorPath?: string | null,
  ) =>
    commands.worktreePreview(
      projectPath,
      floorBranch,
      floorPath ?? null ?? null,
    ),
  worktreeLand: (
    projectPath: string,
    floorBranch: string,
    floorPath?: string | null,
  ) =>
    commands.worktreeLand(projectPath, floorBranch, floorPath ?? null ?? null),
  floorRunHook: (cwd: string, command: string, env: [string, string][]) =>
    commands.floorRunHook(cwd, command, env),

  checkpointCreate: (
    root: string,
    taskId: string,
    taskLabel: string,
    label: string,
  ) => commands.checkpointCreate(root, taskId, taskLabel, label),
  checkpointList: (root: string) => commands.checkpointList(root),
  checkpointPreview: (root: string, id: string) =>
    commands.checkpointPreview(root, id).then(refine.checkpoint),
  checkpointCompare: (root: string, id: string, path: string) =>
    commands.checkpointCompare(root, id, path),
  checkpointRestore: (root: string, id: string, token: string) =>
    commands.checkpointRestore(root, id, token),
  checkpointDelete: (root: string, id: string) =>
    commands.checkpointDelete(root, id).then(() => undefined),

  // Device portals share the existing connection boundary in the bridge.
  deviceList: () => commands.deviceList(),
  deviceAction: (
    serial: string,
    action: import("../lib/devicePortal").DeviceAction,
  ) => commands.deviceAction(serial, action),

  // portals
  listBrowsers: (refresh = false) => commands.listBrowsers(refresh),
  portalOpen: (opts: PortalOpen) => commands.portalOpen(opts),
  portalSetBounds: (id: string, place: PortalPlace) =>
    commands.portalSetBounds(id, place).then(() => undefined),
  portalSetBoundsMany: (updates: PortalBoundsUpdate[]) =>
    commands.portalSetBoundsMany(updates).then(() => undefined),
  portalNavigate: (id: string, url: string) =>
    commands.portalNavigate(id, url).then(() => undefined),
  portalEval: (id: string, js: string) => commands.portalEval(id, js),
  /** Fingerprint of what an address is serving , see `lib/portalLive.ts`. */
  portalProbe: (url: string) => commands.portalProbe(url),
  portalClose: (id: string) => commands.portalClose(id).then(() => undefined),
  portalHideExcept: (keep: string[]) => commands.portalHideExcept(keep),
  /** Closes engines with no card left in any canvas. Returns how many. */
  portalRetain: (keep: string[]) => commands.portalRetain(keep),
  portalInfo: (id: string) => commands.portalInfo(id),
  portalReload: (id: string) => commands.portalReload(id).then(() => undefined),
  portalBack: (id: string) => commands.portalBack(id).then(() => undefined),
  portalForward: (id: string) =>
    commands.portalForward(id).then(() => undefined),
  portalSetMuted: (id: string, muted: boolean) =>
    commands.portalSetMuted(id, muted).then(() => undefined),
  portalSetUa: (id: string, ua: string | null) =>
    commands.portalSetUa(id, ua ?? null).then(() => undefined),
  portalScreenshot: (id: string) => commands.portalScreenshot(id),
  /** PNG crop of one element (Modo Design) , `rect` in the page's CSS pixels. */
  portalGrabShot: (id: string, rect: PortalRect) =>
    commands.portalGrabShot(id, rect),

  // system
  appPaths: () => commands.appPaths(),
  revealPath: (path: string) => commands.revealPath(path).then(() => undefined),
  /** Opens the file in the system's default program (a `.docx`, a `.zip`). */
  openExternal: (path: string) =>
    commands.openExternal(path).then(() => undefined),
  isDirectory: (path: string) => commands.isDirectory(path),
  /** Pasted image (base64 bytes) → file in `%TEMP%`; returns the path. */
  clipboardSaveImage: (data: string) => commands.clipboardSaveImage(data),

  // agent usage limits
  usageSnapshot: () => commands.usageSnapshot().then(refine.usage),
  /** Brings the next usage read forward: one provider, or all when omitted. */
  usageRefresh: (provider?: import("../lib/usageNudge").UsageProvider) =>
    commands.usageRefresh(provider ?? null),

  // agent<->app bridge (CLI `yard`)
  bridgeRespond: (id: number, body: BridgeResponse) =>
    commands.bridgeRespond(id, { ...body }),
  /** Saves a terminal's scrollback to `dest`; `plain` strips the escapes. Bytes written. */
  ptyExport: (id: string, dest: string, plain: boolean) =>
    commands.ptyExport(id, dest, plain),
  // full-text search over what the terminals said (scrollback_search.rs)
  searchScrollback: (
    ids: string[],
    query: string,
    per: number,
    total: number,
  ) => commands.searchScrollback(ids, query, per, total),
  // the forge (forge.rs), every call shells out to `gh`
  /** Loopback port + session token of the bridge, for the SSH launch. */
  bridgeRemote: () =>
    commands
      .bridgeRemote()
      .then(refine.legacyJson<{ port: number | null; token: string }>),
  /** The settings file Claude Code is launched with, beside the shims (bridge.rs). */
  bridgeHooksFile: () => commands.bridgeHooksFile(),
  // one POST to the address in Configurações (webhook.rs)
  webhookPost: (url: string, body: string) =>
    commands.webhookPost(url, body).then(() => undefined),
  forgeStatus: (cwd: string) => commands.forgeStatus(cwd),
  forgePr: (cwd: string, branch: string) => commands.forgePr(cwd, branch),
  forgePrCreate: (
    cwd: string,
    branch: string,
    title: string,
    body: string,
    base: string | null,
    draft: boolean,
  ) => commands.forgePrCreate(cwd, branch, title, body, base ?? null, draft),
  forgePrComments: (cwd: string, number: number) =>
    commands.forgePrComments(cwd, number),
  // tray icon + summon hotkey (tray.rs)
  traySetStatus: (blocked: number, running: number) =>
    commands.traySetStatus(blocked, running).then(() => undefined),
  windowSummon: () => commands.windowSummon(),
  // support bundle (logs of the last two days + about/agents JSON)
  supportBundle: (dest: string) => commands.supportBundle(dest),
  // automatic backup: `dir = null` is the data directory's `backups` folder
  backupAutoRun: (dir: string | null, keep: number) =>
    commands.backupAutoRun(dir ?? null, keep),

  // costs and usage over time (costs.rs)
  usageHistory: (days: number) => commands.usageHistory(days),
  pricingReference: () => commands.pricingReference().then(refine.pricing),
  queuePatch: (
    before: readonly import("../lib/queue").QueueItem[],
    after: readonly import("../lib/queue").QueueItem[],
  ) =>
    commands
      .queuePatch(
        before.map((item) => refine.jsonPayload(item)),
        after.map((item) => refine.jsonPayload(item)),
      )
      .then(refine.legacyJson<import("../lib/queue").QueueItem[]>),
  queueDispatch: (id: string, terminalId: string, attemptedAt: number) =>
    commands
      .queueDispatch(id, terminalId, attemptedAt)
      .then(refine.queueResult),
  queueRead: () =>
    commands
      .queueRead()
      .then(refine.legacyJson<import("../lib/queue").QueueItem[]>),
  nativeHookSnapshot: () => commands.nativeHookSnapshot(),
  routineSnapshot: () =>
    commands
      .routineSnapshot()
      .then(
        refine.legacyJson<import("../lib/routineExecution").RoutineExecution[]>,
      ),
  queueRetry: (id: string, newId: string, attemptedAt: number) =>
    commands
      .queueRetry(id, newId, attemptedAt)
      .then(refine.legacyJson<import("../lib/queue").QueueItem[]>),
  queueRemove: (id: string, attemptedAt?: number) =>
    commands
      .queueRemove(id, attemptedAt ?? null ?? null)
      .then(refine.legacyJson<import("../lib/queue").QueueItem[]>),
  pricingSettings: () =>
    commands.pricingSettings().then(refine.pricingSettings),
  pricingSettingsSave: (
    revision: number,
    rates: import("../lib/pricing").CustomRate[],
  ) =>
    commands.pricingSettingsSave(revision, rates).then(refine.pricingSettings),
  /** The whole session `.jsonl` as events , the "Ombro" digest and the transcript. */
  sessionEvents: (file: string) =>
    commands.sessionEvents(file).then((items) => items.map(refine.feed)),

  // MCP manager (mcp.rs)
  mcpList: (projectRoot: string | null) =>
    commands.mcpList(projectRoot ?? null),
  mcpProbe: (
    cli: string,
    scope: string,
    projectRoot: string | null,
    name: string,
    accountId?: string,
  ) =>
    commands.mcpProbe(cli, scope, projectRoot ?? null, name, accountId ?? null),
  mcpSave: (
    cli: string,
    scope: string,
    projectRoot: string | null,
    server: McpServer,
    accountId?: string,
  ) =>
    commands
      .mcpSave(accountId ?? null, cli, scope, projectRoot ?? null, server)
      .then(() => undefined),
  mcpDelete: (
    cli: string,
    scope: string,
    projectRoot: string | null,
    name: string,
    accountId?: string,
  ) =>
    commands
      .mcpDelete(accountId ?? null, cli, scope, projectRoot ?? null, name)
      .then(() => undefined),
  mcpEnvValues: (
    cli: string,
    scope: string,
    projectRoot: string | null,
    name: string,
    accountId?: string,
  ) =>
    commands.mcpEnvValues(
      accountId ?? null,
      cli,
      scope,
      projectRoot ?? null,
      name,
    ),
  sshStatus: () => commands.sshStatus(),
  // language servers (lsp.rs) , the editor's LSP clients
  lspStart: (id: string, program: string, args: string[], cwd: string) =>
    commands.lspStart(id, program, args, cwd),
  lspSend: (id: string, message: string) =>
    commands.lspSend(id, message).then(() => undefined),
  lspStop: (id: string) => commands.lspStop(id).then(() => undefined),
  lspDetect: (refresh: boolean) => commands.lspDetect(refresh),
};

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/**
 * Event bus topics. A terminal's own events (output, exit, heartbeat, idle)
 * are not among them: they come over the page's PTY channel (`ptyStream.ts`).
 */
function listenEvent<K extends keyof EventPayloads_Serialize>(
  key: K,
  cb: (event: { payload: EventPayloads_Serialize[K] }) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloads_Serialize[K]>(topics[key], cb);
}

/**
 * This document's token for the backend (`pty/pages.rs`): a reload is a new
 * document and a new token, and its first link closes the old page's. Kept on
 * the window, not in this module, so a copy of this module swapped in by HMR
 * still counts as the same page and its link lives next to the first.
 */
function pageToken(): string {
  const page = globalThis as { __yardPtyPage?: string };
  if (!page.__yardPtyPage) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    page.__yardPtyPage = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  return page.__yardPtyPage;
}

/**
 * Every terminal's output, exit, heartbeat and idle, over one ordered channel
 * for this page (why one, and why not the bus: `pty/pages.rs`). Opened on the
 * first subscription.
 */
const ptyStream = createPtyStream(
  {
    open: (deliver) => {
      const channel = new Channel<unknown>();
      channel.onmessage = deliver;
      return commands.ptyEventsOpen(pageToken(), channel);
    },
    subscribe: (link, sub, topic) =>
      commands.ptyEventsSubscribe(link, sub, topic).then(() => undefined),
    unsubscribe: (link, sub) =>
      commands.ptyEventsUnsubscribe(link, sub).then(() => undefined),
    ack: (id, chunks) => commands.ackPtyOutput(id, chunks),
  },
  // `console.error` reaches `yard.log` (`installErrorBridge`), as an uncaught
  // throw in a bus listener did.
  (error) => console.error("[yard] PTY channel:", error),
);

export const on = {
  accountsChanged: (cb: () => void) => listenEvent("accountsChanged", cb),
  output: (id: string, cb: (p: OutputChunk) => void): Promise<UnlistenFn> =>
    ptyStream.output(id, cb),
  exit: (id: string, cb: (p: ExitPayload) => void): Promise<UnlistenFn> =>
    ptyStream.exit(id, cb),
  activity: (
    id: string,
    cb: (p: ActivityPayload) => void,
  ): Promise<UnlistenFn> => ptyStream.activity(id, cb),
  agentIdle: (cb: (p: IdlePayload) => void): Promise<UnlistenFn> =>
    ptyStream.idle(cb),
  agentsChanged: (cb: () => void) => listenEvent("agentsChanged", () => cb()),
  nativeHook: (
    cb: (report: import("../lib/nativeHooks").NativeHookReport) => void,
  ) => listenEvent("nativeHook", (event) => cb(refine.hook(event.payload))),
  queueChanged: (cb: () => void) => listenEvent("queueChanged", () => cb()),
  /** A native flow run changed (empty payload: read `flowSnapshot`). */
  flowChanged: (cb: () => void) => listenEvent("flowChanged", () => cb()),
  /** The pending checkpoint notices changed (read `checkpointNotices`). */
  checkpointNotices: (cb: () => void) =>
    listenEvent("checkpointNotices", () => cb()),
  /** A routine's run state changed (read `routineSnapshot`). */
  routineChanged: (cb: () => void) => listenEvent("routineChanged", () => cb()),
  sessionFeed: (cb: (p: SessionFeed) => void) =>
    listenEvent("sessionFeed", (e) => cb(refine.sessionFeed(e.payload))),
  filesActivity: (cb: (p: FilesActivity) => void) =>
    listenEvent("filesActivity", (e) => cb(refine.files(e.payload))),
  resources: (cb: (p: ResourcesTick) => void) =>
    listenEvent("resourcesTick", (e) => cb(refine.resources(e.payload))),
  windowShown: (cb: (p: WindowShown) => void) =>
    listenEvent("windowShown", (e) => cb(e.payload)),
  bridgeRequest: (cb: (p: { id: number; request: BridgeRequest }) => void) =>
    listenEvent("bridgeRequest", (e) =>
      cb(refine.legacyJson<{ id: number; request: BridgeRequest }>(e.payload)),
    ),
  usage: (cb: (p: UsageSnapshot) => void) =>
    listenEvent("usageUpdate", (e) => cb(refine.usage(e.payload))),
  portalNav: (cb: (p: PortalNav) => void) =>
    listenEvent("portalNav", (e) => cb(e.payload)),
  portalPopup: (cb: (p: PortalPopup) => void) =>
    listenEvent("portalPopup", (e) => cb(e.payload)),
  portalEscape: (cb: (p: PortalEscape) => void) =>
    listenEvent("portalEscape", (e) => cb(e.payload)),
  portalMenu: (cb: (p: PortalMenu) => void) =>
    listenEvent("portalMenu", (e) => cb(refine.portalMenu(e.payload))),
  /** "Sair" picked in the tray menu: run the window's exit flow. */
  trayQuit: (cb: () => void) => listenEvent("trayQuit", () => cb()),
  lspMessage: (cb: (p: LspMessagePayload) => void) =>
    listenEvent("lspMessage", (e) => cb(e.payload)),
  lspExit: (cb: (p: LspExitPayload) => void) =>
    listenEvent("lspExit", (e) => cb(e.payload)),
};

export type { UnlistenFn };
