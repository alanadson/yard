/**
 * IPC contract — TypeScript mirror of `src-tauri/src/events.rs`.
 *
 * No component calls `invoke` directly. Everything goes through here, so
 * changing a signature in Rust breaks the front-end compile instead of
 * becoming a silent `undefined` in production.
 */
// i18n-scan: tables — string-literal unions and backend error names; nothing here is rendered.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Surface } from "./surface";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type PtyKind = "shell" | "agent";
export type ExitReason =
  | "normal"
  | "killed"
  | "suspended"
  | "restarted"
  | "failed"
  /**
   * Not a reason the backend ever sends: it is what the front end writes down
   * when it attaches to an id and finds **no process at all** — the app was
   * closed (and took the process trees with it, §F3) or it died while nothing
   * was mounted to watch it. The scrollback is still on disk, so the card
   * paints a terminal that looks alive; without this the only honest state in
   * the app would be an empty runtime entry nobody renders.
   */
  | "gone";

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
  /** Size the live PTY is on (0 when there is no process behind the id). */
  rows: number;
  cols: number;
  /**
   * The process is painting on the alternate screen, so `data` is a log of
   * incremental redraws and not a screen anyone can repaint. Ask for a
   * `repaintPty` instead of replaying it.
   */
  altScreen: boolean;
}

export interface PtyProbe {
  alive: boolean;
  totalBytes: number;
}

export interface PtyDelta extends PtyProbe {
  data: string;
}

export interface ShellOption {
  id: string;
  label: string;
  program: string;
  available: boolean;
}

export interface FontFamilyInfo {
  family: string;
  /** Monospaced (post table) — the only ones the terminal/editor pickers offer. */
  mono: boolean;
  /** The font's GSUB carries `liga`/`calt`/`dlig` — the ligature checkbox appears. */
  ligatures: boolean;
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

/** Whether an agent can be told to run inside WSL, and in which distro. */
export interface WslStatus {
  available: boolean;
  distros: string[];
  /** Why it cannot be used — the line under the disabled control. */
  reason: string | null;
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
  /**
   * `null` makes this group a **board** ("quadro"): the canvas as its own
   * container, holding cards from several projects at once, so there is no
   * single project it could belong to. `projectsStore.isBoard` is the reading
   * of this field everything else goes through.
   */
  projectId: string | null;
  name: string;
  layoutJson: string;
  suspended: boolean;
  sort: number;
}

export interface TerminalRow {
  id: string;
  groupId: string;
  slot: number;
  /**
   * Which surface draws this terminal: a tab of a pane, or a card on the
   * canvas.
   *
   * `null` is what the backend sends for a row written before the column
   * existed — it adds it empty on purpose, because the surface a pre-split
   * terminal belongs to is the one its group was showing, and only this side
   * parses the group layout. `projectsStore.load` stamps every one of those on
   * the way in and saves them back, so nothing else finds it missing for long.
   */
  surface?: Surface | null;
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
  /**
   * What the **index** holds for this path, on its own. `staged` is a single
   * boolean and a path can be on both sides at once (prepared, then edited
   * again): Source Control lists the two groups separately, so it needs the
   * two halves, not their `or`.
   */
  index: GitSide;
  /** What the **working tree** holds. `untracked` only ever appears here. */
  worktree: GitSide;
  /**
   * The raw unmerged pair (`UU`, `AA`, `DU`…) when conflicted. It is what
   * names the conflict: "both modified" and "deleted by them" want different
   * resolutions.
   */
  conflict: string | null;
}

export interface ChangesSummary {
  isRepo: boolean;
  branch: string | null;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** New files whose lines were not counted (past the backend cap).
   *  Above zero, `additions` is a floor — the UI marks the total as partial. */
  uncounted: number;
}

export interface FileDiff {
  path: string;
  isBinary: boolean;
  truncated: boolean;
  /** File outside the repo (what the agent touched in `%TEMP%`, its own
   *  memory…): `text` is the current content, not a comparison. */
  external: boolean;
  text: string;
}

// --- source control (the bench's "Controle" tab) ---------------------------

/** Which side of the staging area a status belongs to. `none` = nothing here. */
export type GitSide = GitFileStatus | "none";

export interface ScmInfo {
  isRepo: boolean;
  root: string | null;
  /** `null` when HEAD is detached — `detached` then says why. */
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  remotes: ScmRemote[];
  /** `clean` | `merging` | `rebasing` | `cherry-picking` | `reverting` | `bisecting` */
  state: ScmState;
  stashes: number;
  hasHead: boolean;
}

export type ScmState =
  | "clean"
  | "merging"
  | "rebasing"
  | "cherry-picking"
  | "reverting"
  | "bisecting";

export interface ScmRemote {
  name: string;
  url: string;
}

export interface ScmBranch {
  name: string;
  current: boolean;
  /** Under `refs/remotes/`: checking it out would detach HEAD. */
  remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Tracks an upstream that no longer exists — safe to delete locally. */
  gone: boolean;
  hash: string;
  subject: string;
  /** Epoch **seconds** (git's own unit), not milliseconds. */
  date: number;
}

export interface ScmCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  /** Epoch seconds. */
  date: number;
  parents: string[];
  /** `HEAD -> main`, `origin/main`, `tag: v1.0` — what points at it. */
  refs: string[];
  subject: string;
  body: string;
}

