/**
 * What one CodeMirror view remembers about the files it is not showing.
 *
 * There is a single view behind every editor tab: switching files is a
 * `setState`, not a remount. An `EditorState` carries the caret, the
 * selection, the undo history and the folds, but **not** the scroll
 * position, which lives in the DOM. Remembering only the state is what used
 * to drop the reader at the top of a file they were reading in the middle.
 *
 * So the unit here is the pair, and it is keyed by document: a scroll
 * snapshot is only meaningful against the state it was taken from, and
 * replaying one over a different file scrolls to a position that means
 * nothing there.
 */
import { LruCache } from "../../lib/lru";

export interface DocMemoryEntry<S, E> {
  state: S;
  /** Where the file was scrolled, CodeMirror's own snapshot effect, or none yet. */
  scroll: E | null;
}

export class DocMemory<S, E> {
  readonly #entries: LruCache<string, DocMemoryEntry<S, E>>;

  constructor(limit: number) {
    this.#entries = new LruCache(limit);
  }

  get size(): number {
    return this.#entries.size;
  }

  remember(id: string, state: S, scroll: E | null): void {
    this.#entries.set(id, { state, scroll });
  }

  recall(id: string): DocMemoryEntry<S, E> | undefined {
    return this.#entries.get(id);
  }

  forget(id: string): void {
    this.#entries.delete(id);
  }

  /**
   * Everything outside `ids` goes. An `EditorState` holds the whole document
   * and its undo history; a closed tab has no claim on that memory.
   */
  keep(ids: Iterable<string>): void {
    const open = new Set(ids);
    this.#entries.prune((id) => !open.has(id));
  }
}
