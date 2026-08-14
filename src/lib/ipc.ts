/**
 * IPC contract — TypeScript mirror of `src-tauri/src/events.rs`.
 *
 * No component calls `invoke` directly. Everything goes through here, so
 * changing a signature in Rust breaks the front-end compile instead of
 * becoming a silent `undefined` in production.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type PtyKind = "shell" | "agent";
export type ExitReason =
  | "normal"
  | "killed"
  | "suspended"
  | "restarted"
  | "failed";

export interface SpawnOptions {
  id: string;
  program: string;
  args?: string[];
  cwd: string;
  rows: number;
  cols: number;
  kind?: PtyKind;
  title?: string;
  env?: [string, string][];
  keepScrollback?: boolean;
}

export interface PtySnapshot {
  id: string;
  pid: number | null;
  program: string;
  args: string[];
  cwd: string;
  kind: PtyKind;
  title: string;
  startedAt: number;
  rows: number;
  cols: number;
  scrollbackBytes: number;
}

export interface ExitInfo {
  code: number | null;
  reason: ExitReason;
  at: number;
}

export interface AttachResult {
  alive: boolean;
  data: string;
  exit: ExitInfo | null;
  pid: number | null;
}

export interface ShellOption {
  id: string;
  label: string;
  program: string;
  available: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  bin: string | null;
  version: string | null;
  installed: boolean;
  resumeTemplate: string | null;
  continueArgs: string[] | null;
  sessionsKind: string | null;
  docs: string | null;
}

export interface AgentSession {
  agent: string;
  externalId: string;
  projectPath: string;
  title: string | null;
  updatedAt: number;
  sizeBytes: number;
  file: string;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  messages: number;
  models: string[];
  costUsd: number | null;
}

// --- live session tail ("Ao Vivo") -----------------------------------------

export type FeedKind =
  | "prompt"
  | "say"
  | "think"
  | "tool"
  | "result"
  | "usage"
  | "notify";

export type FeedOp =
  | "edit"
  | "write"
  | "read"
  | "run"
  | "search"
  | "agent"
  | "plan"
  | "todo"
  | "skill"
  | "other";

export interface FeedTodo {
  content: string;
  status: string;
}

/** One event of the live feed — mirror of `agents::tail::FeedEvent`. */
export interface FeedEvent {
  kind: FeedKind;
  at: number;
  /** Line written by a sub-agent transcript (sidechain). */
  side?: boolean;
  text?: string;
  toolId?: string;
  tool?: string;
  op?: FeedOp;
  path?: string;
  detail?: string;
  agentType?: string;
  added?: number;
  removed?: number;
  taskId?: string;
  status?: string;
  todos?: FeedTodo[];
  ok?: boolean;
  /** Usage: cumulative totals of the session so far. */
  model?: string;
  inTokens?: number;
  outTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
}

export interface SessionFeed {
  tailId: string;
  /** First batch (or truncation): clear all accumulated state. */
  reset: boolean;
  /** `false` while backfilling; `true` once caught up with the file. */
  live: boolean;
  events: FeedEvent[];
}

export interface PtyResource {
  id: string;
  pids: number[];
  rssMb: number;
  cpu: number;
}

export interface ResourcesTick {
  totalRssMb: number;
  systemAvailableMb: number;
  systemTotalMb: number;
  perPty: PtyResource[];
}

// --- workspace -------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  /** Name of an icon from the registry in `lib/projectStyle.ts`. */
  icon?: string | null;
  sort: number;
  createdAt: number;
}

export interface GroupRow {
  id: string;
  projectId: string;
  name: string;
  layoutJson: string;
  suspended: boolean;
  sort: number;
}

export interface TerminalRow {
  id: string;
  groupId: string;
  slot: number;
  title?: string | null;
  kind: PtyKind;
  agentId?: string | null;
  program: string;
  args: string[];
  cwd: string;
  resume?: string[] | null;
  sort: number;
  alive: boolean;
  createdAt: number;
}

export interface WorkspaceSnapshot {
  rev: number;
  projects: ProjectRow[];
  groups: GroupRow[];
  terminals: TerminalRow[];
}

export interface SaveResult {
  rev: number;
  accepted: boolean;
}

