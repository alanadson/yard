/**
 * When a phone card asks the device for its screen.
 *
 * `"loop"` streams a frame every tick, `"once"` takes one (a paused card
 * still shows where the phone is), `"off"` takes none. The card's effect is
 * keyed on this value, so going from `"off"` back to either of the others is
 * itself the catch-up: one screenshot at once, then the stream resumes.
 */
export type ScreenFeed = "off" | "once" | "loop";

export interface FeedInput {
  /** The user's live toggle on the card. */
  live: boolean;
  /** A surface covering the whole workspace (modal, editor, diff). */
  covered: boolean;
  /** Being erased. */
  faded: boolean;
  /** Inside the camera's view (with the culling margin). */
  onScreen: boolean;
  /** The main window is not hidden or minimized (`lib/windowShown.ts`). */
  windowShown: boolean;
}

export function screenFeed({ live, covered, faded, onScreen, windowShown }: FeedInput): ScreenFeed {
  if (covered || faded || !onScreen || !windowShown) return "off";
  return live ? "loop" : "once";
}
