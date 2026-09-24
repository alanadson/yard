/** Renderer options shared by terminal startup and live preference updates. */
export function terminalAccessibility(prefs: {
  termScreenReader: boolean;
  termAccessibleContrast: boolean;
}) {
  return {
    screenReaderMode: prefs.termScreenReader,
    minimumContrastRatio: prefs.termAccessibleContrast ? 4.5 : 1,
  };
}
