/**
 * How a pane hides the terminals that are not on screen.
 *
 * Every terminal of a slot stays mounted, so an inactive panel has to be
 * hidden without being taken apart, and each way of getting that wrong is
 * invisible until it bites: `display: none` gives the back-tab xterm a 0x0
 * host and the renderer blows up on its first write ("reading 'dimensions'"),
 * a panel hidden only from the eye is still there for a screen reader, a
 * panel hidden in place keeps xterm repainting every chunk of output it gets
 * (its renderer pauses only out of the viewport), and a panel moved out of the
 * viewport without the pane asking its terminals to resume on reveal comes
 * back showing a stale frame first (measured in Edge).
 */
import { describe, expect, it } from "vitest";

import paneSrc from "./index.tsx?raw";
import { terminalPanelProps } from "./panelVisibility";

describe("terminalPanelProps", () => {
  it("shows the active panel to the eye and to assistive tech", () => {
    expect(terminalPanelProps(true)).toEqual({
      "aria-hidden": false,
      style: { visibility: "visible" },
    });
  });

  it("hides an inactive panel from assistive tech as well as from the eye", () => {
    const hidden = terminalPanelProps(false);
    expect(hidden["aria-hidden"]).toBe(true);
    expect(hidden.style.visibility).toBe("hidden");
  });

  it("keeps an inactive panel's box, so the back-tab xterm can still measure its cells and fit", () => {
    const { style } = terminalPanelProps(false);
    expect(style.display).toBeUndefined();
    expect(style.width).toBeUndefined();
    expect(style.height).toBeUndefined();
  });

  it("moves an inactive panel out of the viewport, where xterm stops painting it, at its full size", () => {
    const { style } = terminalPanelProps(false);
    expect(style.transform).toBe("translateX(-200vw)");
    expect(style.display).toBeUndefined();
    expect(style.width).toBeUndefined();
    expect(style.height).toBeUndefined();
  });
});

describe("the pane body", () => {
  it("takes every terminal panel's hiding from the rule, not from an inline style", () => {
    expect(paneSrc).toContain("{...terminalPanelProps(visible)}");
    expect(paneSrc).not.toMatch(/style=\{\{\s*visibility:/);
  });

  it("has its terminals resume inside the frame that reveals them, not a frame late", () => {
    const view = /<XTermView\b[\s\S]*?\/>/.exec(paneSrc)?.[0] ?? "";
    expect(view).toContain("visible={visible}");
    expect(view).toMatch(/\bresumeOnShow\b(?!=\{false\})/);
  });
});
