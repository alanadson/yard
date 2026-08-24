/**
 * A file-tree card on the board (§14): the explorer, next to the agent using
 * it, with the four faces §14.2 asks for.
 *
 * It does **not** reuse `components/FileTree`. That one reads `root`, `dirs`
 * and `expanded` from `stores/editorStore`, which is global by design — one
 * panel, one state. §14.1 asks for the opposite: several cards on the same
 * board, each remembering its own folder, its own open branches and its own
 * mode. So this card keeps the state on its item and reads disk itself.
 *
 * The listing is component state, never the item: it is a picture of a folder
 * that an agent rewrites while you look at it, and persisting it into
 * `layoutJson` would mean restoring a directory that has not existed since
 * yesterday.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-react";

import { ResizeHandles } from "./ResizeHandles";
import { FileGlyph } from "../FileGlyph";
import { ipc, type ChangedFile, type DirEntryInfo, type ScmCommit } from "../../lib/ipc";
import { laneCount, layoutCommits, type GraphRow } from "../../lib/gitGraph";
import { mediaKind, mediaUrl } from "../../lib/media";
import {
  isOpen,
  TREE_LOG_LIMIT,
  TREE_MODE_LABEL,
  TREE_MODES,
  toggled,
  treeNodeName,
  type TreeItem,
  type TreeMode,
} from "../../lib/treeNode";
import type { ResizeDir } from "../../lib/canvas";

interface Props {
  it: TreeItem;
  dx: number;
  dy: number;
  w: number;
  h: number;
  selected: boolean;
  faded: boolean;
  connectClass: string;
  /** Project root, for a card that carries none of its own. */
  projectRoot: string;
  onItemDown: (e: React.PointerEvent, id: string) => void;
  onItemMove: (e: React.PointerEvent) => void;
  onItemUp: (e: React.PointerEvent) => void;
  onPatch: (id: string, patch: Partial<TreeItem>) => void;
  onOpenFile: (path: string) => void;
  onResizeStart: (e: React.PointerEvent, it: TreeItem, dir: ResizeDir) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}

/** One row of the flattened tree. */
interface Row {
  entry: DirEntryInfo;
  depth: number;
  open: boolean;
}

