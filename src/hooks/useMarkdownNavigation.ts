import { useCallback, type MutableRefObject } from "react";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { BlockKind } from "../lib/mdedit";

interface Options {
  previewRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<EditorView | null>;
  isSplit: () => boolean;
  setCaret: (at: { line: number; block: BlockKind }) => void;
}

/**
 * Keeps source, rendered markdown and outline navigation in one vocabulary.
 * Both the file editor and notes use zero-based source lines and rendered
 * blocks tagged with `data-line`; keeping this here prevents the two readers
 * from slowly acquiring different scrolling behaviour.
 */
export function useMarkdownNavigation({
  previewRef,
  viewRef,
  isSplit,
  setCaret,
}: Options) {
  const scrollPreviewTo = useCallback(
    (line: number) => {
      const host = previewRef.current;
      if (!host) return;
      let target: HTMLElement | null = null;
      for (const element of host.querySelectorAll<HTMLElement>("[data-line]")) {
        if (Number(element.dataset.line) <= line) target = element;
        else break;
      }
      if (!target) {
        host.scrollTop = 0;
        return;
      }
      host.scrollTop +=
        target.getBoundingClientRect().top -
        host.getBoundingClientRect().top -
        10;
    },
    [previewRef],
  );

  const goToLine = useCallback(
    (line: number) => {
      const view = viewRef.current;
      if (view) {
        const target = view.state.doc.line(
          Math.min(Math.max(line + 1, 1), view.state.doc.lines),
        );
        view.dispatch({
          selection: EditorSelection.cursor(target.from),
          effects: EditorView.scrollIntoView(target.from, {
            y: "start",
            yMargin: 24,
          }),
        });
        view.focus();
      }
      scrollPreviewTo(line);
    },
    [scrollPreviewTo, viewRef],
  );

  const onCaret = useCallback(
    (at: { line: number; block: BlockKind }) => {
      setCaret(at);
      if (isSplit()) scrollPreviewTo(at.line);
    },
    [isSplit, scrollPreviewTo, setCaret],
  );

  const onScrollLine = useCallback(
    (line: number) => {
      if (isSplit()) scrollPreviewTo(line);
    },
    [isSplit, scrollPreviewTo],
  );

  return { goToLine, onCaret, onScrollLine };
}