export interface ScmCommitDetail {
  commit: ScmCommit;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}

export interface ScmCommitResult {
  hash: string;
  short: string;
  subject: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface ScmStash {
  index: number;
  message: string;
  branch: string | null;
  date: number;
}

export interface ScmTag {
  name: string;
  hash: string;
  subject: string;
  date: number;
}

export interface ScmMergeResult {
  /** Stopped on a collision — a state, not an error. */
  conflicted: boolean;
  message: string;
}

export interface ScmCommitOpts {
  amend?: boolean;
  stageAll?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
  allowEmpty?: boolean;
}

export interface ScmLogQuery {
  /** `0` = the backend's page size. */
  limit?: number;
  skip?: number;
  path?: string | null;
  rev?: string | null;
  all?: boolean;
  search?: string | null;
}

/**
 * Which comparison a diff is of. Getting this wrong is not a cosmetic bug:
 * a hunk patch built against the wrong baseline does not apply.
 * - `worktree`: index → disk (the "Alterações" group);
 * - `index`: HEAD → index (the "Preparado" group);
 * - `head`: HEAD → disk (everything the next commit would change).
 */
export type ScmDiffSide = "worktree" | "index" | "head";

// --- file explorer (tree + editor) -----------------------------------------

export interface DirEntryInfo {
  name: string;
  /** Relative to the project root, with `/` (same convention as git). */
  path: string;
  dir: boolean;
  size: number;
  /** Epoch ms; `0` when the filesystem does not report it. */
  modifiedAt: number;
  symlink: boolean;
}

export interface DirListing {
  path: string;
  entries: DirEntryInfo[];
  /** Items beyond the directory cap — counted only. */
  dropped: number;
}

/** One line that matched the project-wide content search. */
export interface SearchHit {
  /** Relative to the root, with `/`. */
  path: string;
  /** 1-based. */
  line: number;
  /** The line's text, trimmed to a sane width. */
  text: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  filesHit: number;
  /** Stopped at a cap — the project holds more than what came back. */
  truncated: boolean;
}

/** Every file under the root (skip list applied) — the quick-open index. */
export interface FileIndex {
  paths: string[];
  truncated: boolean;
}

export interface TextFile {
  path: string;
  text: string;
  binary: boolean;
  /** Went past the read cap: opens read-only. */
  truncated: boolean;
  /**
   * The bytes on disk are not valid UTF-8 (a legacy cp1252/latin-1 file), so
   * `text` came through a lossy decode and every byte we could not read is now
   * `U+FFFD`. Saving it back would overwrite the original content — opens
   * read-only, same as `truncated`.
   */
  lossy: boolean;
  size: number;
  modifiedAt: number;
  /** The file on disk uses CRLF — saving puts it back the way it was. */
  crlf: boolean;
  /**
   * The file on disk starts with a UTF-8 BOM. Same contract as `crlf`: the
   * buffer never carries it, and saving puts it back — otherwise every save of
   * a `.ps1`/`.csproj` quietly dropped three bytes.
   */
  bom: boolean;
  /**
   * MIME type when the webview can draw the file (`image/png`, `video/mp4`,
   * `application/pdf`…) — what makes the editor show the picture instead of
   * announcing there is no text. `null` = nothing to look at.
   */
  media: string | null;
}

/**
 * What a file looked like on disk at a given moment — the pair a save compares
 * before overwriting (`explorer::Seen` / `explorer::WriteResult` in Rust).
 */
export interface FileStamp {
  modifiedAt: number;
  size: number;
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

export interface LandFile {
  path: string;
  origPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "conflicted" | string;
  additions: number | null;
  deletions: number | null;
}

export interface LandPreview {
  groundBranch: string;
  floorBranch: string;
  clean: boolean;
  alreadyMerged: boolean;
  groundDirty: boolean;
  floorDirty: boolean;
  files: LandFile[];
  additions: number;
  deletions: number;
  conflictPaths: string[];
}

export interface LandResult {
  ok: boolean;
  alreadyMerged: boolean;
  conflicted: boolean;
  message: string;
  conflictPaths: string[];
}

// --- agent usage limits (usage.rs) -----------------------------------------

/** A limit window ("session" 5 h, "weekly", "fable", "monthly"). */
export interface UsageWindow {
  key: string;
  usedPercent: number;
  windowMinutes: number;
  /** Epoch ms; `null` when the provider did not report the reset. */
  resetsAt: number | null;
}

export type UsageStatus = "ok" | "stale" | "auth" | "missing" | "error";

export interface ProviderUsage {
  id: string;
  name: string;
  plan: string | null;
  account: string | null;
  windows: UsageWindow[];
  status: UsageStatus;
  error: string | null;
  /** Epoch ms of the last successful fetch (0 = never). */
  updatedAt: number;
}

export interface UsageSnapshot {
  providers: ProviderUsage[];
  fetchedAt: number;
}

// --- portals (browser on the canvas) ---------------------------------------

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
  clip?: PortalRect | null;
  zoom?: number | null;
}

export interface PortalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a portal's native surface goes.
 *
 * `clip` is the canvas's own rectangle on screen: the page is an OS window
 * over the DOM, so it is the only thing that keeps it from painting over the
 * sidebar and the panels. `zoom` is the camera's — the page renders at it, so
 * a portal scales like every other card.
 */
export interface PortalPlace {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  clip?: PortalRect | null;
  /**
   * App surfaces that have to show through the page — a menu, the toolbar,
   * the minimap, a toast. They are cut out of the native window, which takes
   * the mouse with them: what shows through is clickable, not a picture.
   */
  holes?: PortalRect[] | null;
  zoom?: number | null;
}

export interface PortalBoundsUpdate {
  id: string;
  place: PortalPlace;
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
// notebook (markdown notes) — mirrors persistence/notes.rs
// ---------------------------------------------------------------------------

export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  notebookId: string | null;
  /** Tag ids — names live in `NoteTagRecord`, so renaming never touches notes. */
  tags: string[];
  status: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set = the note is in the trash. */
  deletedAt: number | null;
}

export interface NotebookRecord {
  id: string;
  name: string;
  parentId: string | null;
  /** Emoji chosen by the user; `null` = the default book glyph. */
  icon: string | null;
  sort: number;
}

export interface NoteTagRecord {
  id: string;
  name: string;
  color: string;
  sort: number;
}

export interface NotesData {
  notes: NoteRecord[];
  notebooks: NotebookRecord[];
  tags: NoteTagRecord[];
}

/** What `support_bundle` wrote — the entry list is the privacy contract, shown to the user. */
export interface SupportSummary {
  path: string;
  bytes: number;
  entries: string[];
  version: string;
}
/** What `backup_auto_run` wrote and what it rotated out (`persistence/autobackup.rs`). */
export interface AutoBackupReport {
  path: string;
  bytes: number;
  pruned: string[];
}
// ---------------------------------------------------------------------------
// costs — mirrors costs.rs
// ---------------------------------------------------------------------------

/**
 * One row of the "Custos e uso" panel: one agent, one project, one model, one
 * local day. `costUsd` is `null` for a model outside the price table.
 */
export interface UsageRow {
  day: string;
  agent: string;
  projectPath: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  sessions: number;
}
// ---------------------------------------------------------------------------
// MCP manager — mirrors src-tauri/src/mcp.rs
// ---------------------------------------------------------------------------

/** A server as the manager sees it, whatever CLI it came from. */
export interface McpServer {
  name: string;
  /** `stdio` | `http` | `sse` — plus `ws` passing through from Claude Code. */
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
}

/** One row of the listing: the names of env/header keys, never the values. */
export interface McpRow {
  cli: string;
  /** `user` | `local` | `project`. */
  scope: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  sourceFile: string;
  enabled: boolean;
  /** The CLI has a native on/off flag the manager can write. */
  canToggle: boolean;
}

export interface McpListing {
  rows: McpRow[];
  /** Files that could not be read, each naming its path. */
  errors: string[];
}

export interface McpSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}
/**
 * Whether an agent can be told to run on another machine over SSH, and the
 * aliases `~/.ssh/config` already names — mirrors `WslStatus`.
 */
