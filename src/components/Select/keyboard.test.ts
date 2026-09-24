// A portaled listbox must resume the surrounding form's tab order in one keypress.
import { expect, it } from "vitest";
import { selectTabTarget, selectTypeahead } from "./keyboard";

it("moves Tab and Shift Tab past the trigger and wraps only inside dialogs", () => {
  expect(
    selectTabTarget(["before", "select", "after"], "select", false, true),
  ).toBe("after");
  expect(
    selectTabTarget(["before", "select", "after"], "select", true, true),
  ).toBe("before");
  expect(selectTabTarget(["before", "select"], "select", false, true)).toBe(
    "before",
  );
  expect(
    selectTabTarget(["before", "select"], "select", false, false),
  ).toBeNull();
});

it("finds options by typed prefix, skips disabled choices and cycles repeated letters", () => {
  const options = [
    { value: "claude", label: "Claude" },
    { value: "cline", label: "Cline", disabled: true },
    { value: "codex", label: "Codex" },
    { value: "chrome", label: "Chrome" },
  ];
  const first = selectTypeahead(
    options,
    "claude",
    "c",
    { text: "", at: 0 },
    1_000,
  );
  expect(first.value).toBe("codex");
  const repeated = selectTypeahead(options, first.value, "c", first, 1_100);
  expect(repeated.value).toBe("chrome");
  expect(selectTypeahead(options, "chrome", "o", first, 1_200).value).toBe(
    "codex",
  );
  expect(selectTypeahead(options, "chrome", "c", repeated, 3_000).value).toBe(
    "claude",
  );
});
