/**
 * Roles: the persona a CLI is born with.
 *
 * A role is a name plus a paragraph of instructions. It can be saved under
 * that name — in the group (`--scope current`) or globally — so the same
 * "Revisora de PR" can be handed to the next agent without retyping it, and
 * it can equally be written once, inline, for a single terminal.
 *
 * **How the instructions reach the process** is the part worth reading. The
 * obvious move is to drop a file with the text inside the project and tell the
 * agent to read it; that is what the tool this feature was asked to match
 * does. Yard does not, for two reasons: it writes into a repository the user
 * did not ask us to write into (and then has to ask them to `.gitignore` it),
 * and it depends on the agent choosing to open the file.
 *
 * Instead the text goes in through the CLI's own front door:
 *
 * - a CLI with a flag for it gets the flag (`--append-system-prompt` on Claude
 *   Code), so the role is system-level and survives the whole session;
 * - every other CLI gets a **briefing**: the text is typed into the terminal
 *   as the first message, exactly as the user would have pasted it.
 *
 * Nothing is written to disk either way, and what the agent was told is
 * visible in its own scrollback.
 */
import {
  normalizePresets,
  roleFromText,
  type CanvasData,
  type CardRole,
  type RolePreset,
} from "./canvas";
import { ipc } from "./ipc";

/** Where a saved role lives. Group scope wins over global on a name clash. */
export type RoleScope = "current" | "global";

/** A saved role, flattened for the pickers (the map key becomes `name`). */
export interface SavedRole extends RolePreset {
  name: string;
  scope: RoleScope;
}

/**
 * What a picker hands back: the role itself plus the tint it wants on the
 * card. The color travels beside the role instead of inside it because it is
 * a property of the *card*, and a card can be recolored without the agent's
 * responsibility changing.
 */
export interface RolePick {
  role: CardRole;
  color?: string;
}

/** KV key of the global library. Written as `{ name: text | {text,color} }`. */
export const ROLE_PRESETS_KEY = "rolePresets";

export async function readGlobalRoles(): Promise<Record<string, RolePreset>> {
  try {
    const kv = await ipc.readPrefs();
    return normalizePresets(JSON.parse(kv[ROLE_PRESETS_KEY] ?? "{}")) ?? {};
  } catch {
    // A corrupt blob must not take the picker (or `yard role list`) down: an
    // empty library is a recoverable state, an exception on boot is not.
    return {};
  }
}

/**
 * Kept as a bare string when there is nothing but text, which is the shape
 * every earlier version wrote and the one that stays readable in the KV row.
 */
function toStored(presets: Record<string, RolePreset>): string {
  const out: Record<string, string | RolePreset> = {};
  for (const [name, p] of Object.entries(presets)) {
    out[name] = p.color ? p : p.text;
  }
  return JSON.stringify(out);
}

export async function writeGlobalRole(name: string, preset: RolePreset): Promise<void> {
  const all = await readGlobalRoles();
  all[name.trim()] = preset;
  await ipc.writePref(ROLE_PRESETS_KEY, toStored(all));
}

/** True when the name was there to begin with. */
export async function deleteGlobalRole(name: string): Promise<boolean> {
  const all = await readGlobalRoles();
  if (!(name in all)) return false;
  delete all[name];
  await ipc.writePref(ROLE_PRESETS_KEY, toStored(all));
  return true;
}

export function groupRoles(canvas: CanvasData | undefined): Record<string, RolePreset> {
  return canvas?.rolePresets ?? {};
}

const byName = (a: SavedRole, b: SavedRole) => a.name.localeCompare(b.name, "pt-BR");

/**
 * The whole library, this group's roles before the global ones — the order
 * the picker renders as two labelled sections, so scope never has to be
 * spelled out on each row.
 *
 * A global role with the same name is dropped, not listed twice: the group's
 * copy is the one every lookup finds, so showing both would offer a choice
 * that does not exist.
 */