export interface SshStatus {
  available: boolean;
  /** Where `ssh` was found, for the line under the control. */
  path: string | null;
  hosts: string[];
  /** Why it cannot be used — the line under the disabled control. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// language servers (lsp.rs)
// ---------------------------------------------------------------------------

/** A server of the editor's catalog and whether this machine has it. */
export interface LspServerInfo {
  /** LSP language ids the server takes (`typescript`, `rust`, …). */
  languageIds: string[];
  program: string;
  args: string[];
  version: string | null;
  installHint: string;
  found: boolean;
}
/** One bare-JSON message from a server, tagged with the client id that started it. */
export interface LspMessagePayload {
  id: string;
  message: string;
}
export interface LspExitPayload {
  id: string;
  code: number | null;
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
  /**
   * Asks the console host to re-emit the frame the CLI has on screen right
   * now — the only way to repaint a full-screen CLI that a view rebuilt from
   * scratch can use.
   */
  repaintPty: (id: string) => invoke<void>("repaint_pty", { id }),
  ptyProbe: (id: string) => invoke<PtyProbe>("pty_probe", { id }),
  ptyReadSince: (id: string, after: number, maxBytes: number) =>
    invoke<PtyDelta>("pty_read_since", { id, after, maxBytes }),
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
  /** First call scans the font folders (slow); the backend caches the rest. */
  listFonts: () => invoke<FontFamilyInfo[]>("list_fonts"),

