import type { PortalBoundsUpdate, PortalPlace } from "./ipc";
import { LruCache } from "./lru";

/**
 * Coalesces native portal geometry to the last value in a frame and suppresses
 * placements the native window has already received. Fingerprints are bounded
 * because portal ids can be short-lived during a long application session.
 */
export class PortalBoundsQueue {
  readonly #pending = new Map<string, PortalPlace>();
  readonly #last = new LruCache<string, string>(256);

  enqueue(id: string, place: PortalPlace): void {
    this.#pending.set(id, place);
  }

  drain(): PortalBoundsUpdate[] {
    const updates: PortalBoundsUpdate[] = [];
    for (const [id, place] of this.#pending) {
      const fingerprint = JSON.stringify(place);
      if (this.#last.get(id) === fingerprint) continue;
      this.#last.set(id, fingerprint);
      updates.push({ id, place });
    }
    this.#pending.clear();
    return updates;
  }
}
