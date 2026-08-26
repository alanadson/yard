/**
 * What each CLI is, from Yard's side: the command line it is always born
 * with, where it runs, how long its conversation cache lives, and whether it
 * is offered at all.
 *
 * "Sem pedir permissão" started life as a switch inside "Nova aba", which put
 * the one thing everybody wants **permanently** on behind a gesture repeated
 * on every single tab — and left it out of reach of every CLI that is not
 * born in that dialog: the canvas' `yard recruit`, a fan-out of floors, a
 * resumed session. A setting is what that switch wanted to be, and once there
 * was a place to say things about a CLI, the other three moved in beside it.
 *
 * Two consequences of the line being *text* rather than a set of checkboxes:
 *
 * - the flag stays visible. The switch in Settings writes into the very text
 *   the CLI will receive, the same contract `ArgsField` has: what goes to the
 *   process is what is on screen.
 * - "Nova aba" **pre-fills** its field with this line instead of adding it
 *   behind the scenes. That is what keeps a one-off change possible (erase it
 *   for this tab), and what stops the same flag from being applied twice.
 *
 * Where there is no field to pre-fill — recruit, fan-out, resume — the line
 * is applied straight to the argv.
 */
// i18n-scan: tables — the cache choices and notes are translated where Settings renders them.
import { skipFlagOf, tokenizeArgs, withFlag, type SkipFlag } from "./termArgs";
import { programName } from "./terminals";
import type { AgentInfo } from "./ipc";
import type { RolePick } from "./roles";

/** Where the process runs: this machine, a WSL distro, or another machine over SSH. */
export type AgentWhere = "windows" | "wsl" | "ssh";

/**
 * How long the conversation cache survives a pause.
 *
 * Not a free number, and this is the one place to write down why: the API
 * offers exactly two lifetimes — five minutes and one hour — so a box asking
 * for "expira em X minutos" would be a knob wired to nothing. `""` is
 * "whatever the CLI decides on its own", which depends on how the user
 * authenticates and is the right default.
 */
export type AgentCache = "" | "1h" | "5m" | "off";

/** Everything said about one CLI in Configurações › Agentes. */
export interface AgentConfig {
  /** Command line it is always born with. */
  args: string;
  where: AgentWhere;
  /** WSL distro; `""` means the distro WSL itself defaults to. */
  distro: string;
  /**
   * SSH destination as `ssh` itself reads it — an alias from `~/.ssh/config`
   * or `user@host`. Kept even while `where` is Windows, so switching back to
   * SSH finds it again.
   */
  sshHost: string;
  /** Folder on the remote machine; `""` means the login shell's home. */
  sshPath: string;
  cache: AgentCache;
  /** Kept out of the pickers ("Nova aba", a fan-out) — not uninstalled. */
  hidden: boolean;
  /**
   * Name every new tab of this CLI opens with. Empty = the CLI's own name.
   *
   * It lived in "Nova aba" as a field nobody filled in twice the same way;
   * saying it once here is what let that dialog become a single click.
   */
  name: string;
  /**
   * The responsibility every new tab is born into, and the tint its card
   * wears. Same shape the role picker hands back, so the dialog's control
   * moved here unchanged.
   */
  role: RolePick | null;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  args: "",
  where: "windows",
  distro: "",
  sshHost: "",
  sshPath: "",
  cache: "",
  hidden: false,
  name: "",
  role: null,
};

/** Agent id (the catalog's, from `agents/resolver.rs`) → what was said about it. */
export type AgentDefaults = Record<string, AgentConfig>;

/** True when nothing was said — the row does not need to exist in the kv. */
export function isDefaultConfig(config: AgentConfig): boolean {
  return (
    config.args === DEFAULT_AGENT_CONFIG.args &&
    config.where === DEFAULT_AGENT_CONFIG.where &&
    config.distro === DEFAULT_AGENT_CONFIG.distro &&
    config.sshHost === DEFAULT_AGENT_CONFIG.sshHost &&
    config.sshPath === DEFAULT_AGENT_CONFIG.sshPath &&
    config.cache === DEFAULT_AGENT_CONFIG.cache &&
    config.hidden === DEFAULT_AGENT_CONFIG.hidden &&
    config.name === DEFAULT_AGENT_CONFIG.name &&
    config.role === null
  );
}