function TreeCardImpl({
  it,
  dx,
  dy,
  w,
  h,
  selected,
  faded,
  connectClass,
  projectRoot,
  onItemDown,
  onItemMove,
  onItemUp,
  onPatch,
  onOpenFile,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: Props) {
  const root = it.root || projectRoot;
  const [dirs, setDirs] = useState<Record<string, DirEntryInfo[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangedFile[] | null>(null);
  const [log, setLog] = useState<ScmCommit[] | null>(null);
  /** Bumped by the refresh button; every fetch below depends on it. */
  const [tick, setTick] = useState(0);

  const grab = useCallback(
    (e: React.PointerEvent) => onItemDown(e, it.id),
    [it.id, onItemDown],
  );

  // --- what this card needs from disk, per mode ---------------------------

  const wanted = useMemo(() => {
    if (it.mode === "changes" || it.mode === "graph") return [];
    // The card's own folder, plus every folder it has open. Grid never
    // recurses — it is one folder's worth of thumbnails.
    return it.mode === "grid" ? [it.path] : [it.path, ...(it.expanded ?? [])];
  }, [it.mode, it.path, it.expanded]);

  useEffect(() => {
    if (!root || !wanted.length) return;
    let alive = true;
    setError(null);
    Promise.all(
      wanted.map((path) =>
        ipc
          .fsListDir(root, path)
          .then((listing) => [path, listing.entries] as const)
          .catch((e) => {
            if (path === it.path) setError(String(e));
            return [path, [] as DirEntryInfo[]] as const;
          }),
      ),
    ).then((pairs) => {
      if (!alive) return;
      setDirs((cur) => {
        const next = { ...cur };
        for (const [path, entries] of pairs) next[path] = entries;
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // `wanted` is rebuilt whenever the path or the open set changes, which is
    // exactly when a folder has to be read.
  }, [root, wanted, it.path, tick]);

  useEffect(() => {
    if (it.mode !== "changes" || !root) return;
    let alive = true;
    ipc
      .gitChanges(root)
      .then((summary) => alive && setChanges(summary.files))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [it.mode, root, tick]);

  useEffect(() => {
    if (it.mode !== "graph" || !root) return;
    let alive = true;
    ipc
      .scmLog(root, { limit: TREE_LOG_LIMIT })
      .then((commits) => alive && setLog(commits))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [it.mode, root, tick]);

  // --- the flattened list -------------------------------------------------

  const rows = useMemo((): Row[] => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of dirs[dir] ?? []) {
        const open = entry.dir && isOpen(it, entry.path);
        out.push({ entry, depth, open });
        if (open) walk(entry.path, depth + 1);
      }
    };
    walk(it.path, 0);
    return out;
  }, [dirs, it, it.path]);

  const toggle = useCallback(
    (path: string) => onPatch(it.id, { expanded: toggled(it, path) }),
    [it, onPatch],
  );

  const pick = useCallback(
    (entry: DirEntryInfo) => {
      if (entry.dir) {
        toggle(entry.path);
        return;
      }
      onPatch(it.id, { selected: entry.path });
      onOpenFile(entry.path);
    },
    [it.id, onOpenFile, onPatch, toggle],
  );

  const graph = useMemo(() => (log ? layoutCommits(log) : []), [log]);

  return (
    <div
      className={`cv-tree ${selected ? "is-selected" : ""} ${connectClass}`}
      style={{ left: it.x + dx, top: it.y + dy, width: w, height: h, opacity: faded ? 0.22 : 1 }}
    >
      <div
        className="cv-tree-head"
        style={{ background: it.color }}
        onPointerDown={grab}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      >
        <span className="cv-tree-title" title={it.path || root}>
          {treeNodeName(it)}
        </span>
        {/* Up one folder — the only navigation the card needs, since going
            down is what clicking a folder already does. */}
        {it.path && (
          <button
            className="cv-tree-btn"
            data-tip="Subir uma pasta"
            aria-label="Subir uma pasta"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const cut = it.path.lastIndexOf("/");
              onPatch(it.id, { path: cut > 0 ? it.path.slice(0, cut) : "" });
            }}
          >
            ↑
          </button>
        )}
        <button
          className="cv-tree-btn"
          data-tip="Reler do disco"
          aria-label="Reler do disco"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setTick((t) => t + 1);
          }}
        >
          <RefreshCw size={11} />
        </button>
      </div>

      <div
        className="cv-tree-modes"
        role="tablist"
        aria-label="Modo da árvore"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {TREE_MODES.map((m: TreeMode) => (
          <button
            key={m}
            role="tab"
            aria-selected={it.mode === m}
            className={`cv-tree-mode ${it.mode === m ? "is-active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onPatch(it.id, { mode: m });
            }}
          >
            {TREE_MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <div
        className="cv-tree-body"
        onPointerDown={(e) => {
          // The empty space below the rows drags the card; a row stops the
          // pointer on its own.
          if (e.target === e.currentTarget) grab(e);
        }}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
      >
        {!root ? (
          <span className="cv-tree-msg">
            Este quadro não tem projeto — abra a pasta pelo menu do cartão.
          </span>
        ) : error ? (
          <span className="cv-tree-msg is-error">{error}</span>
        ) : it.mode === "list" ? (
          rows.length ? (
            rows.map(({ entry, depth, open }) => (
              <button
                key={entry.path}
                className={`cv-tree-row ${it.selected === entry.path ? "is-selected" : ""}`}
                style={{ paddingLeft: 6 + depth * 12 }}
                title={entry.path}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  pick(entry);
                }}
              >
                <span className="cv-tree-caret">
                  {entry.dir ? (
                    open ? (
                      <ChevronDown size={11} />
                    ) : (
                      <ChevronRight size={11} />
                    )
                  ) : null}
                </span>
                <FileGlyph name={entry.name} dir={entry.dir} expanded={open} size={12} />
                <span className="cv-tree-name">{entry.name}</span>
              </button>
            ))
          ) : (
            <span className="cv-tree-msg">pasta vazia</span>
          )
        ) : it.mode === "grid" ? (
          <div className="cv-tree-grid">
            {(dirs[it.path] ?? []).map((entry) => {
              const kind = entry.dir ? null : mediaKind(guessMime(entry.name));
              return (
                <button
                  key={entry.path}
                  className="cv-tree-tile"
                  title={entry.path}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(entry);
                  }}
                >
                  {kind === "image" ? (
                    <Thumb root={root} path={entry.path} name={entry.name} />
                  ) : (
                    <span className="cv-tree-thumb is-glyph">
                      <FileGlyph name={entry.name} dir={entry.dir} size={22} />
                    </span>
                  )}
                  <span className="cv-tree-tile-name">{entry.name}</span>
                </button>
              );
            })}
          </div>
        ) : it.mode === "changes" ? (
          changes === null ? (
            <span className="cv-tree-msg">lendo o git…</span>
          ) : changes.length ? (
            changes.map((file) => (
              <button
                key={file.path}
                className="cv-tree-row"
                title={file.path}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile(file.path);
                }}
              >
                <span className={`cv-tree-status st-${file.status.trim() || "m"}`}>
                  {file.status.trim() || "M"}
                </span>
                <FileGlyph name={file.path} size={12} />
                <span className="cv-tree-name">{file.path}</span>
              </button>
            ))
          ) : (
            <span className="cv-tree-msg">nada alterado</span>
          )
        ) : log === null ? (
          <span className="cv-tree-msg">lendo o histórico…</span>
        ) : log.length ? (
          <CommitGraph rows={graph} commits={log} />
        ) : (
          <span className="cv-tree-msg">sem commits</span>
        )}
      </div>

      <ResizeHandles
        onDown={(e, dir) => onResizeStart(e, it, dir)}
        onMove={onResizeMove}
        onUp={onResizeEnd}
      />
    </div>
  );
}

/**
 * One thumbnail, with the glyph as its floor.
 *
 * The extension said "image"; the file may still refuse to draw — an agent
 * deleted it between the listing and the render, it is a `.png` that is
 * actually text, it is 400 MB of TIFF. A bare `<img>` leaves the webview's own
 * broken-image icon in the tile, which says nothing and looks like our bug.
 */
function Thumb({ root, path, name }: { root: string; path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="cv-tree-thumb is-glyph">
        <FileGlyph name={name} size={22} />
      </span>
    );
  }
  return (
    <img
      className="cv-tree-thumb"
      src={mediaUrl(root, path)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Lane width and row height of the graph gutter, in px. */
const LANE_W = 13;
const ROW_H = 30;

/**
 * The commit graph (§14.2).
 *
 * One `<svg>` per row rather than one for the whole list: the rows scroll, and
 * a single tall SVG would have to be re-laid-out on every scroll of a card
 * that may be showing eighty commits.
 */
function CommitGraph({
  rows,
  commits,
}: {
  rows: GraphRow[];
  commits: ScmCommit[];
}) {
  const lanes = Math.max(1, laneCount(rows));
  const width = lanes * LANE_W;
  const x = (lane: number) => lane * LANE_W + LANE_W / 2;

  return (
    <div className="cv-tree-graph">
      {rows.map((row, i) => {
        const commit = commits[i];
        return (
          <div key={row.hash} className="cv-tree-commit">
            <svg
              className="cv-tree-lanes"
              width={width}
              height={ROW_H}
              viewBox={`0 0 ${width} ${ROW_H}`}
              aria-hidden="true"
            >
              {/* Lanes crossing without touching this commit. */}
              {row.through.map((lane) => (
                <line
                  key={`t${lane}`}
                  x1={x(lane)}
                  y1={0}
                  x2={x(lane)}
                  y2={ROW_H}
                  className="cv-lane-line"
                />
              ))}
              {/* Branches ending at this commit, coming in from the right. */}
              {row.merges.map((lane) => (
                <path
                  key={`m${lane}`}
                  d={`M ${x(lane)} 0 C ${x(lane)} ${ROW_H / 2}, ${x(row.lane)} ${ROW_H / 2}, ${x(row.lane)} ${ROW_H / 2}`}
                  className="cv-lane-line"
                  fill="none"
                />
              ))}
              {/* Down to each parent. */}
              {row.links.map((lane) => (
                <path
                  key={`l${lane}`}
                  d={`M ${x(row.lane)} ${ROW_H / 2} C ${x(row.lane)} ${ROW_H}, ${x(lane)} ${ROW_H / 2}, ${x(lane)} ${ROW_H}`}
                  className="cv-lane-line"
                  fill="none"
                />
              ))}
              <circle
                cx={x(row.lane)}
                cy={ROW_H / 2}
                r={3.5}
                className={`cv-lane-dot ${commit.parents.length > 1 ? "is-merge" : ""}`}
              />
            </svg>
            <span className="cv-tree-commit-text" title={`${commit.short} ${commit.subject}`}>
              {commit.refs.length > 0 && (
                <span className="cv-tree-ref">
                  <GitBranch size={9} />
                  {commit.refs[0]}
                </span>
              )}
              {commit.subject}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * MIME from the file name, for the grid's thumbnails.
 *
 * Deliberately tiny and deliberately here: the backend's table is the
 * authority, but asking it costs one IPC round trip **per tile**, and a folder
 * of two hundred files would spend two hundred of them to decide which icons
 * to draw. A wrong guess costs a glyph instead of a thumbnail, and the picture
 * that does load proves the guess right.
 */
function guessMime(name: string): string | null {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(ext)) {
    return `image/${ext === "jpg" ? "jpeg" : ext}`;
  }
  if (["mp4", "webm", "mkv", "mov"].includes(ext)) return `video/${ext}`;
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return `audio/${ext}`;
  if (ext === "pdf") return "application/pdf";
  return null;
}

export const TreeCard = memo(TreeCardImpl);
