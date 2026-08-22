/**
 * Who rules the native balloon when an agent stops.
 *
 * `pty/reader.rs` emits a single event — 4.5 s of silence — and `blocked.ts`
 * reads the tail to say *why* the agent stopped. The two reasons cost
 * different things: "finished" is information that can wait, "waiting for
 * you" is dead time until someone walks over. With a single switch, whoever
 * turned off the first lost the second — and the second is what justifies the
 * feature existing.
 */

/** The two `Prefs` switches that decide this. */
export interface NoticePrefs {
  notifyOnFinish: boolean;
  notifyBlocked: boolean;
}

/** `travado` is `classifyPrompt`'s reading: the agent asked for something in the tail. */
export function shouldNotify(locked: boolean, prefs: NoticePrefs): boolean {
  return locked ? prefs.notifyBlocked : prefs.notifyOnFinish;
}
