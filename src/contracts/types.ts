import type * as Wire from "../desktop/bindings";
/** Application data contracts and frontend refinements. No desktop runtime imports. */
import type { Surface } from "../lib/surface";

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
   * when it attaches to an id and finds **no process at all** , the app was
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

/**
 * What the view will do with the history, said before it knows whether the
 * process is alive (`pty::AttachWants`). Each field only lets the backend
 * leave out what the view would not read; left out, `attach_pty` sends the
 * whole history, as it always did.
 */
export interface AttachWants {
  /** If the terminal is dead, its history is discarded (the view spawns on a clean screen). */
  omitDeadHistory?: boolean;
  /**
   * If a live process is on the alternate screen, only `data.slice(-altTail)`
   * is read. The backend then sends a suffix holding at least that many UTF-16
   * units, so the same slice gives the same text.
   */
  altTail?: number;
}

export type PtyProbe = Wire.PtyProbe;

export type PtyDelta = Wire.PtyDelta;

export type ShellOption = Wire.ShellOption;

export type FontFamilyInfo = Wire.FontFamilyInfo;

export type AgentInfo = Wire.AgentInfo_Serialize;

/** Whether an agent can be told to run inside WSL, and in which distro. */
export type WslStatus = Wire.WslStatus_Serialize;

export interface AgentSession {
  accountId?: string | null;
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
  cacheCreationOneHourTokens?: number;
  cacheReadTokens: number;
  messages: number;
  models: string[];
  costUsd: number | null;
}

// --- live session tail ("Ao Vivo") -----------------------------------------

export type FeedKind =
  "prompt" | "say" | "think" | "tool" | "result" | "usage" | "notify";

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

/** One event of the live feed , mirror of `agents::tail::FeedEvent`. */
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

/** The main window was hidden/minimized (`false`) or came back (`true`). */
export interface WindowShown {
  shown: boolean;
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
   * existed , it adds it empty on purpose, because the surface a pre-split
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
  /**
   * Kept at the front of its pane's bar, and out of every crowd close. A
   * column since schema v8; a row written before it comes back `false`.
   */
  pinned?: boolean;
}

export interface WorkspaceSnapshot {
  rev: number;
  projects: ProjectRow[];
  groups: GroupRow[];
  terminals: TerminalRow[];
}

export type SaveResult = Wire.SaveResult;

export type AppPaths = Wire.AppPaths;

/** A score on disk (`<data>\partituras\<nome>.json`). */
export type ScoreMeta = Wire.ScoreMeta;

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
  /** Paths beyond the window cap , counted only, not listed. */
  dropped: number;
}

export type GitFileStatus =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

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
   *  Above zero, `additions` is a floor , the UI marks the total as partial. */
  uncounted: number;
}

export type FileDiff = Wire.FileDiff;

// --- source control (the bench's "Controle" tab) ---------------------------

/** Which side of the staging area a status belongs to. `none` = nothing here. */
export type GitSide = GitFileStatus | "none";

export interface ScmInfo {
  isRepo: boolean;
  root: string | null;
  /** `null` when HEAD is detached , `detached` then says why. */
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
  /** Tracks an upstream that no longer exists , safe to delete locally. */
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
  /** `HEAD -> main`, `origin/main`, `tag: v1.0` , what points at it. */
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
  /** Stopped on a collision , a state, not an error. */
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

export type DirEntryInfo = Wire.DirEntryInfo;

export type DirListing = Wire.DirListing;

/** One line that matched the project-wide content search. */
export type SearchHit = Wire.SearchHit;

export type SearchOutcome = Wire.SearchOutcome;

/**
 * How the project search reads the query and which files it opens. The same
 * options govern the replace: what gets rewritten has to be exactly what the
 * result list showed.
 */
export type SearchOptions = Wire.SearchOptions_Serialize;

export type ReplaceOutcome = Wire.ReplaceOutcome;

/** Every file under the root (skip list applied) , the quick-open index. */
export type FileIndex = Wire.FileIndex;

export type TextFile = Wire.TextFile_Serialize;

/**
 * What a file looked like on disk at a given moment , the pair a save compares
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
  /** Where the new worktree's HEAD landed , the rollback's compare-and-swap. */
  headOid: string | null;
  /** The commit the branch grew from, when this call created the branch. */
  baseOid: string | null;
}

