/** Serializes snapshots and remembers only values acknowledged by storage. */
export class PreferenceWriter {
  private saved: Record<string, string> = {};
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly persist: (entries: [string, string][]) => Promise<void>,
  ) {}

  write(values: Record<string, string>): Promise<void> {
    const snapshot = { ...values };
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        const changed = Object.entries(snapshot).filter(
          ([key, value]) => this.saved[key] !== value,
        );
        if (changed.length) await this.persist(changed);
        this.saved = snapshot;
      });
    this.pending = next;
    return next;
  }
}
