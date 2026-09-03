/**
 * What a CLI's own hook tells the app about its turn.
 *
 * Silence says *that* an agent stopped and the tail of its output says why;
 * both are guesses. The CLIs that have hooks say it themselves: a prompt
 * was submitted, a turn ended, a permission is being asked, a tool ran.
 * Yard hands Claude Code a settings file whose hooks call `yard hook …`
 * (`--settings`, so nothing is written into anybody's home), and Codex a
 * `notify` program on the command line. This module turns what they post
 * into one small vocabulary; `bridge.ts` applies it to the runtime mirror.
 *
 * Only what each CLI documents is read. A shape this file does not know is
 * refused (`null`), never guessed at: a badge that lies is worse than none.
 */

export type HookEvent =
  | { kind: "turn-start"; sessionId?: string }
  | { kind: "turn-end"; sessionId?: string }
  | { kind: "permission"; sessionId?: string; ask: string }
  | { kind: "working"; sessionId?: string }
  | { kind: "session"; sessionId?: string };

/**
 * The settings Claude Code is launched with (`--settings <file>`). Every
 * hook is the same shim, told which event it carries, reading the JSON
 * Claude Code posts on stdin. `PostToolUse` is the "still working" edge: a
 * permission that was granted shows up as the tool running.
 */
export const CLAUDE_HOOK_SETTINGS = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "yard hook prompt --stdin" }] }],
    Stop: [{ hooks: [{ type: "command", command: "yard hook stop --stdin" }] }],
    Notification: [
      {
        matcher: "permission_prompt",
        hooks: [{ type: "command", command: "yard hook permission --stdin" }],
      },
    ],
    PostToolUse: [{ hooks: [{ type: "command", command: "yard hook tool --stdin" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "yard hook session --stdin" }] }],
  },
} as const;

function parseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sessionOf(body: Record<string, unknown>): { sessionId?: string } {
  const id = body.session_id;
  return typeof id === "string" && id.trim() ? { sessionId: id.trim() } : {};
}

/**
 * `argv` is what follows `yard hook`; `stdin` is what Claude Code posted.
 * Codex carries its notification as the argument after `codex`.
 */
export function parseHookEvent(argv: readonly string[], stdin: string | null | undefined): HookEvent | null {
  const verb = (argv[0] ?? "").toLowerCase();
  if (!verb) return null;
  if (verb === "codex") {
    const body = parseJson(argv[1]);
    return body.type === "agent-turn-complete" ? { kind: "turn-end" } : null;
  }
  const body = parseJson(stdin);
  const session = sessionOf(body);
  switch (verb) {
    case "prompt":
      return { kind: "turn-start", ...session };
    case "stop":
      return { kind: "turn-end", ...session };
    case "permission":
      return {
        kind: "permission",
        ...session,
        ask: typeof body.message === "string" ? body.message.trim() : "",
      };
    case "tool":
      return { kind: "working", ...session };
    case "session":
      return { kind: "session", ...session };
    default:
      return null;
  }
}
