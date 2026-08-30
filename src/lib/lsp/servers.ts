/**
 * The catalog side of language servers: which LSP language a file is, which
 * installed server takes it, and the `file:///C:/…` URIs a server expects.
 *
 * The catalog itself (programs, arguments, install lines) lives in
 * `src-tauri/src/lsp.rs` and arrives through `ipc.lspDetect`; this module
 * only reads it. The extension → language-id table is separate from the
 * editor's `languages.ts` on purpose: that one picks a CodeMirror grammar
 * (and knows fifty languages), this one names what a server would accept
 * (and knows the seven the catalog serves).
 */
import type { LspServerInfo } from "../ipc";

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "jsonc",
};

/** The LSP language id of a path, or `null` when no server in the catalog takes it. */
export function languageIdFor(path: string): string | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The installed server that lists the language, or `null`. */
export function serverFor(
  languageId: string,
  detected: readonly LspServerInfo[],
): LspServerInfo | null {
  return detected.find((s) => s.found && s.languageIds.includes(languageId)) ?? null;
}

/** Forward slashes, no trailing slash. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Only a drive letter makes a path absolute here: on Windows a leading `/`
 * is not a place (`/src/x.rs` is what a tool prints for a project-relative
 * path), so it is taken as relative to the root.
 */
function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p);
}

/** One path segment, encoded the way a URI wants it; a drive letter stays `C:`. */
function encodeSegment(segment: string, first: boolean): string {
  if (first && /^[a-zA-Z]:$/.test(segment)) return segment;
  return encodeURIComponent(segment);
}

function toFileUri(absolute: string): string {
  const clean = absolute.replace(/^\/+/, "");
  const parts = clean.split("/").filter((s) => s.length > 0);
  return "file:///" + parts.map((s, i) => encodeSegment(s, i === 0)).join("/");
}

/** `file:///C:/…` for a project root. */
export function rootUri(root: string): string {
  return toFileUri(normalizePath(root));
}

/** `file:///C:/…` for a file — `path` relative to `root`, or absolute on its own. */
export function fileUri(root: string, path: string): string {
  const p = normalizePath(path);
  if (isAbsolute(p)) return toFileUri(p);
  return toFileUri(normalizePath(root) + "/" + p.replace(/^\/+/, ""));
}

/** One client per (root, server): the same root spelled differently is the same root. */
export function clientKey(root: string, program: string): string {
  return `${normalizePath(root).toLowerCase()}::${program}`;
}

// ---------------------------------------------------------------------------
// how long to wait
// ---------------------------------------------------------------------------

/**
 * Servers that read the whole project before answering anything. On a cold
 * `target/`, a fresh venv or a module cache that has to be built, the *first*
 * request can take half a minute, and until it lands, `F12` does nothing at
 * all. A short budget here does not protect the editor, it just makes the
 * feature look broken exactly when it is doing the most work.
 */
const INDEXERS = new Set([
  "rust-analyzer",
  "pyright-langserver",
  "gopls",
  "typescript-language-server",
]);

/** Generous, for a server that is still reading the project. */
export const INDEXER_TIMEOUT_MS = 30_000;

/**
 * Short, for a server that answers from the open file alone. Nothing here
 * has anything to index, so slow means wedged, and a wedged server must not
 * be able to hang the editor.
 */
export const FILE_TIMEOUT_MS = 8_000;

/** The bare program name: the catalog hands over whatever `which` found. */
function programName(program: string): string {
  const base = program.replace(/\\/g, "/").split("/").pop() ?? program;
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, "");
}

/** How long a request to `program` may take before the client gives up. */
export function requestTimeoutMs(program: string): number {
  return INDEXERS.has(programName(program)) ? INDEXER_TIMEOUT_MS : FILE_TIMEOUT_MS;
}