/** What was said about an agent — the defaults when nothing was. */
export function configOf(
  all: AgentDefaults,
  id: string | null | undefined,
): AgentConfig {
  return (id && all[id]) || DEFAULT_AGENT_CONFIG;
}

const WHERES: readonly string[] = ["windows", "wsl", "ssh"];
const CACHES: readonly string[] = ["", "1h", "5m", "off"];

/**
 * The stored role of an agent, sifted. A role with no name and no text is
 * nothing — better no role than a card labelled `undefined`.
 */
function parseRole(value: unknown): RolePick | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pick = value as Record<string, unknown>;
  const role = pick.role;
  if (!role || typeof role !== "object" || Array.isArray(role)) return null;
  const row = role as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const text = typeof row.text === "string" ? row.text : "";
  if (!name && !text.trim()) return null;
  return {
    role: { name, text },
    ...(typeof pick.color === "string" && pick.color ? { color: pick.color } : {}),
  };
}

/** One entry of the kv blob, sifted. Anything unknown falls back. */
function parseConfig(value: unknown): AgentConfig {
  // The shape the previous version wrote — the whole setting *was* the line.
  if (typeof value === "string") {
    return { ...DEFAULT_AGENT_CONFIG, args: value.trim() };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_AGENT_CONFIG;
  }
  const row = value as Record<string, unknown>;
  const where = row.where;
  const cache = row.cache;
  return {
    name: typeof row.name === "string" ? row.name.trim() : "",
    role: parseRole(row.role),
    args: typeof row.args === "string" ? row.args.trim() : DEFAULT_AGENT_CONFIG.args,
    // A value from outside that is none of the three places would reach the
    // launcher as none of them: it becomes the default instead of a broken spawn.
    where: WHERES.includes(where as string) ? (where as AgentWhere) : "windows",
    distro: typeof row.distro === "string" ? row.distro.trim() : "",
    sshHost: typeof row.sshHost === "string" ? row.sshHost.trim() : "",
    sshPath: typeof row.sshPath === "string" ? row.sshPath.trim() : "",
    cache: CACHES.includes(cache as string) ? (cache as AgentCache) : "",
    hidden: row.hidden === true,
  };
}

/**
 * kv holds text and can be edited from outside (a restored backup, a file
 * touched by hand); never trust the shape. A config that says nothing is
 * dropped, so "configured" and "has something to say" are the same thing
 * everywhere else in this module.
 */
