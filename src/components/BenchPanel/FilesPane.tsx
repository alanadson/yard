/**
 * The bench's "Files" tab — the active project's explorer, in the shape
 * everyone already knows from VS Code: a lazy tree on the right, a click
 * opens the file in the editor.
 *
 * The root follows the **active floor**: in a group with a worktree, the tree
 * shows the worktree, not the project's ground — the same root the watcher
 * and the changes panel's `git status` already use.
 */
import { useEffect, useRef, useState } from "react";
import {
  FilePlus,
  FolderPlus,
  FoldVertical,
  ListFilter,
  RotateCw,
  Search,
  X,
} from "lucide-react";

import { FileTree } from "../FileTree";
import { useEditor } from "../../stores/editorStore";
import { useUI } from "../../stores/uiStore";
import { sameRoot } from "../../lib/roots";

export function FilesPane({
  focusTick,
  onSearch,
}: {
  focusTick: number;
  /** Flips the pane into project search — the magnifier in the toolbar. */
  onSearch: () => void;
}) {
  // The root is wired up in `App` (alongside the watcher), so the editor works
  // even with this tab closed; here it is only read.
  const root = useEditor((s) => s.root);
  const filter = useEditor((s) => s.filter);
  const setFilter = useEditor((s) => s.setFilter);
  const activePath = useEditor((s) => {
    const active = s.docs.find((d) => d.id === s.activeId);
    return active && sameRoot(active.root, s.root) ? active.path : null;
  });
  const showToast = useUI((s) => s.showToast);

  const [drafting, setDrafting] = useState<{ dir: string; isDir: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusTick > 0) searchRef.current?.focus();
  }, [focusTick]);

  const open = (path: string) => {
    void useEditor
      .getState()
      .openFile(path)
      .catch((e) => showToast(`Não consegui abrir: ${e}`, "error"));
  };

  const collapseAll = () => {
    useEditor.setState({ expanded: {} });
  };

  return (
    <div className="bench-body bench-body--files" role="tabpanel" aria-label="Arquivos">
      <div className="bench-bar">
        <div className="bench-search">
          {/* Funnel, not magnifier: this narrows by name; the magnifier in the
              toolbar is the one that searches content. */}
          <ListFilter size={12} aria-hidden="true" />
          <input
            ref={searchRef}
            value={filter}
            placeholder="Filtrar por nome"
            aria-label="Filtrar arquivos pelo nome"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (filter) setFilter("");
                else e.currentTarget.blur();
              }
            }}
          />
          {filter && (
            <button
              className="icon-btn"
              aria-label="Limpar o filtro"
              onClick={() => {
                setFilter("");
                searchRef.current?.focus();
              }}
            >
              <X size={11} />
            </button>
          )}
        </div>
        <div className="ftree-tools">
          {/* First tool in both faces of the tab, so the magnifier never
              moves — here it opens the search, there (lit blue) it closes. */}
          <button
            className="icon-btn bench-lens"
            data-tip="Buscar no projeto (Ctrl+Shift+F)"
            aria-label="Buscar texto em todo o projeto"
            aria-pressed={false}
            onClick={onSearch}
          >
            <Search size={13} />
          </button>
          <button
            className="icon-btn"
            data-tip="Novo arquivo na raiz"
            aria-label="Novo arquivo na raiz do projeto"
            disabled={!root}
            onClick={() => setDrafting({ dir: "", isDir: false })}
          >
            <FilePlus size={13} />
          </button>
          <button
            className="icon-btn"
            data-tip="Nova pasta na raiz"
            aria-label="Nova pasta na raiz do projeto"
            disabled={!root}
            onClick={() => setDrafting({ dir: "", isDir: true })}
          >
            <FolderPlus size={13} />
          </button>
          <button
            className="icon-btn"
            data-tip="Recolher tudo"
            aria-label="Recolher todas as pastas"
            onClick={collapseAll}
          >
            <FoldVertical size={13} />
          </button>
          <button
            className="icon-btn"
            data-tip="Reler do disco"
            aria-label="Reler o disco"
            disabled={!root}
            onClick={() => useEditor.getState().refreshTree()}
          >
            <RotateCw size={13} />
          </button>
        </div>
      </div>

      {filter.trim() && (
        <p className="bench-note">
          filtrando só as pastas já abertas
        </p>
      )}

      <div className="ftree-scroll">
        <FileTree
          onOpen={open}
          activePath={activePath}
          drafting={drafting}
          onDraftStart={(dir, isDir) => setDrafting({ dir, isDir })}
          onDraftEnd={() => setDrafting(null)}
        />
      </div>
    </div>
  );
}
