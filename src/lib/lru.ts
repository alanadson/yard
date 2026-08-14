/**
 * Bounded cache that evicts the oldest entry instead of emptying itself.
 *
 * Three caches in the app used to call `clear()` on overflow — the layout
 * parse, the rough/freehand paths and the file diffs. That works, but it
 * turns a full cache into a cliff: on a large canvas in continuous editing,
 * every Nth commit threw away *every* path and repainted the whole drawing
 * from scratch. `Map` iterates in insertion order, so dropping the first key
 * is the whole implementation.
 */
export class Lru<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    // Re-insert so a value that keeps being read stays young.
    if (hit !== undefined) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /** Drops entries whose key matches — used to invalidate one project's diffs. */
  prune(matches: (key: K) => boolean): void {
    for (const key of [...this.map.keys()]) {
      if (matches(key)) this.map.delete(key);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
