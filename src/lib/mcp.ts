/**
 * The MCP manager's rules — everything the Settings section decides before
 * it touches a file.
 *
 * The files belong to the CLIs (`~/.claude.json`, `~/.codex/config.toml`…)
 * and are read at their next start; a bad entry does not fail here, it fails
 * there, silently. So the form validates with the same strictness the CLIs
 * apply, the env block has one spelling, and copying an entry between CLIs
 * says out loud what the target cannot express. The backend (`mcp.rs`) owns
 * the dialects; this side owns the neutral model and the screen's order.
 */
import { locale, t } from "./i18n";
import type { AgentInfo, McpRow, McpSecrets, McpServer } from "./ipc";
import { quoteArgs, tokenizeArgs } from "./termArgs";

export type { McpRow, McpSecrets, McpServer } from "./ipc";

/** The CLIs whose configuration format the backend verified and knows. */
export const MCP_SUPPORTED = ["claude", "codex", "gemini", "cursor-agent", "opencode"] as const;
export type McpCli = (typeof MCP_SUPPORTED)[number];

export type McpTransport = "stdio" | "http" | "sse";
export type McpScope = "user" | "local" | "project";

/** What the form holds while the user types. */
export interface McpDraft {
  name: string;
  /** `ws` only ever comes from an existing Claude Code entry. */
  transport: McpTransport | "ws";
  command: string;
  argsText: string;
  url: string;
  /** One `KEY=value` per line. */
  envText: string;
  headersText: string;
  enabled: boolean;
}

export type McpValidation =
  | { ok: true; server: McpServer }
  | { ok: false; errors: Partial<Record<keyof McpDraft, string>> };

export type EnvLines =
  | { ok: true; map: Record<string, string> }
  | { ok: false; line: number; error: string };

/** A JSON key and a TOML table name at once: letters, digits, `-`, `_`, `.`. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Parses the env/headers block: `KEY=value`, one per line, blanks skipped. */
export function fromEnvLines(text: string): EnvLines {
  const map: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) {
      return { ok: false, line: i + 1, error: t('linha {n}: "{raw}" não tem o formato CHAVE=valor', { n: i + 1, raw }) };
    }
    const key = raw.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      return { ok: false, line: i + 1, error: t('linha {n}: "{key}" não é um nome de variável', { n: i + 1, key }) };
    }
    map[key] = raw.slice(eq + 1);
  }
  return { ok: true, map };
}