export function mergeRoles(
  group: Record<string, RolePreset>,
  global: Record<string, RolePreset>,
): SavedRole[] {
  const locals: SavedRole[] = Object.entries(group)
    .map(([name, p]) => ({ ...p, name, scope: "current" as const }))
    .sort(byName);
  const taken = new Set(locals.map((r) => r.name.toLowerCase()));
  const globals: SavedRole[] = Object.entries(global)
    .filter(([name]) => !taken.has(name.toLowerCase()))
    .map(([name, p]) => ({ ...p, name, scope: "global" as const }))
    .sort(byName);
  return [...locals, ...globals];
}

export function findSaved(list: SavedRole[], name: string): SavedRole | undefined {
  const q = name.trim().toLowerCase();
  return list.find((r) => r.name.toLowerCase() === q);
}

/** A saved role as it goes onto a card. */
export function roleOf(saved: SavedRole): CardRole {
  return { name: saved.name, text: saved.text };
}

/**
 * What `yard role set "Agente" "x"` and `recruit --role "x"` receive: either
 * the name of a saved role, or the role's text written out on the spot.
 */
export async function resolveRole(
  canvas: CanvasData | undefined,
  textOrName: string,
): Promise<CardRole | undefined> {
  const saved = findSaved(
    mergeRoles(groupRoles(canvas), await readGlobalRoles()),
    textOrName,
  );
  return saved ? roleOf(saved) : roleFromText(textOrName);
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

/**
 * CLIs that take a system prompt on the command line. One entry each, by the
 * agent id the detector reports — checked against the CLI's own `--help`,
 * because a flag invented here dies in the PTY with a usage error that nothing
 * on screen connects to the role picker.
 */
const SYSTEM_PROMPT_ARGS: Record<string, (text: string) => string[]> = {
  claude: (text) => ["--append-system-prompt", text],
};

export interface RoleLaunch {
  /** Extra argv, when the CLI has a flag for the job. */
  args: string[];
  /** Text to type in after the CLI is up, when it does not. */
  briefing: string | null;
}

export const NO_LAUNCH: RoleLaunch = { args: [], briefing: null };

/**
 * The framing around the instructions. Without it the agent reads a bare
 * paragraph as the first task and starts working on it; with it, it reads a
 * standing rule. The closing line keeps the confirmation turn cheap.
 */
export function briefingFor(role: CardRole): string {
  return (
    `[Yard] Papel deste terminal: "${role.name}".\n\n` +
    `${role.text}\n\n` +
    "Isso vale para toda a sessão. Responda só \"ok\" e espere o próximo pedido."
  );
}

/**
 * Drops one exact argv run from a command line, if it is there.
 *
 * This is how a role is *swapped* on a card that already exists: the flag the
 * previous role added has to come out, or two `--append-system-prompt` would
 * stack and the agent would be told to be two things at once.
 */
export function withoutArgs(args: string[], run: string[]): string[] {
  if (run.length === 0) return args;
  for (let i = 0; i + run.length <= args.length; i++) {
    if (run.every((a, j) => args[i + j] === a)) {
      return [...args.slice(0, i), ...args.slice(i + run.length)];
    }
  }
  return args;
}

export function roleLaunch(
  agentId: string | null | undefined,
  role: CardRole | undefined,
): RoleLaunch {
  // A role with no text is a label the user put on the card — there is
  // nothing to tell the process, and typing its own name at it would be noise.
  if (!role?.text?.trim()) return NO_LAUNCH;
  const flag = agentId ? SYSTEM_PROMPT_ARGS[agentId] : undefined;
  if (flag) return { args: flag(role.text.trim()), briefing: null };
  return { args: [], briefing: briefingFor({ ...role, text: role.text.trim() }) };
}

/** One line for the UI: how this role is going to reach this CLI. */
export function launchHint(agentId: string | null | undefined): string {
  return agentId && SYSTEM_PROMPT_ARGS[agentId]
    ? "As instruções entram no prompt de sistema da CLI, na hora de abrir."
    : "As instruções são enviadas como a primeira mensagem, assim que a CLI subir.";
}

