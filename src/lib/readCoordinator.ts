interface PendingRead<T = unknown> {
  scope: string;
  done: Promise<void>;
  /**
   * Still in the turn of the event loop that started the read. Callers who
   * ask in that same turn are asking the same question (two panes mounting,
   * two refreshes fired by one gesture) and share the answer.
   */
  joinable: boolean;
  /**
   * A run of the same key and scope that arrived after the read was already
   * under way: not a duplicate, but the news that what the read is about to
   * return is behind. The closures are the latest caller's, so the re-read
   * sees what that caller wanted.
   */
  rerun: boolean;
  read: () => Promise<T>;
  accept: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Share pending reads while keeping publication owned by the latest scope. */
export class ReadCoordinator {
  private readonly pending = new Map<string, PendingRead>();

  invalidate(key: string): void {
    this.pending.delete(key);
  }

  run<T>(
    key: string,
    scope: string,
    read: () => Promise<T>,
    accept: (value: T) => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    const previous = this.pending.get(key) as PendingRead<T> | undefined;
    if (previous?.scope === scope) {
      if (!previous.joinable) {
        previous.rerun = true;
        previous.read = read;
        previous.accept = accept;
        previous.reject = reject;
      }
      return previous.done;
    }
    const request: PendingRead<T> = {
      scope,
      done: Promise.resolve(),
      joinable: true,
      rerun: true,
      read,
      accept,
      reject,
    };
    this.pending.set(key, request as PendingRead);
    queueMicrotask(() => {
      request.joinable = false;
    });
    request.done = (async () => {
      try {
        while (request.rerun && this.pending.get(key) === request) {
          request.rerun = false;
          try {
            const value = await request.read();
            if (this.pending.get(key) === request) request.accept(value);
          } catch (error) {
            if (this.pending.get(key) === request) request.reject(error);
          }
        }
      } finally {
        if (this.pending.get(key) === request) this.pending.delete(key);
      }
    })();
    return request.done;
  }
}
