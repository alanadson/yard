// i18n-scan: tables
/**
 * The project's file tree — the same one that appears in the bench's "Files"
 * tab and in the editor's left rail.
 *
 * Rules that hold in both places:
 * - **lazy**: a directory is only read when it opens (a project with
 *   `node_modules` costs nothing as long as nobody goes in there);
 * - **git does the coloring, everything else is grey**: following the app's
 *   visual contract, the icons are neutral and the only color comes from the
 *   file's git state — modified (yellow), new (green). A directory with a
 *   change inside gets a dot, as in VS Code. The Symbols extension is the
 *   opt-out: with it on, `FileGlyph` draws colored glyphs instead;
 * - **the right-click menu does the disk work**: create, rename, copy path,
 *   reveal in Explorer, delete.
 *
 * Why the list is flattened instead of one component per recursive node: an
 * accessible tree needs things that only exist when you look at siblings and
 * depth from outside — roving tabindex (one Tab stop for the whole tree,
 * arrows navigate inside), `aria-level`/`aria-posinset`/`aria-setsize`, and a
 * filter that can see descendants. The price is a single store subscription
 * instead of one per node; for a list, React handles it.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import { ask } from "../../lib/confirmation";

import { fileTreeMenu } from "../../lib/fileTreeMenu";
import { ContextMenu, type MenuAnchor } from "../ContextMenu";
import { FileGlyph } from "../FileGlyph";
import { InlineRename } from "../ContextMenu/InlineRename";
import { copyText } from "../../lib/clipboard";
import { writeDragPaths } from "../../lib/canvasDrop";
import { joinPath as joinAbsolute } from "../../lib/cardPath";
import { ipc, type DirEntryInfo, type GitFileStatus } from "../../lib/ipc";
import { ancestors, joinPath, parentDir, useEditor } from "../../stores/editorStore";
import { useChanges } from "../../stores/changesStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";
import { failureMessage } from "../../lib/loading";
import { t as tl } from "../../lib/i18n";
import { OFFSCREEN_SKIP, gitMarks, rowMark, skipsOffscreen } from "./rowView";

/** Where a new item is being named (parent directory + kind). */
interface Drafting {
  dir: string;
  isDir: boolean;
}

interface Props {
  onOpen: (path: string) => void;
  activePath?: string | null;
  /** "New file/folder" draft — the panel's owner holds the state, because its
   *  toolbar can open one too. */
  drafting?: Drafting | null;
  onDraftStart?: (dir: string, isDir: boolean) => void;
  onDraftEnd?: () => void;
}

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

/**
 * Paths the filter lets through, or `null` when there is no filter.
 *
 * A node is visible when **it** matches, when **an already loaded descendant**
 * matches (otherwise `stores/editorStore` would be invisible just because
 * `src` does not contain the word), or when it is **inside a directory that
 * matched** — so the found directory stays navigable from within.
 */
export function visiblePaths(
  dirs: Record<string, DirEntryInfo[]>,
  filter: string,
): Set<string> | null {
  const needle = filter.trim().toLowerCase();
  if (!needle) return null;

  const visible = new Set<string>();
  const matchedFolders = new Set<string>();

  for (const entries of Object.values(dirs)) {
    for (const e of entries) {
      if (!e.name.toLowerCase().includes(needle)) continue;
      visible.add(e.path);
      // The whole lineage comes along, otherwise the matched item would have
      // no way of being reached in the tree.
      for (const dir of ancestors(e.path)) visible.add(dir);
      if (e.dir) matchedFolders.add(e.path);
    }
  }

  if (matchedFolders.size > 0) {
    for (const entries of Object.values(dirs)) {
      for (const e of entries) {
        if (visible.has(e.path)) continue;
        if (ancestors(e.path).some((dir) => matchedFolders.has(dir))) {
          visible.add(e.path);
        }
      }
    }
  }

  return visible;
}

// ---------------------------------------------------------------------------
// flattening
// ---------------------------------------------------------------------------

type Row =
  | {
      kind: "entry";
      key: string;
      entry: DirEntryInfo;
      depth: number;
      expanded: boolean;
      posinset: number;
      setsize: number;
    }
  | { kind: "note"; key: string; depth: number; text: string }
  | { kind: "fail"; key: string; depth: number; dir: string; text: string }
  | { kind: "draft"; key: string; depth: number; dir: string; isDir: boolean };