export function toEnvLines(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** The form → the neutral model, or the field-by-field reasons it cannot be. */
export function validateServer(draft: McpDraft): McpValidation {
  const errors: Partial<Record<keyof McpDraft, string>> = {};
  const name = draft.name.trim();
  if (!NAME_RE.test(name)) {
    errors.name = t("Só letras, dígitos, ponto, hífen e sublinhado — e começando com letra ou dígito.");
  }
  const remote = draft.transport !== "stdio";
  const command = draft.command.trim();
  const url = draft.url.trim();
  if (!remote && !command) errors.command = t("Um servidor stdio precisa do comando que o inicia.");
  if (remote && !/^https?:\/\/\S+$/i.test(url)) {
    errors.url = t("Um servidor remoto precisa de um endereço http(s)://.");
  }
  const env = fromEnvLines(draft.envText);
  if (!env.ok) errors.envText = env.error;
  const headers = fromEnvLines(draft.headersText);
  if (!headers.ok) errors.headersText = headers.error;
  if (Object.keys(errors).length || !env.ok || !headers.ok) return { ok: false, errors };
  return {
    ok: true,
    server: {
      name,
      transport: draft.transport,
      command: remote ? null : command,
      args: remote ? [] : tokenizeArgs(draft.argsText),
      url: remote ? url : null,
      env: remote ? {} : env.map,
      headers: remote ? headers.map : {},
      enabled: draft.enabled,
    },
  };
}

/** The form for an existing row, with the values the listing left out. */
export function draftOf(row: McpRow, secrets: McpSecrets): McpDraft {
  return {
    name: row.name,
    transport: (row.transport === "http" || row.transport === "sse" || row.transport === "ws"
      ? row.transport
      : "stdio") as McpDraft["transport"],
    command: row.command ?? "",
    argsText: quoteArgs(row.args),
    url: row.url ?? "",
    envText: toEnvLines(secrets.env),
    headersText: toEnvLines(secrets.headers),
    enabled: row.enabled,
  };
}

export const EMPTY_DRAFT: McpDraft = {
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  url: "",
  envText: "",
  headersText: "",
  enabled: true,
};

/** Which scopes a CLI has a file for — mirrors `config_path` in `mcp.rs`. */
export function scopesFor(cli: string): McpScope[] {
  switch (cli) {
    case "claude":
      return ["user", "local", "project"];
    case "codex":
      return ["user"];
    case "gemini":
    case "cursor-agent":
    case "opencode":
      return ["user", "project"];
    default:
      return [];
  }
}

export function scopeLabel(scope: string): string {
  switch (scope) {
    case "local":
      return "local";
    case "project":
      return t("projeto");
    default:
      return t("usuário");
  }
}

export function scopeHint(scope: McpScope): string {
  switch (scope) {
    case "local":
      return t("só neste projeto, só para você (fica em ~/.claude.json)");
    case "project":
      return t("no arquivo do projeto — vai junto no repositório");
    default:
      return t("em todos os projetos, só nesta máquina");
  }
}

export function transportLabel(transport: string): string {
  switch (transport) {
    case "http":
      return "HTTP";
    case "sse":
      return "SSE";
    case "ws":
      return "WS";
    default:
      return "stdio";
  }
}

export interface CliGroup {
  cli: string;
  name: string;
  installed: boolean;
  /** Whether the backend knows this CLI's format at all. */
  supported: boolean;
  rows: McpRow[];
}

const FALLBACK_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  "cursor-agent": "Cursor",
  opencode: "OpenCode",
};

/**
 * The cards, in the order the screen shows them: supported CLIs first —
 * installed ones before the rest, alphabetical inside each half — and the
 * catalog's unsupported CLIs at the end, flagged, so nobody wonders where
 * theirs went.
 */
export function groupByCli(rows: McpRow[], agents: AgentInfo[]): CliGroup[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const supported: CliGroup[] = MCP_SUPPORTED.map((cli) => ({
    cli,
    name: byId.get(cli)?.name ?? FALLBACK_NAMES[cli] ?? cli,
    installed: byId.get(cli)?.installed ?? false,
    supported: true,
    rows: rows.filter((r) => r.cli === cli),
  }));
  const rank = (g: CliGroup) => (g.installed ? 0 : g.rows.length ? 1 : 2);
  supported.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, locale()));
  const unsupported: CliGroup[] = agents
    .filter((a) => !(MCP_SUPPORTED as readonly string[]).includes(a.id))
    .map((a) => ({ cli: a.id, name: a.name, installed: a.installed, supported: false, rows: [] }))
    .sort((a, b) => a.name.localeCompare(b.name, locale()));
  return [...supported, ...unsupported];
}

export type CopyResult =
  | { ok: true; server: McpServer; note: string | null }
  | { ok: false; reason: string };

/**
 * The same entry for another CLI. The neutral model already is the target's
 * shape; what changes is what the target cannot say — Cursor and Codex have
 * no SSE, and nobody but Claude Code speaks WebSocket.
 */
export function copyTo(server: McpServer, cli: string): CopyResult {
  if (!(MCP_SUPPORTED as readonly string[]).includes(cli)) {
    return { ok: false, reason: t("{cli} ainda não é suportada aqui.", { cli: FALLBACK_NAMES[cli] ?? cli }) };
  }
  if (server.transport === "ws") {
    return {
      ok: false,
      reason: t("Só o Claude Code fala WebSocket; esse servidor não tem forma na CLI de destino."),
    };
  }
  if (server.transport === "sse" && (cli === "cursor-agent" || cli === "codex")) {
    return {
      ok: true,
      server: { ...server, transport: "http" },
      note:
        cli === "codex"
          ? t("O Codex não distingue SSE de HTTP: o endereço vai como url e a CLI decide.")
          : t("O Cursor não distingue SSE de HTTP: o endereço vai como url e a CLI decide."),
    };
  }
  return { ok: true, server, note: null };
}
