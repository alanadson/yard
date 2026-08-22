/**
 * A tiny bounded LRU for in-memory UI state.
 *
 * Reading promotes an entry, so the item evicted by the next write is the
 * one the user has gone longest without touching. This deliberately exposes
 * only the operations our session caches need; a smaller API is harder to
 * accidentally use as an unbounded Map.
 */
export class LruCache<K, V> {
  readonly #values = new Map<K, V>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("LruCache limit must be a positive integer");
    }
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    const value = this.#values.get(key);
    if (value === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.#values.delete(key);
    this.#values.set(key, value);
    while (this.#values.size > this.limit) {
      const oldest = this.#values.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.#values.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.#values.delete(key);
  }

  keys(): IterableIterator<K> {
    return this.#values.keys();
  }

  prune(remove: (key: K, value: V) => boolean): number {
    let removed = 0;
    for (const [key, value] of this.#values) {
      if (remove(key, value)) {
        this.#values.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.#values.clear();
  }
}

/** Short name kept for caches outside React surfaces. */
export { LruCache as Lru };