function buildRows(args: {
  dirs: Record<string, DirEntryInfo[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  dirError: Record<string, string>;
  dirDropped: Record<string, number>;
  visible: Set<string> | null;
  drafting: Drafting | null;
}): Row[] {
  const { dirs, expanded, loading, dirError, dirDropped, visible, drafting } = args;
  const out: Row[] = [];

  const walk = (dir: string, depth: number) => {
    if (drafting?.dir === dir) {
      out.push({
        kind: "draft",
        key: `draft:${dir}`,
        depth,
        dir,
        isDir: drafting.isDir,
      });
    }

    // A directory that would not open says so **in place**, at its own depth.
    // These errors were being recorded in the store and rendered nowhere: a
    // folder without read permission just never opened, indistinguishable
    // from one still loading, and a failure at the root replaced the entire
    // tree with a single sentence and no way to retry.
    const err = dirError[dir];
    if (err) {
      out.push({ kind: "fail", key: `fail:${dir}`, depth, dir, text: err });
      return;
    }

    const all = dirs[dir];
    if (!all) {
      if (loading[dir]) {
        out.push({ kind: "note", key: `loading:${dir}`, depth, text: tl("lendo…") });
      }
      return;
    }

    const dropped = dirDropped[dir] ?? 0;
    const entries = visible ? all.filter((e) => visible.has(e.path)) : all;
    if (entries.length === 0 && drafting?.dir !== dir) {
      out.push({
        kind: "note",
        key: `empty:${dir}`,
        depth,
        text: visible ? tl("nada com esse nome aqui") : tl("pasta vazia"),
      });
    } else {
      entries.forEach((entry, i) => {
        const isExpanded = entry.dir && !!expanded[entry.path];
        out.push({
          kind: "entry",
          key: entry.path,
          entry,
          depth,
          expanded: isExpanded,
          posinset: i + 1,
          setsize: entries.length,
        });
        if (isExpanded) walk(entry.path, depth + 1);
      });
    }

    // The backend caps a listing at 4000 items. Saying nothing turned a
    // truncated folder into a complete-looking one — and the file someone was
    // looking for into a file that "does not exist".
    if (dropped > 0) {
      out.push({
        kind: "note",
        key: `dropped:${dir}`,
        depth,
        text: tl("+{n} item(ns) além do teto desta pasta — não listados", { n: dropped }),
      });
    }
  };

  walk("", 0);
  return out;
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

export function FileTree({
  onOpen,
  activePath,
  drafting,
  onDraftStart,
  onDraftEnd,
}: Props) {
  const t = useT();
  const root = useEditor((s) => s.root);
  const dirs = useEditor((s) => s.dirs);
  const expanded = useEditor((s) => s.expanded);
  const loading = useEditor((s) => s.loading);
  const dirError = useEditor((s) => s.dirError);
  const dirDropped = useEditor((s) => s.dirDropped);
  const filter = useEditor((s) => s.filter);

  const [menu, setMenu] = useState<{ entry: DirEntryInfo | null; anchor: MenuAnchor } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // "Renomear…" asked from a file tab: the box lives on the tree row, so the
  // request has to travel through the store to get here.
  const renameRequest = useEditor((s) => s.renameRequest);
  useEffect(() => {
    if (!renameRequest) return;
    setRenaming(renameRequest.path);
    useEditor.getState().clearRenameRequest();
  }, [renameRequest]);
  /** The row that carries the tree's single Tab stop (roving tabindex). */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** Only moves DOM focus when the navigation came from the keyboard. */
  const pendingFocus = useRef<string | null>(null);
  const showToast = useUI((s) => s.showToast);

  // Map of `path -> git status`, plus the set of directories that contain
  // some change. Recomputed only when `git status` changes; each row gets
  // only its own projection of it (`rowMark`), never the map itself.
  const projectId = useEditor((s) => s.projectId);
  const git = useChanges((s) => (projectId ? s.gitByProject[projectId] : undefined));
  const marks = useMemo(() => gitMarks(git?.files), [git]);

  const visible = useMemo(() => visiblePaths(dirs, filter), [dirs, filter]);
  const rows = useMemo(
    () =>
      buildRows({
        dirs,
        expanded,
        loading,
        dirError,
        dirDropped,
        visible,
        drafting: drafting ?? null,
      }),
    [dirs, expanded, loading, dirError, dirDropped, visible, drafting],
  );

  const navigable = useMemo(
    () => rows.filter((r): r is Extract<Row, { kind: "entry" }> => r.kind === "entry"),
    [rows],
  );

  // The Tab stop must always exist: if the focused row is gone (filter,
  // collapsed directory, deleted file), it falls back to the first one.
  const tabStop =
    focusPath && navigable.some((r) => r.entry.path === focusPath)
      ? focusPath
      : (navigable[0]?.entry.path ?? null);

  /** A name field is open somewhere in the tree: no row skips its paint. */
  const editingName = renaming !== null || !!drafting;

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    rowRefs.current.get(target)?.focus();
  }, [rows, focusPath]);

  const moveFocus = useCallback(
    (path: string) => {
      pendingFocus.current = path;
      setFocusPath(path);
    },
    [],
  );

  // The rows are memoized (`TreeRow`), so the handlers they get are made once
  // and read the latest committed render through this ref. A fresh closure
  // per row per render (what they got before) re-rendered every row on every
  // git refresh. The layout effect runs in the same commit that used to hand
  // the rows their new closures, before any event can reach them.
  const latest = useRef({ navigable, onOpen });
  useLayoutEffect(() => {
    latest.current = { navigable, onOpen };
  });

  const openPath = useCallback((path: string) => latest.current.onOpen(path), []);
  const stopRename = useCallback(() => setRenaming(null), []);
  const openMenu = useCallback(
    (entry: DirEntryInfo, anchor: MenuAnchor) => setMenu({ entry, anchor }),
    [],
  );
  const registerRow = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(path, el);
    else rowRefs.current.delete(path);
  }, []);

  const onRowKeyDown = useCallback(
    (e: React.KeyboardEvent, entry: DirEntryInfo, isExpanded: boolean) => {
      const { navigable, onOpen } = latest.current;
      const i = navigable.findIndex((r) => r.entry.path === entry.path);
      const consume = () => {
        // The canvas listens for the same arrows on the window: whatever the
        // row handles, it consumes.
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "Enter" || e.key === " ") {
        consume();
        if (entry.dir) useEditor.getState().toggleDir(entry.path);
        else onOpen(entry.path);
      } else if (e.key === "F2") {
        consume();
        setRenaming(entry.path);
      } else if (e.key === "ArrowDown") {
        consume();
        const fresh = navigable[i + 1];
        if (fresh) moveFocus(fresh.entry.path);
      } else if (e.key === "ArrowUp") {
        consume();
        const previous = navigable[i - 1];
        if (previous) moveFocus(previous.entry.path);
      } else if (e.key === "Home") {
        consume();
        if (navigable[0]) moveFocus(navigable[0].entry.path);
      } else if (e.key === "End") {
        consume();
        const lastOne = navigable[navigable.length - 1];
        if (lastOne) moveFocus(lastOne.entry.path);
      } else if (e.key === "ArrowRight") {
        consume();
        if (entry.dir && !isExpanded) useEditor.getState().toggleDir(entry.path);
        else if (entry.dir && isExpanded && navigable[i + 1]) {
          moveFocus(navigable[i + 1].entry.path);
        }
      } else if (e.key === "ArrowLeft") {
        consume();
        if (entry.dir && isExpanded) {
          useEditor.getState().toggleDir(entry.path);
        } else {
          // Go up to the parent directory, as in any tree.
          const parent = parentDir(entry.path);
          if (parent && navigable.some((r) => r.entry.path === parent)) moveFocus(parent);
        }
      }
    },
    [moveFocus],
  );

  if (!root) {
    return (
      <div className="bench-empty">
        <FolderOpen size={20} aria-hidden="true" />
        {t("Nenhum projeto ativo.")}
        <small>{t("Escolha um projeto na barra lateral para ver os arquivos.")}</small>
      </div>
    );
  }

  // Nothing read yet and nothing to explain: the root listing is in flight.
  // A failed root is **not** handled here any more — it comes through as a
  // `fail` row inside the tree, with its own retry.
  if (!dirs[""] && !dirError[""]) {
    return <p className="bench-note">{loading[""] ? t("lendo a pasta…") : ""}</p>;
  }

  return (
    <>
      <ul
        className="ftree"
        role="tree"
        aria-label={t("Arquivos do projeto")}
        // The space below the last file — in a small project, half the pane.
        // The rows stop propagation; what is left is the project.
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ entry: null, anchor: { x: e.clientX, y: e.clientY } });
        }}
      >
        {rows.map((row) => {
          if (row.kind === "draft") {
            return (
              <DraftRow
                key={row.key}
                depth={row.depth}
                isDir={row.isDir}
                dir={row.dir}
                onEnd={() => onDraftEnd?.()}
              />
            );
          }
          if (row.kind === "note") {
            return (
              <li
                key={row.key}
                className="ftree-note"
                style={{ paddingLeft: 16 + row.depth * 12 }}
              >
                {row.text}
              </li>
            );
          }
          if (row.kind === "fail") {
            return (
              <li
                key={row.key}
                className="ftree-fail"
                style={{ paddingLeft: 16 + row.depth * 12 }}
              >
                <span className="ftree-fail-msg" data-tip-wrap="" data-tip={row.text}>
                  {row.text}
                </span>
                <button
                  type="button"
                  onClick={() => void useEditor.getState().loadDir(row.dir, true)}
                >
                  {t("tentar de novo")}
                </button>
              </li>
            );
          }
          const { entry } = row;
          const mark = rowMark(marks, entry.path, entry.dir);
          return (
            <TreeRow
              key={row.key}
              entry={entry}
              depth={row.depth}
              expanded={row.expanded}
              posinset={row.posinset}
              setsize={row.setsize}
              root={root}
              status={mark.status}
              dot={mark.dot}
              active={entry.path === activePath}
              isTabStop={entry.path === tabStop}
              renaming={renaming === entry.path}
              skipOffscreen={skipsOffscreen(row.depth, editingName)}
              onStopRename={stopRename}
              registerRow={registerRow}
              onFocusRow={setFocusPath}
              onKeyDown={onRowKeyDown}
              onOpen={openPath}
              onMenu={openMenu}
              showToast={showToast}
            />
          );
        })}
      </ul>

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={fileTreeMenu(menu.entry, root, {
            rename: (path) => setRenaming(path),
            draft: (dir, isDir) => {
              // The draft appears inside the chosen directory: if it is
              // closed, open it first — otherwise the field would be born
              // invisible.
              if (dir && !useEditor.getState().expanded[dir]) {
                useEditor.getState().toggleDir(dir);
              }
              onDraftStart?.(dir, isDir);
            },
            copyPath: (path) => void copyText(path),
            reveal: (osPath) => {
              void ipc.revealPath(osPath).catch((e) => showToast(failureMessage(e), "error"));
            },
            refresh: () => useEditor.getState().refreshTree(),
            remove: (entry) => {
              void (async () => {
                const sure = await ask(
                  entry.dir
                    ? t("Excluir “{name}” e tudo que está dentro? Não dá para desfazer.", { name: entry.name })
                    : t("Excluir “{name}”? Não dá para desfazer.", { name: entry.name }),
                  { title: t("Excluir do disco"), kind: "warning" },
                );
                if (!sure) return;
                try {
                  await useEditor.getState().deleteEntry(entry.path);
                } catch (e) {
                  showToast(t("Não consegui excluir: {e}", { e: String(e) }), "error");
                }
              })();
            },
          })}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// row