export function parseAgentDefaults(raw: string | undefined): AgentDefaults {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: AgentDefaults = {};
    for (const [id, value] of Object.entries(data)) {
      const config = parseConfig(value);
      if (!isDefaultConfig(config)) out[id] = config;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * What goes into the kv: the bare line when that is all there is to say.
 *
 * The row stays readable next to the others, and a profile written here is
 * still understood by a version that only knew the line — the same shape
 * `roles.ts` keeps for a preset that is nothing but text.
 */
export function serializeAgentDefaults(
  all: AgentDefaults,
): Record<string, string | Partial<AgentConfig>> {
  const out: Record<string, string | Partial<AgentConfig>> = {};
  for (const [id, config] of Object.entries(all)) {
    if (isDefaultConfig(config)) continue;
    const rest: Partial<AgentConfig> = {};
    if (config.args) rest.args = config.args;
    if (config.where !== "windows") rest.where = config.where;
    if (config.distro) rest.distro = config.distro;
    if (config.sshHost) rest.sshHost = config.sshHost;
    if (config.sshPath) rest.sshPath = config.sshPath;
    if (config.cache) rest.cache = config.cache;
    if (config.hidden) rest.hidden = true;
    if (config.name) rest.name = config.name;
    if (config.role) rest.role = config.role;
    const keys = Object.keys(rest);
    out[id] = keys.length === 1 && keys[0] === "args" ? config.args : rest;
  }
  return out;
}

/** Changes part of one agent's config, leaving every other one alone. */
export function withAgentConfig(
  all: AgentDefaults,
  id: string,
  patch: Partial<AgentConfig>,
): AgentDefaults {
  const next = { ...all };
  const config: AgentConfig = { ...configOf(all, id), ...patch };
  if (typeof patch.args === "string") config.args = patch.args.trim();
  if (typeof patch.distro === "string") config.distro = patch.distro.trim();
  if (typeof patch.sshHost === "string") config.sshHost = patch.sshHost.trim();
  if (typeof patch.sshPath === "string") config.sshPath = patch.sshPath.trim();
  if (typeof patch.name === "string") config.name = patch.name.trim();
  if (isDefaultConfig(config)) delete next[id];
  else next[id] = config;
  return next;
}

/** Sets (or erases) one agent's line — the most common single change. */
export function withAgentDefault(
  all: AgentDefaults,
  id: string,
  line: string,
): AgentDefaults {
  return withAgentConfig(all, id, { args: line });
}

/** The configured line of an agent, or an empty string. */
export function defaultArgsOf(
  all: AgentDefaults,
  id: string | null | undefined,
): string {
  return configOf(all, id).args;
}

/**
 * The title a new card of this CLI is born with: what was configured, else
 * the CLI's own name. "Nova aba" used to ask this on every single tab.
 */
export function titleFor(
  all: AgentDefaults,
  agentId: string | null | undefined,
  fallback: string,
): string {
  return configOf(all, agentId).name || fallback;
}

/** The role a new card of this CLI is born into, when one was configured. */
export function defaultRoleOf(
  all: AgentDefaults,
  agentId: string | null | undefined,
): RolePick | null {
  return configOf(all, agentId).role;
}

/**
 * The same line as an `argv` — what a spawn with no field to pre-fill adds to
 * the command line. Quotes group, as they do in the dialog's field.
 */
export function defaultArgvOf(
  all: AgentDefaults,
  id: string | null | undefined,
): string[] {
  return tokenizeArgs(defaultArgsOf(all, id));
}

/**
 * The argv a CLI is born with where there is **no** field to pre-fill:
 * `yard recruit`, a fan-out of floors, a resumed session.
 *
 * What the caller already decided comes first and wins: a flag the fixed line
 * would repeat is dropped, along with the values that belong to it. The case
 * that makes this necessary is `--append-system-prompt` — a role delivers
 * itself through that flag on Claude Code, and so can a fixed line, and two of
 * them tell the CLI to be two things at once. Between the two, the one
 * attached to *this* card is the more specific intent.
 */
export function spawnArgv(
  all: AgentDefaults,
  agentId: string | null | undefined,
  before: readonly string[],
): string[] {
  const fixed = defaultArgvOf(all, agentId);
  const out = [...before];
  // A flag opens a run; the tokens after it that are not flags are its values,
  // and they leave with it — dropping only the flag would hand the CLI a bare
  // value it has no argument for.
  let dropping = false;
  for (const token of fixed) {
    if (token.startsWith("-")) dropping = before.includes(token);
    if (!dropping) out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// where it runs
// ---------------------------------------------------------------------------

/** What a card is actually launched with. */
export interface Launch {
  program: string;
  args: string[];
}

/**
 * The same CLI, launched inside a WSL distro.
 *
 * Three things this has to get right, each of which broke a terminal before it
 * was written down:
 *
 * - **the program is the bare command**, not the path the Windows detector
 *   found. `C:\…\npm\claude.cmd` does not exist inside the distro; `claude`
 *   does, if it was installed there.
 * - **`--cd` takes the Windows path** and WSL translates it. Handing it
 *   `/mnt/c/...` computed here would be a second, worse implementation of a
 *   translation WSL already does.
 * - **`--` closes wsl's own options.** Without it, a CLI flag that `wsl.exe`
 *   also knows (`-d`, `-u`, `--cd`) is eaten by the launcher and never reaches
 *   the agent.
 */
export function wslLaunch(input: {
  program: string;
  args: readonly string[];
  cwd: string;
  distro: string;
}): Launch {
  // `programName` stops at the file name, which still carries the Windows
  // extension: inside the distro `claude.cmd` is "command not found" and
  // `claude` is the CLI.
  const command = programName(input.program).replace(/\.(cmd|bat|exe|ps1)$/i, "");
  const args = ["--cd", input.cwd];
  // No distro chosen is not an error: it means the one WSL defaults to, and
  // naming it here would go stale the moment the user changes that default.
  if (input.distro.trim()) args.unshift("-d", input.distro.trim());
  return {
    program: "wsl.exe",
    args: [...args, "--", command, ...input.args],
  };
}

/**
 * A value a POSIX shell reads back verbatim: single quotes, with the one
 * character they cannot hold — the single quote itself — closed, escaped and
 * reopened (`it's` → `'it'\''s'`).
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A word of the remote command line: quoted only when the shell would
 * otherwise read something into it. A plain flag stays a plain flag, which is
 * what a human sees when the card's command line is shown back.
 */
function shWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shQuote(value);
}

/**
 * The same CLI, launched on another machine over SSH.
 *
 * The shape is the WSL one turned outward: the process Yard spawns is
 * `ssh.exe`, and the CLI, its arguments and the folder travel inside a
 * single remote command. What this has to get right:
 *
 * - **`-tt` forces a tty.** From ssh's point of view a ConPTY is a pipe, and
 *   without a tty on the far side the CLIs refuse to draw (or run in a mode
 *   nobody wants). Doubled so it is forced even when ssh disagrees.
 * - **the program is the bare command**, as in WSL: `claude.cmd` is the npm
 *   shim on this machine, not the CLI over there.
 * - **every argument is quoted** for the remote shell — a role brief handed
 *   over with `--append-system-prompt` is one argument here and must stay one
 *   argument there.
 * - `exec` so the CLI replaces the login shell: exit codes and the "process
 *   ended" banner mean the CLI, not a shell that outlived it.
 *
 * What does **not** travel: the `yard` shim and the `YARD_*` environment. The
 * remote CLI cannot talk to the canvas — a limit, written down in the docs.
 */
export function sshLaunch(input: {
  program: string;
  args: readonly string[];
  cwd: string;
  host: string;
  remotePath: string;
}): Launch {
  const command = programName(input.program).replace(/\.(cmd|bat|exe|ps1)$/i, "");
  const run = [command, ...input.args.map(shWord)].join(" ");
  const path = input.remotePath.trim();
  const remote = path ? `cd ${shQuote(path)} && exec ${run}` : `exec ${run}`;
  return {
    program: "ssh.exe",
    args: ["-tt", input.host.trim(), remote],
  };
}

/**
 * Everything a card is born with, given what was configured for that agent:
 * the fixed line, the cache, and where it runs.
 *
 * It is deliberately the **whole** answer rather than one step of it. While
 * "Nova aba" still had a form, the fixed line reached the process through the
 * field it pre-filled, so this function only had to do the rest — and when the
 * form went away the line lost its only ride. Every Claude opened in auto mode
 * with `--dangerously-skip-permissions` sitting in Settings, and nothing on
 * screen connected the two. A caller cannot forget a step that does not exist.
 */
export function launchFor(
  all: AgentDefaults,
  agentId: string | null | undefined,
  launch: Launch & { cwd: string },
): Launch {
  const config = configOf(all, agentId);
  // The fixed line first, then the cache flags. Both join here, at the single
  // point every creation site goes through, and a flag the caller already
  // spelled is never doubled.
  const args = spawnArgv(all, agentId, launch.args);
  for (const token of cacheArgvOf(all, agentId)) {
    if (token.startsWith("-") && args.includes(token)) break;
    args.push(token);
  }
  if (config.where === "wsl") {
    return wslLaunch({
      program: launch.program,
      args,
      cwd: launch.cwd,
      distro: config.distro,
    });
  }
  if (config.where === "ssh") {
    return sshLaunch({
      program: launch.program,
      args,
      cwd: launch.cwd,
      host: config.sshHost,
      remotePath: config.sshPath,
    });
  }
  return { program: launch.program, args };
}

// ---------------------------------------------------------------------------
// the conversation cache
// ---------------------------------------------------------------------------

/** One cache choice, as it is offered and as it reaches the process. */
export interface CacheChoice {
  value: AgentCache;
  label: string;
  /** What the row explains under the picker. */
  hint: string;
  /** Environment of the process — empty when this CLI takes flags instead. */
  env: [string, string][];
  /** Command line of the process — empty when this CLI reads the environment. */
  args: string[];
}

/**
 * The cache lifetimes each CLI really exposes, keyed by the catalog id.
 *
 * Same discipline as the permission flags: what is written here was read in
 * the CLI's own documentation, and being absent is a real answer. Claude Code
 * documents these three environment variables; for every other agent in the
 * catalog we have nothing verified, so they get no control at all instead of a
 * variable invented here that the process would silently ignore.
 */
const CACHE_CHOICES: Record<string, readonly CacheChoice[]> = {
  claude: [
    {
      value: "",
      label: "Automático",
      hint: "1 h na assinatura, 5 min na chave de API — o que a própria CLI escolhe",
      env: [],
      args: [],
    },
    {
      value: "1h",
      label: "1 hora",
      hint: "ENABLE_PROMPT_CACHING_1H — a retomada depois de uma pausa longa continua barata; escrever no cache custa mais",
      env: [["ENABLE_PROMPT_CACHING_1H", "1"]],
      args: [],
    },
    {
      value: "5m",
      label: "5 minutos",
      hint: "FORCE_PROMPT_CACHING_5M — o TTL curto e mais barato de escrever, mesmo na assinatura",
      env: [["FORCE_PROMPT_CACHING_5M", "1"]],
      args: [],
    },
    {
      value: "off",
      label: "Desligado",
      hint: "DISABLE_PROMPT_CACHING — reprocessa a conversa inteira a cada turno; serve para depurar, e sai caro",
      env: [["DISABLE_PROMPT_CACHING", "1"]],
      args: [],
    },
  ],
  // Aider is the other side of the coin: its caching is **off** until asked,
  // and it is asked with flags. `--cache-keepalive-pings N` keeps the prefix
  // warm for N×5 min, which is how "one hour" is spelled here.
  aider: [
    {
      value: "",
      label: "Automático",
      hint: "o aider não usa cache a não ser que você peça — este é o padrão dele",
      env: [],
      args: [],
    },
    {
      value: "1h",
      label: "1 hora",
      hint: "--cache-prompts --cache-keepalive-pings 12 — doze pings de 5 min mantêm o prefixo quente por ~1 h",
      env: [],
      args: ["--cache-prompts", "--cache-keepalive-pings", "12"],
    },
    {
      value: "5m",
      label: "5 minutos",
      hint: "--cache-prompts — liga o cache e deixa expirar nos 5 min do provedor",
      env: [],
      args: ["--cache-prompts"],
    },
    {
      value: "off",
      label: "Desligado",
      hint: "sem --cache-prompts: cada turno reprocessa a conversa inteira",
      env: [],
      args: [],
    },
  ],
};

/**
 * Why a CLI has no cache control, for the line where the picker would be.
 *
 * "Não tem" is an answer the screen owes the user. The alternative is a
 * setting that appears for one agent and silently vanishes for the others,
 * which reads as a bug in Yard rather than as a fact about the CLI.
 */
const CACHE_NOTES: Record<string, string> = {
  codex:
    "o Codex faz cache sozinho, automático a partir de ~1.024 tokens, e não expõe ajuste de duração",
};

const CACHE_NOTE_UNKNOWN =
  "não achamos um ajuste de cache documentado nesta CLI — se ela ganhar um, ele aparece aqui";

/** The sentence to show when there is no picker; empty when there is one. */
export function cacheNoteOf(agentId: string): string {
  if (CACHE_CHOICES[agentId]) return "";
  return CACHE_NOTES[agentId] ?? CACHE_NOTE_UNKNOWN;
}

/** The choices this CLI offers, or null when it exposes none we can verify. */
export function cacheChoicesOf(agentId: string): readonly CacheChoice[] | null {
  return CACHE_CHOICES[agentId] ?? null;
}

/**
 * The environment a card is spawned with, for the cache choice it carries.
 *
 * Read at launch, like every environment variable: changing the setting
 * reaches a CLI that is already up only when it is restarted, which is what
 * the row in Settings says.
 */
function cacheChoiceOf(
  all: AgentDefaults,
  agentId: string | null | undefined,
): CacheChoice | null {
  if (!agentId) return null;
  return (
    cacheChoicesOf(agentId)?.find((c) => c.value === configOf(all, agentId).cache) ??
    null
  );
}

export function cacheEnvOf(
  all: AgentDefaults,
  agentId: string | null | undefined,
): [string, string][] {
  return (cacheChoiceOf(all, agentId)?.env ?? []).map(([k, v]) => [k, v]);
}

/** The flags of the cache choice, for the CLIs that take flags instead. */
export function cacheArgvOf(
  all: AgentDefaults,
  agentId: string | null | undefined,
): string[] {
  return [...(cacheChoiceOf(all, agentId)?.args ?? [])];
}

// ---------------------------------------------------------------------------
// what "Nova aba" shows
// ---------------------------------------------------------------------------

/**
 * The agents a picker offers.
 *
 * Turning one off is not uninstalling it: the row stays in Settings, the
 * fixed line stays, and `yard recruit --agent x` still finds it by name. This
 * is about the grid of marks — with nine CLIs detected, the two you actually
 * use are a scan away from the seven you do not.
 */
export function pickableAgents<T extends { id: string }>(
  agents: readonly T[],
  all: AgentDefaults,
): T[] {
  return agents.filter((a) => !configOf(all, a.id).hidden);
}

/** What a mark in "Nova aba" brings with it: its fixed line and its flag. */
export interface ChoiceArgs {
  fixed: string;
  /** The CLI's "skip the prompts" flag, when it has one. */
  skip: SkipFlag | null;
}

/**
 * Whether what is in the field is the *user's* writing, rather than the line
 * the setting put there.
 *
 * "Nova aba" asks before discarding a filled-in field. Now that the field
 * opens pre-filled, without this the dialog would ask that question on every
 * close — for text nobody typed.
 */
export function isArgsTouched(current: string, fixed: string): boolean {
  return current.trim() !== "" && current !== fixed;
}

/**
 * The text of "Argumentos extras" when the chosen mark changes.
 *
 * Two things have to be true at once. A field nobody touched belongs to the
 * choice, and follows it — switching from Claude to Codex has to show Codex's
 * line, not Claude's. A field that *was* typed in belongs to the user and is
 * kept — but the permission flag inside it is re-spelled, or Codex would be
 * born carrying Claude's flag and die on an unknown option before printing a
 * thing.
 */
export function argsForChoice(
  current: string,
  previous: ChoiceArgs | null,
  next: ChoiceArgs,
): string {
  if (!isArgsTouched(current, previous?.fixed ?? "")) return next.fixed;
  if (!previous?.skip || previous.skip === next.skip) return current;
  const stripped = withFlag(current, previous.skip.args, false);
  if (stripped === current) return current;
  return next.skip ? withFlag(stripped, next.skip.args, true) : stripped;
}

/** One agent's row in Settings › Agentes. */
export interface AgentDefaultRow {
  id: string;
  name: string;
  installed: boolean;
  /** Version or path, as the detector reported it; empty when it has none. */
  detail: string;
  skip: SkipFlag | null;
  /** What is configured today — the defaults when nothing is. */
  config: AgentConfig;
}

/**
 * The agent whose panel is open: the one picked, or — when that id is gone
 * (detection changed, the CLI was uninstalled) — the first that can run.
 * Falling back beats a panel with nothing in it.
 */
export function pickAgentTab(
  rows: readonly AgentDefaultRow[],
  selected: string | null | undefined,
): AgentDefaultRow | null {
  return (
    rows.find((r) => r.id === selected) ??
    rows.find((r) => r.installed) ??
    rows[0] ??
    null
  );
}

/**
 * The list the settings screen renders: what can run first, and — after
 * everything the detector saw — any agent that has something configured but
 * was not detected.
 *
 * That tail matters: a setting goes on being applied by id, so an agent
 * missing from the catalog (detection failed, the binary left the machine)
 * would otherwise have a setting with nowhere to read or erase it.
 */
export function agentDefaultRows(
  agents: readonly AgentInfo[],
  all: AgentDefaults,
): AgentDefaultRow[] {
  const rows: AgentDefaultRow[] = agents.map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    detail: a.installed ? (a.version ?? a.bin ?? "") : "",
    skip: skipFlagOf("agent", a.id),
    config: configOf(all, a.id),
  }));
  const seen = new Set(rows.map((r) => r.id));
  const orphans: AgentDefaultRow[] = Object.entries(all)
    .filter(([id]) => !seen.has(id))
    .map(([id, config]) => ({
      id,
      name: id,
      installed: false,
      detail: "",
      skip: skipFlagOf("agent", id),
      config,
    }));
  return [
    ...rows.filter((r) => r.installed),
    ...rows.filter((r) => !r.installed),
    ...orphans,
  ];
}
