/**
 * Which product is running in a terminal — the answer the icon draws.
 *
 * `kind` only says "shell" or "agent", and that was all the chrome knew: every
 * agent wore the same robot and every shell the same little screen, so four
 * cards side by side told the user nothing about which CLI was which. The
 * program (or the catalog id it was born from) does know, and it is the same
 * question in six places — tabs, tree, card, picker, sessions, usage strip —
 * so it is answered once, here.
 *
 * Two ways in, because the callers hold different things:
 *
 * - `brandOf` for a terminal that exists (`agentId` when the picker created
 *   it; the program name otherwise, which also covers the ones restored from
 *   the workspace and the ones typed by hand).
 * - `brandById` for a catalog row that is not a terminal yet: an `AgentInfo`,
 *   a `ShellOption`, a usage provider.
 *
 * An id with no mark returns `null` on purpose — that is a real answer
 * ("nothing official to draw"), and the generic Lucide glyph takes over.
 */
import { programName } from "./terminals";

export type BrandId =
  | "powershell"
  | "cmd"
  | "claude"
  | "codex"
  | "openai"
  | "grok"
  | "gemini"
  | "copilot"
  | "cursor"
  | "opencode"
  | "goose"
  | "ollama"
  | "qwen"
  | "deepseek"
  | "bash"
  | "zsh"
  | "fish"
  | "nushell"
  | "ubuntu"
  | "python"
  | "node"
  | "git";

/**
 * Ids from `agents/resolver.rs` (and from the usage strip, which shares the
 * `claude`/`codex`/`grok` names). Aider is missing on purpose: it has no
 * public mark, so it keeps the generic glyph instead of borrowing someone
 * else's logo.
 */
const BY_ID: Record<string, BrandId> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  "cursor-agent": "cursor",
  goose: "goose",
  "gh-copilot": "copilot",
  grok: "grok",
  // shells, by the id `list_shells` gives them
  pwsh: "powershell",
  powershell: "powershell",
  cmd: "cmd",
  bash: "bash",
  sh: "bash",
};

/** By executable name, without the directory and without the extension. */
const BY_PROGRAM: Record<string, BrandId> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  openai: "openai",
  chatgpt: "openai",
  grok: "grok",
  gemini: "gemini",
  copilot: "copilot",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  goose: "goose",
  ollama: "ollama",
  qwen: "qwen",
  "qwen-code": "qwen",
  deepseek: "deepseek",
  pwsh: "powershell",
  powershell: "powershell",
  cmd: "cmd",
  // The Windows console under another name: `wt` is Windows Terminal,
  // `conhost` the host it used to open by itself.
  wt: "cmd",
  conhost: "cmd",
  bash: "bash",
  sh: "bash",
  "git-bash": "bash",
  zsh: "zsh",
  fish: "fish",
  nu: "nushell",
  wsl: "ubuntu",
  ubuntu: "ubuntu",
  python: "python",
  python3: "python",
  py: "python",
  node: "node",
  git: "git",
};

/** `C:\...\npm\claude.cmd` → `claude`. */
function stem(program: string): string {
  return programName(program)
    .toLowerCase()
    .replace(/\.(exe|com|cmd|bat|ps1)$/, "");
}

export function brandById(id: string | null | undefined): BrandId | null {
  if (!id) return null;
  return BY_ID[id] ?? BY_PROGRAM[id] ?? null;
}

/**
 * The catalog id wins over the program: an agent opened by the picker carries
 * `agentId`, and that is the answer even when the binary was resolved to a
 * shim with another name (`cursor-agent` lives in `cursor-agent.cmd`, but
 * `copilot` is the executable of `gh-copilot`).
 */
export function brandOf(t: {
  agentId?: string | null;
  program: string;
}): BrandId | null {
  const byId = t.agentId ? BY_ID[t.agentId] : undefined;
  return byId ?? BY_PROGRAM[stem(t.program)] ?? null;
}
