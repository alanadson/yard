/**
 * What a CLI's own hook tells the app. Claude Code posts JSON on stdin with
 * the event's name; Codex hands its notification as the last argument. Both
 * become one small vocabulary the runtime mirror understands, and anything
 * else is refused rather than guessed, because a hook that lies paints a
 * badge that lies.
 */
import { describe, expect, it } from "vitest";

import { CLAUDE_HOOK_SETTINGS, parseHookEvent } from "./hookEvents";

describe("parseHookEvent", () => {
  it("reads Claude Code's events from stdin", () => {
    expect(parseHookEvent(["prompt"], '{"session_id":"s1","hook_event_name":"UserPromptSubmit"}')).toEqual({
      kind: "turn-start",
      sessionId: "s1",
    });
    expect(parseHookEvent(["stop"], '{"session_id":"s1","hook_event_name":"Stop"}')).toEqual({
      kind: "turn-end",
      sessionId: "s1",
    });
    expect(
      parseHookEvent(["permission"], '{"session_id":"s1","message":"Claude needs your permission to use Bash"}'),
    ).toEqual({ kind: "permission", sessionId: "s1", ask: "Claude needs your permission to use Bash" });
    expect(parseHookEvent(["tool"], '{"session_id":"s1"}')).toEqual({ kind: "working", sessionId: "s1" });
    expect(parseHookEvent(["session"], '{"session_id":"s1"}')).toEqual({ kind: "session", sessionId: "s1" });
  });

  it("a permission with no message still says what it is", () => {
    expect(parseHookEvent(["permission"], "{}")).toEqual({ kind: "permission", ask: "" });
  });

  it("reads Codex's turn-complete notification from the argument", () => {
    const json = JSON.stringify({ type: "agent-turn-complete", "turn-id": "t9", "last-assistant-message": "done" });
    expect(parseHookEvent(["codex", json], undefined)).toEqual({ kind: "turn-end" });
    expect(parseHookEvent(["codex", JSON.stringify({ type: "something-else" })], undefined)).toBeNull();
  });

  it("refuses an unknown event, junk JSON and a missing name", () => {
    expect(parseHookEvent(["dance"], "{}")).toBeNull();
    expect(parseHookEvent(["stop"], "{not json")).toEqual({ kind: "turn-end" });
    expect(parseHookEvent([], undefined)).toBeNull();
  });
});

describe("the settings file handed to Claude Code", () => {
  it("wires every event to the yard shim, reading stdin", () => {
    const hooks = CLAUDE_HOOK_SETTINGS.hooks as unknown as Record<string, { hooks: { command: string }[] }[]>;
    for (const name of ["UserPromptSubmit", "Stop", "Notification", "PostToolUse", "SessionStart"]) {
      const cmd = hooks[name][0].hooks[0].command;
      expect(cmd).toMatch(/^yard hook \w+ --stdin$/);
    }
    expect(JSON.parse(JSON.stringify(CLAUDE_HOOK_SETTINGS))).toEqual(CLAUDE_HOOK_SETTINGS);
  });
});
