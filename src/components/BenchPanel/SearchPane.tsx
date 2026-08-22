/**
 * Project-wide content search (Ctrl+Shift+F) — the search face of the bench's
 * Files tab, reached by the magnifier in its toolbar (it is still the `search`
 * tab in `benchStore`; only the strip stopped showing it). The VS Code shape
 * everyone knows: a box on top, results grouped by file, a click lands the
 * caret on the line. The lit magnifier (or Esc on an empty box) goes back to
 * the tree.
 *
 * The walk happens in Rust (`fs_search_text`) with the same skip list the
 * quick-open index uses; here it is only typed, debounced and painted. The
 * results live in `searchStore`, not in this component — switching tabs must
 * not eat a result list the user is still walking through.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Search,
  WholeWord,
  X,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { copyText } from "../../lib/clipboard";
import { ipc } from "../../lib/ipc";
import { fileName, toOsPath } from "../../lib/paths";
import { useEditor, parentDir } from "../../stores/editorStore";
import { MIN_QUERY, outcomeIsCurrent, useSearch } from "../../stores/searchStore";
import { useUI } from "../../stores/uiStore";

/** Typing pauses this long before the disk is walked. */
const DEBOUNCE_MS = 350;

export function SearchPane({
  focusTick,
  onClose,
}: {
  focusTick: number;
  /** Back to the file tree — the lit magnifier and the empty-box Esc. */
  onClose: () => void;
}) {
  const root = useEditor((s) => s.root);
  const query = useSearch((s) => s.query);
  const caseSensitive = useSearch((s) => s.caseSensitive);
  const wholeWord = useSearch((s) => s.wholeWord);
  const status = useSearch((s) => s.status);
  const error = useSearch((s) => s.error);
  const outcome = useSearch((s) => s.outcome);
  const outcomeRoot = useSearch((s) => s.root);
  const collapsed = useSearch((s) => s.collapsed);
  const showToast = useUI((s) => s.showToast);

  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  // Auto-search on a pause; options flipping re-run the standing query.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < MIN_QUERY) return;
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      void useSearch.getState().run();
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, caseSensitive, wholeWord]);

  const fresh = outcomeIsCurrent({ root: outcomeRoot, outcome });
  const groups = useMemo(() => {
    if (!outcome || !fresh) return [];
    const byFile = new Map<string, typeof outcome.hits>();
    for (const hit of outcome.hits) {
      const list = byFile.get(hit.path);
      if (list) list.push(hit);
      else byFile.set(hit.path, [hit]);
    }
    return [...byFile.entries()];
  }, [outcome, fresh]);

  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(
    null,
  );

  /**
   * A result's menu: open where a click already opens, plus the three things
   * the list gives no other way — the path, the line and the folder. Without
   * it, copying the matched snippet meant opening the file and finding the
   * line all over again.
   */
  const hitMenu = (path: string, line: number | null, theText: string | null) => {
    const absolutePath = root ? toOsPath(root, path) : null;
    const copy = (theValue: string) => {
      void copyText(theValue).then((ok) =>
        showToast(ok ? "Copiado." : "Não consegui copiar.", ok ? "info" : "error"),
      );
    };
    const entries: MenuEntry[] = [
      {
        id: "abrir",
        label: line === null ? "Abrir o arquivo" : `Abrir na linha ${line}`,
        onSelect: () => openHit(path, line ?? 1),
      },
      { kind: "sep" },
      { id: "copiar", label: "Copiar caminho", onSelect: () => copy(path) },
      {
        id: "copiar-abs",
        label: "Copiar caminho completo",
        disabled: absolutePath === null,
        onSelect: () => absolutePath && copy(absolutePath),
      },
    ];
    if (theText !== null) {
      entries.push({
        id: "copiar-linha",
        label: "Copiar a linha",
        onSelect: () => copy(theText),
      });
    }
    entries.push({
      id: "revelar",
      label: "Mostrar na pasta",
      disabled: absolutePath === null,
      onSelect: () => {
        if (absolutePath) void ipc.revealPath(absolutePath).catch((e) => showToast(String(e), "error"));
      },
    });
    return entries;
  };

  const openMenu = (
    e: React.MouseEvent,
    path: string,
    line: number | null,
    text: string | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, entries: hitMenu(path, line, text) });
  };

  const openHit = (path: string, line: number) => {
    void useEditor
      .getState()
      .openFileAt(path, line)
      .catch((e) => showToast(`Não consegui abrir: ${e}`, "error"));
  };

  return (
    <div className="bench-body bench-body--search" role="tabpanel" aria-label="Buscar no projeto">
      <div className="bench-bar">
        <div className="bench-search">
          <Search size={12} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Buscar no projeto"
            aria-label="Buscar texto em todos os arquivos do projeto"
            disabled={!root}
            onChange={(e) => useSearch.getState().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (timer.current) clearTimeout(timer.current);
                void useSearch.getState().run();
              } else if (e.key === "Escape") {
                if (query) useSearch.getState().clear();
                else onClose();
              }
            }}
          />
          {query && (
            <button
              className="icon-btn"
              aria-label="Limpar a busca"
              onClick={() => {
                useSearch.getState().clear();
                inputRef.current?.focus();
              }}
            >
              <X size={11} />
            </button>
          )}
        </div>
        <div className="ftree-tools">
          {/* Same slot as in the tree face: the magnifier that opened the
              search closes it, lit blue while it is on. */}
          <button
            className="icon-btn bench-lens is-active"
            data-tip="Fechar a busca"
            aria-label="Fechar a busca e voltar à árvore"
            aria-pressed={true}
            onClick={onClose}
          >
            <Search size={13} />
          </button>
          <button
            className={`icon-btn ${caseSensitive ? "is-active" : ""}`}
            data-tip="Diferenciar maiúsculas"
            aria-label="Diferenciar maiúsculas de minúsculas"
            aria-pressed={caseSensitive}
            onClick={() => useSearch.getState().setCaseSensitive(!caseSensitive)}
          >
            <CaseSensitive size={14} />
          </button>
          <button
            className={`icon-btn ${wholeWord ? "is-active" : ""}`}
            data-tip="Palavra inteira"
            aria-label="Só palavras inteiras"
            aria-pressed={wholeWord}
            onClick={() => useSearch.getState().setWholeWord(!wholeWord)}
          >
            <WholeWord size={14} />
          </button>
        </div>
      </div>

      {!root && <p className="bench-note">Abra um projeto para buscar nele.</p>}
      {/* Under two characters the search does not run; without this line the
          area sat empty and the silence looked like a failure. */}
      {root && query.trim().length > 0 && query.trim().length < MIN_QUERY && (
        <p className="bench-note">Digite ao menos {MIN_QUERY} caracteres.</p>
      )}
      {status === "error" && error && (
        <p className="bench-note bench-note--error">{error}</p>
      )}
      {status === "searching" && <p className="bench-note">buscando…</p>}
      {status === "done" && fresh && outcome && (
        <p className="bench-note">
          {outcome.hits.length === 0
            ? `Nada de “${query.trim()}” em ${outcome.filesScanned} arquivos.`
            : `${outcome.hits.length} linha(s) em ${outcome.filesHit} arquivo(s).`}
          {outcome.truncated &&
            " A lista parou num limite — refine a busca para ver o resto."}
        </p>
      )}

      <div className="psearch-scroll">
        {groups.map(([path, hits]) => {
          const closed = collapsed[path];
          return (
            <section className="psearch-file" key={path}>
              <button
                className="psearch-file-head"
                aria-expanded={!closed}
                onClick={() => useSearch.getState().toggleFile(path)}
                onContextMenu={(e) => openMenu(e, path, null, null)}
              >
                {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="psearch-file-name">{fileName(path)}</span>
                <span className="psearch-file-dir" data-tip-wrap="" data-tip={path}>
                  {parentDir(path)}
                </span>
                <span className="psearch-count">{hits.length}</span>
              </button>
              {!closed &&
                hits.map((hit) => (
                  <button
                    key={`${hit.path}:${hit.line}`}
                    className="psearch-hit"
                    data-tip={`linha ${hit.line}`}
                    onClick={() => openHit(hit.path, hit.line)}
                    onContextMenu={(e) => openMenu(e, hit.path, hit.line, hit.text)}
                  >
                    <span className="psearch-line">{hit.line}</span>
                    <HitText text={hit.text} query={query} caseSensitive={caseSensitive} />
                  </button>
                ))}
            </section>
          );
        })}
      </div>

      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          items={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** The matched line with the needle marked — first occurrence is enough. */
function HitText({
  text,
  query,
  caseSensitive,
}: {
  text: string;
  query: string;
  caseSensitive: boolean;
}) {
  const needle = query.trim();
  const hay = caseSensitive ? text : text.toLowerCase();
  const at = needle ? hay.indexOf(caseSensitive ? needle : needle.toLowerCase()) : -1;
  if (at < 0) return <span className="psearch-text">{text.trim()}</span>;
  // Keep the match on screen even in a long line: start a bit before it.
  const from = Math.max(0, at - 32);
  const shown = text.slice(from);
  const rel = at - from;
  return (
    <span className="psearch-text">
      {from > 0 && "…"}
      {shown.slice(0, rel).trimStart()}
      <mark>{shown.slice(rel, rel + needle.length)}</mark>
      {shown.slice(rel + needle.length)}
    </span>
  );
}