/** One row of the dialog, as the preflight is asked about it. */
export interface PreflightItem {
  id: string;
  /** `new_branch` | `existing_branch` | `adopt` | `ground`. */
  kind: string;
  name: string;
  branch?: string | null;
  worktreeName?: string | null;
  baseRef?: string | null;
  worktreePath?: string | null;
}

/**
 * What git would do with that row , facts, not verdicts. The rules that turn
 * these into refusals live in `lib/provision/plan.ts`, because they need what
 * the app knows too (which front owns what, which agent is alive where).
 */
export type PreflightItemResult = Wire.PreflightItemResult_Serialize;

export type Preflight = Wire.Preflight_Serialize;

export type WorktreeEntry = Wire.WorktreeEntry_Serialize;

export type WorktreeRemoval = Wire.WorktreeRemoval_Serialize;

export type HookResult = Wire.HookResult;

export type LandFile = Wire.LandFile_Serialize;

export type LandPreview = Wire.LandPreview_Serialize;

export type LandResult = Wire.LandResult;

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

export interface AgentAccount {
  id: string;
  provider: string;
  label: string;
  status: string;
}

export type AccountBinding = Wire.AccountBinding_Serialize;

export interface AccountsSnapshot {
  accounts: AgentAccount[];
  selected: Record<string, string | null>;
  bindings: AccountBinding[];
}

export interface UsageSnapshot {
  providers: ProviderUsage[];
  accounts?: { accountId: string | null; usage: ProviderUsage }[];
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
 * sidebar and the panels. `zoom` is the camera's , the page renders at it, so
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
   * App surfaces that have to show through the page , a menu, the toolbar,
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

export type PortalInfo = Wire.PortalInfo;

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
// notebook (markdown notes) , mirrors persistence/notes.rs
// ---------------------------------------------------------------------------

export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  notebookId: string | null;
  /** Tag ids , names live in `NoteTagRecord`, so renaming never touches notes. */
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

export type NotesData = Wire.NotesData_Serialize;

/** What `support_bundle` wrote , the entry list is the privacy contract, shown to the user. */
export type SupportSummary = Wire.SupportSummary;

/** What `backup_auto_run` wrote and what it rotated out (`persistence/autobackup.rs`). */
export type AutoBackupReport = Wire.AutoBackupReport;

// ---------------------------------------------------------------------------
// costs , mirrors costs.rs
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
  cacheWriteOneHour?: number;
  costUsd: number | null;
  sessions: number;
}

// ---------------------------------------------------------------------------
// MCP manager , mirrors src-tauri/src/mcp.rs
// ---------------------------------------------------------------------------

/** A server as the manager sees it, whatever CLI it came from. */
export type McpServer = Wire.McpServer_Serialize;

/** One row of the listing: the names of env/header keys, never the values. */
export type McpRow = Wire.McpRow_Serialize;

export interface McpListing {
  accounts?: Record<string, string | null>;
  rows: McpRow[];
  /** Files that could not be read, each naming its path. */
  errors: string[];
}

export type McpSecrets = Wire.McpSecrets;

export type McpHealth = Wire.McpHealth_Serialize;

/**
 * Whether an agent can be told to run on another machine over SSH, and the
 * aliases `~/.ssh/config` already names , mirrors `WslStatus`.
 */
export type SshStatus = Wire.SshStatus_Serialize;

// ---------------------------------------------------------------------------
// language servers (lsp.rs)
// ---------------------------------------------------------------------------

/** A server of the editor's catalog and whether this machine has it. */
export type LspServerInfo = Wire.LspServerInfo_Serialize;

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

/** One line a terminal printed, as `scrollback_search.rs` returns it. */
export interface ScrollbackHit {
  /** 1-based line inside the terminal's `.bin`. */
  line: number;
  /** Character offset of the match inside `text`. */
  col: number;
  text: string;
  /** `text` is a window cut out of a longer line. */
  clipped: boolean;
}

export type TerminalHits = Wire.TerminalHits;

// --- the forge (gh), `src-tauri/src/forge.rs` -----------------------------

export type Checks = Wire.Checks;

export type PullRequest = Wire.PullRequest;

export type ForgeStatus = Wire.ForgeStatus;

export type ReviewNote = Wire.ReviewNote;

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

export interface OutputChunk {
  data: string;
}

export interface ExitPayload {
  id: string;
  code: number | null;
  reason: ExitReason;
}

export type ActivityPayload = Wire.ActivityPayload;

export interface IdlePayload {
  id: string;
  title: string;
  idleMs: number;
}
