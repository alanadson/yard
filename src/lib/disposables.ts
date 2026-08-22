export type DisposeFn = () => void;

/**
 * Owns cleanup callbacks whose registration may finish after the consumer has
 * already unmounted. Tauri's event APIs return their unlisten function through
 * a promise, so a plain local variable leaks the listener in that race.
 */
export class AsyncDisposer {
  private gone = false;
  private readonly items = new Set<DisposeFn>();

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  get disposed() {
    return this.gone;
  }

  keep(dispose: DisposeFn) {
    if (this.gone) {
      this.run(dispose);
      return false;
    }
    this.items.add(dispose);
    return true;
  }

  async add(source: Promise<DisposeFn>) {
    try {
      return this.keep(await source);
    } catch (error) {
      if (!this.gone) this.onError(error);
      return false;
    }
  }

  dispose() {
    if (this.gone) return;
    this.gone = true;
    for (const dispose of this.items) this.run(dispose);
    this.items.clear();
  }

  private run(dispose: DisposeFn) {
    try {
      dispose();
    } catch (error) {
      this.onError(error);
    }
  }
}
