/**
 * What a terminal is *called*, in one place.
 *
 * This is not cosmetic. The same string is the label on the tab, the row in
 * the sidebar, the title of the canvas card — and the address that
 * `yard ask "Nome"` accepts from an agent. Nine call sites used to derive it
 * inline, each with its own fallback ("CLI" here, "terminal" there,
 * "agente" in the live overlay), so the same process answered to different
 * names depending on where you were looking at it.
 */
import type { TerminalRow } from "./ipc";

/** Last path segment of the program, on either slash. */
export function programName(program: string): string {
  return program.split(/[\\/]/).pop() || "";
}

/**
 * Display name of a terminal: the user's title, else the program's file name.
 *
 * Accepts a partial row so the callers that only hold `{ title, program }`
 * (the live overlay, a score being serialized) go through here too.
 */
export function baseName(t: Pick<TerminalRow, "title" | "program">): string {
  return t.title || programName(t.program) || "terminal";
}
