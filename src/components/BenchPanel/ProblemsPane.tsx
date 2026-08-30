/**
 * The Problems tab, everything the language servers have found, for the
 * whole project rather than for the file that happens to be open.
 *
 * It wears the project search's shape on purpose (a section per file, a click
 * lands the caret on the line): the two answer the same kind of question, and
 * a second layout for the same gesture would be a second thing to learn.
 *
 * The rules, what a section holds, how the sections rank, what "só erros"
 * hides, are in `lib/lsp/problems.ts`. Here it is only painted.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleAlert, Info } from "lucide-react";

import { fileName } from "../../lib/paths";
import { problemGroups, type Severity } from "../../lib/lsp/problems";
import { parentDir, useEditor } from "../../stores/editorStore";
import { useLsp } from "../../stores/lspStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

export function ProblemsPane() {
  const t = useT();
  const problems = useLsp((s) => s.problems);
  const lspEnabled = useUI((s) => s.prefs.lspEnabled);
  const root = useEditor((s) => s.root);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const groups = useMemo(
    () => problemGroups(problems, errorsOnly),
    [problems, errorsOnly],
  );

  const openAt = (path: string, line: number) => {
    void useEditor.getState().openFileAt(path, line);
  };

  return (
    <div className="bench-body" role="tabpanel" aria-label={t("Problemas do projeto")}>
      <div className="bench-bar">
        <div className="ftree-tools">
          <button
            className={`icon-btn ${errorsOnly ? "is-active" : ""}`}
            data-tip={errorsOnly ? t("Mostrando só os erros") : t("Mostrar só os erros")}
            aria-label={t("Mostrar só os erros")}
            aria-pressed={errorsOnly}
            onClick={() => setErrorsOnly(!errorsOnly)}
          >
            <CircleAlert size={14} />
          </button>
        </div>
      </div>

      {!lspEnabled && (
        <p className="bench-note">
          {t("Os servidores de linguagem estão desligados em Configurações.")}
        </p>
      )}
      {lspEnabled && !root && (
        <p className="bench-note">{t("Abra um projeto para ver o que os servidores acham dele.")}</p>
      )}
      {lspEnabled && root && groups.length === 0 && (
        <p className="bench-note">
          {errorsOnly
            ? t("Nenhum erro. Desligue o filtro para ver avisos e notas.")
            : t("Nada a corrigir, ou nenhum servidor de linguagem instalado para estes arquivos.")}
        </p>
      )}

      <div className="psearch-scroll">
        {groups.map((group) => {
          const shut = closed[group.path];
          return (
            <section className="psearch-file" key={group.path}>
              <button
                className="psearch-file-head"
                aria-expanded={!shut}
                onClick={() =>
                  setClosed((c) => ({ ...c, [group.path]: !c[group.path] }))
                }
              >
                {shut ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <SeverityGlyph severity={group.worst} />
                <span className="psearch-file-name">{fileName(group.path)}</span>
                <span className="psearch-file-dir" data-tip-wrap="" data-tip={group.path}>
                  {parentDir(group.path)}
                </span>
                <span className="psearch-count">{group.rows.length}</span>
              </button>
              {!shut &&
                group.rows.map((row, i) => (
                  <button
                    key={`${row.line}:${row.column}:${i}`}
                    className="psearch-hit"
                    data-tip={t("linha {line}", { line: row.line })}
                    onClick={() => openAt(group.path, row.line)}
                  >
                    <span className="psearch-line">{row.line}</span>
                    <span className="psearch-text">{row.message}</span>
                    {row.source && <span className="problem-source">{row.source}</span>}
                  </button>
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Error, warning, everything else. Colour is content here, which the contract allows. */
function SeverityGlyph({ severity }: { severity: Severity }) {
  if (severity === 1) {
    return <CircleAlert size={12} className="problem-sev problem-sev--error" aria-hidden="true" />;
  }
  if (severity === 2) {
    return <AlertTriangle size={12} className="problem-sev problem-sev--warn" aria-hidden="true" />;
  }
  return <Info size={12} className="problem-sev problem-sev--info" aria-hidden="true" />;
}