export interface AppPaths {
  appDir: string;
  dbPath: string;
  logsDir: string;
  backupsDir: string;
}

/** A score on disk (`<data>\partituras\<nome>.json`). */
export interface ScoreMeta {
  name: string;
  path: string;
  updatedAt: number;
  sizeBytes: number;
}

// --- project files (live feed + review) --------------------------

export type FileEventKind = "created" | "modified" | "deleted";

export interface FileEvent {
  /** Relative to the project root, with `/` (same as git). */
  path: string;
  kind: FileEventKind;
  at: number;
}

export interface FilesActivity {
  projectId: string;
  root: string;
  events: FileEvent[];
  /** Paths beyond the window cap — counted only, not listed. */
  dropped: number;
}

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface ChangedFile {
  path: string;
  origPath: string | null;
  status: GitFileStatus;
  staged: boolean;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface ChangesSummary {
  isRepo: boolean;
  branch: string | null;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  isBinary: boolean;
  truncated: boolean;
  text: string;
}

// --- floors (git worktree) -------------------------------------------------

export interface WorktreeProvision {
  path: string;
  branch: string | null;
  /** `isolated` = git worktree; `plain` = no git, same cwd as the ground. */
  kind: "isolated" | "plain";
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  bare: boolean;
}

export interface HookResult {
  code: number;
  output: string;
}

// --- portals (navegador no canvas) -----------------------------------------

export type BrowserFamily = "webview2" | "chromium" | "firefox";

export interface BrowserInfo {
  id: string;
  name: string;
  family: BrowserFamily;
  bin: string | null;
  version: string | null;
  installed: boolean;
}

export interface PortalOpen {
  id: string;
  url: string;
  engine?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  ua?: string | null;
  storage?: "instance" | "workspace" | "global" | null;
  muted?: boolean | null;
  projectId?: string | null;
}

export interface PortalInfo {
  id: string;
  url: string;
  title: string;
  engine: string;
  visible: boolean;
}

export interface PortalNav {
  id: string;
  url: string;
  title: string | null;
}

export interface PortalPopup {
  parentId: string;
  url: string;
}

export interface PortalEscape {
  id: string;
}

export interface PortalMenu {
  id: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export const ipc = {
  // PTY
  spawnPty: (opts: SpawnOptions) => invoke<PtySnapshot>("spawn_pty", { opts }),
  writePty: (id: string, data: string) => invoke<void>("write_pty", { id, data }),
  resizePty: (id: string, rows: number, cols: number) =>
    invoke<void>("resize_pty", { id, rows, cols }),
  attachPty: (id: string) => invoke<AttachResult>("attach_pty", { id }),
  ptyExists: (id: string) => invoke<boolean>("pty_exists", { id }),
  listPtys: () => invoke<PtySnapshot[]>("list_ptys"),
  killPty: (id: string) => invoke<void>("kill_pty", { id }),
  suspendPty: (id: string) => invoke<void>("suspend_pty", { id }),
  suspendGroup: (ids: string[]) => invoke<string[]>("suspend_group", { ids }),
  restartPty: (id: string) => invoke<PtySnapshot>("restart_pty", { id }),
  clearPty: (id: string) => invoke<void>("clear_pty", { id }),
  setPtyVisible: (id: string, visible: boolean) =>
    invoke<void>("set_pty_visible", { id, visible }),
  getPtyTreeInfo: (id: string) => invoke<PtyResource>("get_pty_tree_info", { id }),
  forgetPty: (id: string) => invoke<void>("forget_pty", { id }),
  defaultShell: () => invoke<string>("default_shell"),
  listShells: () => invoke<ShellOption[]>("list_shells"),

  // workspace / prefs
  saveWorkspace: (snapshot: WorkspaceSnapshot) =>
    invoke<SaveResult>("save_workspace", { snapshot }),
  loadWorkspace: () => invoke<WorkspaceSnapshot>("load_workspace"),
  readPrefs: () => invoke<Record<string, string>>("read_prefs"),
  writePref: (key: string, value: string) =>
    invoke<void>("write_pref", { key, value }),
  deletePref: (key: string) => invoke<void>("delete_pref", { key }),
  exportBackup: (dest: string) => invoke<string>("export_backup", { dest }),
  importBackup: (src: string) => invoke<void>("import_backup", { src }),

  // scores (saved arrangements of a group)
  scoreSave: (name: string, json: string) =>
    invoke<string>("score_save", { name, json }),
  scoreList: () => invoke<ScoreMeta[]>("score_list"),
  scoreRead: (name: string) => invoke<string>("score_read", { name }),
  scoreDelete: (name: string) => invoke<void>("score_delete", { name }),

  // agents
  detectAgents: (refresh = false) =>
    invoke<AgentInfo[]>("detect_agents", { refresh }),
  listAgentSessions: (agent: string, projectPath: string) =>
    invoke<AgentSession[]>("list_agent_sessions", { agent, projectPath }),
  getSessionUsage: (file: string) =>
    invoke<SessionUsage>("get_session_usage", { file }),
  agentResumeArgs: (agent: string, sessionId: string) =>
    invoke<string[] | null>("agent_resume_args", { agent, sessionId }),
  sessionTailStart: (tailId: string, file: string) =>
    invoke<void>("session_tail_start", { tailId, file }),
  sessionTailStop: (tailId: string) =>
    invoke<void>("session_tail_stop", { tailId }),

  // project files
  watchProject: (projectId: string, root: string) =>
    invoke<void>("watch_project", { projectId, root }),
  unwatchProject: (projectId: string) =>
    invoke<void>("unwatch_project", { projectId }),
  gitChanges: (cwd: string) => invoke<ChangesSummary>("git_changes", { cwd }),
  gitFileDiff: (
    cwd: string,
    path: string,
    untracked: boolean,
    origPath?: string | null,
    /** Context lines per hunk (`-U<n>`); omitted = git default (3). */
    context?: number | null,
  ) =>
    invoke<FileDiff>("git_file_diff", {
      cwd,
      path,
      untracked,
      origPath: origPath ?? null,
      context: context ?? null,
    }),

  // floors (git worktree)
  worktreeProvision: (opts: {
    projectPath: string;
    name: string;
    branch?: string | null;
    existingBranch: boolean;
    noGit: boolean;
  }) =>
    invoke<WorktreeProvision>("worktree_provision", {
      projectPath: opts.projectPath,
      name: opts.name,
      branch: opts.branch ?? null,
      existingBranch: opts.existingBranch,
      noGit: opts.noGit,
    }),
  worktreeList: (projectPath: string) =>
    invoke<WorktreeEntry[]>("worktree_list", { projectPath }),
  worktreeDirty: (path: string) => invoke<boolean>("worktree_dirty", { path }),
  worktreeRemove: (
    projectPath: string,
    path: string,
    deleteBranch?: string | null,
  ) =>
    invoke<void>("worktree_remove", {
      projectPath,
      path,
      deleteBranch: deleteBranch ?? null,
    }),
  floorRunHook: (cwd: string, command: string, env: [string, string][]) =>
    invoke<HookResult>("floor_run_hook", { cwd, command, env }),

  // portals
  listBrowsers: (refresh = false) =>
    invoke<BrowserInfo[]>("list_browsers", { refresh }),
  portalOpen: (opts: PortalOpen) => invoke<PortalInfo>("portal_open", { opts }),
  portalSetBounds: (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    visible: boolean,
  ) => invoke<void>("portal_set_bounds", { id, x, y, w, h, visible }),
  portalNavigate: (id: string, url: string) =>
    invoke<void>("portal_navigate", { id, url }),
  portalEval: (id: string, js: string) =>
    invoke<string>("portal_eval", { id, js }),
  portalClose: (id: string) => invoke<void>("portal_close", { id }),
  portalHideExcept: (keep: string[]) =>
    invoke<void>("portal_hide_except", { keep }),
  portalInfo: (id: string) => invoke<PortalInfo>("portal_info", { id }),
  portalReload: (id: string) => invoke<void>("portal_reload", { id }),
  portalBack: (id: string) => invoke<void>("portal_back", { id }),
  portalForward: (id: string) => invoke<void>("portal_forward", { id }),
  portalSetMuted: (id: string, muted: boolean) =>
    invoke<void>("portal_set_muted", { id, muted }),
  portalSetUa: (id: string, ua: string | null) =>
    invoke<void>("portal_set_ua", { id, ua }),
  portalScreenshot: (id: string) => invoke<string>("portal_screenshot", { id }),

  // system
  appPaths: () => invoke<AppPaths>("app_paths"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  isDirectory: (path: string) => invoke<boolean>("is_directory", { path }),

  // agent<->app bridge (CLI `yard`)
  bridgeRespond: (id: number, body: BridgeResponse) =>
    invoke<boolean>("bridge_respond", { id, body }),
};

/** Request from the `yard` CLI (one JSON line on the pipe). */
export interface BridgeRequest {
  v: number;
  /** YARD_PTY_ID of the calling terminal. */
  terminal: string | null;
  cwd: string | null;
  argv: string[];
  /**
   * Long text from `--file`/`--stdin`. cmd.exe's `%*` eats line breaks,
   * so a multi-line prompt cannot travel in `argv`.
   */
  stdin?: string | null;
  timeoutMs?: number;
}

export interface BridgeResponse {
  code: number;
  output: string;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export const topics = {
  output: (id: string) => `pty://output/${id}`,
  exit: (id: string) => `pty://exit/${id}`,
  activity: (id: string) => `pty://activity/${id}`,
  agentIdle: "pty://idle",
  agentsChanged: "agents://changed",
  sessionFeed: "session://feed",
  filesActivity: "files://activity",
  resourcesTick: "resources://tick",
  bridgeRequest: "bridge://request",
  portalNav: "portal://nav",
  portalPopup: "portal://popup",
  portalEscape: "portal://escape",
  portalMenu: "portal://menu",
} as const;

export interface OutputChunk {
  data: string;
}
export interface ExitPayload {
  id: string;
  code: number | null;
  reason: ExitReason;
}
export interface ActivityPayload {
  id: string;
  lastByteAt: number;
  idleMs: number;
}
export interface IdlePayload {
  id: string;
  title: string;
  idleMs: number;
}

export const on = {
  output: (id: string, cb: (p: OutputChunk) => void) =>
    listen<OutputChunk>(topics.output(id), (e) => cb(e.payload)),
  exit: (id: string, cb: (p: ExitPayload) => void) =>
    listen<ExitPayload>(topics.exit(id), (e) => cb(e.payload)),
  activity: (id: string, cb: (p: ActivityPayload) => void) =>
    listen<ActivityPayload>(topics.activity(id), (e) => cb(e.payload)),
  agentIdle: (cb: (p: IdlePayload) => void) =>
    listen<IdlePayload>(topics.agentIdle, (e) => cb(e.payload)),
  agentsChanged: (cb: () => void) => listen(topics.agentsChanged, () => cb()),
  sessionFeed: (cb: (p: SessionFeed) => void) =>
    listen<SessionFeed>(topics.sessionFeed, (e) => cb(e.payload)),
  filesActivity: (cb: (p: FilesActivity) => void) =>
    listen<FilesActivity>(topics.filesActivity, (e) => cb(e.payload)),
  resources: (cb: (p: ResourcesTick) => void) =>
    listen<ResourcesTick>(topics.resourcesTick, (e) => cb(e.payload)),
  bridgeRequest: (cb: (p: { id: number; request: BridgeRequest }) => void) =>
    listen<{ id: number; request: BridgeRequest }>(topics.bridgeRequest, (e) =>
      cb(e.payload),
    ),
  portalNav: (cb: (p: PortalNav) => void) =>
    listen<PortalNav>(topics.portalNav, (e) => cb(e.payload)),
  portalPopup: (cb: (p: PortalPopup) => void) =>
    listen<PortalPopup>(topics.portalPopup, (e) => cb(e.payload)),
  portalEscape: (cb: (p: PortalEscape) => void) =>
    listen<PortalEscape>(topics.portalEscape, (e) => cb(e.payload)),
  portalMenu: (cb: (p: PortalMenu) => void) =>
    listen<PortalMenu>(topics.portalMenu, (e) => cb(e.payload)),
};

export type { UnlistenFn };
