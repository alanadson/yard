/**
 * The three marks every file surface in the app draws: the git status badge,
 * the watcher-event badge and the dir/name path label.
 *
 * They appear in the files panel, the diff viewer, the floating peek and the
 * live overlay — and used to be five separate copies of the same two maps,
 * which is how "novo (untracked)" ended up worded differently from one panel
 * to the next.
 */
// i18n-scan: tables
import { useT } from "../../hooks/useT";
import { splitPath } from "../../lib/paths";
import type { FileEventKind, GitFileStatus } from "../../lib/ipc";

type Mark = { label: string; cls: string; tip: string };

const GIT_MARKS: Record<GitFileStatus, Mark> = {
  modified: { label: "M", cls: "badge--mod", tip: "modificado" },
  added: { label: "A", cls: "badge--add", tip: "novo (staged)" },
  untracked: { label: "A", cls: "badge--add", tip: "novo (untracked)" },
  deleted: { label: "D", cls: "badge--del", tip: "excluído" },
  renamed: { label: "R", cls: "badge--mod", tip: "renomeado" },
  conflicted: { label: "C", cls: "badge--conflict", tip: "conflito de merge" },
};

const KIND_MARKS: Record<FileEventKind, Mark> = {
  created: { label: "+", cls: "badge--add", tip: "criado" },
  modified: { label: "M", cls: "badge--mod", tip: "modificado" },
  deleted: { label: "−", cls: "badge--del", tip: "apagado" },
};

function Badge({ mark }: { mark: Mark }) {
  const t = useT();
  return (
    <span className={`file-badge ${mark.cls}`} data-tip={t(mark.tip)} role="img" aria-label={t(mark.tip)}>
      {mark.label}
    </span>
  );
}

/** What `git status` says about the file. */
export function GitStatusBadge({ status }: { status: string }) {
  const mark = GIT_MARKS[status as GitFileStatus] ?? {
    label: "?",
    cls: "badge--mod",
    tip: status,
  };
  return <Badge mark={mark} />;
}

/** What the filesystem watcher saw happen to the file this session. */
export function FileKindBadge({ kind }: { kind: FileEventKind }) {
  return <Badge mark={KIND_MARKS[kind]} />;
}

/**
 * `src/lib/` in a dim tone, `canvas.ts` in the reading tone — the split that
 * lets a column of paths be scanned by file name without losing the folder.
 */
export function PathLabel({
  path,
  deleted,
  bare,
}: {
  path: string;
  deleted?: boolean;
  /** Without the wrapper span — for hosts that style the parts themselves. */
  bare?: boolean;
}) {
  const { dir, base } = splitPath(path);
  const parts = (
    <>
      {dir && <span className="path-dir">{dir}</span>}
      <span className="path-name">{base}</span>
    </>
  );
  if (bare) return parts;
  return (
    <span className={`path-label ${deleted ? "path-label--deleted" : ""}`}>
      {parts}
    </span>
  );
}