  // workspace / prefs
  saveWorkspace: (snapshot: WorkspaceSnapshot) =>
    invoke<SaveResult>("save_workspace", { snapshot }),
  loadWorkspace: () => invoke<WorkspaceSnapshot>("load_workspace"),
  readPrefs: () => invoke<Record<string, string>>("read_prefs"),
  writePref: (key: string, value: string) =>
    invoke<void>("write_pref", { key, value }),
  deletePref: (key: string) => invoke<void>("delete_pref", { key }),
  exportBackup: (dest: string) => invoke<string>("export_backup", { dest }),
  /** Stages the backup for the next boot; the live database is not touched. */
  importBackup: (src: string) => invoke<void>("import_backup", { src }),
  backupPending: () => invoke<boolean>("backup_pending"),
  /** Discards the staged backup; the next boot keeps the current workspace. */
  cancelBackup: () => invoke<void>("cancel_backup"),
  restartApp: () => invoke<void>("restart_app"),
  /** Energy mode: `true` = the PC neither sleeps nor turns off the screen. */
  setKeepAwake: (on: boolean) => invoke<void>("set_keep_awake", { on }),

  // notebook (markdown notes)
  notesLoad: () => invoke<NotesData>("notes_load"),
  noteSave: (note: NoteRecord) => invoke<void>("note_save", { note }),
  noteDelete: (id: string) => invoke<void>("note_delete", { id }),
  notebookSave: (notebook: NotebookRecord) =>
    invoke<void>("notebook_save", { notebook }),
  notebookDelete: (id: string) => invoke<void>("notebook_delete", { id }),
  noteTagSave: (tag: NoteTagRecord) => invoke<void>("note_tag_save", { tag }),
  noteTagDelete: (id: string) => invoke<void>("note_tag_delete", { id }),
  noteExport: (dest: string, text: string) =>
    invoke<void>("note_export", { dest, text }),

