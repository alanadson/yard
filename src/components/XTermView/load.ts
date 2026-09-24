/**
 * The terminal view's chunk (xterm.js, its addons and the attach logic), as
 * one promise for the whole app.
 *
 * `TerminalPane` renders it through `lazy()`, which only asked for the chunk
 * on the first render of a pane, after the "carregando workspace" screen had
 * gone: the download started exactly when the user was already waiting for
 * it. `App` calls this at the start of the boot so the download overlaps the
 * workspace load, and `lazy()` takes the same promise, so the chunk is
 * requested once.
 */
let chunk: Promise<typeof import("./index")> | null = null;

export function loadXTermView(): Promise<typeof import("./index")> {
  return (chunk ??= import("./index"));
}
