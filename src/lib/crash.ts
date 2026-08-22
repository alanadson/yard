/**
 * What is left of a component that crashed: a readable message and a place.
 *
 * A `throw` can be anything in JavaScript — `Error`, string, object,
 * `undefined` — and the lazy path (`error.message`) turns half of those cases
 * into `undefined` on screen and `[object Object]` in the log. Here every
 * thrown thing becomes text before it leaves.
 */

export interface Crash {
  /** In the user's voice: "este painel", "o Yard". Goes on screen and in the log. */
  where: string;
  message: string;
  stack: string | null;
}

/** Readable text for anything somebody threw. */
function theText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // Cycles, getters that blow up: falls through to the String() below.
  }
  return String(error);
}

export function crashOf(error: unknown, where: string): Crash {
  return {
    where,
    message: theText(error),
    stack: error instanceof Error && error.stack ? error.stack : null,
  };
}

/**
 * The line that goes to `yard.log`. The place comes first because it is what
 * the minified stack does not give: with six panes on screen, knowing which
 * one fell is half the diagnosis.
 */
export function crashLine(crash: Crash): string {
  const head = `quebrou em ${crash.where}: ${crash.message}`;
  return crash.stack ? `${head}\n${crash.stack}` : head;
}