  // scores (saved arrangements of a group)
  /**
   * Refuses to replace a score that already exists unless `overwrite` says so
   * — the error then starts with `JA_EXISTE:` and the caller offers to replace.
   */
  scoreSave: (name: string, json: string, overwrite = false) =>
    invoke<string>("score_save", { name, json, overwrite }),
  scoreList: () => invoke<ScoreMeta[]>("score_list"),
  scoreRead: (name: string) => invoke<string>("score_read", { name }),
  scoreDelete: (name: string) => invoke<void>("score_delete", { name }),

  // agents
  detectAgents: (refresh = false) =>
    invoke<AgentInfo[]>("detect_agents", { refresh }),
  wslStatus: () => invoke<WslStatus>("wsl_status"),
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

  // file explorer — `root` is the project root (or the active floor's) and
  // every `path` is relative to it; the backend refuses anything outside.
  fsListDir: (root: string, path: string) =>
    invoke<DirListing>("fs_list_dir", { root, path }),
  fsReadText: (root: string, path: string) =>
    invoke<TextFile>("fs_read_text", { root, path }),
  /**
   * Writes the file and returns its new stamp. Errors with `CONFLITO:` when
   * the disk moved: `expected` is what the editor last saw there, and it
   * carries the **size** as well as the timestamp — the mtime alone has a
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
  ) =>
    invoke<FileStamp>("fs_write_text", {
      root,
      path,
      text,
      expected,
      crlf,
      bom,
    }),
  fsCreateEntry: (root: string, path: string, dir: boolean) =>
    invoke<void>("fs_create_entry", { root, path, dir }),
  fsRenameEntry: (root: string, path: string, newPath: string) =>
    invoke<void>("fs_rename_entry", { root, path, newPath }),
  fsDeleteEntry: (root: string, path: string) =>
    invoke<void>("fs_delete_entry", { root, path }),
  /** Literal text search across the whole project (Ctrl+Shift+F). */
  fsSearchText: (
    root: string,
    query: string,
    caseSensitive: boolean,
    wholeWord: boolean,
  ) =>
    invoke<SearchOutcome>("fs_search_text", {
      root,
      query,
      caseSensitive,
      wholeWord,
    }),
  fsCancelSearch: (root: string) => invoke<void>("fs_cancel_search", { root }),
  /** All file paths under the root — what Ctrl+P offers before any browsing. */
  fsIndexFiles: (root: string) => invoke<FileIndex>("fs_index_files", { root }),
  /**
   * The file's content at HEAD (normalized to `\n`), or `null` when there is
   * nothing to compare against: untracked, no commit yet, binary, no git.
   */
  gitHeadText: (root: string, path: string) =>
    invoke<string | null>("git_head_text", { root, path }),

  // source control — every call takes the repository's `cwd` (the project
  // root, or the active floor's worktree) as its first argument, exactly like
  // `gitChanges`. Nothing here caches: the store owns freshness.
  scmInfo: (cwd: string) => invoke<ScmInfo>("scm_info", { cwd }),
  scmInit: (cwd: string) => invoke<void>("scm_init", { cwd }),

  scmStage: (cwd: string, paths: string[]) => invoke<void>("scm_stage", { cwd, paths }),
  scmStageAll: (cwd: string) => invoke<void>("scm_stage_all", { cwd }),
  scmUnstage: (cwd: string, paths: string[]) =>
    invoke<void>("scm_unstage", { cwd, paths }),
  scmUnstageAll: (cwd: string) => invoke<void>("scm_unstage_all", { cwd }),
  scmDiscard: (cwd: string, paths: string[]) =>
    invoke<void>("scm_discard", { cwd, paths }),
  scmDiscardAll: (cwd: string, includeUntracked: boolean) =>
    invoke<void>("scm_discard_all", { cwd, includeUntracked }),

  scmCommit: (cwd: string, message: string, opts: ScmCommitOpts = {}) =>
    invoke<ScmCommitResult>("scm_commit", {
      cwd,
      message,
      opts: {
        amend: opts.amend ?? false,
        stageAll: opts.stageAll ?? false,
        signoff: opts.signoff ?? false,
        noVerify: opts.noVerify ?? false,
        allowEmpty: opts.allowEmpty ?? false,
      },
    }),
  /** The full message of the last commit — what the amend box is pre-filled with. */
  scmLastMessage: (cwd: string) => invoke<string | null>("scm_last_message", { cwd }),

