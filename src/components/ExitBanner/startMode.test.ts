/** Starting a new conversation must archive its previous output rather than merge the sessions. */
import { expect, it } from "vitest";
import { keepOutputOnStart } from "./startMode";

it("starting from scratch on a resumable agent requests a separate active output session", () => {
  expect(keepOutputOnStart(true, false)).toBe(false);
});

it("continuing a conversation preserves its active output history", () => {
  expect(keepOutputOnStart(true, true)).toBe(true);
});

it("resuming a generic terminal preserves its active output history", () => {
  expect(keepOutputOnStart(false, false)).toBe(true);
});
