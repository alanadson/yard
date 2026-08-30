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
  Filter,
  Regex,
  Replace,
  Search,
  WholeWord,
  X,
} from "lucide-react";

import { ContextMenu, type MenuAnchor, type MenuEntry } from "../ContextMenu";
import { ask } from "@tauri-apps/plugin-dialog";

import { copyText } from "../../lib/clipboard";
import { ipc } from "../../lib/ipc";
import { replaceReadiness, type ReplaceRefusal } from "../../lib/replaceScope";
import { fileName, toOsPath } from "../../lib/paths";
import { useEditor, parentDir } from "../../stores/editorStore";
import { MIN_QUERY, outcomeIsCurrent, useSearch } from "../../stores/searchStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

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
  const regex = useSearch((s) => s.regex);
  const include = useSearch((s) => s.include);
  const exclude = useSearch((s) => s.exclude);
  const replacement = useSearch((s) => s.replacement);
  const replacing = useSearch((s) => s.replacing);
  const [filtering, setFiltering] = useState(false);
  const status = useSearch((s) => s.status);
  const error = useSearch((s) => s.error);
  const outcome = useSearch((s) => s.outcome);
  const outcomeRoot = useSearch((s) => s.root);
  const collapsed = useSearch((s) => s.collapsed);
  const showToast = useUI((s) => s.showToast);
  const t = useT();

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
        showToast(ok ? t("Copiado.") : t("Não consegui copiar."), ok ? "info" : "error"),
      );
    };
    const entries: MenuEntry[] = [
      {
        id: "abrir",
        label: line === null ? t("Abrir o arquivo") : t("Abrir na linha {line}", { line }),
        onSelect: () => openHit(path, line ?? 1),
      },
      { kind: "sep" },
      { id: "copiar", label: t("Copiar caminho"), onSelect: () => copy(path) },
      {
        id: "copiar-abs",
        label: t("Copiar caminho completo"),
        disabled: absolutePath === null,
        onSelect: () => absolutePath && copy(absolutePath),
      },
    ];
    if (theText !== null) {
      entries.push({
        id: "copiar-linha",
        label: t("Copiar a linha"),
        onSelect: () => copy(theText),
      });
    }
    entries.push({
      id: "revelar",
      label: t("Mostrar na pasta"),
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
      .catch((e) => showToast(t("Não consegui abrir: {e}", { e: String(e) }), "error"));
  };

  /**
   * Whether "Substituir tudo" may run at all, and over how much
   * (`lib/replaceScope.ts`). The button is disabled rather than hidden: the
   * reason it cannot run is the useful part.
   */
  const ready = replaceReadiness({
    root,
    query,
    status,
    outcome,
    current: fresh,
  });

  /**
   * The one confirmation in this panel. It rewrites files the user is not
   * looking at, it is not undoable from here, and the count is the only thing
   * that makes it reviewable before it happens.
   */
  const runReplace = async () => {
    if (!ready.ok) return;
    const go = await ask(
      t(
        "Trocar {hits} ocorrência(s) de “{query}” por “{replacement}” em {files} arquivo(s)?\n\nOs arquivos são gravados no disco. Só o histórico do git desfaz isso.",
        {
          hits: ready.hits,
          files: ready.files,
          query: query.trim(),
          replacement,
        },
      ),
      { title: t("Substituir no projeto"), kind: "warning" },
    );
    if (!go) return;
    try {
      const outcome = await useSearch.getState().replace();
      if (!outcome) return;
      showToast(
        outcome.replacements === 0
          ? t("Nada mudou.")
          : t("{n} troca(s) em {files} arquivo(s).", {
              n: outcome.replacements,
              files: outcome.filesChanged,
            }),
      );
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <div className="bench-body bench-body--search" role="tabpanel" aria-label={t("Buscar no projeto")}>
      <div className="bench-bar">
        <div className="bench-search">
          <Search size={12} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder={t("Buscar no projeto")}
            aria-label={t("Buscar texto em todos os arquivos do projeto")}
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
              aria-label={t("Limpar a busca")}
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
            data-tip={t("Fechar a busca")}
            aria-label={t("Fechar a busca e voltar à árvore")}
            aria-pressed={true}
            onClick={onClose}
          >
            <Search size={13} />
          </button>
          <button
            className={`icon-btn ${caseSensitive ? "is-active" : ""}`}
            data-tip={t("Diferenciar maiúsculas")}
            aria-label={t("Diferenciar maiúsculas de minúsculas")}
            aria-pressed={caseSensitive}
            onClick={() => useSearch.getState().setCaseSensitive(!caseSensitive)}
          >
            <CaseSensitive size={14} />
          </button>
          <button
            className={`icon-btn ${wholeWord ? "is-active" : ""}`}
            data-tip={t("Palavra inteira")}
            aria-label={t("Só palavras inteiras")}
            aria-pressed={wholeWord}
            onClick={() => useSearch.getState().setWholeWord(!wholeWord)}
          >
            <WholeWord size={14} />
          </button>
          <button
            className={`icon-btn ${regex ? "is-active" : ""}`}
            data-tip={t("Expressão regular")}
            aria-label={t("Ler a busca como expressão regular")}
            aria-pressed={regex}
            onClick={() => useSearch.getState().setRegex(!regex)}
          >
            <Regex size={14} />
          </button>
          <button
            className={`icon-btn ${filtering || include || exclude ? "is-active" : ""}`}
            data-tip={t("Incluir e excluir arquivos")}
            aria-label={t("Filtrar por caminho de arquivo")}
            aria-pressed={filtering}
            onClick={() => setFiltering(!filtering)}
          >
            <Filter size={14} />
          </button>
          <button
            className={`icon-btn ${replacing ? "is-active" : ""}`}
            data-tip={t("Substituir")}
            aria-label={t("Mostrar o campo de substituição")}
            aria-pressed={replacing}
            onClick={() => useSearch.getState().setReplacing(!replacing)}
          >
            <Replace size={14} />
          </button>
        </div>
      </div>

      {/* The replace row lives under the query it rewrites, never beside it:
          the reading is "this becomes that", top to bottom. */}
      {replacing && (
        <div className="bench-bar">
          <div className="bench-search">
            <Replace size={12} aria-hidden="true" />
            <input
              value={replacement}
              placeholder={t("Substituir por")}
              aria-label={t("Texto que entra no lugar de cada ocorrência")}
              disabled={!root}
              onChange={(e) => useSearch.getState().setReplacement(e.target.value)}
            />
          </div>
          <div className="ftree-tools">
            <button
              className="btn btn--sm"
              disabled={!ready.ok}
              data-tip={ready.ok ? undefined : refusalText(ready.reason, t)}
              onClick={() => void runReplace()}
            >
              {t("Substituir tudo")}
            </button>
          </div>
        </div>
      )}

      {/* Two globs, shown only when asked for: they are the panel's least used
          control and its widest, and a project search is mostly project-wide. */}
      {filtering && (
        <div className="psearch-filters">
          <input
            className="psearch-glob"
            value={include}
            placeholder={t("incluir: *.ts, src/**")}
            aria-label={t("Só nos arquivos que casarem com estes padrões")}
            onChange={(e) => useSearch.getState().setInclude(e.target.value)}
          />
          <input
            className="psearch-glob"
            value={exclude}
            placeholder={t("excluir: *.test.ts")}
            aria-label={t("Fora os arquivos que casarem com estes padrões")}
            onChange={(e) => useSearch.getState().setExclude(e.target.value)}
          />
        </div>
      )}

      {!root && <p className="bench-note">{t("Abra um projeto para buscar nele.")}</p>}
      {/* Under two characters the search does not run; without this line the
          area sat empty and the silence looked like a failure. */}
      {root && query.trim().length > 0 && query.trim().length < MIN_QUERY && ( // i18n-ok
        <p className="bench-note">{t("Digite ao menos {n} caracteres.", { n: MIN_QUERY })}</p>
      )}
      {status === "error" && error && (
        <p className="bench-note bench-note--error">{error}</p>
      )}
      {status === "searching" && <p className="bench-note">{t("buscando…")}</p>}
      {status === "done" && fresh && outcome && (
        <p className="bench-note">
          {outcome.hits.length === 0
            ? t("Nada de “{query}” em {files} arquivos.", {
                query: query.trim(),
                files: outcome.filesScanned,
              })
            : t("{hits} linha(s) em {files} arquivo(s).", {
                hits: outcome.hits.length,
                files: outcome.filesHit,
              })}
          {outcome.truncated &&
            ` ${t("A lista parou num limite — refine a busca para ver o resto.")}`}
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
                    data-tip={t("linha {line}", { line: hit.line })}
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

/** Why the replace cannot run, in one line under the button. */
function refusalText(reason: ReplaceRefusal, t: (s: string) => string): string {
  switch (reason) {
    case "sem-projeto":
      return t("Abra um projeto primeiro.");
    case "curto":
      return t("Busque alguma coisa primeiro.");
    case "buscando":
      return t("Esperando a busca terminar.");
    case "sem-resultado":
      return t("Não há resultado para substituir.");
    case "truncado":
      // The list is shorter than the truth; replacing from it would rewrite
      // files that never appeared on screen.
      return t("A lista parou num limite. Refine a busca antes de substituir.");
  }
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