  scmLog: (cwd: string, query: ScmLogQuery = {}) =>
    invoke<ScmCommit[]>("scm_log", {
      cwd,
      query: {
        limit: query.limit ?? 0,
        skip: query.skip ?? 0,
        path: query.path ?? null,
        rev: query.rev ?? null,
        all: query.all ?? false,
        search: query.search ?? null,
      },
    }),
  scmCommitDetail: (cwd: string, hash: string) =>
    invoke<ScmCommitDetail>("scm_commit_detail", { cwd, hash }),
  scmCommitFileDiff: (cwd: string, hash: string, path: string) =>
    invoke<FileDiff>("scm_commit_file_diff", { cwd, hash, path }),

  scmBranches: (cwd: string) => invoke<ScmBranch[]>("scm_branches", { cwd }),
  scmCheckout: (cwd: string, name: string) => invoke<void>("scm_checkout", { cwd, name }),
  scmBranchCreate: (
    cwd: string,
    name: string,
    startPoint: string | null,
    switchTo: boolean,
  ) => invoke<void>("scm_branch_create", { cwd, name, startPoint, switch: switchTo }),
  scmBranchDelete: (cwd: string, name: string, force: boolean) =>
    invoke<void>("scm_branch_delete", { cwd, name, force }),
  scmBranchRename: (cwd: string, from: string, to: string) =>
    invoke<void>("scm_branch_rename", { cwd, from, to }),

  scmMerge: (cwd: string, name: string, noFf: boolean) =>
    invoke<ScmMergeResult>("scm_merge", { cwd, name, noFf }),
  scmRebase: (cwd: string, onto: string) =>
    invoke<ScmMergeResult>("scm_rebase", { cwd, onto }),
  scmRevert: (cwd: string, hash: string) =>
    invoke<ScmMergeResult>("scm_revert", { cwd, hash }),
  /** `soft` keeps everything prepared, `mixed` keeps the files, `hard` throws it away. */
  scmReset: (cwd: string, rev: string, mode: "soft" | "mixed" | "hard") =>
    invoke<void>("scm_reset", { cwd, rev, mode }),
  scmResolveConflict: (cwd: string, paths: string[], side: "ours" | "theirs") =>
    invoke<void>("scm_resolve_conflict", { cwd, paths, side }),
  scmAbort: (cwd: string) => invoke<void>("scm_abort", { cwd }),
  scmContinue: (cwd: string) => invoke<void>("scm_continue", { cwd }),

  scmStashList: (cwd: string) => invoke<ScmStash[]>("scm_stash_list", { cwd }),
  scmStashPush: (
    cwd: string,
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
  ) => invoke<void>("scm_stash_push", { cwd, message, includeUntracked, keepIndex }),
  scmStashApply: (cwd: string, index: number, pop: boolean) =>
    invoke<void>("scm_stash_apply", { cwd, index, pop }),
  scmStashDrop: (cwd: string, index: number) =>
    invoke<void>("scm_stash_drop", { cwd, index }),
  scmStashShow: (cwd: string, index: number) =>
    invoke<string>("scm_stash_show", { cwd, index }),

  scmFetch: (cwd: string, remote: string | null, prune: boolean) =>
    invoke<void>("scm_fetch", { cwd, remote, prune }),
  scmPull: (cwd: string, rebase: boolean) => invoke<void>("scm_pull", { cwd, rebase }),
  /** `force` is `--force-with-lease` on the backend, never a plain `--force`. */
  scmPush: (
    cwd: string,
    remote: string,
    branch: string | null,
    setUpstream: boolean,
    force: boolean,
  ) => invoke<void>("scm_push", { cwd, remote, branch, setUpstream, force }),
  scmPushDelete: (cwd: string, remote: string, branch: string) =>
    invoke<void>("scm_push_delete", { cwd, remote, branch }),

  scmTags: (cwd: string) => invoke<ScmTag[]>("scm_tags", { cwd }),
  scmTagCreate: (
    cwd: string,
    name: string,
    message: string | null,
    target: string | null,
  ) => invoke<void>("scm_tag_create", { cwd, name, message, target }),
  scmTagDelete: (cwd: string, name: string) => invoke<void>("scm_tag_delete", { cwd, name }),