// ---------------------------------------------------------------------------

interface RowProps {
  entry: DirEntryInfo;
  depth: number;
  expanded: boolean;
  posinset: number;
  setsize: number;
  /** The tree's root: a drag carries the absolute path, not the relative one. */
  root: string;
  /** This row's own git state (`rowMark`), never the project-wide map. */
  status: GitFileStatus | null;
  dot: boolean;
  active: boolean;
  isTabStop: boolean;
  renaming: boolean;
  /** `content-visibility: auto` on the `<li>` (`skipsOffscreen`). */
  skipOffscreen: boolean;
  onStopRename: () => void;
  registerRow: (path: string, el: HTMLDivElement | null) => void;
  onFocusRow: (path: string) => void;
  onKeyDown: (e: React.KeyboardEvent, entry: DirEntryInfo, expanded: boolean) => void;
  onOpen: (path: string) => void;
  onMenu: (entry: DirEntryInfo, anchor: MenuAnchor) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
}

/**
 * One entry of the tree. Memoized: every prop is a plain value or a handler
 * the tree makes once, so a git refresh, another active file or a folder
 * opening elsewhere re-renders only the rows whose own props moved.
 */
const TreeRow = memo(function TreeRow({
  entry,
  depth,
  expanded,
  posinset,
  setsize,
  root,
  status,
  dot,
  active,
  isTabStop,
  renaming,
  skipOffscreen,
  onStopRename,
  registerRow,
  onFocusRow,
  onKeyDown,
  onOpen,
  onMenu,
  showToast,
}: RowProps) {
  const t = useT();

  // Stable for the row's whole life (its key is the path): the element is
  // registered once on mount and dropped on unmount.
  const registerRef = useCallback(
    (el: HTMLDivElement | null) => registerRow(entry.path, el),
    [registerRow, entry.path],
  );

  const activate = () => {
    if (entry.dir) useEditor.getState().toggleDir(entry.path);
    else onOpen(entry.path);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(entry, { x: e.clientX, y: e.clientY });
  };

  const commitRename = (itemName: string) => {
    onStopRename();
    const next = joinPath(parentDir(entry.path), itemName);
    void useEditor
      .getState()
      .renameEntry(entry.path, next)
      .catch((e) => showToast(t("Não consegui renomear: {e}", { e: String(e) }), "error"));
  };

  return (
    <li role="none" style={skipOffscreen ? OFFSCREEN_SKIP : undefined}>
      <div
        ref={registerRef}
        className={[
          "ftree-row",
          active ? "is-active" : "",
          status ? `is-${status}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: 4 + depth * 12 }}
        role="treeitem"
        aria-expanded={entry.dir ? expanded : undefined}
        aria-selected={active}
        aria-level={depth + 1}
        aria-posinset={posinset}
        aria-setsize={setsize}
        // Roving tabindex: the whole tree is one Tab stop and the arrows
        // navigate inside it. Before, every row was tabbable, so leaving a
        // large tree cost one keypress per file.
        tabIndex={isTabStop ? 0 : -1}
        onClick={activate}
        onFocus={() => onFocusRow(entry.path)}
        onContextMenu={onContextMenu}
        onKeyDown={(e) => onKeyDown(e, entry, expanded)}
        // A row can be carried onto the board (a card) or into a terminal
        // (its path at the prompt). The payload is the absolute path.
        draggable
        onDragStart={(e) =>
          writeDragPaths(e.dataTransfer, [
            { path: joinAbsolute(root, entry.path), ...(entry.dir ? { dir: true } : {}) },
          ])
        }
      >
        <span className="ftree-twist" aria-hidden="true">
          {entry.dir &&
            (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <span className="ftree-icon" aria-hidden="true">
          <FileGlyph name={entry.name} dir={entry.dir} expanded={expanded} size={13} />
        </span>

        {renaming ? (
          <InlineRename
            value={entry.name}
            onCommit={commitRename}
            onCancel={onStopRename}
          />
        ) : (
          <span className="ftree-name" data-tip-wrap="" data-tip={entry.path}>
            {entry.name}
          </span>
        )}

        {dot && <span className="ftree-dot" aria-hidden="true" />}
        {status && (
          <span className="ftree-mark" aria-label={t(GIT_LABEL[status])}>
            {GIT_LETTER[status]}
          </span>
        )}
      </div>
    </li>
  );
});

/** Blank row where the new item's name is typed. */
function DraftRow({
  depth,
  isDir,
  dir,
  onEnd,
}: {
  depth: number;
  isDir: boolean;
  dir: string;
  onEnd: () => void;
}) {
  const showToast = useUI((s) => s.showToast);
  const t = useT();
  return (
    <li role="none">
      <div className="ftree-row is-draft" style={{ paddingLeft: 4 + depth * 12 }}>
        <span className="ftree-twist" aria-hidden="true" />
        <span className="ftree-icon" aria-hidden="true">
          <FileGlyph name="" dir={isDir} size={13} />
        </span>
        <InlineRename
          value=""
          onCommit={(name) => {
            onEnd();
            void useEditor
              .getState()
              .createEntry(dir, name, isDir)
              .catch((e) => showToast(t("Não consegui criar: {e}", { e: String(e) }), "error"));
          }}
          onCancel={onEnd}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// marks
// ---------------------------------------------------------------------------

const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "C",
};

const GIT_LABEL: Record<GitFileStatus, string> = {
  modified: "modificado",
  added: "novo (staged)",
  untracked: "novo",
  deleted: "excluído",
  renamed: "renomeado",
  conflicted: "conflito",
};
