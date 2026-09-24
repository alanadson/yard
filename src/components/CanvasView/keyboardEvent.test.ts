// DOM keyboard modifiers are inherited properties, so spreading an event loses Ctrl+Z.
import { expect, it } from "vitest";
import { actionFor, resolveKeymap } from "../../lib/keymap";
import { canvasKeyEvent, spaceActivatesTarget } from "./keyboardEvent";

it("preserves DOM key modifiers so Ctrl+Z can undo a canvas resize", () => {
  const event = Object.create({
    code: "KeyZ",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  });
  expect(actionFor(resolveKeymap({}), canvasKeyEvent(event))).toBe("undo");
});

// Space on the board is the pan modifier; on a button inside a card it is the
// button's click, and swallowing it there broke keyboard activation.
it("Space belongs to a focused button, not to the board", () => {
  expect(spaceActivatesTarget({ tagName: "BUTTON" })).toBe(true);
  expect(spaceActivatesTarget({ tagName: "A" })).toBe(true);
});

it("Space on the board itself, or on nothing, is the board's", () => {
  expect(spaceActivatesTarget({ tagName: "DIV" })).toBe(false);
  expect(spaceActivatesTarget(null)).toBe(false);
});
