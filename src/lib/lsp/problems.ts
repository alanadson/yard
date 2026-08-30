/**
 * Every problem a language server knows about, for the whole project.
 *
 * Diagnostics were already reaching the editor, but only as squiggles inside
 * a document that happened to be open, so the answer to "is this branch
 * clean?" was "open the forty files and look". Servers never worked that way:
 * `textDocument/publishDiagnostics` arrives for whatever the server has
 * compiled, open or not, and that half of the feed was being dropped.
 *
 * Two properties shape everything here.
 *
 * The feed is **authoritative per file**. A notification carrying an empty
 * list is the server saying "this file is clean now", not "nothing to add",
 * reading it the second way leaves an error the user already fixed on the
 * panel until the app restarts.
 *
 * And it comes from a foreign process, so nothing is assumed. A diagnostic
 * with no range is skipped; one with no severity is an error, because the
 * safe reading of "something is wrong and I did not say how badly" is not
 * "hint".
 */

/** Errors, warnings, everything else, the three the panel groups by. */
export type Severity = 1 | 2 | 3 | 4;

export interface Problem {
  /** Relative to the project root, or absolute when it lives outside it. */
  path: string;
  /** The project this file was reported under, how a closed project is dropped. */
  root: string;
  /** 1-based, the way a person reads a file. */
  line: number;
  column: number;
  severity: Severity;
  message: string;
  /** Who said so (`ts`, `rustc`, `eslint`), servers relay other tools. */
  source?: string;
}

interface FileProblems {
  root: string;
  path: string;
  problems: Problem[];
  /**
   * The entries exactly as the server sent them. A quick fix is looked up by
   * the diagnostic itself, `tsserver` finds its fixes by the error code,
   * and the normalised `Problem` above has thrown that code away.
   */
  raw: unknown[];
}

/** Everything on the panel, by document uri. */
export type ProblemsState = Readonly<Record<string, FileProblems>>;

export const NO_PROBLEMS: ProblemsState = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `file:///C:/a/b.ts` back to `C:/a/b.ts`. */
function pathFromUri(uri: string): string {
  const bare = uri.replace(/^file:\/\/\//, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/** The path as the panel shows it: relative to the project when it is inside it. */
export function displayPath(root: string, uri: string): string {
  const full = pathFromUri(uri).replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  // Case-insensitively, because one server answers `c:/` and another `C:/`
  // for the same disk.
  if (full.toLowerCase().startsWith(base.toLowerCase() + "/")) {
    return full.slice(base.length + 1);
  }
  return full;
}

function readSeverity(value: unknown): Severity {
  return value === 2 || value === 3 || value === 4 ? value : 1;
}

/**
 * A `publishDiagnostics` notification. Replaces everything known about that
 * file, see the note on authority above.
 */
export function receive(
  state: ProblemsState,
  root: string,
  uri: string,
  diagnostics: unknown,
): ProblemsState {
  const path = displayPath(root, uri);
  const problems: Problem[] = [];
  if (Array.isArray(diagnostics)) {
    for (const entry of diagnostics) {
      if (!isRecord(entry)) continue;
      const range = entry.range;
      if (!isRecord(range) || !isRecord(range.start)) continue;
      const start = range.start as { line?: unknown; character?: unknown };
      if (!Number.isInteger(start.line)) continue;
      problems.push({
        path,
        root,
        line: (start.line as number) + 1,
        column: Number.isInteger(start.character) ? (start.character as number) + 1 : 1,
        severity: readSeverity(entry.severity),
        message: typeof entry.message === "string" ? entry.message : "",
        ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      });
    }
  }
  const next = { ...state };
  if (problems.length === 0) delete next[uri];
  else next[uri] = { root, path, problems, raw: Array.isArray(diagnostics) ? diagnostics : [] };
  return next;
}

/** The servers of `root` are gone; so are the problems they reported. */
export function dropRoot(state: ProblemsState, root: string): ProblemsState {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const next: Record<string, FileProblems> = {};
  for (const [uri, file] of Object.entries(state)) {
    const owner = file.root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (owner !== base) next[uri] = file;
  }
  return next;
}

/**
 * The panel's rows: worst first, then by file, then down the file. Severity
 * leads because the question the panel answers is "what is broken", and a
 * hundred hints must never bury the one error.
 */
export function problemRows(state: ProblemsState): Problem[] {
  const rows: Problem[] = [];
  for (const file of Object.values(state)) rows.push(...file.problems);
  return rows.sort(
    (a, b) =>
      a.severity - b.severity ||
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

/** The two numbers a status line can carry, plus the rest. */
export function countBySeverity(state: ProblemsState): {
  errors: number;
  warnings: number;
  other: number;
} {
  let errors = 0;
  let warnings = 0;
  let other = 0;
  for (const file of Object.values(state)) {
    for (const problem of file.problems) {
      if (problem.severity === 1) errors++;
      else if (problem.severity === 2) warnings++;
      else other++;
    }
  }
  return { errors, warnings, other };
}

export interface ProblemGroup {
  path: string;
  /** The most severe thing in this file, what ranks it against the others. */
  worst: Severity;
  rows: Problem[];
}

/**
 * The panel's shape: one section per file, worst file first, and inside a
 * file read top to bottom, between files the reader wants the broken one,
 * inside one they want to walk down it.
 *
 * `errorsOnly` is the narrowing that makes the panel usable on a project with
 * four hundred lint hints and one type error.
 */
export function problemGroups(
  state: ProblemsState,
  errorsOnly = false,
): ProblemGroup[] {
  const groups = new Map<string, Problem[]>();
  for (const file of Object.values(state)) {
    const rows = errorsOnly
      ? file.problems.filter((p) => p.severity === 1)
      : file.problems;
    if (rows.length === 0) continue;
    const had = groups.get(file.path);
    if (had) had.push(...rows);
    else groups.set(file.path, [...rows]);
  }
  return [...groups.entries()]
    .map(([path, rows]) => ({
      path,
      worst: rows.reduce<Severity>((w, p) => (p.severity < w ? p.severity : w), 4),
      rows: rows.sort((a, b) => a.line - b.line || a.column - b.column),
    }))
    // Path breaks the tie so the list does not shuffle under the reader as
    // servers republish.
    .sort((a, b) => a.worst - b.worst || a.path.localeCompare(b.path));
}

/**
 * The untouched diagnostics covering a 0-based line, what
 * `textDocument/codeAction` has to be handed for a server to find a fix.
 */
export function diagnosticsAt(
  state: ProblemsState,
  uri: string,
  line: number,
): unknown[] {
  let file: FileProblems | undefined;
  for (const [key, value] of Object.entries(state)) {
    if (key.toLowerCase() === uri.toLowerCase()) {
      file = value;
      break;
    }
  }
  if (!file) return [];
  return file.raw.filter((entry) => {
    if (!isRecord(entry) || !isRecord(entry.range)) return false;
    const start = entry.range.start;
    const end = entry.range.end;
    if (!isRecord(start) || !Number.isInteger(start.line)) return false;
    const from = start.line as number;
    const to = isRecord(end) && Number.isInteger(end.line) ? (end.line as number) : from;
    return line >= from && line <= to;
  });
}
