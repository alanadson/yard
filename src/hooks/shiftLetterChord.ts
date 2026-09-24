/**
 * The window's Ctrl+Shift+<letter> chords, as one table: a key can only
 * name one action here, which is what keeps a second branch for the same
 * chord from silently shadowing the first in `useKeybindings`.
 */
export const SHIFT_LETTER_CHORDS = {
  KeyP: "preferences",
  KeyB: "bench",
  KeyT: "reopenLastTab",
  KeyE: "files",
  KeyR: "scm",
  KeyD: "changes",
  KeyA: "attention",
  KeyW: "closeTab",
  KeyH: "shortcuts",
  KeyN: "notes",
  KeyF: "find",
  KeyG: "nextGroup",
  KeyU: "broadcast",
  KeyO: "shoulder",
} as const;

export type ShiftLetterAction = (typeof SHIFT_LETTER_CHORDS)[keyof typeof SHIFT_LETTER_CHORDS];

export function shiftLetterChord(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
}): ShiftLetterAction | null {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return null;
  return (SHIFT_LETTER_CHORDS as Record<string, ShiftLetterAction>)[e.code] ?? null;
}
