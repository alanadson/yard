import type { EditorView } from "@codemirror/view";

/**
 * Publishes the first visible source line at most once per animation frame.
 * Returns the whole cleanup so every CodeMirror surface cancels a queued
 * frame as well as removing the DOM listener.
 */
export function observeVisibleLine(
  view: EditorView,
  publish: () => ((line: number) => void) | undefined,
): () => void {
  let pending = 0;
  const onScroll = () => {
    if (!publish() || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const current = publish();
      if (!current) return;
      const rect = view.scrollDOM.getBoundingClientRect();
      const pos = view.posAtCoords({ x: rect.left + 8, y: rect.top + 4 });
      current(pos == null ? 0 : view.state.doc.lineAt(pos).number - 1);
    });
  };
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    if (pending) cancelAnimationFrame(pending);
    view.scrollDOM.removeEventListener("scroll", onScroll);
  };
}
