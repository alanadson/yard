// Accessibility preferences must reach both newly created and running terminals.
import { expect, it } from "vitest";
import { terminalAccessibility } from "./terminalAccessibility";
import { DEFAULT_PREFS } from "../stores/uiStore";

it("protects text contrast by default and honors explicit terminal accessibility choices", () => {
  expect(terminalAccessibility(DEFAULT_PREFS)).toEqual({
    screenReaderMode: false,
    minimumContrastRatio: 4.5,
  });
  expect(
    terminalAccessibility({
      termScreenReader: true,
      termAccessibleContrast: false,
    }),
  ).toEqual({ screenReaderMode: true, minimumContrastRatio: 1 });
});
