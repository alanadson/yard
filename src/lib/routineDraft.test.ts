// A rejected numeric draft must never schedule a routine using the previous interval.
import { expect, it } from "vitest";
import { routineDraftIsDirty, validateRoutineDraft } from "./routineDraft";

it("rejects invalid intervals instead of falling back to the last committed value", () => {
  for (const interval of ["", "0", "10081", "1.5", "NaN"]) {
    expect(validateRoutineDraft("run tests", interval)).toEqual({
      valid: false,
      field: "interval",
    });
  }
  expect(validateRoutineDraft(" run tests ", "45")).toEqual({
    valid: true,
    text: "run tests",
    everyMin: 45,
  });
});

it("does not warn about unsaved work after a routine with a custom schedule was created", () => {
  const saved = { interval: "45", once: true };
  expect(routineDraftIsDirty({ text: "", ...saved }, saved)).toBe(false);
  expect(routineDraftIsDirty({ text: "run tests", ...saved }, saved)).toBe(
    true,
  );
  expect(
    routineDraftIsDirty({ text: "", interval: "60", once: true }, saved),
  ).toBe(true);
});
