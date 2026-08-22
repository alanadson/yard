/**
 * The document's headings, as a rail on the right.
 *
 * A long README is navigated by its structure, not by its scrollbar. The list
 * doubles as a position indicator: the heading the caret is under shows
 * marked, so you always know where in the document you are writing — the one
 * thing a preview pane cannot tell you while you type.
 *
 * Clicking asks the editor to go to the heading's **source line**, which
 * works the same in all four modes: the writing surface scrolls to the line,
 * the reading surface scrolls to the block that was born on it.
 */
import { memo } from "react";

import type { OutlineEntry } from "../../lib/mddoc";

/**
 * What a row needs — satisfied by a markdown heading (`OutlineEntry`) and by
 * a code symbol (`lib/symbols.ts`) alike: this rail serves both.
 */
type Entry = Pick<OutlineEntry, "level" | "text" | "line">;

interface Props {
  entries: Entry[];
  /** Line the caret is on — the entry above it is the one in view. */
  line: number;
  onGo: (line: number) => void;
  /** Shown with nothing to list; the default speaks markdown. */
  empty?: string;
}

function OutlineImpl({ entries, line, onGo, empty }: Props) {
  // The last heading at or above the caret: the section it belongs to.
  let active = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].line <= line) active = i;
    else break;
  }

  if (entries.length === 0) {
    return (
      <nav className="md-outline" aria-label="Sumário">
        <p className="md-outline-empty">
          {empty ?? (
            <>
              Sem títulos ainda. Comece uma linha com <code>#</code> e ela
              aparece aqui.
            </>
          )}
        </p>
      </nav>
    );
  }

  return (
    <nav className="md-outline" aria-label="Sumário">
      <ul>
        {entries.map((h, i) => (
          <li key={`${h.line}-${i}`}>
            <button
              className={`md-outline-item ${i === active ? "is-active" : ""}`}
              style={{ paddingLeft: `${6 + (h.level - 1) * 11}px` }}
              data-level={h.level}
              data-tip-wrap=""
              data-tip={h.text}
              aria-current={i === active ? "true" : undefined}
              onClick={() => onGo(h.line)}
            >
              {h.text || "(sem título)"}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const Outline = memo(OutlineImpl);
