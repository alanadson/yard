/**
 * Where a Ctrl+click on a link in the terminal ends up.
 *
 * Two halves. `resolveTarget` and `planOpen` are the decision — pure, tested:
 * which root and which relative path a printed `src/x.ts:12` means, and which
 * surface answers (editor tab, portal, browser tab, the system). `openTermLink`
 * is the effect that carries the plan out against the stores.
 *
 * The path half exists because a process prints paths relative to **its own**
 * folder, not to the project: `cargo` running inside `src-tauri/` says
 * `src/pty/mod.rs`, and the file is `src-tauri/src/pty/mod.rs` from the
 * root. And the editor only reads inside a root (`explorer::resolve` refuses
 * `..` and drive letters), so an absolute path outside every root cannot
 * become a tab — it goes to the system's default application instead, the
 * same door `openLink.ts` uses for files.
 */
import { t } from "./i18n";
import { ipc } from "./ipc";
import { uiLog } from "./log";
import { spawnPortalNear } from "./portalSpawn";
import { rootKey, sameRoot } from "./roots";
import { normalizeSurface, type Surface } from "./surface";
import type { LinkMatch } from "./termLinks";
import { useBrowsers } from "../stores/browsersStore";
import { useEditor } from "../stores/editorStore";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

export type LinkTarget =
  | { kind: "url"; url: string }
  /** A file under `root`, as the editor addresses it: relative, `/`-separated. */
  | { kind: "file"; root: string; path: string; line?: number; col?: number }
  /** An absolute path outside every root — only the system can open it. */
  | { kind: "external"; path: string };

export interface LinkContext {
  /** The folder the process was started in (a shell that `cd`s is not tracked). */
  cwd: string;
  /** The project or worktree root of the terminal's group; `null` on a board. */
  root: string | null;
}

const DRIVE = /^[A-Za-z]:[\\/]/;
/** `/c/Users/…`: how Git Bash and MSYS spell `C:\Users\…`. */
const MSYS_DRIVE = /^\/([A-Za-z])\//;

/**
 * The absolute, `/`-separated form of a printed path, or `null` when it
 * cannot be placed on this machine — a POSIX absolute path (`/home/x`) is a
 * WSL location the app has no distro for.
 */
function absolutize(printed: string, cwd: string): string | null {
  let abs: string;
  if (DRIVE.test(printed) || printed.startsWith("\\\\")) abs = printed;
  else if (MSYS_DRIVE.test(printed)) {
    abs = printed.replace(MSYS_DRIVE, (_, d: string) => `${d.toUpperCase()}:/`);
  } else if (printed.startsWith("/")) return null;
  else abs = `${cwd.replace(/[\\/]+$/, "")}/${printed}`;

  const parts = abs.replaceAll("\\", "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || (part === "" && out.length > 0)) continue;
    if (part === "..") {
      // Never climb past the drive.
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** The pure decision: what a matched link points at, given where it was printed. */
export function resolveTarget(match: LinkMatch, ctx: LinkContext): LinkTarget | null {
  if (match.kind === "url") return match.url ? { kind: "url", url: match.url } : null;
  if (!match.path) return null;
  const abs = absolutize(match.path, ctx.cwd);
  if (!abs) return null;

  if (ctx.root) {
    const key = rootKey(ctx.root);
    const lower = abs.toLocaleLowerCase("en-US");
    if (lower === key) return null;
    if (lower.startsWith(`${key}/`)) {
      const target: LinkTarget = { kind: "file", root: ctx.root, path: abs.slice(key.length + 1) };
      if (match.line !== undefined) target.line = match.line;
      if (match.col !== undefined) target.col = match.col;
      return target;
    }
  }
  return { kind: "external", path: abs.replaceAll("/", "\\") };
}

export type PlannedOpen =
  | { op: "portal"; groupId: string; terminalId: string; url: string }
  | { op: "browser"; groupId: string; slot: number; url: string }
  | { op: "editor"; root: string; path: string; line?: number }
  | { op: "external"; path: string };

/**
 * Which surface answers a target, given the terminal it was clicked in.
 *
 * An address opens where the terminal lives: beside a canvas card it is a
 * portal wired to that card (the same object the globe creates, so the
 * agent can already drive it); beside a pane tab it is a browser tab of the
 * same pane. A file is always an editor tab at the line.
 */
export function planOpen(
  target: LinkTarget,
  term: { id: string; groupId: string; slot: number; surface: Surface },
): PlannedOpen {
  switch (target.kind) {
    case "url":
      return term.surface === "canvas"
        ? { op: "portal", groupId: term.groupId, terminalId: term.id, url: target.url }
        : { op: "browser", groupId: term.groupId, slot: term.slot, url: target.url };
    case "file": {
      const plan: PlannedOpen = { op: "editor", root: target.root, path: target.path };
      if (target.line !== undefined) plan.line = target.line;
      return plan;
    }
    case "external":
      return { op: "external", path: target.path };
  }
}

const fail = (what: string, e: unknown) =>
  useUI.getState().showToast(t("Não consegui abrir {what}: {e}", { what, e: String(e) }), "error");

/** The effect: a Ctrl+click on `match` inside terminal `terminalId`. */
export function openTermLink(terminalId: string, match: LinkMatch): void {
  const projects = useProjects.getState();
  const row = projects.terminal(terminalId);
  if (!row) return;
  const root = projects.rootOfGroup(row.groupId);
  const target = resolveTarget(match, { cwd: row.cwd, root });
  if (!target) {
    useUI.getState().showToast(t("Não sei onde fica {text} nesta máquina.", { text: match.text }));
    return;
  }
  const plan = planOpen(target, {
    id: row.id,
    groupId: row.groupId,
    slot: row.slot,
    surface: normalizeSurface(row.surface),
  });
  uiLog.info(`link no terminal: ${match.text} -> ${plan.op}`);
  switch (plan.op) {
    case "portal":
      void spawnPortalNear({
        groupId: plan.groupId,
        url: plan.url,
        nearTerminalId: plan.terminalId,
      }).catch((e) => fail(t("o portal"), e));
      return;
    case "browser":
      useBrowsers.getState().open({ groupId: plan.groupId, slot: plan.slot, url: plan.url });
      return;
    case "editor": {
      const editor = useEditor.getState();
      // The editor's tree follows the active group; a click on a terminal of
      // another root (a floor's card seen from the ground) turns it first, the
      // same way the App does when the group changes.
      if (!sameRoot(editor.root, plan.root)) {
        editor.setRoot(projects.projectOfGroup(row.groupId)?.id ?? null, plan.root);
      }
      const open =
        plan.line !== undefined
          ? useEditor.getState().openFileAt(plan.path, plan.line)
          : useEditor.getState().openFile(plan.path);
      void open.catch((e) => fail(plan.path, e));
      return;
    }
    case "external":
      void ipc.openExternal(plan.path).catch((e) => fail(plan.path, e));
      return;
  }
}