  /**
   * Applies a patch the panel built from selected hunks (or selected lines).
   * `cached` writes to the index, `reverse` undoes instead of applying — the
   * four combinations are prepare, unprepare, discard and re-apply.
   */
  scmApplyPatch: (cwd: string, patch: string, cached: boolean, reverse: boolean) =>
    invoke<void>("scm_apply_patch", { cwd, patch, cached, reverse }),
  scmDiff: (
    cwd: string,
    path: string,
    side: ScmDiffSide,
    origPath: string | null = null,
    context: number | null = null,
  ) => invoke<FileDiff>("scm_diff", { cwd, path, side, origPath, context }),

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
  worktreePreview: (
    projectPath: string,
    floorBranch: string,
    floorPath?: string | null,
  ) =>
    invoke<LandPreview>("worktree_preview", {
      projectPath,
      floorBranch,
      floorPath: floorPath ?? null,
    }),
  worktreeLand: (
    projectPath: string,
    floorBranch: string,
    floorPath?: string | null,
  ) =>
    invoke<LandResult>("worktree_land", {
      projectPath,
      floorBranch,
      floorPath: floorPath ?? null,
    }),
  floorRunHook: (cwd: string, command: string, env: [string, string][]) =>
    invoke<HookResult>("floor_run_hook", { cwd, command, env }),

  // portals
  listBrowsers: (refresh = false) =>
    invoke<BrowserInfo[]>("list_browsers", { refresh }),
  portalOpen: (opts: PortalOpen) => invoke<PortalInfo>("portal_open", { opts }),
  portalSetBounds: (id: string, place: PortalPlace) =>
    invoke<void>("portal_set_bounds", { id, place }),
  portalSetBoundsMany: (updates: PortalBoundsUpdate[]) =>
    invoke<void>("portal_set_bounds_many", { updates }),
  portalNavigate: (id: string, url: string) =>
    invoke<void>("portal_navigate", { id, url }),
  portalEval: (id: string, js: string) =>
    invoke<string>("portal_eval", { id, js }),
  /** Fingerprint of what an address is serving — see `lib/portalLive.ts`. */
  portalProbe: (url: string) => invoke<string>("portal_probe", { url }),
  portalClose: (id: string) => invoke<void>("portal_close", { id }),
  portalHideExcept: (keep: string[]) =>
    invoke<void>("portal_hide_except", { keep }),
  /** Closes engines with no card left in any canvas. Returns how many. */
  portalRetain: (keep: string[]) => invoke<number>("portal_retain", { keep }),
  portalInfo: (id: string) => invoke<PortalInfo>("portal_info", { id }),
  portalReload: (id: string) => invoke<void>("portal_reload", { id }),
  portalBack: (id: string) => invoke<void>("portal_back", { id }),
  portalForward: (id: string) => invoke<void>("portal_forward", { id }),
  portalSetMuted: (id: string, muted: boolean) =>
    invoke<void>("portal_set_muted", { id, muted }),
  portalSetUa: (id: string, ua: string | null) =>
    invoke<void>("portal_set_ua", { id, ua }),
  portalScreenshot: (id: string) => invoke<string>("portal_screenshot", { id }),
  /** PNG crop of one element (Modo Design) — `rect` in the page's CSS pixels. */
  portalGrabShot: (id: string, rect: PortalRect) =>
    invoke<string>("portal_grab_shot", { id, rect }),

