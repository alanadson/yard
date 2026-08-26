/**
 * The seam between the matcher and xterm.
 *
 * xterm asks for the links of one buffer row while the mouse hovers it; the
 * answer is the matcher's spans in xterm's own coordinates (1-based cells,
 * inclusive range). Only the row handed over is looked at — a path wrapped
 * over two rows is not matched, on purpose: stitching rows means guessing
 * where the wrap fell, and a wrong guess opens the wrong file.
 *
 * Activation demands **Ctrl (or Meta) + click**. A plain click on a path in
 * the middle of a CLI's screen keeps meaning "focus here"; without the
 * modifier, a stray click during a selection would start opening editor tabs.
 */
import { findLinks, linkRange, type LinkMatch } from "./termLinks";

/** The slice of xterm's `Terminal` the provider reads — a test fakes this. */
export interface LinkSource {
  buffer: {
    active: {
      getLine: (y: number) => { translateToString: (trim?: boolean) => string } | undefined;
    };
  };
}

export interface RowLink {
  range: ReturnType<typeof linkRange>;
  text: string;
  decorations: { pointerCursor: boolean; underline: boolean };
  activate: (event: MouseEvent, text: string) => void;
}

export interface RowLinkProvider {
  provideLinks: (row: number, callback: (links: RowLink[] | undefined) => void) => void;
}

export function termLinkProvider(
  term: LinkSource,
  onOpen: (match: LinkMatch) => void,
): RowLinkProvider {
  return {
    provideLinks(row, callback) {
      // xterm's rows are 1-based; the buffer's are 0-based.
      const text = term.buffer.active.getLine(row - 1)?.translateToString(true) ?? "";
      const links = findLinks(text).map((match) => ({
        range: linkRange(match, row),
        text: match.text,
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          if (event.ctrlKey || event.metaKey) onOpen(match);
        },
      }));
      callback(links.length ? links : undefined);
    },
  };
}