  // system
  appPaths: () => invoke<AppPaths>("app_paths"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  /** Opens the file in the system's default program (a `.docx`, a `.zip`). */
  openExternal: (path: string) => invoke<void>("open_external", { path }),
  isDirectory: (path: string) => invoke<boolean>("is_directory", { path }),
  /** Pasted image (base64 bytes) → file in `%TEMP%`; returns the path. */
  clipboardSaveImage: (data: string) =>
    invoke<string>("clipboard_save_image", { data }),

  // agent usage limits
  usageSnapshot: () => invoke<UsageSnapshot>("usage_snapshot"),
  usageRefresh: () => invoke<void>("usage_refresh"),

  // agent<->app bridge (CLI `yard`)
  bridgeRespond: (id: number, body: BridgeResponse) =>
    invoke<boolean>("bridge_respond", { id, body }),
  /** Saves a terminal's scrollback to `dest`; `plain` strips the escapes. Bytes written. */
  ptyExport: (id: string, dest: string, plain: boolean) =>
    invoke<number>("pty_export", { id, dest, plain }),
  // tray icon + summon hotkey (tray.rs)
  traySetStatus: (blocked: number, running: number) =>
    invoke<void>("tray_set_status", { blocked, running }),
  windowSummon: () => invoke<"show" | "hide">("window_summon"),
  // support bundle (logs of the last two days + about/agents JSON)
  supportBundle: (dest: string) =>
    invoke<SupportSummary>("support_bundle", { dest }),
  // automatic backup: `dir = null` is the data directory's `backups` folder
  backupAutoRun: (dir: string | null, keep: number) =>
    invoke<AutoBackupReport>("backup_auto_run", { dir, keep }),

  // costs and usage over time (costs.rs)
  usageHistory: (days: number) => invoke<UsageRow[]>("usage_history", { days }),
  /** The whole session `.jsonl` as events — the "Ombro" digest and the transcript. */
  sessionEvents: (file: string) => invoke<FeedEvent[]>("session_events", { file }),

  // MCP manager (mcp.rs)
  mcpList: (projectRoot: string | null) =>
    invoke<McpListing>("mcp_list", { projectRoot }),
  mcpSave: (cli: string, scope: string, projectRoot: string | null, server: McpServer) =>
    invoke<void>("mcp_save", { cli, scope, projectRoot, server }),
  mcpDelete: (cli: string, scope: string, projectRoot: string | null, name: string) =>
    invoke<void>("mcp_delete", { cli, scope, projectRoot, name }),
  mcpEnvValues: (cli: string, scope: string, projectRoot: string | null, name: string) =>
    invoke<McpSecrets>("mcp_env_values", { cli, scope, projectRoot, name }),
  sshStatus: () => invoke<SshStatus>("ssh_status"),
  // language servers (lsp.rs) — the editor's LSP clients
  lspStart: (id: string, program: string, args: string[], cwd: string) =>
    invoke<number>("lsp_start", { id, program, args, cwd }),
  lspSend: (id: string, message: string) => invoke<void>("lsp_send", { id, message }),
  lspStop: (id: string) => invoke<void>("lsp_stop", { id }),
  lspDetect: (refresh: boolean) => invoke<LspServerInfo[]>("lsp_detect", { refresh }),
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
  usageUpdate: "usage://update",
  portalNav: "portal://nav",
  portalPopup: "portal://popup",
  portalEscape: "portal://escape",
  portalMenu: "portal://menu",
  trayQuit: "tray://quit",
  lspMessage: "lsp://message",
  lspExit: "lsp://exit",
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
  usage: (cb: (p: UsageSnapshot) => void) =>
    listen<UsageSnapshot>(topics.usageUpdate, (e) => cb(e.payload)),
  portalNav: (cb: (p: PortalNav) => void) =>
    listen<PortalNav>(topics.portalNav, (e) => cb(e.payload)),
  portalPopup: (cb: (p: PortalPopup) => void) =>
    listen<PortalPopup>(topics.portalPopup, (e) => cb(e.payload)),
  portalEscape: (cb: (p: PortalEscape) => void) =>
    listen<PortalEscape>(topics.portalEscape, (e) => cb(e.payload)),
  portalMenu: (cb: (p: PortalMenu) => void) =>
    listen<PortalMenu>(topics.portalMenu, (e) => cb(e.payload)),
  /** "Sair" picked in the tray menu: run the window's exit flow. */
  trayQuit: (cb: () => void) => listen<null>(topics.trayQuit, () => cb()),
  lspMessage: (cb: (p: LspMessagePayload) => void) =>
    listen<LspMessagePayload>(topics.lspMessage, (e) => cb(e.payload)),
  lspExit: (cb: (p: LspExitPayload) => void) =>
    listen<LspExitPayload>(topics.lspExit, (e) => cb(e.payload)),
};

export type { UnlistenFn };
